export type Status = 'pending' | 'done' | 'failed' | 'blocked';

export interface MeterReading {
  meter: string;
  kind: string;
  value: number;
}

export interface AccountInfo {
  accountId: string;
  balanceText: string;
}

export interface SubmissionRow {
  portal: string;
  period: string;
  status: Status;
  attempts: number;
  submittedValues: MeterReading[] | null;
  accountInfo: AccountInfo | null;
  lastError: string | null;
  lastAttemptAt: number | null;
  submittedAt: number | null;
  notifiedWindowClosed: boolean;
}

export interface SubmissionsStore {
  getOrCreate(portal: string, period: string): SubmissionRow;
  markPending(portal: string, period: string): void;
  markDone(portal: string, period: string, values: MeterReading[], info: AccountInfo): void;
  markFailed(portal: string, period: string, error: string): void;
  markBlocked(portal: string, period: string): void;
  markWindowClosedNotified(portal: string, period: string): void;
  lastSubmittedValueFor(portal: string, meter: string): number | null;
  close(): void;
}
