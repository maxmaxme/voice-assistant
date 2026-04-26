import { exec } from 'child_process';
import type { OpenAiAgent } from '../../agent/openaiAgent.ts';
import type { Session } from '../../agent/session.ts';
import type { MemoryStore } from '../../memory/types.ts';
import type { TelegramReceiver, TelegramSender, TelegramMessage } from '../../telegram/types.ts';
import { BotTelegramSender } from '../../telegram/telegramSender.ts';
import type { TelegramVoiceTranscriber } from '../../telegram/voiceTranscriber.ts';
import { createLogger } from '../../utils/logger.ts';
import type { Logger } from 'pino';

const log = createLogger('telegram');

export interface TelegramRunnerDeps {
  receiver: TelegramReceiver;
  /** Sender used to reply to the *originating* chat. The default factory uses
   * the configured chat_id; the runner overrides it per-message via `replyTo`. */
  sender: TelegramSender;
  agent: OpenAiAgent;
  session: Session;
  memory: MemoryStore;
  allowedChatIds: number[];
  /** Build a new sender targeting a specific chat. Defaults to the global one
   * (single-user setup). Tests inject this. */
  replyTo?: (chatId: number) => TelegramSender;
  /** Transcribes voice messages by Telegram file_id. When omitted, voice
   *  messages get a "not supported" reply (back-compat for tests). */
  voiceTranscriber?: TelegramVoiceTranscriber;
}

const HELP_TEXT = `Personal-agent bot ready. Just type — I forward to the agent.
Commands:
  /reset — clear conversation context
  /profile — dump remembered profile
  /update — pull latest image and restart
  /help — show this`;

export async function runTelegramMode(deps: TelegramRunnerDeps): Promise<void> {
  const { receiver, agent, session, memory, allowedChatIds, voiceTranscriber } = deps;
  const allow = new Set(allowedChatIds);

  for await (const msg of receiver.messages()) {
    // One child logger per inbound update — every line emitted while
    // handling this message is automatically tagged with chatId+updateId,
    // which is what you want when grepping logs across overlapping requests.
    const reqLog = log.child({ chatId: msg.chatId, updateId: msg.updateId, kind: msg.kind });
    const replyer = deps.replyTo ? deps.replyTo(msg.chatId) : deps.sender;
    if (!allow.has(msg.chatId)) {
      reqLog.warn(`dropped message from chat=${msg.chatId} (not allow-listed)`);
      continue;
    }
    try {
      await handleMessage(msg, {
        agent,
        session,
        memory,
        sender: replyer,
        voiceTranscriber,
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
    sender: TelegramSender;
    voiceTranscriber?: TelegramVoiceTranscriber;
    log: Logger;
  },
): Promise<void> {
  if (msg.kind === 'voice') {
    if (!ctx.voiceTranscriber) {
      await ctx.sender.send('Voice messages are not supported yet — please send text.');
      return;
    }
    let transcript: string;
    try {
      transcript = await ctx.voiceTranscriber.transcribe(msg.fileId);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, `voice transcription failed: ${m}`);
      await ctx.sender.send(`Could not transcribe voice message: ${m}`);
      return;
    }
    transcript = transcript.trim();
    if (!transcript) {
      await ctx.sender.send('Voice message is empty — no speech detected.');
      return;
    }
    let reply;
    try {
      reply = await ctx.agent.respond(transcript);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      ctx.log.error({ err }, `agent error on voice transcript: ${m}`);
      await ctx.sender.send(`Agent error: ${m}`);
      return;
    }
    await ctx.sender.send(`🎤 «${transcript}»\n\n${reply.text}`);
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
    await ctx.sender.send(JSON.stringify(ctx.memory.profile.recall(), null, 2));
    return;
  }
  if (text === '/update') {
    if (process.platform !== 'linux') {
      await ctx.sender.send('Update only works on the Pi. Locally, restart manually.');
      return;
    }
    await ctx.sender.send('🔄 Starting update...');
    // Writes to a host-side FIFO; va-update-listener.service picks it up and
    // runs deploy/update.sh. The script itself posts the result to Telegram.
    exec('echo trigger > /tmp/va-update');
    return;
  }

  let reply;
  try {
    reply = await ctx.agent.respond(text);
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    ctx.log.error({ err }, `agent error: ${m}`);
    await ctx.sender.send(`Agent error: ${m}`);
    return;
  }
  await ctx.sender.send(reply.text);
}

/** Build a sender that replies to a specific chat using the same bot token. */
export function perChatSender(botToken: string): (chatId: number) => TelegramSender {
  return (chatId) => new BotTelegramSender({ botToken, chatId: String(chatId) });
}
