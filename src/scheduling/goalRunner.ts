import type { Agent } from '../agent/types.ts';
import { TELEGRAM_TOOL_NAME } from '../agent/telegramTool.ts';
import type { TelegramSender } from '../telegram/types.ts';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('goalRunner');

export interface GoalRunner {
  /** Fire a previously-scheduled goal once. Should not throw under
   * normal-failure conditions; the scheduler treats a thrown error as
   * "advance and retry next tick" for cron, "mark error" for once. */
  fire(goal: string): Promise<void>;
}

export interface GoalRunnerOptions {
  /** The Agent to use for goal execution. Should be configured in goal mode
   * (no `ask` tool, fresh Session per fire). The runner does NOT manage the
   * agent's lifecycle — caller wires it. */
  agent: Agent;
  /** Used as a safety net: if the goal completes with non-empty text but
   * the agent never called send_to_telegram, the runner forwards the text
   * here so the user actually hears about it. */
  telegram: TelegramSender;
}

function truncate(s: string, max = 80): string {
  const oneLine = s.replace(/\n/g, '\\n');
  if (oneLine.length <= max) {
    return oneLine;
  }
  return oneLine.slice(0, max - 1) + '…';
}

export function buildGoalRunner(opts: GoalRunnerOptions): GoalRunner {
  const { agent, telegram } = opts;
  return {
    async fire(goal: string): Promise<void> {
      const startedAt = Date.now();
      log.info({ goal }, `firing goal "${truncate(goal)}"`);
      try {
        const res = await agent.respond(goal);
        const text = res.text ?? '';
        const durationMs = Date.now() - startedAt;
        const toolsUsed = res.toolsUsed ?? [];
        log.info(
          { goal, reply: text, toolsUsed, durationMs, toolCount: toolsUsed.length },
          `goal "${truncate(goal)}" → ${truncate(text)} [${durationMs}ms, ${toolsUsed.length} tool(s): ${toolsUsed.join(',') || 'none'}]`,
        );

        const calledTelegram = toolsUsed.includes(TELEGRAM_TOOL_NAME);
        if (text.length > 0 && !calledTelegram) {
          const fallback = `⚠️ Запланированная задача завершилась без действия.\nЦель: ${goal}\nОтвет агента: ${text}`;
          log.warn(
            { goal, reply: text, toolsUsed },
            `goal "${truncate(goal)}" produced text but did not call ${TELEGRAM_TOOL_NAME}; forwarding to Telegram`,
          );
          try {
            await telegram.send(fallback);
            log.info({ goal }, `goal "${truncate(goal)}" Telegram fallback sent`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ goal, err }, `goal "${truncate(goal)}" Telegram fallback failed: ${msg}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error({ goal, err }, `goal "${truncate(goal)}" failed: ${msg}`);
        throw err;
      }
    },
  };
}
