# Iteration 5: Raspberry Pi Deployment (Docker) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the voice assistant to a Raspberry Pi 5 (8GB, Raspberry Pi OS Bookworm 64-bit) as a Docker container managed by `docker compose`. Audio works via ALSA passthrough. Home Assistant runs anywhere reachable on the LAN.

**Architecture:** No application code changes — only packaging artifacts. The container runs Node.js 24 directly against the TypeScript sources using Node's native type stripping; there is no `tsc` build step and no `dist/` directory.

**Tech Stack:** Raspberry Pi OS 64-bit, Docker + docker compose, Node.js 24 LTS (inside container), ALSA passthrough, USB microphone + USB speaker (or 3.5mm).

**Prerequisite:** Iteration 4 complete and tested on macOS. `package.json` scripts run `.ts` directly via `node` (no `tsx`, no `tsc`).

---

## Why Docker, not systemd

The Pi host stays clean: only `docker` and `docker compose` are installed. No NodeSource repo, no `build-essential`, no system-wide Node.js, no `npm` cache piling up under `/root` or `/home/pi`. Updates are a single `docker compose up -d --build`. Removal is `docker compose down && docker volume rm`.

## Why Node 24, not 20

Node 24 (and 23.6+) ships native TypeScript type stripping as a stable feature: `node src/cli/run.ts` works without flags. This eliminates the `tsc` build step, the `dist/` directory, and `tsx` as a dev dependency. The same command runs in dev (on macOS) and in prod (in the container on the Pi).

Caveat: type stripping does not transform enums, namespaces, or experimental decorators. The project uses none of these. NodeNext modules with explicit `.js` imports continue to work — the runtime ignores the `.js`/`.ts` distinction once types are stripped.

---

## File Structure

```
deploy/
├── Dockerfile                   # single-stage: node:24-bookworm-slim + native deps
├── docker-compose.yml           # service, /dev/snd passthrough, audio gid, volumes
├── .dockerignore
├── install.sh                   # installs docker on a fresh Pi, brings up the stack
└── uninstall.sh
docs/
└── raspberry-pi-setup.md        # one-time host setup + audio verification
```

No application code changes. No `dist/`. No `build` script.

---

## Task 1: ARM compatibility audit (inside the container)

Goal: confirm every native module builds or has prebuilds for `linux/arm64`, and that the container image runs on Pi 5.

- [ ] **Step 1: List native deps**

```bash
npm ls --omit=dev --parseable | xargs -I{} sh -c 'test -f "{}/binding.gyp" && echo "{}"' 2>/dev/null
```

Expected: `better-sqlite3`, `speaker`, `@picovoice/porcupine-node`. The `mic` package is pure JS — it shells out to `arecord` (provided inside the container via `alsa-utils`).

- [ ] **Step 2: Confirm prebuilt arm64 binaries**

- `better-sqlite3` v12: ships `prebuild-install`, arm64 supported.
- `speaker` v0.5: prebuilds via `prebuild-install`, arm64 supported.
- `@picovoice/porcupine-node`: ships `linux-arm64` native binary in-package.

If a prebuild is missing, the Dockerfile installs `build-essential python3` to allow source compilation. Image size cost is paid once.

- [ ] **Step 3: Verify no non-TS runtime assets are loaded by path**

```bash
grep -rE "\b(readFileSync|readdirSync|loadFile)\b" src/
```

Each hit must read a path passed in by the caller (env var, CLI arg) — not a sibling file colocated with the source. Since we run `.ts` directly, there is no `src/` vs `dist/` divergence to worry about.

Wake-word models (`models/*.ppn`, `*.onnx`) are loaded from a path resolved relative to the project root. They will be `COPY`-ed into the image (Task 2).

- [ ] **Step 4: Verify Node 24 runs the entry points**

On macOS, locally:

```bash
node --version          # expect v24.x
node src/cli/run.ts --help 2>&1 || true
```

Should not error on `.ts` syntax. If it does, the local Node is older than 24 — `nvm use 24` first.

Nothing to commit yet.

---

## Task 2: Dockerfile

**Files:**
- Create: `deploy/Dockerfile`
- Create: `deploy/.dockerignore`

- [ ] **Step 1: Create `deploy/.dockerignore`**

```
node_modules
dist
.git
.env
.env.*
!.env.example
*.log
.vscode
.idea
data
docs/superpowers
```

- [ ] **Step 2: Create `deploy/Dockerfile`**

```dockerfile
# syntax=docker/dockerfile:1.7
FROM node:24-bookworm-slim

# Native module build deps + ALSA runtime + arecord (used by `mic`)
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 \
      libasound2 alsa-utils \
      ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first — better layer cache
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App sources (TS, models, configs)
COPY src ./src
COPY models ./models
COPY tsconfig.json ./

# Persistent state lives on a host-mounted volume; create the mountpoint.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

# Run TS directly via Node 24's native type stripping. No tsc, no tsx.
CMD ["node", "src/cli/run.ts"]
```

Notes:
- `node:24-bookworm-slim` is multi-arch — pulled as `linux/arm64` automatically on Pi 5.
- `USER node` runs unprivileged; the audio gid is granted via compose `group_add`.
- We ship `build-essential` and `python3` only because some prebuilds may be missing for arm64 on first install. If image size becomes a concern, switch to multi-stage with a builder stage. Not worth it for a single-host deployment.

- [ ] **Step 3: Commit**

```bash
git add deploy/Dockerfile deploy/.dockerignore
git commit -m "chore(deploy): add Dockerfile for Pi (Node 24, no build step)"
```

---

## Task 3: docker-compose.yml + install / uninstall

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/install.sh`
- Create: `deploy/uninstall.sh`

- [ ] **Step 1: Create `deploy/docker-compose.yml`**

```yaml
services:
  voice-assistant:
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    container_name: voice-assistant
    restart: unless-stopped
    devices:
      - /dev/snd:/dev/snd
    group_add:
      - "${AUDIO_GID:-29}"
    env_file:
      - ../.env
    volumes:
      - ../data:/app/data
    # ALSA device selection — override in .env if your mic is not card 1.
    environment:
      - ALSA_CARD=${ALSA_CARD:-1}
    stop_grace_period: 10s
    healthcheck:
      test: ["CMD", "pgrep", "-f", "src/cli/run.ts"]
      interval: 30s
      timeout: 5s
      retries: 3
```

The `AUDIO_GID` is the host's `audio` group gid (29 on Bookworm). `install.sh` resolves and exports it.

- [ ] **Step 2: Create `deploy/install.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/voice-assistant
REPO_URL="${REPO_URL:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# 1. Docker (official convenience script — fine for a single Pi)
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# 2. Allow the pi user to run docker without sudo
usermod -aG docker pi || true

# 3. App directory
mkdir -p "$APP_DIR"
chown -R pi:pi "$APP_DIR"

# 4. Pull or update sources
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u pi git -C "$APP_DIR" pull
elif [[ -n "$REPO_URL" ]]; then
  sudo -u pi git clone "$REPO_URL" "$APP_DIR"
else
  echo "REPO_URL not set and $APP_DIR is not a git checkout."
  echo "Either set REPO_URL or rsync sources to $APP_DIR before running."
  exit 1
fi

# 5. .env
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u pi cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Created $APP_DIR/.env from example. Edit it before starting the service."
fi

# 6. Resolve audio gid and persist it for compose
AUDIO_GID=$(getent group audio | cut -d: -f3)
if ! grep -q '^AUDIO_GID=' "$APP_DIR/.env"; then
  echo "AUDIO_GID=${AUDIO_GID}" | sudo -u pi tee -a "$APP_DIR/.env" >/dev/null
fi

# 7. data dir
sudo -u pi mkdir -p "$APP_DIR/data"

# 8. Build and start
cd "$APP_DIR/deploy"
sudo -u pi docker compose build
sudo -u pi docker compose up -d

echo
echo "Service is starting. Tail logs with:"
echo "  cd $APP_DIR/deploy && docker compose logs -f"
```

- [ ] **Step 3: Create `deploy/uninstall.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/voice-assistant

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

if [[ -d "$APP_DIR/deploy" ]]; then
  cd "$APP_DIR/deploy"
  sudo -u pi docker compose down -v || true
fi

echo "Container removed. Sources at $APP_DIR and Docker itself are left in place."
```

- [ ] **Step 4: Make executable and commit**

```bash
chmod +x deploy/install.sh deploy/uninstall.sh
git add deploy/docker-compose.yml deploy/install.sh deploy/uninstall.sh
git commit -m "chore(deploy): add docker compose + install scripts"
```

---

## Task 4: Pi setup documentation

**Files:**
- Create: `docs/raspberry-pi-setup.md`

- [ ] **Step 1: Create the doc**

```markdown
# Raspberry Pi Setup (Docker)

Tested on Raspberry Pi 5 (8GB) with Raspberry Pi OS Bookworm 64-bit.

## Hardware

- USB microphone (e.g. Jabra Speak, ReSpeaker, or any UVC USB mic)
- USB speaker, 3.5mm speakers, or HDMI audio
- Pi 5 / 8GB recommended

## OS preparation

1. Flash Raspberry Pi OS 64-bit (Bookworm or newer) using Pi Imager. Preconfigure
   hostname, SSH, Wi-Fi, locale in advanced options.
2. Boot, SSH in.
3. Update:
   \`\`\`bash
   sudo apt update && sudo apt full-upgrade -y
   sudo reboot
   \`\`\`

That is the entire host setup. Docker is installed by `deploy/install.sh`. No
Node.js, no build tools on the host.

## Audio (verify on host before starting the container)

1. Confirm input/output devices:
   \`\`\`bash
   arecord -l   # list capture devices, note the card number for your USB mic
   aplay -l     # list playback devices
   \`\`\`
2. Test recording (5 seconds):
   \`\`\`bash
   arecord -D plughw:1,0 -d 5 -f S16_LE -r 16000 -c 1 test.wav
   aplay test.wav
   \`\`\`
3. Note the card number — set `ALSA_CARD` in `.env` if it is not 1.
4. The `pi` user is in the `audio` group by default. Verify:
   \`\`\`bash
   groups pi | grep audio
   \`\`\`

## Install the assistant

Option A — clone on the Pi:

\`\`\`bash
sudo REPO_URL=git@your-host:voice-assistant.git \\
  bash -c 'curl -fsSL https://your-host/install.sh | bash'
\`\`\`

Option B — rsync from your laptop, then run install:

\`\`\`bash
rsync -av --exclude node_modules --exclude data --exclude .git \\
  ./ pi@raspberrypi.local:/opt/voice-assistant/
ssh pi@raspberrypi.local 'sudo /opt/voice-assistant/deploy/install.sh'
\`\`\`

Then on the Pi:

1. Edit `/opt/voice-assistant/.env`. At minimum set `HA_URL`, `HA_TOKEN`,
   `OPENAI_API_KEY`, `PORCUPINE_ACCESS_KEY`. If your mic is not on card 1, set
   `ALSA_CARD=<n>`.
2. Apply changes:
   \`\`\`bash
   cd /opt/voice-assistant/deploy
   docker compose up -d
   docker compose logs -f
   \`\`\`

## Updating

\`\`\`bash
cd /opt/voice-assistant
git pull
cd deploy
docker compose up -d --build
\`\`\`

## Troubleshooting

- **No audio captured:** check `arecord -l` on the host first. Then verify the
  container sees `/dev/snd`: `docker exec voice-assistant arecord -l`. If the
  list is empty, the device passthrough failed — check the compose file.
- **`Permission denied` on /dev/snd inside the container:** the `AUDIO_GID` in
  `.env` does not match the host's `audio` group. Re-run:
  `getent group audio | cut -d: -f3` and update `.env`, then
  `docker compose up -d --force-recreate`.
- **Porcupine fails to load native binary:** ensure the package version supports
  `linux-arm64`. Older versions were `linux-armv7l` only.
- **Service crashes on start:** `docker compose logs voice-assistant` shows the
  stack trace. Most often: missing `.env` value or HA unreachable.
- **High latency:** `ping api.openai.com` from the Pi. Move to 5GHz Wi-Fi or
  wired Ethernet if RTT is high.
- **Container restarts loop:** `docker compose ps` and
  `docker inspect voice-assistant | grep -A5 Health`. Health check looks for the
  Node process; if it crashes immediately, logs explain why.
```

- [ ] **Step 2: Commit**

```bash
git add docs/raspberry-pi-setup.md
git commit -m "docs: add Raspberry Pi (Docker) setup guide"
```

---

## Task 5: Live deployment test

Manual checklist on a real Pi 5.

- [ ] **Step 1: Provision Pi**

Follow `docs/raspberry-pi-setup.md` sections "OS preparation" and "Audio".

- [ ] **Step 2: Deploy**

```bash
rsync -av --exclude node_modules --exclude data --exclude .git ./ pi@raspberrypi.local:/opt/voice-assistant/
ssh pi@raspberrypi.local 'sudo /opt/voice-assistant/deploy/install.sh'
ssh pi@raspberrypi.local 'sudo nano /opt/voice-assistant/.env'   # fill values
ssh pi@raspberrypi.local 'cd /opt/voice-assistant/deploy && docker compose up -d && docker compose logs -f'
```

- [ ] **Step 3: End-to-end voice test**

1. Say wake word → "включи лампу" → confirm Test Lamp turns on, hear assistant reply.
2. Wait > 3 minutes silently.
3. Say wake word → "а выключи" → expected behavior depends on idle timeout (per spec).
4. Reboot Pi → `docker` starts, container auto-starts, voice still works.

- [ ] **Step 4: Resource check**

```bash
ssh pi@raspberrypi.local 'docker stats --no-stream voice-assistant'
ssh pi@raspberrypi.local 'docker compose -f /opt/voice-assistant/deploy/docker-compose.yml ps'
```

Idle: < 200MB RSS (container + node), < 5% CPU.
Active turn: brief CPU spike, mostly network-bound.

- [ ] **Step 5: Document the result**

Append a short "Verified deployments" section to `docs/raspberry-pi-setup.md`
with the Pi model, OS version, and measured round-trip latency from VAD-end to
first speaker output.

```bash
git add docs/raspberry-pi-setup.md
git commit -m "docs(deploy): record verified Pi 5 deployment"
```

---

## Definition of done

- `sudo deploy/install.sh` on a fresh Pi 5 produces a running container without manual steps beyond editing `.env`.
- `docker compose ps` shows `Up (healthy)`; container does not flap.
- Wake-word + voice pipeline works end-to-end through ALSA passthrough.
- Container auto-starts on Pi reboot.
- Host has only `docker` installed — no Node.js, no build-essential, no NodeSource repo.
- Resource use within targets (< 200MB RSS idle, < 5% CPU idle).
- README or top-level docs link to `docs/raspberry-pi-setup.md`.
