// Thin shim — the implementation lives in src/cli/unified.ts. Kept so
// `npm run start` and any external invocations keep working.
process.env.AGENT_MODE = 'wake';
await import('./unified.ts');
