#!/usr/bin/env bash
# One-time bootstrap on a fresh Raspberry Pi. Idempotent.
#
# Usage:
#   sudo git clone https://github.com/maxmaxme/voice-assistant.git /opt/voice-assistant
#   sudo /opt/voice-assistant/deploy/install.sh
set -euo pipefail

APP_DIR=/opt/voice-assistant
REPO_URL="${REPO_URL:-}"

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

# Resolve the unprivileged user that should own $APP_DIR and run docker.
# Override with APP_USER=foo when invoking the script. Defaults to $SUDO_USER
# (the human who ran `sudo install.sh`), falling back to `pi` for back-compat.
APP_USER="${APP_USER:-${SUDO_USER:-pi}}"
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  echo "User '$APP_USER' does not exist. Set APP_USER=<existing-user> and re-run." >&2
  exit 1
fi
APP_GROUP="$(id -gn "$APP_USER")"
echo "Installing for user: $APP_USER ($APP_GROUP)"

# 1. Docker (official convenience script — fine for a single-host home setup)
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

# 2. Allow the app user to run docker without sudo
usermod -aG docker "$APP_USER" || true

# 3. App directory
mkdir -p "$APP_DIR"
chown -R "$APP_USER:$APP_GROUP" "$APP_DIR"

# 4. Pull or update sources
if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$APP_USER" git -C "$APP_DIR" pull
elif [[ -n "$REPO_URL" ]]; then
  sudo -u "$APP_USER" git clone "$REPO_URL" "$APP_DIR"
else
  echo "REPO_URL not set and $APP_DIR has no sources."
  echo "Either set REPO_URL or rsync sources to $APP_DIR before running."
  exit 1
fi

# 5. .env
if [[ ! -f "$APP_DIR/.env" ]]; then
  sudo -u "$APP_USER" cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  echo "Created $APP_DIR/.env from example. Edit it before starting the service."
fi

# 5b. Resolve audio gid and persist it for compose
AUDIO_GID=$(getent group audio | cut -d: -f3)
if ! grep -q '^AUDIO_GID=' "$APP_DIR/.env"; then
  echo "AUDIO_GID=${AUDIO_GID}" | sudo -u "$APP_USER" tee -a "$APP_DIR/.env" >/dev/null
fi

# 6. models/ — custom .onnx wake-word models live outside git (binaries).
sudo -u "$APP_USER" mkdir -p "$APP_DIR/models"
if [[ -z "$(ls -A "$APP_DIR/models" 2>/dev/null)" ]]; then
  echo
  echo "Note: $APP_DIR/models/ is empty. The default keyword (WAKE_WORD_KEYWORD"
  echo "in .env, e.g. hey_jarvis) will load from openwakeword's bundled set."
  echo "For a custom .onnx model, rsync it from your dev machine:"
  echo "  rsync -av models/ ${APP_USER}@<this-pi>:$APP_DIR/models/"
  echo "Then set WAKE_WORD_KEYWORD=models/<file>.onnx in .env."
fi

# 7. data dir
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"

# 8. First-run image fetch + start.
# Subsequent runs go through the systemd timer; no `docker compose build`
# in the host install path because CI builds the image now.
cd "$APP_DIR/deploy"
sudo -u "$APP_USER" docker compose pull voice-assistant
sudo -u "$APP_USER" docker compose up -d

# 9. Install systemd units.
#    - voice-assistant.service: brings the compose stack up at boot (safety
#      net for when docker's `restart: unless-stopped` fails to recover the
#      stack after a host reboot, e.g. unattended-upgrades restarting docker).
#    - voice-assistant-update.{service,timer}: nightly auto-update at 04:00.
#    - va-update-listener.service: reads the /tmp/va-update FIFO for the
#      Telegram /update command.
sed "s|^User=pi$|User=$APP_USER|" voice-assistant.service \
  > /etc/systemd/system/voice-assistant.service
chmod 0644 /etc/systemd/system/voice-assistant.service
sed "s|^User=pi$|User=$APP_USER|" voice-assistant-update.service \
  > /etc/systemd/system/voice-assistant-update.service
chmod 0644 /etc/systemd/system/voice-assistant-update.service
install -m 0644 voice-assistant-update.timer /etc/systemd/system/
install -m 0644 va-update-listener.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now voice-assistant.service
systemctl enable --now voice-assistant-update.timer
systemctl enable --now va-update-listener.service

cat <<EOM

Service is starting. Tail logs with:
  cd $APP_DIR/deploy && docker compose logs -f
First boot loads the openwakeword ONNX models — give it ~30 seconds
before the healthcheck flips green.

Auto-update is armed (04:00 daily). Inspect with:
  systemctl list-timers voice-assistant-update.timer
  journalctl -u voice-assistant-update -n 50
EOM
