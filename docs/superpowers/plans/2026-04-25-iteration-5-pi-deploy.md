# Iteration 5: Raspberry Pi Deployment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the voice assistant to a Raspberry Pi 4 or 5 (64-bit Raspberry Pi OS Bookworm) as a systemd service. Audio works via ALSA. The Pi runs the assistant; Home Assistant runs anywhere reachable on the LAN.

**Architecture:** No new code paths — only packaging, deployment artifacts, and an ARM-compatibility audit of native modules. The same Node.js application from Iteration 4 runs on the Pi.

**Tech Stack:** Raspberry Pi OS 64-bit, Node.js 20 LTS, systemd, ALSA, USB microphone + USB speaker (or 3.5mm + DAC).

**Prerequisite:** Iteration 4 complete and tested on macOS.

---

## File Structure

```
deploy/
├── voice-assistant.service       # systemd unit
├── install.sh                    # bootstrap on a fresh Pi
└── uninstall.sh
docs/
└── raspberry-pi-setup.md         # one-time host setup instructions
```

No application code changes are expected. If any are needed (compatibility shims), they go in their existing modules.

---

## Task 1: ARM compatibility audit

Goal: confirm every native module has prebuilt Linux arm64 binaries, document any source-build fallbacks.

- [ ] **Step 1: List native deps**

Run on macOS:

```bash
npm ls --omit=dev --parseable | xargs -I{} sh -c 'test -d "{}/build" || test -f "{}/binding.gyp" && echo "{}"' 2>/dev/null
```

Expected to surface: `better-sqlite3`, `speaker`, `mic`, `@picovoice/porcupine-node`. The `mic` package is pure JS — it shells out to `arecord` on Linux.

- [ ] **Step 2: Confirm prebuilt arm64 binaries exist**

For each package, check:

- `better-sqlite3`: ships prebuilds via `prebuild-install`. arm64 supported since v9.
- `speaker`: prebuilds via `prebuild-install`. arm64 supported.
- `@picovoice/porcupine-node`: ships native binaries for `linux-arm64` inside the package.

Verify in `node_modules` after install on the Pi (Task 2 step 5). If any package falls back to compile, the Pi will need `build-essential` and `python3` — covered by `install.sh`.

- [ ] **Step 3: Document the audit in the deploy doc** (created in Task 4)

Nothing to commit yet — this is research.

---

## Task 2: systemd unit

**Files:**
- Create: `deploy/voice-assistant.service`

- [ ] **Step 1: Create the unit file**

```ini
[Unit]
Description=Voice Assistant
After=network-online.target sound.target
Wants=network-online.target

[Service]
Type=simple
User=pi
Group=pi
WorkingDirectory=/opt/voice-assistant
EnvironmentFile=/opt/voice-assistant/.env
ExecStart=/usr/bin/node --enable-source-maps /opt/voice-assistant/dist/cli/run.js
Restart=on-failure
RestartSec=5

# Hardening
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=yes
ReadWritePaths=/opt/voice-assistant/data
PrivateTmp=yes

# Audio access
SupplementaryGroups=audio

# Resource caps
MemoryMax=512M

[Install]
WantedBy=multi-user.target
```

Note: runs the **compiled** `dist/cli/run.js`, not `tsx src/...`. Production-style.

- [ ] **Step 2: Add a build step**

Verify `package.json` has a `build` script (it does, from Iteration 1: `"build": "tsc"`). Add a `start:prod` script:

```json
"start:prod": "node --enable-source-maps dist/cli/run.js"
```

- [ ] **Step 3: Confirm `tsc` produces runnable output**

```bash
npm run build
node dist/cli/run.js --help 2>&1 || true
```

Expected: a build error or successful runtime startup-then-config-failure (not a TS path issue). If TS produces files but `import './foo.js'` paths break at runtime, fix imports — they should already include `.js` (we set `module: NodeNext`).

- [ ] **Step 4: Commit**

```bash
git add deploy/voice-assistant.service package.json
git commit -m "chore(deploy): add systemd unit and prod start script"
```

---

## Task 3: install / uninstall scripts

**Files:**
- Create: `deploy/install.sh`
- Create: `deploy/uninstall.sh`

These are run on the Pi as a one-time bootstrap.

- [ ] **Step 1: Create `deploy/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/voice-assistant
SERVICE_NAME=voice-assistant
REPO_URL="${REPO_URL:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# 1. System packages
apt-get update
apt-get install -y \
  nodejs npm \
  build-essential python3 \
  alsa-utils libasound2-dev \
  sox libsox-fmt-all \
  git

# 2. App user (pi already exists on Raspberry Pi OS)
mkdir -p "$APP_DIR"
chown -R pi:pi "$APP_DIR"

# 3. Pull or update sources
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u pi git -C "$APP_DIR" pull
elif [[ -n "$REPO_URL" ]]; then
  sudo -u pi git clone "$REPO_URL" "$APP_DIR"
else
  echo "REPO_URL not set and $APP_DIR is not a git checkout."
  echo "Either set REPO_URL or rsync sources to $APP_DIR before running."
  exit 1
fi

# 4. Install deps and build
sudo -u pi bash -c "cd $APP_DIR && npm ci && npm run build"

# 5. .env
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u pi cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Created $APP_DIR/.env from example. Edit it before starting the service."
fi

# 6. data dir
sudo -u pi mkdir -p "$APP_DIR/data"

# 7. systemd
install -m 644 "$APP_DIR/deploy/voice-assistant.service" "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo
echo "Install complete. Edit $APP_DIR/.env, then run:"
echo "  sudo systemctl start ${SERVICE_NAME}"
echo "  journalctl -u ${SERVICE_NAME} -f"
```

- [ ] **Step 2: Create `deploy/uninstall.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME=voice-assistant
APP_DIR=/opt/voice-assistant

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}" 2>/dev/null || true
rm -f "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

echo "Service removed. App directory $APP_DIR left in place; remove manually if desired."
```

- [ ] **Step 3: Make executable**

```bash
chmod +x deploy/install.sh deploy/uninstall.sh
```

- [ ] **Step 4: Commit**

```bash
git add deploy/install.sh deploy/uninstall.sh
git commit -m "chore(deploy): add install and uninstall scripts"
```

---

## Task 4: Pi setup documentation

**Files:**
- Create: `docs/raspberry-pi-setup.md`

- [ ] **Step 1: Create the doc**

```markdown
# Raspberry Pi Setup

Tested on Raspberry Pi 5 (8GB) and Pi 4 (4GB) with Raspberry Pi OS Bookworm 64-bit.

## Hardware

- USB microphone (e.g. Jabra Speak, ReSpeaker 2-Mic HAT, or any UVC USB mic)
- USB speaker, 3.5mm speakers, or HDMI audio
- Pi 4 minimum; Pi 5 recommended for lower latency

## OS preparation

1. Flash Raspberry Pi OS 64-bit (Bookworm or newer) using Pi Imager. In the imager's
   advanced options, preconfigure: hostname, SSH, Wi-Fi, locale.
2. Boot, SSH in.
3. Update:
   \`\`\`bash
   sudo apt update && sudo apt full-upgrade -y
   sudo reboot
   \`\`\`
4. Install Node.js 20 LTS:
   \`\`\`bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
   node --version  # expect v20.x
   \`\`\`

## Audio

1. Confirm input/output devices:
   \`\`\`bash
   arecord -l   # list capture devices
   aplay -l     # list playback devices
   \`\`\`
2. Test recording (5 seconds):
   \`\`\`bash
   arecord -D plughw:1,0 -d 5 -f S16_LE -r 16000 -c 1 test.wav
   aplay test.wav
   \`\`\`
   If `plughw:1,0` is wrong, find your card/device numbers in the `arecord -l` output.
3. If the wrong device is default, set it in `~/.asoundrc`:
   \`\`\`
   pcm.!default {
     type asym
     playback.pcm "plughw:0,0"
     capture.pcm  "plughw:1,0"
   }
   \`\`\`
4. Add the `pi` user to the `audio` group (usually already is):
   \`\`\`bash
   groups pi | grep audio || sudo usermod -aG audio pi
   \`\`\`

## Install the assistant

1. Copy the project to the Pi (rsync or git clone via the install script).
2. Run:
   \`\`\`bash
   cd /opt/voice-assistant
   sudo deploy/install.sh
   \`\`\`
   If sources are not yet at `/opt/voice-assistant`, rsync first:
   \`\`\`bash
   rsync -av --exclude node_modules --exclude dist --exclude .git \\
     ./ pi@raspberrypi.local:/opt/voice-assistant/
   \`\`\`
   Then re-run `sudo deploy/install.sh` on the Pi.
3. Edit `/opt/voice-assistant/.env`. At minimum, set `HA_URL`, `HA_TOKEN`,
   `OPENAI_API_KEY`, and `PORCUPINE_ACCESS_KEY`.
4. Start:
   \`\`\`bash
   sudo systemctl start voice-assistant
   journalctl -u voice-assistant -f
   \`\`\`

## Troubleshooting

- **No audio captured:** wrong ALSA device. Re-check `arecord -l`. If using
  ReSpeaker, install its driver per Seeed's docs first.
- **Porcupine fails to load native binary:** ensure the package version supports
  `linux-arm64`. Older versions only had `linux-armv7l`.
- **High CPU during idle:** Porcupine alone should be < 5%. If higher, check
  whether `mic` is set to a sample rate other than 16kHz.
- **Service crashes on start:** `journalctl -u voice-assistant --since "5 minutes ago"`
  will show the stack trace. Most often: missing `.env` value or HA unreachable.
- **Latency is bad:** ensure good Wi-Fi (RTT to OpenAI < 60ms ideally).
  Run `ping api.openai.com`. Move the Pi to 5GHz or wired Ethernet.

## Updating

\`\`\`bash
cd /opt/voice-assistant
sudo -u pi git pull
sudo -u pi npm ci
sudo -u pi npm run build
sudo systemctl restart voice-assistant
\`\`\`
```

- [ ] **Step 2: Commit**

```bash
git add docs/raspberry-pi-setup.md
git commit -m "docs: add Raspberry Pi setup guide"
```

---

## Task 5: Live deployment test

This is a manual checklist run on real Pi hardware.

- [ ] **Step 1: Provision Pi**

Follow `docs/raspberry-pi-setup.md` sections "OS preparation" and "Audio".

- [ ] **Step 2: Deploy**

```bash
rsync -av --exclude node_modules --exclude dist --exclude .git ./ pi@raspberrypi.local:/opt/voice-assistant/
ssh pi@raspberrypi.local 'sudo /opt/voice-assistant/deploy/install.sh'
ssh pi@raspberrypi.local 'sudo nano /opt/voice-assistant/.env'   # fill values
ssh pi@raspberrypi.local 'sudo systemctl start voice-assistant'
ssh pi@raspberrypi.local 'journalctl -u voice-assistant -f'
```

- [ ] **Step 3: End-to-end voice test**

Stand near the Pi:
1. Say wake word → "включи лампу" → confirm Test Lamp turns on, hear assistant reply.
2. Wait > 3 minutes silently.
3. Say wake word → "а выключи" → expected behavior depends: idle timeout cleared context,
   so the assistant may ask which device. (This is expected per spec.)
4. Reboot Pi → service auto-starts, voice still works.

- [ ] **Step 4: Resource check**

```bash
ssh pi@raspberrypi.local 'systemctl status voice-assistant'
ssh pi@raspberrypi.local 'top -bn1 | grep -E "node|voice"'
```

Idle: < 100MB RSS, < 5% CPU.
Active turn (during STT/LLM/TTS): brief CPU spike, mostly network-bound.

- [ ] **Step 5: Document the result**

Append a short "Verified deployments" section to `docs/raspberry-pi-setup.md` listing
the model and OS version that worked, with measured latency (round-trip from VAD-end
to first speaker output).

```bash
git add docs/raspberry-pi-setup.md
git commit -m "docs(deploy): record verified Pi deployment"
```

---

## Definition of done

- `sudo systemctl start voice-assistant` brings the service up without errors on a fresh Pi.
- `systemctl status` shows `active (running)` and no flapping.
- Wake-word + voice pipeline works end-to-end on the Pi.
- Service auto-starts on reboot.
- Resource use is within targets (memory < 512MB cap, idle CPU low).
- README or top-level docs link to `docs/raspberry-pi-setup.md`.
