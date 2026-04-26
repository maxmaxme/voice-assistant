import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { OpenWakeWord } from '../../src/audio/wakeWord.ts';

function fakeProc(scriptedStdout: string[]) {
  const stdout = new Readable({ read() {} });
  const stdin = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  const proc = new EventEmitter() as EventEmitter & {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill: (sig?: string) => void;
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = new Readable({ read() {} });
  proc.kill = () => {};
  // Push scripted lines on next tick so callers have time to attach listeners.
  setImmediate(() => {
    for (const line of scriptedStdout) {
      stdout.push(line + '\n');
    }
  });
  return proc;
}

describe('OpenWakeWord', () => {
  it('resolves start() once the daemon prints ready', async () => {
    const spawnFn = vi.fn(() =>
      fakeProc([JSON.stringify({ type: 'ready', keyword: 'hey_jarvis', threshold: 0.5 })]),
    );
    const ww = new OpenWakeWord({
      pythonPath: '/x/python',
      scriptPath: '/x/script.py',
      keyword: 'hey_jarvis',
      spawnFn: spawnFn as never,
    });
    await ww.start();
    expect(spawnFn).toHaveBeenCalledOnce();
  });

  it('fires onWake when the daemon reports a detection', async () => {
    const spawnFn = vi.fn(() =>
      fakeProc([
        JSON.stringify({ type: 'ready', keyword: 'hey_jarvis', threshold: 0.5 }),
        JSON.stringify({ type: 'wake', keyword: 'hey_jarvis', score: 0.91 }),
      ]),
    );
    const ww = new OpenWakeWord({
      pythonPath: '/x/python',
      scriptPath: '/x/script.py',
      keyword: 'hey_jarvis',
      spawnFn: spawnFn as never,
    });
    const events: Array<[string, number]> = [];
    ww.onWake((k, s) => events.push([k, s]));
    await ww.start();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toEqual([['hey_jarvis', 0.91]]);
  });
});
