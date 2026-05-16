import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.ts';
import type {
  AccountInfo,
  MeterReading,
  Status,
  SubmissionRow,
  SubmissionsStore,
} from './types.ts';

interface DbRow {
  portal: string;
  period: string;
  status: Status;
  attempts: number;
  submitted_values: string | null;
  account_info: string | null;
  last_error: string | null;
  last_attempt_at: number | null;
  submitted_at: number | null;
  notified_window_closed: number;
}

function parseValues(json: string | null): MeterReading[] | null {
  if (!json) {
    return null;
  }
  return JSON.parse(json);
}

function parseInfo(json: string | null): AccountInfo | null {
  if (!json) {
    return null;
  }
  return JSON.parse(json);
}

function deserialize(row: DbRow): SubmissionRow {
  return {
    portal: row.portal,
    period: row.period,
    status: row.status,
    attempts: row.attempts,
    submittedValues: parseValues(row.submitted_values),
    accountInfo: parseInfo(row.account_info),
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
    submittedAt: row.submitted_at,
    notifiedWindowClosed: row.notified_window_closed === 1,
  };
}

export function openSubmissionsStore(path: string): SubmissionsStore {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  // Apply migrations idempotently (the file is created with a single v1 migration).
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='submissions'")
    .get();
  if (!tableExists) {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  }

  const selectStmt = db.prepare<{ portal: string; period: string }, DbRow>(
    'SELECT * FROM submissions WHERE portal = @portal AND period = @period',
  );
  const insertStmt = db.prepare<{ portal: string; period: string }>(
    `INSERT INTO submissions (portal, period) VALUES (@portal, @period)
     ON CONFLICT DO NOTHING`,
  );
  const lastValueStmt = db.prepare<{ portal: string }, { submitted_values: string | null }>(
    `SELECT submitted_values FROM submissions
     WHERE portal = @portal AND status = 'done'
     ORDER BY submitted_at DESC`,
  );

  function row(portal: string, period: string): SubmissionRow {
    const r = selectStmt.get({ portal, period });
    if (!r) {
      throw new Error(`submissions row not found after upsert: ${portal} ${period}`);
    }
    return deserialize(r);
  }

  return {
    getOrCreate(portal, period) {
      insertStmt.run({ portal, period });
      return row(portal, period);
    },
    markPending(portal, period) {
      db.prepare(`UPDATE submissions SET status = 'pending' WHERE portal = ? AND period = ?`).run(
        portal,
        period,
      );
    },
    markDone(portal, period, values, info) {
      db.prepare(
        `UPDATE submissions
         SET status = 'done',
             submitted_values = ?,
             account_info = ?,
             submitted_at = ?,
             last_attempt_at = ?
         WHERE portal = ? AND period = ?`,
      ).run(JSON.stringify(values), JSON.stringify(info), Date.now(), Date.now(), portal, period);
    },
    markFailed(portal, period, error) {
      db.prepare(
        `UPDATE submissions
         SET status = 'failed',
             attempts = attempts + 1,
             last_error = ?,
             last_attempt_at = ?
         WHERE portal = ? AND period = ?`,
      ).run(error, Date.now(), portal, period);
    },
    markBlocked(portal, period) {
      db.prepare(`UPDATE submissions SET status = 'blocked' WHERE portal = ? AND period = ?`).run(
        portal,
        period,
      );
    },
    markWindowClosedNotified(portal, period) {
      db.prepare(
        `UPDATE submissions SET notified_window_closed = 1 WHERE portal = ? AND period = ?`,
      ).run(portal, period);
    },
    lastSubmittedValueFor(portal, meter) {
      for (const r of lastValueStmt.iterate({ portal })) {
        const values = parseValues(r.submitted_values) ?? [];
        const hit = values.find((v) => v.meter === meter);
        if (hit) {
          return hit.value;
        }
      }
      return null;
    },
    close() {
      db.close();
    },
  };
}
