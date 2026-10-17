# Development

Conventions (no build step, `.ts` imports, the adapter pattern, the prompt registry, the DB-backed config model) are documented in [CLAUDE.md](../CLAUDE.md).

## 🛠️ Commands

```bash
npm run start                        # the single entry point
npm run typecheck                    # tsc --noEmit
npm test                             # vitest run
npm run lint                         # eslint
npm run format                       # prettier --write .

npm run mcp:call -- list             # list HA's MCP tools (needs HA installed)
npm run mcp:call -- call HassTurnOn '{"name":"Kitchen Light"}'

npm run db:generate                  # Drizzle migration (voice-assistant owns the schema)
```

User and device management (`npm run users -- …`) is covered in [configuration.md](configuration.md#-users-auth--memory).

## 🧪 Tests

```bash
npm test                       # unit tests
RUN_INTEGRATION=1 npm test     # also runs the MCP test against a live HA on :8123
npm run typecheck
```
