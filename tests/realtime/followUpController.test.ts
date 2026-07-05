import { describe, it, expect, vi, afterEach } from 'vitest';
import { FollowUpController } from '../../src/realtime/followUpController.ts';
import { captureLogs } from '../helpers/captureLogs.ts';

afterEach(() => {
  vi.useRealTimers();
});

describe('FollowUpController window request', () => {
  it('takeWindowRequest consumes the deferred request exactly once', () => {
    const c = new FollowUpController('sess1');
    c.requestWindow();
    expect(c.takeWindowRequest()).toBe(true);
    expect(c.takeWindowRequest()).toBe(false);
  });

  it('cancelWindowRequest drops a pending request (new turn supersedes it)', () => {
    const c = new FollowUpController('sess1');
    c.requestWindow();
    c.cancelWindowRequest();
    expect(c.takeWindowRequest()).toBe(false);
  });
});

describe('FollowUpController retry budget', () => {
  it('allows exactly one retry per armed follow-up', () => {
    const c = new FollowUpController('sess1');
    c.armPending();
    expect(c.tryRetry()).toBe(true);
    expect(c.tryRetry()).toBe(false);
  });

  it('tryRetry arms pending so the retried response is checked too', () => {
    const c = new FollowUpController('sess1');
    expect(c.isPending()).toBe(false);
    c.tryRetry();
    expect(c.isPending()).toBe(true);
  });

  it('armPending refreshes the retry budget for the next tool batch', () => {
    const c = new FollowUpController('sess1');
    c.armPending();
    c.tryRetry();
    c.armPending();
    expect(c.tryRetry()).toBe(true);
  });

  it('clearPending settles the turn without touching the retry budget', () => {
    const c = new FollowUpController('sess1');
    c.armPending();
    c.clearPending();
    expect(c.isPending()).toBe(false);
    // A later empty response is not a loss — but the budget itself is intact.
    expect(c.tryRetry()).toBe(true);
  });

  it('reset clears everything (upstream session died)', () => {
    const c = new FollowUpController('sess1');
    c.armPending();
    c.requestWindow();
    c.tryRetry();
    c.reset();
    expect(c.isPending()).toBe(false);
    expect(c.takeWindowRequest()).toBe(false);
    expect(c.tryRetry()).toBe(true);
  });
});

describe('FollowUpController watchdog', () => {
  it('logs an expiry line when the user never responds', () => {
    vi.useFakeTimers();
    const c = new FollowUpController('sess1');
    const logs = captureLogs();
    try {
      c.armWatchdog();
      vi.advanceTimersByTime(12_001);
      expect(logs.text()).toMatch(/request_follow_up window expired — user did not respond/);
    } finally {
      logs.restore();
    }
  });

  it('logs the response latency and cancels the expiry when the user speaks', () => {
    vi.useFakeTimers();
    const c = new FollowUpController('sess1');
    const logs = captureLogs();
    try {
      c.armWatchdog();
      vi.advanceTimersByTime(3_000);
      c.noteUserSpeech();
      expect(logs.text()).toMatch(/request_follow_up — user responded after 3000ms/);
      vi.advanceTimersByTime(20_000);
      expect(logs.text()).not.toMatch(/window expired/);
    } finally {
      logs.restore();
    }
  });

  it('noteUserSpeech is a no-op when no window is pending', () => {
    const c = new FollowUpController('sess1');
    const logs = captureLogs();
    try {
      c.noteUserSpeech();
      expect(logs.text()).toBe('');
    } finally {
      logs.restore();
    }
  });

  it('clearWatchdog silences the expiry log', () => {
    vi.useFakeTimers();
    const c = new FollowUpController('sess1');
    const logs = captureLogs();
    try {
      c.armWatchdog();
      c.clearWatchdog();
      vi.advanceTimersByTime(20_000);
      expect(logs.text()).toBe('');
    } finally {
      logs.restore();
    }
  });
});
