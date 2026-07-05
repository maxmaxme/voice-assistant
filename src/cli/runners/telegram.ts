import { exec } from 'child_process';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import { Session } from '../../agent/session.ts';
import type { MemoryStore } from '../../memory/types.ts';
import { makeScopedProfile, type Scope, type ScopedProfile } from '../../memory/scope.ts';
import type { IdentitiesAdapter } from '../../memory/types.ts';
import type { SqliteProfileMemory } from '../../memory/sqliteProfileMemory.ts';
import type { TelegramReceiver, TelegramSender, TelegramMessage } from '../../telegram/types.ts';
import { BotTelegramSender } from '../../telegram/telegramSender.ts';
import { DraftStreamer } from '../../telegram/draftStreamer.ts';
import type { AgentImage } from '../../agent/types.ts';
import type { TelegramVoiceTranscriber } from '../../telegram/voiceTranscriber.ts';
import type { TelegramPhotoLoader } from '../../telegram/photoLoader.ts';
import { createLogger } from '../../utils/logger.ts';
import type { Logger } from 'pino';

const log = createLogger('telegram');

export interface TelegramRunnerDeps {
  receiver: TelegramReceiver;
  /** Optional fallback sender. The runner normally replies per-message via
   * `replyTo(msg.chatId)`; `sender` is only used when `replyTo` is absent
   * (e.g. some tests). At least one of the two must be provided. */
  sender?: TelegramSender;
  agent: OpenAiAgent;
  memory: MemoryStore;
  /** Resolves the (self-persisting) Session for a chat. The default impl in
   * unified.ts builds Sessions backed by `memory.telegramSessions`; tests can
   * pass an in-memory factory. */
  sessionFor: (chatId: number) => Session;
  identities: IdentitiesAdapter;
  profileStore: SqliteProfileMemory;
  /** Build a new sender targeting a specific chat. Defaults to the global one
   * (single-user setup). Tests inject this. */
  replyTo?: (chatId: number) => TelegramSender;
  /** Transcribes voice messages by Telegram file_id. When omitted, voice
   *  messages get a "not supported" reply (back-compat for tests). */
  voiceTranscriber?: TelegramVoiceTranscriber;
  /** Downloads photos by Telegram file_id. When omitted, photo messages get a
   *  "not supported" reply. */
  photoLoader?: TelegramPhotoLoader;
}

const HELP_TEXT = `Personal-agent bot ready. Just type — I forward to the agent.
Commands:
  /reset — clear conversation context
  /profile — dump remembered profile
  /help — show this`;

export function resolveTelegramScope(identities: IdentitiesAdapter, chatId: number): Scope | null {
  const res = identities.resolve('telegram', String(chatId));
  if (!res) {
    return null;
  }
  identities.touch('telegram', String(chatId));
  return { userId: res.userId };
}

export async function runTelegramMode(deps: TelegramRunnerDeps): Promise<void> {
  const { receiver, agent, sessionFor, memory, voiceTranscriber, photoLoader } = deps;

  for await (const msg of receiver.messages()) {
    // One child logger per inbound update — every line emitted while
    // handling this message is automatically tagged with chatId+updateId,
    // which is what you want when grepping logs across overlapping requests.
    const reqLog = log.child({ chatId: msg.chatId, updateId: msg.updateId, kind: msg.kind });
    if (msg.kind === 'voice') {
      reqLog.info(
        { fileId: msg.fileId, durationSec: msg.durationSec },
        `inbound voice (${msg.durationSec}s)`,
      );
    } else if (msg.kind === 'photo') {
      reqLog.info({ fileId: msg.fileId }, 'inbound photo');
    } else {
      reqLog.info('inbound message');
    }
    const replyer = deps.replyTo ? deps.replyTo(msg.chatId) : deps.sender;
    if (!replyer) {
      reqLog.error('no replyTo factory or fallback sender configured; dropping message');
      continue;
    }
    const scope = resolveTelegramScope(deps.identities, msg.chatId);
    if (!scope) {
      reqLog.warn(`dropped message from chat=${msg.chatId} (no identity)`);
      continue;
    }
    try {
      await handleMessage(msg, {
        agent,
        session: sessionFor(msg.chatId),
        memory,
        profile: makeScopedProfile(deps.profileStore, scope),
        scope,
        isAdmin: deps.identities.isAdmin(scope.userId),
        sender: replyer,
        voiceTranscriber,
        photoLoader,
        log: reqLog,
      });
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      reqLog.error({ err }, `handler error: ${text}`);
      try {
        await replyer.send(`Internal error: ${text}`);
      } catch {
        // swallow — Telegram itself is failing
      }
    }
  }
}

async function handleMessage(
  msg: TelegramMessage,
  ctx: {
    agent: OpenAiAgent;
    session: Session;
    memory: MemoryStore;
    profile: ScopedProfile;
    scope: Scope;
    /** Whether the resolved principal may run privileged commands (/update). */
    isAdmin: boolean;
    sender: TelegramSender;
    voiceTranscriber?: TelegramVoiceTranscriber;
    photoLoader?: TelegramPhotoLoader;
    log: Logger;
  },
): Promise<void> {
  if (msg.kind === 'voice') {
    if (!ctx.voiceTranscriber) {
      await ctx.sender.send('Voice messages are not supported yet — please send text.');
      return;
    }
    let transcript: string;
    const sttStartedAt = Date.now();
    try {
      transcript = await ctx.voiceTranscriber.transcribe(msg.fileId);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, `voice transcription failed: ${m}`);
      await ctx.sender.send(`Could not transcribe voice message: ${m}`);
      return;
    }
    transcript = transcript.trim();
    ctx.log.info(
      { transcribeMs: Date.now() - sttStartedAt, chars: transcript.length },
      `transcribed voice → ${transcript}`,
    );
    if (!transcript) {
      await ctx.sender.send('Voice message is empty — no speech detected.');
      return;
    }
    let reply;
    try {
      reply = await respondWithDraft(ctx, msg.updateId, transcript);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, `agent error on voice transcript: ${m}`);
      await ctx.sender.send(`Agent error: ${m}`);
      return;
    }
    await ctx.sender.send(reply.text);
    return;
  }
  if (msg.kind === 'photo-album-rejected') {
    await ctx.sender.send('I can only handle one photo at a time — please send them one by one.');
    return;
  }
  if (msg.kind === 'photo') {
    if (!ctx.photoLoader) {
      await ctx.sender.send('Photos are not supported yet — please send text.');
      return;
    }
    let image;
    try {
      image = await ctx.photoLoader.load(msg.fileId);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, `photo download failed: ${m}`);
      await ctx.sender.send(`Could not download photo: ${m}`);
      return;
    }
    let reply;
    try {
      reply = await respondWithDraft(ctx, msg.updateId, msg.caption ?? '', [image]);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, `agent error on photo: ${m}`);
      await ctx.sender.send(`Agent error: ${m}`);
      return;
    }
    await ctx.sender.send(reply.text);
    return;
  }
  if (msg.kind === 'unsupported') {
    await ctx.sender.send('Unsupported message type. Send text or use a command (/help).');
    return;
  }

  const text = msg.text.trim();
  if (text === '/start' || text === '/help') {
    await ctx.sender.send(HELP_TEXT);
    return;
  }
  if (text === '/reset') {
    ctx.session.reset();
    await ctx.sender.send('Context cleared.');
    return;
  }
  if (text === '/profile') {
    await ctx.sender.send(JSON.stringify(ctx.profile.recall(), null, 2));
    return;
  }
  if (text === '/update') {
    if (!ctx.isAdmin) {
      await ctx.sender.send('Sorry, /update is restricted to admins.');
      return;
    }
    if (process.platform !== 'linux') {
      await ctx.sender.send('Update only works on the Pi. Locally, restart manually.');
      return;
    }
    await ctx.sender.send('🔄 Starting update...');
    // Writes to a host-side FIFO; the host's va-update-listener.service
    // picks it up and runs update.sh. The script itself posts the result to Telegram.
    exec('echo trigger > /tmp/va-update');
    return;
  }

  let reply;
  try {
    reply = await respondWithDraft(ctx, msg.updateId, text);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err }, `agent error: ${m}`);
    await ctx.sender.send(`Agent error: ${m}`);
    return;
  }
  await ctx.sender.send(reply.text);
}

/** Run agent.respond() while live-streaming the reply into a Telegram draft
 * when the sender supports it. draftId = updateId (unique per message,
 * non-zero as required by sendMessageDraft). */
async function respondWithDraft(
  ctx: {
    agent: OpenAiAgent;
    session: Session;
    profile: ScopedProfile;
    scope: Scope;
    sender: TelegramSender;
  },
  draftId: number,
  userText: string,
  images?: AgentImage[],
) {
  const sendDraft = ctx.sender.sendDraft?.bind(ctx.sender);
  const streamer = sendDraft ? new DraftStreamer({ sendDraft }, draftId || 1) : null;
  streamer?.start();
  try {
    return await ctx.agent.respond(userText, {
      session: ctx.session,
      profile: ctx.profile,
      scope: ctx.scope,
      ...(images ? { images } : {}),
      ...(streamer ? { onTextDelta: (d: string) => streamer.onDelta(d) } : {}),
    });
  } finally {
    if (streamer) {
      // Wait out any in-flight draft send so a slow draft can't land after
      // the final persisted message.
      await streamer.finish();
    }
  }
}

/** Build a sender that replies to a specific chat using the same bot token. */
export function perChatSender(botToken: string): (chatId: number) => TelegramSender {
  return (chatId) => new BotTelegramSender({ botToken, chatId: String(chatId) });
}
