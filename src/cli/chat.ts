// Thin shim — the implementation lives in src/cli/unified.ts. Kept so
// `npm run chat` and any external invocations keep working.
process.env.AGENT_MODE = 'chat';
const { main } = await import('./unified.ts');
await main();
