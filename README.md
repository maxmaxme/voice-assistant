<div align="center">

# 🎙️ voice-assistant

**A self-hosted, voice-first personal assistant for your smart home.**

Talk to your house through a [Home Assistant Voice PE](https://www.home-assistant.io/voice-pe/) speaker, an iOS Shortcut, or Telegram — one agent core, powered by OpenAI, configured from a web panel, running on a Raspberry Pi.

[![CI](https://github.com/maxmaxme/voice-assistant/actions/workflows/ci.yml/badge.svg)](https://github.com/maxmaxme/voice-assistant/actions/workflows/ci.yml)
[![License: AGPL v3](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A524-43853d?logo=node.js&logoColor=white)](package.json)
[![Container](https://img.shields.io/badge/ghcr.io-voice--assistant-2496ED?logo=docker&logoColor=white)](https://github.com/maxmaxme/voice-assistant/pkgs/container/voice-assistant)

</div>

---

`voice-assistant` is the server side of a private smart-home assistant. It brokers between the people talking to it (speaker, phone, chat), the language model that understands them ([OpenAI](https://openai.com/)), and the home that acts on it ([Home Assistant](https://www.home-assistant.io/)). Everything that used to be an environment variable — API keys, models, which channels run, who's allowed in — now lives in a SQLite database and is edited from a **web config panel**. `.env` carries nothing but process knobs.

> **Works without Home Assistant.** No HA? It's still a capable chat assistant with memory, weather, and reminders — HA just adds device control.

## 🧭 Architecture

```mermaid
flowchart LR
    PE["🔊 Voice PE speaker"]
    PV["🎙️ pipecat-voice<br/>OpenAI Realtime"
    HTTP["🌐 HTTP · :3000<br/>/text /audio /assist"]
    TG["💬 Telegram"]

    PE -- "WS /voice" --> PV
    PV -- "/mcp · tools, prompt, config" --> CORE
    HTTP --> CORE
    TG --> CORE

    CORE["🧠 Agent core<br/>tools · memory · scheduler"]
    CORE --> OAI["OpenAI<br/>STT · LLM · TTS"]
    CORE -- "MCP tools" --> HA["🏠 Home Assistant<br/>(optional)"]
    CORE --> DB[("🗄️ SQLite<br/>memory · users · config")]

    WEB["⚙️ Web panel · web/"] -. "edits" .-> DB
```

- **Voice PE — the primary voice path.** The [Home Assistant Voice PE](https://www.home-assistant.io/voice-pe/) speaker streams PCM16 audio both ways over a WebSocket into an OpenAI **Realtime** session — STT, the LLM, and TTS all happen in that one bidirectional stream. HA is reached only as an MCP tool backend here. (Firmware: [`home-assistant-voice-pe`](https://github.com/maxmaxme/home-assistant-voice-pe).)
- **HTTP** — `/text` + `/audio` for iOS-Shortcuts-style clients, and `/assist` for the Home Assistant Assist bridge (via [`ha-http-conversation-agent`](https://github.com/maxmaxme/ha-http-conversation-agent)).
- **Telegram** — text, voice, and photos into the same core.

## ✨ Features

- 🏠 **Smart-home control in plain language** across all three channels, sharing one agent core — or a standalone chat assistant when HA is absent
- ⚙️ **Configured from a web panel** ([`web/`](web/)), DB-backed, no env edits: integrations (OpenAI / HA / Telegram), tool gates, editable prompts, users & devices, per-channel toggles — applied on the next restart
- 🧠 **Long-term memory** in SQLite (`remember` / `recall` / `forget`) with a shared `household` scope and per-principal `personal` scopes
- ⏰ **Scheduled actions** — one-shot (wall-clock) or recurring (cron) goals, fired through a goal-mode agent
- 🙋 **`ask` tool** — clarifying questions reopen the HA Assist mic via `continue_conversation`, no new wake word
- 🔐 **DB-backed auth** — per-channel identities (Telegram chat / HTTP token / voice device token); raw tokens are never stored, only their hash
- 🚀 **Hands-off updates** — CI publishes an arm64 image to GHCR; the host stack pulls and restarts with healthcheck-gated rollback

## 📦 Requirements

- **Node.js 24+** — native TypeScript stripping, **no build step**
- **An [OpenAI API key](https://platform.openai.com/api-keys)** — entered in the web panel (mandatory)
- _Optional:_ a **Home Assistant** instance with the [MCP Server integration](https://www.home-assistant.io/integrations/mcp_server/), for device control

## 🚀 Quick start

```bash
# 1. Install (no native audio modules — plain install)
npm install

# 2. .env — process/infra knobs only; everything else has sane defaults
cp .env.example .env

# 3. Configure in the web panel (web/): install & enable the OpenAI integration
#    (mandatory), plus Home Assistant / Telegram if you want them.
#    See web/README.md.

# 4. Register yourself so a channel will admit you (see docs/configuration.md)
npm run users -- add-user --name me

# 5. Run — one process; each channel self-gates from the panel config
npm run start
```

On a fresh database the app **fails fast** until the OpenAI integration is installed and enabled. Which channels then come up is decided by panel config, not a flag — Telegram (integration + toggle), HTTP endpoints (their toggles), Voice PE / realtime (its toggle). There is no `AGENT_MODE`.

## 🚢 Deployment

CI builds the root `Dockerfile` and publishes `ghcr.io/maxmaxme/voice-assistant:latest` on every push to `main`. Host-side compose, systemd units, healthchecks and monitoring live in a separate (private) `home-infra` repo — not this repo's concern.

## 📚 Docs

|                                             |                                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| ⚙️ Configuration, channels & auth           | [docs/configuration.md](docs/configuration.md)                                                                             |
| 🛠️ Development: commands & tests            | [docs/development.md](docs/development.md)                                                                                 |
| 🏠 Home Assistant setup                     | [docs/home-assistant-setup.md](docs/home-assistant-setup.md)                                                               |
| 📱 iPhone Shortcuts                         | [docs/iphone-shortcuts.md](docs/iphone-shortcuts.md)                                                                       |
| 🖥️ Web config panel                         | [web/README.md](web/README.md)                                                                                             |
| 🧱 Architecture (for contributors / agents) | [CLAUDE.md](CLAUDE.md)                                                                                                     |
| 📐 Design spec                              | [docs/superpowers/specs/2026-04-25-voice-assistant-design.md](docs/superpowers/specs/2026-04-25-voice-assistant-design.md) |
| 🗺️ Roadmap                                  | [docs/superpowers/roadmap.md](docs/superpowers/roadmap.md)                                                                 |

## 🤝 Contributing

A personal project, but issues and PRs are welcome. Conventions are documented in [CLAUDE.md](CLAUDE.md), commands in [docs/development.md](docs/development.md) — please skim them first. `npm run typecheck && npm test && npm run lint` should be green before a PR.

## 📄 License

Copyright © 2026 maxmaxme.

Licensed under the **GNU Affero General Public License v3.0 or later** ([AGPL-3.0-or-later](LICENSE)). Use, study, modify, and self-host it freely — but any modified version you distribute **or run as a network service** must also be released under the AGPL, source and all. No warranty.
