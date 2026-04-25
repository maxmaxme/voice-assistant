# Iteration 1: MCP Client Against Home Assistant Mock — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Node.js CLI that connects to a Home Assistant MCP server running locally in Docker, lists exposed tools, and successfully calls one (e.g. `HassTurnOn` for a mock light). No voice yet, no LLM yet — just proving the MCP transport, auth, and tool-calling loop.

**Architecture:** Single TypeScript module behind an `McpClient` adapter interface. The adapter wraps `@modelcontextprotocol/sdk` Streamable HTTP transport with Bearer-token auth. CLI entry point reads target tool name + JSON args from argv. HA runs in Docker with one mock `input_boolean` entity exposed to Assist.

**Tech Stack:** Node.js 20 LTS, TypeScript, `tsx` (dev runner), `vitest` (tests), `@modelcontextprotocol/sdk`, Home Assistant in Docker.

---

## File Structure

```
voice-assistant/
├── src/
│   ├── config.ts             # load env vars, validate
│   ├── mcp/
│   │   ├── types.ts          # McpClient interface + domain types
│   │   └── haMcpClient.ts    # adapter: @modelcontextprotocol/sdk → McpClient
│   └── cli/
│       └── mcp-call.ts       # CLI entry: list tools or call one
├── tests/
│   └── mcp/
│       ├── haMcpClient.unit.test.ts   # unit, mocked transport
│       └── haMcpClient.integration.test.ts  # against real HA, gated by env
├── docker/
│   ├── docker-compose.yml
│   └── homeassistant/
│       └── configuration.yaml
├── docs/
│   └── home-assistant-setup.md   # one-time manual steps for HA
├── .env.example
├── .gitignore                    # already exists
├── package.json                  # already exists, will extend
├── tsconfig.json
└── vitest.config.ts
```

**Responsibility split:**

- `src/mcp/types.ts` — pure types/interfaces, no runtime code. The contract.
- `src/mcp/haMcpClient.ts` — only place that imports `@modelcontextprotocol/sdk`. Replaceable.
- `src/config.ts` — only place that reads `process.env`. Validates on startup.
- `src/cli/mcp-call.ts` — composition root for this iteration. Wires config + adapter.

---

## Task 1: Project tooling — TypeScript, Vitest, scripts

**Files:**

- Modify: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `src/.gitkeep`, `tests/.gitkeep`

- [x] **Step 1: Install dependencies**

```bash
cd /Users/mlepekha/Developer/voice-assistant
npm install --save-dev typescript tsx vitest @types/node
npm install @modelcontextprotocol/sdk dotenv zod
```

- [x] **Step 1b: Verify MCP SDK import paths up-front**

The SDK's subpath exports change between releases. Confirm the two paths used in Task 4 actually exist in the version that just got installed:

```bash
node -e "console.log(Object.keys(require('@modelcontextprotocol/sdk/package.json').exports || {}))"
ls node_modules/@modelcontextprotocol/sdk/dist/esm/client/
```

Expected: the `exports` listing includes `./client/index.js` and `./client/streamableHttp.js` (or equivalent). If the layout differs, update the import lines in Task 4 Step 3 before writing the file. **Do not skip this** — getting it wrong wastes the rest of Task 4.

- [x] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [x] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [x] **Step 4: Update `package.json`**

Replace the contents of `package.json` with:

```json
{
  "name": "voice-assistant",
  "version": "0.1.0",
  "description": "Voice assistant for smart home control via Home Assistant MCP",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx",
    "test": "vitest run",
    "test:watch": "vitest",
    "mcp:call": "tsx src/cli/mcp-call.ts"
  },
  "license": "ISC"
}
```

Note: switching from `commonjs` to `type: module`. The original `package.json` was empty boilerplate. ESM is the path forward and the MCP SDK ships ESM-first.

- [x] **Step 5: Create empty source dirs**

```bash
mkdir -p src/mcp src/cli tests/mcp
touch src/.gitkeep tests/.gitkeep
```

- [x] **Step 6: Verify toolchain works**

```bash
npx tsc --noEmit
npx vitest run
```

Expected: `tsc` exits 0. `vitest` exits 0 with "No test files found" — that's fine, tests come next.

- [x] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts src tests
git commit -m "chore: bootstrap TypeScript + Vitest toolchain"
```

---

## Task 2: Config loader

**Files:**

- Create: `src/config.ts`
- Create: `.env.example`
- Test: `tests/config.test.ts`

- [x] **Step 1: Write failing test**

Create `tests/config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.HA_URL;
    delete process.env.HA_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns config when both HA_URL and HA_TOKEN are set', () => {
    process.env.HA_URL = 'http://localhost:8123';
    process.env.HA_TOKEN = 'tok_abc';
    const cfg = loadConfig();
    expect(cfg.ha.url).toBe('http://localhost:8123');
    expect(cfg.ha.token).toBe('tok_abc');
  });

  it('throws when HA_URL is missing', () => {
    process.env.HA_TOKEN = 'tok_abc';
    expect(() => loadConfig()).toThrow(/HA_URL/);
  });

  it('throws when HA_TOKEN is missing', () => {
    process.env.HA_URL = 'http://localhost:8123';
    expect(() => loadConfig()).toThrow(/HA_TOKEN/);
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/config.test.ts
```

Expected: FAIL — module `../src/config.js` not found.

- [x] **Step 3: Implement `src/config.ts`**

```ts
import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  ha: z.object({
    url: z.string().url(),
    token: z.string().min(1),
  }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(): Config {
  const raw = {
    ha: {
      url: process.env.HA_URL,
      token: process.env.HA_TOKEN,
    },
  };
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid config (${fields}): ${parsed.error.message}`);
  }
  return parsed.data;
}
```

- [x] **Step 4: Create `.env.example`**

```
# Home Assistant MCP
HA_URL=http://localhost:8123
HA_TOKEN=replace_with_long_lived_access_token
```

- [x] **Step 5: Run tests**

```bash
npx vitest run tests/config.test.ts
```

Expected: 3 passed.

- [x] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts .env.example
git commit -m "feat(config): add env-based config loader with zod validation"
```

---

## Task 3: McpClient interface (the contract)

**Files:**

- Create: `src/mcp/types.ts`

- [x] **Step 1: Define the interface**

Create `src/mcp/types.ts`:

```ts
export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  isError: boolean;
  content: Array<{ type: string; text?: string }>;
}

export interface McpClient {
  connect(): Promise<void>;
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult>;
  disconnect(): Promise<void>;
}
```

No runtime code, no test needed — this file is pure types and will be exercised by every subsequent task. If it breaks, those tasks fail.

- [x] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [x] **Step 3: Commit**

```bash
git add src/mcp/types.ts
git commit -m "feat(mcp): add McpClient interface and types"
```

---

## Task 4: HA MCP client adapter — unit-tested skeleton

**Files:**

- Create: `src/mcp/haMcpClient.ts`
- Test: `tests/mcp/haMcpClient.unit.test.ts`

The strategy: the adapter takes a transport factory in its constructor, so unit tests inject a fake transport. This avoids needing a running HA for unit tests.

- [x] **Step 1: Write failing test**

Create `tests/mcp/haMcpClient.unit.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { HaMcpClient } from '../../src/mcp/haMcpClient.js';

function makeFakeSdkClient() {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'HassTurnOn',
          description: 'Turn on an entity',
          inputSchema: { type: 'object' },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      isError: false,
      content: [{ type: 'text', text: 'ok' }],
    }),
  };
}

describe('HaMcpClient', () => {
  it('connect() delegates to the underlying SDK client', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk as never,
    });
    await client.connect();
    expect(sdk.connect).toHaveBeenCalledOnce();
  });

  it('listTools() returns mapped tools', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk as never,
    });
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('HassTurnOn');
  });

  it('callTool() returns mapped result', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk as never,
    });
    await client.connect();
    const result = await client.callTool('HassTurnOn', { entity_id: 'light.x' });
    expect(result.isError).toBe(false);
    expect(sdk.callTool).toHaveBeenCalledWith({
      name: 'HassTurnOn',
      arguments: { entity_id: 'light.x' },
    });
  });

  it('disconnect() closes the SDK client', async () => {
    const sdk = makeFakeSdkClient();
    const client = new HaMcpClient({
      url: 'http://h:8123',
      token: 't',
      sdkClientFactory: () => sdk as never,
    });
    await client.connect();
    await client.disconnect();
    expect(sdk.close).toHaveBeenCalledOnce();
  });
});
```

- [x] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/mcp/haMcpClient.unit.test.ts
```

Expected: FAIL — `HaMcpClient` not exported.

- [x] **Step 3: Implement `src/mcp/haMcpClient.ts`**

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpClient, McpTool, McpToolResult } from './types.js';

interface SdkLike {
  connect: (transport?: unknown) => Promise<void>;
  close: () => Promise<void>;
  listTools: () => Promise<{ tools: McpTool[] }>;
  callTool: (req: { name: string; arguments: Record<string, unknown> }) => Promise<McpToolResult>;
}

export interface HaMcpClientOptions {
  url: string;
  token: string;
  /** For tests: inject a fake SDK client. Defaults to the real one. */
  sdkClientFactory?: (opts: { url: string; token: string }) => SdkLike;
}

function defaultSdkClientFactory({ url, token }: { url: string; token: string }): SdkLike {
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/api/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${token}` },
    },
  });
  const client = new Client({ name: 'voice-assistant', version: '0.1.0' }, { capabilities: {} });
  return {
    connect: () => client.connect(transport),
    close: () => client.close(),
    listTools: () => client.listTools() as Promise<{ tools: McpTool[] }>,
    callTool: (req) => client.callTool(req) as Promise<McpToolResult>,
  };
}

export class HaMcpClient implements McpClient {
  private sdk: SdkLike;

  constructor(opts: HaMcpClientOptions) {
    const factory = opts.sdkClientFactory ?? defaultSdkClientFactory;
    this.sdk = factory({ url: opts.url, token: opts.token });
  }

  async connect(): Promise<void> {
    await this.sdk.connect();
  }

  async listTools(): Promise<McpTool[]> {
    const res = await this.sdk.listTools();
    return res.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    return this.sdk.callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    await this.sdk.close();
  }
}
```

- [x] **Step 4: Run tests**

```bash
npx vitest run tests/mcp/haMcpClient.unit.test.ts
```

Expected: 4 passed.

- [x] **Step 5: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0. If `streamableHttp.js` import path is wrong on the installed SDK version, fix the import path now (check `node_modules/@modelcontextprotocol/sdk/dist/esm/client/`).

- [x] **Step 6: Commit**

```bash
git add src/mcp/haMcpClient.ts tests/mcp/haMcpClient.unit.test.ts
git commit -m "feat(mcp): add HaMcpClient adapter over @modelcontextprotocol/sdk"
```

---

## Task 5: Home Assistant in Docker

**Files:**

- Create: `docker/docker-compose.yml`
- Create: `docker/homeassistant/configuration.yaml`
- Create: `docs/home-assistant-setup.md`
- Modify: `.gitignore`

- [x] **Step 1: Create `docker/docker-compose.yml`**

```yaml
services:
  homeassistant:
    image: ghcr.io/home-assistant/home-assistant:stable
    container_name: voice-assistant-ha
    volumes:
      - ./homeassistant:/config
      - /etc/localtime:/etc/localtime:ro
    restart: unless-stopped
    ports:
      - '8123:8123'
```

- [x] **Step 2: Create `docker/homeassistant/configuration.yaml`**

```yaml
default_config:

# Mock device for MCP testing
input_boolean:
  test_lamp:
    name: Test Lamp
    icon: mdi:lightbulb

# Allow Docker bridge network IPs to reach the API
http:
  use_x_forwarded_for: true
  trusted_proxies:
    - 172.16.0.0/12
    - 192.168.0.0/16
```

- [x] **Step 3: Update `.gitignore`**

Append to existing `.gitignore`:

```
# Home Assistant runtime data
docker/homeassistant/.storage/
docker/homeassistant/.cloud/
docker/homeassistant/home-assistant*.log*
docker/homeassistant/home-assistant_v2.db*
docker/homeassistant/deps/
docker/homeassistant/tts/
docker/homeassistant/.HA_VERSION
```

- [x] **Step 4: Create `docs/home-assistant-setup.md`**

```markdown
# Home Assistant Setup (one-time, manual)

These steps are needed once on each dev machine. They produce a running HA
instance with the MCP Server enabled and a Long-Lived Access Token for the
Node.js client.

## 1. Start HA

\`\`\`bash
cd docker
docker compose up -d
\`\`\`

Wait ~60 seconds, then open http://localhost:8123. Complete the onboarding
wizard (create your owner user; everything else can be skipped).

## 2. Expose the test entity to Assist

1. Settings → Voice assistants → Expose
2. Toggle ON `input_boolean.test_lamp`
3. Save

## 3. Enable the MCP Server integration

1. Settings → Devices & Services → Add Integration
2. Search for "Model Context Protocol Server"
3. Add it (uses default LLM hass API)

## 4. Create a Long-Lived Access Token

1. Click your user avatar (bottom-left) → Security tab
2. Bottom of page: "Long-lived access tokens" → Create token
3. Name it "voice-assistant-dev"
4. Copy the token (you only see it once)

## 5. Wire up the project

\`\`\`bash
cp .env.example .env
\`\`\`

Edit `.env`:

\`\`\`
HA_URL=http://localhost:8123
HA_TOKEN=<paste your token>
\`\`\`

## Verify

\`\`\`bash
npm run mcp:call -- list
\`\`\`

You should see a list of tools including `HassTurnOn`, `HassTurnOff`, and others.
```

- [ ] **Step 5: Smoke-test the docker setup** (skipped in this run — Docker may not be installed; HA onboarding cannot be automated)

```bash
cd docker && docker compose up -d
sleep 60
curl -s http://localhost:8123 | head -c 200
docker compose down
cd ..
```

Expected: curl returns HTML containing `<title>Home Assistant</title>` or similar. If timeouts, increase the sleep or check `docker compose logs homeassistant`.

- [x] **Step 6: Commit**

```bash
git add docker/docker-compose.yml docker/homeassistant/configuration.yaml docs/home-assistant-setup.md .gitignore
git commit -m "chore(ha): add Docker Compose for Home Assistant + setup docs"
```

---

## Task 6: CLI entry point

**Files:**

- Create: `src/cli/mcp-call.ts`

This task has no automated tests — it's a thin composition over already-tested modules, and its real test is the integration test in Task 7.

- [x] **Step 1: Implement `src/cli/mcp-call.ts`**

```ts
import { loadConfig } from '../config.js';
import { HaMcpClient } from '../mcp/haMcpClient.js';

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
```

- [x] **Step 2: Verify type-check**

```bash
npx tsc --noEmit
```

Expected: exits 0.

- [x] **Step 3: Smoke-run with bad config**

```bash
HA_URL= HA_TOKEN= npm run mcp:call -- list
```

Expected: exits non-zero with config validation error mentioning `ha.url` or `ha.token`.

- [x] **Step 4: Commit**

```bash
git add src/cli/mcp-call.ts
git commit -m "feat(cli): add mcp-call CLI for listing tools and invoking them"
```

---

## Task 7: Integration test against real HA

**Files:**

- Test: `tests/mcp/haMcpClient.integration.test.ts`

Gated behind an env var so it doesn't run in normal `npm test`. Engineer runs it manually after completing the HA setup in `docs/home-assistant-setup.md`.

- [x] **Step 1: Write the integration test**

```ts
import { describe, it, expect } from 'vitest';
import { HaMcpClient } from '../../src/mcp/haMcpClient.js';
import { loadConfig } from '../../src/config.js';

const RUN = process.env.RUN_INTEGRATION === '1';

describe.runIf(RUN)('HaMcpClient (integration)', () => {
  it('connects, lists tools, and toggles the test lamp', async () => {
    const cfg = loadConfig();
    const client = new HaMcpClient({ url: cfg.ha.url, token: cfg.ha.token });
    await client.connect();
    try {
      const tools = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const hasTurnOn = tools.some((t) => t.name === 'HassTurnOn');
      expect(hasTurnOn).toBe(true);

      const onResult = await client.callTool('HassTurnOn', { name: 'Test Lamp' });
      expect(onResult.isError).toBe(false);

      const offResult = await client.callTool('HassTurnOff', { name: 'Test Lamp' });
      expect(offResult.isError).toBe(false);
    } finally {
      await client.disconnect();
    }
  }, 30_000);
});
```

- [x] **Step 2: Run unit tests still pass**

```bash
npx vitest run
```

Expected: all unit tests pass; integration test is skipped (no `RUN_INTEGRATION=1`).

- [ ] **Step 3: Manual integration run** (skipped — no live HA available in this run)

Prerequisites: completed `docs/home-assistant-setup.md`, `.env` populated, `docker compose up -d` is running.

```bash
RUN_INTEGRATION=1 npx vitest run tests/mcp/haMcpClient.integration.test.ts
```

Expected: 1 passed. If it fails:

- 401 → token wrong or revoked
- 404 → MCP Server integration not added in HA UI
- Tool `HassTurnOn` missing → `input_boolean.test_lamp` not exposed to Assist
- Tool runs but lamp state didn't change → check Settings → Voice assistants → Expose

- [ ] **Step 4: Manual CLI verification** (skipped — no live HA available in this run)

```bash
npm run mcp:call -- list
npm run mcp:call -- call HassTurnOn '{"name":"Test Lamp"}'
```

Open http://localhost:8123 → check that `Test Lamp` shows ON.

```bash
npm run mcp:call -- call HassTurnOff '{"name":"Test Lamp"}'
```

Check it shows OFF.

- [x] **Step 5: Commit**

```bash
git add tests/mcp/haMcpClient.integration.test.ts
git commit -m "test(mcp): add gated integration test against real HA"
```

---

## Task 8: README pointer

**Files:**

- Create: `README.md`

- [x] **Step 1: Create minimal `README.md`**

```markdown
# voice-assistant

Voice assistant for smart home control. Targets Raspberry Pi runtime,
developed on macOS. Cloud-heavy stack (OpenAI STT/TTS), Home Assistant
via MCP for device control.

## Status

Iteration 1 in progress: MCP client against Home Assistant in Docker.

## Docs

- Spec: [docs/superpowers/specs/2026-04-25-voice-assistant-design.md](docs/superpowers/specs/2026-04-25-voice-assistant-design.md)
- Iteration 1 plan: [docs/superpowers/plans/2026-04-25-iteration-1-mcp-client.md](docs/superpowers/plans/2026-04-25-iteration-1-mcp-client.md)
- HA setup: [docs/home-assistant-setup.md](docs/home-assistant-setup.md)

## Quick start (after HA setup is done)

\`\`\`bash
npm install
cp .env.example .env # then fill HA_URL and HA_TOKEN
docker compose -f docker/docker-compose.yml up -d
npm run mcp:call -- list
\`\`\`

## Tests

\`\`\`bash
npm test # unit tests only
RUN_INTEGRATION=1 npm test # plus integration tests against running HA
\`\`\`
```

- [x] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README with iteration 1 quick start"
```

---

## Definition of done for Iteration 1

- `npm test` exits 0 with all unit tests passing.
- With HA running and `.env` populated, `npm run mcp:call -- list` prints HA tools.
- `npm run mcp:call -- call HassTurnOn '{"name":"Test Lamp"}'` toggles the lamp visible in HA UI.
- Integration test passes with `RUN_INTEGRATION=1`.

## What's next (Iteration 2 — separate plan)

Wrap the MCP client in an LLM-driven agent: text in → LLM with tool-calling → MCP calls → text out. Still no voice. That's the next plan document.
