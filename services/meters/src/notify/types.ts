import type { AccountInfo } from '../storage/types.ts';

export interface Notifier {
  success(input: {
    portal: string;
    period: string;
    meterCount: number;
    info: AccountInfo | null;
  }): Promise<void>;
  failure(input: {
    portal: string;
    period: string;
    attempt: number;
    maxAttempts: number;
    error: string;
    screenshotPath: string | null;
  }): Promise<void>;
  windowClosed(input: { portal: string; period: string }): Promise<void>;
}
