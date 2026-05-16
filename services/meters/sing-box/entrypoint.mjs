#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

// parseVlessUrl is bundled as .mjs (stripped from TS).
const { parseVlessUrl } = await import('/parseVlessUrl.mjs');

const url = process.env.RU_PROXY_URL;
if (!url) {
  console.error('RU_PROXY_URL env var is required');
  process.exit(1);
}

let config;
try {
  config = parseVlessUrl(url);
} catch (err) {
  console.error('Failed to parse RU_PROXY_URL:', err.message);
  process.exit(1);
}

const configPath = '/tmp/sb.json';
writeFileSync(configPath, JSON.stringify(config, null, 2));
console.log(`sing-box config written to ${configPath}`);

const child = spawn('/usr/local/bin/sing-box', ['run', '-c', configPath], {
  stdio: 'inherit',
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
