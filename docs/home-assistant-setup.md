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

## 2. Enable the MCP Server integration

1. Settings → Devices & Services → Add Integration
2. Search for **Model Context Protocol Server** (pick "Server", not "Client")
3. Submit (uses the default LLM hass API)

## 3. Create a Long-Lived Access Token

1. Click your user avatar (bottom-left) → **Security** tab
2. Scroll to "Long-lived access tokens" → **Create Token**
3. Name it `voice-assistant-dev`
4. Copy the token (it's only shown once)

## 4. Wire up the project

```bash
cp .env.example .env
```

Edit `.env`:

```
HA_URL=http://localhost:8123
HA_TOKEN=<paste your token>
```

## 5. Expose the test entity to Assist

> **Why this is needed.** In Home Assistant, every entity has an internal
> "expose to voice assistant" flag, **off by default**. Any assistant
> (built-in Assist, Alexa, our MCP client) only sees entities with this
> flag on. Without it, MCP tool calls fail with
> `MatchFailedError(... no_match_reason=ASSISTANT)` — the entity exists,
> but the assistant isn't allowed to see it.

### Option A — UI (try this first)

1. Settings → **Voice assistants** → tab **Expose**
2. Click **Expose Entity** → check `input_boolean.test_lamp` → Submit

The tab only appears once a Voice pipeline exists. Onboarding usually
creates one; if it didn't, the WS fallback below works regardless.

### Option B — WebSocket fallback (if the UI doesn't stick)

The UI in HA 2026.x sometimes silently fails to persist the flag (config
files end up out of sync between `core.entity_registry` and
`homeassistant.exposed_entities`, and MCP keeps refusing the entity).
The canonical, reliable way is the WebSocket service
`homeassistant/expose_entity`:

```bash
docker exec -e TOKEN="$(grep '^HA_TOKEN=' .env | cut -d= -f2-)" \
  voice-assistant-ha python3 -c '
import asyncio, json, os, aiohttp

async def go():
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect("http://localhost:8123/api/websocket") as ws:
            await ws.receive_json()  # auth_required
            await ws.send_json({"type":"auth","access_token":os.environ["TOKEN"]})
            await ws.receive_json()  # auth_ok
            await ws.send_json({
                "id": 1,
                "type": "homeassistant/expose_entity",
                "assistants": ["conversation"],
                "entity_ids": ["input_boolean.test_lamp"],
                "should_expose": True,
            })
            print(await ws.receive_json())

asyncio.run(go())
'
```

Expected output: `{'id': 1, 'type': 'result', 'success': True, ...}`.

To expose more entities later, repeat with a different `entity_ids` list.

### Auto-expose every new entity

HA has a per-assistant **global** flag (not per-domain): once on, every
new entity created after that moment is automatically exposed to the
assistant. Existing entities keep their current expose state.

UI: Settings → Voice assistants → pick the pipeline → "Expose entities"
section → toggle **Expose new entities**.

WebSocket equivalent (set / read):

```bash
docker exec -e TOKEN="$(grep '^HA_TOKEN=' .env | cut -d= -f2-)" \
  voice-assistant-ha python3 -c '
import asyncio, os, aiohttp
async def go():
    async with aiohttp.ClientSession() as s:
        async with s.ws_connect("http://localhost:8123/api/websocket") as ws:
            await ws.receive_json()
            await ws.send_json({"type":"auth","access_token":os.environ["TOKEN"]})
            await ws.receive_json()
            await ws.send_json({"id":1,"type":"homeassistant/expose_new_entities/set",
                                "assistant":"conversation","expose_new":True})
            print(await ws.receive_json())
asyncio.run(go())
'
```

**Recommendation.** For dev with mock entities — turn it on, saves
clicks. For real homes with locks, cameras, covers — leave it off and
expose each device explicitly. There is no per-domain whitelist: it's
all-or-nothing per assistant.

## 6. Verify

```bash
npm run mcp:call -- list
npm run mcp:call -- call HassTurnOn '{"name":"Test Lamp"}'
```

The first command lists HA's MCP tools (`HassTurnOn`, `HassTurnOff`,
`GetLiveContext`, etc.). The second one toggles the lamp — open
http://localhost:8123 and confirm `Test Lamp` shows ON.

Then run the integration test:

```bash
RUN_INTEGRATION=1 npm test
```

Expected: 1 integration test passes (turns the lamp on, then off).

## Troubleshooting

- **`MatchFailedReason.ASSISTANT`** — entity not exposed; redo step 5.
- **`404 Not Found` on POST to `/api/mcp`** — MCP Server integration
  not added; redo step 2. Confirm with
  `curl -s -H "Authorization: Bearer $TOKEN" http://localhost:8123/api/config | grep -o mcp_server`.
- **`401 Unauthorized`** — wrong/expired token; redo step 3.
- **HA UI keeps logging me out** — token age limit; create a fresh LLAT.
