export interface OffsetStore {
  /** Returns the current offset, or 0 when absent. */
  read(): number;
  /** Persists a new offset. Monotonic — values <= current are ignored. */
  write(value: number): void;
}
