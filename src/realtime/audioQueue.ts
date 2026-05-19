/**
 * Push-based async iterable for streaming PCM chunks into a player.
 * Producer calls push(buf) for each audio.delta event; consumer drives
 * the iterator. end() resolves any pending wait so the player can flush.
 */
type ChunkResult = IteratorResult<Buffer, undefined>;

export class AudioChunkQueue implements AsyncIterable<Buffer, undefined> {
  private readonly buffer: Buffer[] = [];
  private waiter: ((v: ChunkResult) => void) | null = null;
  private ended = false;

  push(chunk: Buffer): void {
    if (this.ended) {
      return;
    }
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: chunk, done: false });
      return;
    }
    this.buffer.push(chunk);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer, undefined> {
    return {
      next: (): Promise<ChunkResult> => {
        const next = this.buffer.shift();
        if (next !== undefined) {
          return Promise.resolve({ value: next, done: false });
        }
        if (this.ended) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<ChunkResult>((resolve) => {
          this.waiter = resolve;
        });
      },
    };
  }
}
