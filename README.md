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

```bash
npm install
cp .env.example .env  # then fill HA_URL and HA_TOKEN
docker compose -f docker/docker-compose.yml up -d
npm run mcp:call -- list
```

## Tests

```bash
npm test                       # unit tests only
RUN_INTEGRATION=1 npm test     # plus integration tests against running HA
```
