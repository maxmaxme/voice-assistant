export type ProfileFacts = Record<string, unknown>;

export interface MemoryAdapter {
  remember(key: string, value: unknown): void;
  recall(key?: string): ProfileFacts;
  forget(key: string): void;
  close(): void;
}
