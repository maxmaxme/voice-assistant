#!/usr/bin/env bash
# Stop and remove the voice-assistant container. Sources, .env, data/,
# models/ and Docker itself are left in place — those are the user's data.
set -euo pipefail

APP_DIR=/opt/voice-assistant

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

APP_USER="${APP_USER:-${SUDO_USER:-pi}}"

if [[ -d "$APP_DIR/deploy" ]]; then
  cd "$APP_DIR/deploy"
  sudo -u "$APP_USER" docker compose down -v || true
fi

echo "Container removed. Sources at $APP_DIR and Docker itself are left in place."
