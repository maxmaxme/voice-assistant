export type DueItem =
  | { kind: 'reminder'; id: number; text: string; fireAt: number }
  | { kind: 'timer'; id: number; label: string; fireAt: number; durationMs: number };

export interface FireSink {
  fire(item: DueItem): Promise<void>;
}
