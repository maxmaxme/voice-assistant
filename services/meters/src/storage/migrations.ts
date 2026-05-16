export const MIGRATIONS: string[] = [
  `
  CREATE TABLE submissions (
    portal TEXT NOT NULL,
    period TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    submitted_values TEXT,
    account_info TEXT,
    last_error TEXT,
    last_attempt_at INTEGER,
    submitted_at INTEGER,
    notified_window_closed INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (portal, period)
  );
  CREATE INDEX idx_submissions_status ON submissions(status);
  `,
];
