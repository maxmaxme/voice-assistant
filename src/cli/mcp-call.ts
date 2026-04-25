import { loadConfig } from '../config.ts';
import { HaMcpClient } from '../mcp/haMcpClient.ts';

function usage(): never {
  console.error('Usage:');
  console.error('  mcp-call list');
  console.error('  mcp-call call <toolName> <jsonArgs>');
  console.error('');
  console.error('Examples:');
  console.error('  mcp-call list');
  console.error('  mcp-call call HassTurnOn \'{"name":"Test Lamp"}\'');
  process.exit(2);
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  if (!cmd) usage();

  const cfg = loadConfig();
  const client = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
  await client.connect();
  try {
    if (cmd === 'list') {
      const tools = await client.listTools();
      for (const t of tools) {
        console.log(`- ${t.name}: ${t.description}`);
      }
    } else if (cmd === 'call') {
      const [name, jsonArgs = '{}'] = rest;
      if (!name) usage();
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(jsonArgs);
      } catch {
        console.error(`Invalid JSON args: ${jsonArgs}`);
        process.exit(2);
      }
      const result = await client.callTool(name, args);
      console.log(JSON.stringify(result, null, 2));
      if (result.isError) process.exit(1);
    } else {
      usage();
    }
  } finally {
    await client.disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
