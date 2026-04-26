#!/usr/bin/env bash
# One-time bootstrap on a fresh Raspberry Pi. Idempotent.
#
# Usage:
#   sudo REPO_URL=https://github.com/you/voice-assistant.git deploy/install.sh
# OR rsync sources into /opt/voice-assistant first, then:
#   sudo /opt/voice-assistant/deploy/install.sh
set -euo pipefail

APP_DIR=/opt/voice-assistant
REPO_URL="${REPO_URL:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# 1. Docker (official convenience script — fine for a single-host home setup)
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
  echo "REPO_URL not set and $APP_DIR has no sources."
  echo "Either set REPO_URL or rsync sources to $APP_DIR before running."
  exit 1
fi

# 5. .env
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u pi cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Created $APP_DIR/.env from example. Edit it before starting the service."
fi

# 5b. Resolve audio gid and persist it for compose
AUDIO_GID=$(getent group audio | cut -d: -f3)
if ! grep -q '^AUDIO_GID=' "$APP_DIR/.env"; then
  echo "AUDIO_GID=${AUDIO_GID}" | sudo -u pi tee -a "$APP_DIR/.env" >/dev/null
fi

# 6. models/ — custom .onnx wake-word models live outside git (binaries).
sudo -u pi mkdir -p "$APP_DIR/models"
if [[ -z "$(ls -A "$APP_DIR/models" 2>/dev/null)" ]]; then
  echo
  echo "Note: $APP_DIR/models/ is empty. The default keyword (WAKE_WORD_KEYWORD"
  echo "in .env, e.g. hey_jarvis) will load from openwakeword's bundled set."
  echo "For a custom .onnx model, rsync it from your dev machine:"
  echo "  rsync -av models/ pi@<this-pi>:$APP_DIR/models/"
  echo "Then set WAKE_WORD_KEYWORD=models/<file>.onnx in .env."
fi

# 7. data dir
sudo -u pi mkdir -p "$APP_DIR/data"

# 8. First-run image fetch + start.
# Subsequent runs go through the systemd timer; no `docker compose build`
# in the host install path because CI builds the image now.
cd "$APP_DIR/deploy"
sudo -u pi docker compose pull voice-assistant
sudo -u pi docker compose up -d

# 9. Install systemd update timer.
install -m 0644 voice-assistant-update.service /etc/systemd/system/
install -m 0644 voice-assistant-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now voice-assistant-update.timer

cat <<EOM

Service is starting. Tail logs with:
  cd $APP_DIR/deploy && docker compose logs -f
First boot loads the openwakeword ONNX models — give it ~30 seconds
before the healthcheck flips green.

Auto-update is armed (04:00 daily). Inspect with:
  systemctl list-timers voice-assistant-update.timer
  journalctl -u voice-assistant-update -n 50
EOM
