import type { Agent } from '../agent/types.ts';
import type { IdentitiesAdapter } from '../memory/types.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('goalRunner');

export interface GoalRunner {
  /** Fire a previously-scheduled goal once, delivering the agent's reply to
   * the action's author (`ownerUserId`) over Telegram. Should not throw under
   * normal-failure conditions; the scheduler treats a thrown error as
   * "advance and retry next tick" for cron, "mark error" for once. */
  fire(goal: string, ownerUserId: number): Promise<void>;
}

export interface GoalRunnerOptions {
  /** The Agent to use for goal execution. Should be configured in goal mode
   * (no `ask` tool, no send_to_telegram, fresh Session per fire). The runner
   * does NOT manage the agent's lifecycle — caller wires it. */
  agent: Agent;
  /** Resolves an author's Telegram chat id (and other channels). */
  identities: IdentitiesAdapter;
  /** Build a sender targeting a specific Telegram chat id. */
  senderFor: (chatId: string) => TelegramSender;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\n/g, '\\n');
  if (oneLine.length <= max) {
    return oneLine;
  }
  return oneLine.slice(0, max - 1) + '…';
}

export function buildGoalRunner(opts: GoalRunnerOptions): GoalRunner {
  const { agent, identities, senderFor } = opts;

  // Resolve the author's Telegram chat to a sender. null when they have no
  // Telegram identity (shouldn't happen — scheduling validates it) → we log
  // and skip delivery rather than misrouting to some default chat.
  const senderForOwner = (ownerUserId: number, goal: string): TelegramSender | null => {
    const chatId = identities.identityFor('telegram', ownerUserId);
    if (chatId === null) {
      log.warn(
        { ownerUserId, goal },
        `goal "${truncate(goal)}" owner ${ownerUserId} has no Telegram identity; dropping delivery`,
      );
      return null;
    }
    return senderFor(chatId);
  };

  return {
    async fire(goal: string, ownerUserId: number): Promise<void> {
      const startedAt = Date.now();
      log.info({ goal, ownerUserId }, `firing goal "${truncate(goal)}"`);
      try {
        const res = await agent.respond(goal);
        const text = res.text ?? '';
        const durationMs = Date.now() - startedAt;
        const toolsUsed = res.toolsUsed ?? [];
        log.info(
          { goal, ownerUserId, reply: text, toolsUsed, durationMs, toolCount: toolsUsed.length },
          `goal "${truncate(goal)}" → ${truncate(text)} [${durationMs}ms, ${toolsUsed.length} tool(s): ${toolsUsed.join(',') || 'none'}]`,
        );

        // Empty text is fine when tools did the work (the goal WAS the
        // action), but empty text with zero tool calls means the fire produced
        // nothing observable — the goal was likely silently lost.
        if (text.length === 0 && toolsUsed.length === 0) {
          log.warn(
            { goal, ownerUserId, durationMs },
            `goal "${truncate(goal)}" produced empty text and used no tools — nothing reached the user`,
          );
        }

        // Goal-mode agents have no send_to_telegram — the runner owns
        // delivery, sending the agent's reply to the action's author.
        if (text.length > 0) {
          const sender = senderForOwner(ownerUserId, goal);
          if (sender === null) {
            return;
          }
          try {
            await sender.send(text);
            log.info({ goal, ownerUserId }, `goal "${truncate(goal)}" delivered to author`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error(
              { goal, ownerUserId, err },
              `goal "${truncate(goal)}" delivery failed: ${msg}`,
            );
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ goal, ownerUserId, err }, `goal "${truncate(goal)}" failed: ${msg}`);
        throw err;
      }
    },
  };
}
