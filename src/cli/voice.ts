// Thin shim — the implementation lives in src/cli/unified.ts. Kept so
// `npm run voice` and any external invocations keep working.
process.env.AGENT_MODE = 'voice';
const { main } = await import('./unified.ts');
await main();
