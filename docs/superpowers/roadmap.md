# Roadmap

Ideas and feature requests discussed during development and intentionally
deferred for later. Not a plan — more of a "backlog" for future iterations.

When we get to it, we'll pick one item, implement it, turn it into a spec
and plan. Not all items are equally important and not all will become separate
iterations: some are just a few lines of code, others require rewriting an entire module.

Grouped by topic, not by priority.

---

## ✅ Done

### Streaming TTS

`gpt-4o-mini-tts` supports streaming PCM. Currently we wait for the full
buffer, then play. With streaming, we start playing ~300ms after send instead
of 2–3 seconds. Saves 1–3 seconds of round-trip on long responses.

### Custom Russian wake-word

Currently we catch built-in English keywords from openWakeWord (`hey_jarvis`,
`alexa`, ...). A custom Russian word (e.g. «Алиса», «Слушай», «Эй друг») can be
trained via the openWakeWord notebook in Colab in ~1 hour. We get an `.onnx` file,
place it in `models/`, and switch `WAKE_WORD_KEYWORD`.

**Status:** ✅ Project set up. `WAKE_WORD_KEYWORD` env supports a path to a custom
`.onnx` file. `models/` is in .gitignore. To use: train a model via openWakeWord-notebook,
place it in `models/`, set `WAKE_WORD_KEYWORD=path/to/model.onnx`.

### Reliability & observability — HTTP /health endpoint

Currently healthcheck in Docker runs `pgrep` on processes — weak. Better to have
an HTTP `/health` endpoint in the app that checks: MCP connection alive, wake-daemon
alive, OpenAI API key valid (lazy ping every N minutes).

**Status:** Basic `/health` endpoint implemented in HTTP runner (returns `{ status: 'ok' }`).
Without full component checks (TODO).

### Reliability — Structured tool-call logging

Currently in REPL and voice-loop logs only the final assistant text is visible.
Hidden tool calls (what exactly the agent called, with what args, what it got back)
are not visible. Add structured logging: "agent called X with {...}, got Y". Helps
a lot with prompt debugging.

**Status:** ✅ Implemented in `src/agent/openaiAgent.ts` (lines 193–198).
Logs `{ tool: name, args, isError }` with call and result text.

### DevX & extensibility — Richer HA mock environment

For testing group commands ("turn off all lights", "turn on kitchen lights") we need
more mocks in `docker/homeassistant/configuration.yaml`: multiple `light.*` via
template entities, `switch.*`, `sensor.*`, areas (Kitchen/Bedroom/Living Room).
Currently just one `input_boolean.test_lamp`, not enough test scenarios.

**Status:** Enriched to 3 light entities, 1 switch, 1 input_number. Areas not added.

---

## 📋 TODO

## Audio & Voice

### Acoustic Echo Cancellation (AEC)

When the assistant speaks through speakers, its voice leaks back into the mic.
That's why we disabled follow-up listening by default — the assistant would start
talking to itself. With AEC we could safely re-enable follow-up and always-listen
during speaking. Options: WebRTC AEC via `webrtc-audio-processing`, Speex AEC, or
system PipeWire `module-echo-cancel` on Pi (no code). 4–6 hours.

### Multiple wake-words

Currently one keyword at a time. openWakeWord can load multiple models simultaneously.
Useful for a home: "Алиса" for me, "Окей дом" for guests, plus separate "Стоп"
keyword as hardware-level emergency.

### Settle delay after TTS

Right after `speaker.stop()` the tail of speech sometimes lingers in the air and
VAD catches it as user speech. Add 200–300 ms "mute window" before opening capture
in follow-up.

### Streaming LLM responses

`chat.completions.create({stream: true})` — tokens arrive as they're generated.
Can combine with streaming TTS: speak the first sentence while the second is being
generated. Serious UX win.

### OpenAI Realtime API (alternative to the whole stack)

Single websocket instead of separate STT + LLM + TTS. Server-side VAD, turn detection,
barge-in out of the box. Latency ~300–500ms end-to-end instead of current 3–5 seconds.
Downsides: more expensive (~$30/month of active dialogue), architectural rework of half
the code. Alternative path, not a complement.

---

## Memory

### Memory Level 2 — episodic

Past conversations: "remember when we talked about…?" Implementation: summarize the
dialogue with the LLM at session end + embed the summary + vector search via
`sqlite-vss` or `sqlite-vec` (same `assistant.db` as the profile). Need an
`episodic-memory` module with the same `MemoryAdapter` interface. Don't build this
until the user notices the assistant asking the same thing twice.

### Memory Level 3 — learned habits

"Every weekday at 7:30 they ask for the weather" → the assistant starts offering it
proactively. Boils down to two simpler things:

- **Voice automation creation**: user says "when I say sleep, turn off lights and set
  thermostat to 19" → agent creates an HA automation. Basically export to HA.
- **Suggestions**: cron weekly, LLM scans dialogue logs and proposes "want me to do
  this automatically?"

ROI is questionable; many such scenarios the user solves better themselves.

---

## Reliability & observability

### Subprocess lifecycle hardening

If wake-daemon (Python) dies on its own, Node won't notice — `feed()` silently no-ops,
wake-events stop arriving. Add SIGCHLD watching and auto-restart with backoff.
Similarly for other subprocesses (mic, speaker, MCP client).

### MCP listTools() caching

Currently `mcp.listTools()` is called on every user turn — round-trip to HA. Tools
in HA change rarely. Cache for 5 minutes or invalidate on HA events. Small optimization.

---

## DevX & extensibility

### System prompt outside code

Currently system prompt is hardcoded in `systemPrompt.ts`. As the prompt grows and
evolves, extract it to `prompts/base.md`, `prompts/voice.md`, `prompts/chat.md`.
Optional hot-reload.

### Config in YAML/JSON instead of .env

`.env` doesn't fit hierarchical settings (multiple keywords, multiple scenarios,
multiple voices). Switch to `config.yaml` with the same zod schemas for validation,
keep `.env` for secrets only.

### `--once` mode for voice/chat REPL

Currently `printf '...' | npm run chat` runs once and hangs waiting for EOF.
Explicit `--once` mode — for testing and scripting.

### Auto-aliases for HA entities

When a device "Test Lamp" is added, the agent should match "lamp", "lampbulb", "light".
Currently have to do it manually via WS `config/entity_registry/update`. Build a helper
script `scripts/add-aliases.ts` that reads a CSV map of entity_id → [aliases] and
updates HA in one command.

---

## Advanced features

### Speaker recognition (voiceprint)

If the assistant is in a shared room with guests, it currently responds to anyone
after wake-word. With voiceprint we could listen only to the owner. Picovoice Eagle,
Resemblyzer, or openWakeWord's own verifier model. Separate module before STT that
checks "is this Maxim's voice?". ~3–4 hours.

### Hardware button (Pi GPIO)

Alternative to wake-word (or complement): physical button on Pi case, press → start
recording, release → stop. No ML, 100% reliable, zero false positives. Via `onoff`
or `pigpio` in Node. Can combine: "normally wake-word, but if echo-loop suspected,
fall back to button-only".

### Mic mute during speaking

Alternative "poor person's AEC": don't feed mic frames to VAD/wake while the assistant
speaks. Simple solution, but kills barge-in entirely. Option `BARGE_IN=false` in .env
for users without headphones who're tired of self-loops.

---

## Platform support

### macOS deployment artifacts

Currently Docker deploy is tested only on `linux/arm64` (Pi 5). If someone wants to
run the assistant 24/7 on Mac mini, they'll want a LaunchAgent plist analogous to
the systemd unit.

### Graphical client

Web-UI to view dialogue history, device status, edit memory profile, debug. Not needed
for main UX (voice is the primary interface), but handy for administration.

---

## Misc

### Regression: "device not found" with verb case

In one session the agent said "couldn't find device 'лампа'" even though the same
phrase worked 5 minutes before. Possibly memory or history trim interfered.
Reproduce and fix.

### Integration tests on CI

Currently integration test (`RUN_INTEGRATION=1`) runs manually only and requires a
live HA instance. On CI we can spin up HA in Docker in the pipeline. Adds confidence
during refactoring.
