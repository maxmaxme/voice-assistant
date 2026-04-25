# Home Assistant Setup (one-time, manual)

These steps are needed once on each dev machine. They produce a running HA
instance with the MCP Server enabled and a Long-Lived Access Token for the
Node.js client.

## 1. Start HA

```bash
cd docker
docker compose up -d
```

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

```bash
cp .env.example .env
```

Edit `.env`:

```
HA_URL=http://localhost:8123
HA_TOKEN=<paste your token>
```

## Verify

```bash
npm run mcp:call -- list
```

You should see a list of tools including `HassTurnOn`, `HassTurnOff`, and others.
