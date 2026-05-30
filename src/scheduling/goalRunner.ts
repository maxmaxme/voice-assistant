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
  /** Fallback sender, used when the author has no resolvable Telegram chat
   * (shouldn't happen — validated at scheduling time). */
  defaultTelegram: TelegramSender;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\n/g, '\\n');
  if (oneLine.length <= max) {
    return oneLine;
  }
  return oneLine.slice(0, max - 1) + '…';
}

export function buildGoalRunner(opts: GoalRunnerOptions): GoalRunner {
  const { agent, identities, senderFor, defaultTelegram } = opts;

  // Resolve the author's Telegram chat to a sender, falling back to the
  // default when they have none (defensive — scheduling validates this).
  const senderForOwner = (ownerUserId: number, goal: string): TelegramSender => {
    const chatId = identities.identityFor('telegram', ownerUserId);
    if (chatId === null) {
      log.warn(
        { ownerUserId, goal },
        `goal "${truncate(goal)}" owner ${ownerUserId} has no Telegram identity; using default sender`,
      );
      return defaultTelegram;
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

        // Goal-mode agents have no send_to_telegram — the runner owns
        // delivery, sending the agent's reply to the action's author.
        if (text.length > 0) {
          const sender = senderForOwner(ownerUserId, goal);
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
