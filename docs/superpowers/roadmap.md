# Roadmap

A backlog of ideas, not a plan. Grouped by topic, not priority. When we pick one
up, it becomes a spec + plan.

> **Architecture note.** This project pivoted away from its first generation — a
> Pi-local microphone with a Python wake-daemon (openWakeWord), separate
> STT/LLM/TTS, a REPL, and `.env` config. The current generation is **Voice PE
> speakers streaming to an OpenAI Realtime session**, an **HTTP** channel, and
> **Telegram**, all configured from a **web panel** (DB-backed). Most of the old
> backlog is therefore either shipped or obsolete — see the bottom section.

---

## ✅ Shipped

- **OpenAI Realtime path** — single bidirectional WebSocket (STT + LLM + TTS in
  one session) for Voice PE speakers; supersedes the old separate-stage stack.
- **Web config panel** (`web/`) — graphical admin for integrations, prompts,
  tools, users/devices, and channel toggles. This delivered three old backlog
  items at once: a graphical client, config out of `.env`, and prompts out of
  code (the prompt registry).
- **DB-backed everything** — multi-channel config, per-channel auth identities
  (Telegram chat / HTTP token / per-device voice token), memory scopes.
- **Structured tool-call logging**, **HTTP `/health`**, **scheduled actions**
  (one-shot + cron), and **memory Level 1** (household + personal profile).

---

## 📋 Open ideas

### AI providers & tools

- **Multiple LLM providers** (Anthropic / Gemini) for the chat/Responses path,
  selectable per the OpenAI-integration model — the Realtime path stays
  OpenAI-only (no equivalent elsewhere). Adapter pattern already in place.
- **Tool-providing integrations** — let an integration register agent tools
  (not just config), wired into `buildLocalToolset` when enabled. The
  foundation for the next three.
- **More integrations on top of that**: push notifications (ntfy / Pushover)
  for proactive alerts off the Telegram path; calendar (read/create); email
  (read). Check first whether HA already exposes the capability via MCP — that's
  zero code.

### Memory

- **Level 2 — episodic.** Summarize a dialogue at session end, embed it, vector
  search via `sqlite-vec` over the same DB. Build only once the assistant is
  caught asking the same thing twice.
- **Level 3 — learned habits / voice→HA automation.** "When I say sleep, turn
  off the lights" → the agent writes an HA automation; weekly LLM scan proposes
  automations. ROI questionable.

### Realtime / voice UX

- **Re-enable follow-up turns** once echo cancellation is reliable. Currently
  `kFollowupMs = 0` in the firmware (`home-assistant-voice-pe`) because XMOS AEC
  leaves ~10× speaker→mic leak — a **cross-repo** change (firmware + maybe
  bridge), not this repo alone.
- **Speaker recognition (voiceprint)** so a shared-room speaker responds only to
  known voices. Mostly a firmware/DSP-side concern now.

### Reliability & DevX

- **MCP `listTools()` caching** for the Responses-API path (the realtime bridge
  already caches tool _results_); HA's tool list changes rarely.
- **Integration tests on CI** — spin up HA in Docker in the pipeline so the
  `RUN_INTEGRATION=1` test isn't manual-only.
- **macOS deployment artifacts** — a LaunchAgent plist analogous to the systemd
  unit, for running on a Mac mini instead of the Pi.

---

## 🗄️ Obsolete (first-generation, no longer applicable)

Kept only as a record of what the pivot removed: Pi-local mic + Python
wake-daemon, openWakeWord custom/multiple wake-words, server-side AEC and
mic-mute-while-speaking, settle-delay after TTS, GPIO hardware button, the
`--once` REPL, streaming TTS for the old separate-stage stack, `config.yaml`
(superseded by the DB-backed web panel), and subprocess-lifecycle hardening for
the wake-daemon. The wake word now runs **on the speaker** (`micro_wake_word` on
the ESP32), and DSP/AEC is the XMOS co-processor's job — both live in the
`home-assistant-voice-pe` firmware repo, not here.
