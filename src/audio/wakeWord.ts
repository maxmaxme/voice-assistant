import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';
import { createLogger } from '../utils/logger.ts';

const log = createLogger('wake');

export interface WakeWord {
  /** Frame length in samples that should be fed via feed(). */
  readonly frameLength: number;
  /** Audio sample rate the wake-word expects (Hz). */
  readonly sampleRate: number;
  start(): Promise<void>;
  feed(frame: Int16Array): void;
  onWake(cb: (keyword: string, score: number) => void): void;
  stop(): Promise<void>;
}

export interface OpenWakeWordOptions {
  /** Python interpreter path — usually `.venv/bin/python` */
  pythonPath: string;
  /** Path to scripts/wake_word_daemon.py */
  scriptPath: string;
  /** openwakeword model name, e.g. "hey_jarvis" */
  keyword: string;
  /** Detection threshold 0..1 (default 0.5) */
  threshold?: number;
  /** Print per-frame diagnostics from the daemon to stderr (default false) */
  debug?: boolean;
  /** Inject a custom spawn for tests */
  spawnFn?: typeof spawn;
}

const FRAME_LENGTH = 1280;
const SAMPLE_RATE = 16_000;

export class OpenWakeWord implements WakeWord {
  readonly frameLength = FRAME_LENGTH;
  readonly sampleRate = SAMPLE_RATE;
  private proc: ChildProcess | null = null;
  private cb: (keyword: string, score: number) => void = () => {};
  private ready = false;
  private readyResolve: (() => void) | null = null;
  private readonly opts: OpenWakeWordOptions;

  constructor(opts: OpenWakeWordOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const args = [
      this.opts.scriptPath,
      '--keyword',
      this.opts.keyword,
      '--threshold',
      String(this.opts.threshold ?? 0.5),
    ];
    if (this.opts.debug) {
      args.push('--debug');
    }
    const spawnFn = this.opts.spawnFn ?? spawn;
    this.proc = spawnFn(this.opts.pythonPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (!this.proc.stdout) {
      throw new Error('wake-word daemon has no stdout');
    }
    // Forward daemon stderr through pino, line by line, so model-load
    // errors and --debug diagnostics are visible alongside the rest of our
    // structured logs. We split chunks so pretty-output doesn't get one big
    // multi-line record and JSON-output stays one record per line. Buffer
    // partial lines across chunks (Python prints with newlines but TCP /
    // pipes can split mid-line).
    let pending = '';
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        if (line.length === 0) {
          continue;
        }
        log.info(line);
      }
    });
    this.proc.stderr?.on('end', () => {
      if (pending.length > 0) {
        log.info(pending);
        pending = '';
      }
    });
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let evt: { type?: string; keyword?: string; score?: number };
      try {
        evt = JSON.parse(line);
      } catch {
        return;
      }
      if (evt.type === 'ready') {
        this.ready = true;
        this.readyResolve?.();
      } else if (evt.type === 'wake' && evt.keyword) {
        this.cb(evt.keyword, evt.score ?? 0);
      }
    });

    this.proc.on('exit', () => {
      if (!this.ready) {
        // Surface startup failures as a rejected ready promise.
        this.readyResolve?.();
      }
      this.proc = null;
    });

    await new Promise<void>((resolve) => {
      if (this.ready) {
        resolve();
      } else {
        this.readyResolve = resolve;
      }
    });
    if (!this.ready) {
      throw new Error('wake-word daemon failed to start (see stderr)');
    }
  }

  feed(frame: Int16Array): void {
    if (!this.proc || !this.proc.stdin || frame.length !== FRAME_LENGTH) {
      return;
    }
    const buf = Buffer.alloc(FRAME_LENGTH * 2);
    for (let i = 0; i < FRAME_LENGTH; i++) {
      buf.writeInt16LE(frame[i], i * 2);
    }
    this.proc.stdin.write(buf);
  }

  onWake(cb: (keyword: string, score: number) => void): void {
    this.cb = cb;
  }

  async stop(): Promise<void> {
    if (!this.proc) {
      return;
    }
    this.proc.stdin?.end();
    this.proc.kill('SIGTERM');
    this.proc = null;
  }
}
