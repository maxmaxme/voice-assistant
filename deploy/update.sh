#!/usr/bin/env bash
# Pulls the latest voice-assistant image, restarts the container if the
# digest changed, waits for the existing healthcheck, rolls back on
# failure. Notifies via Telegram. Run by systemd timer at 04:00.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$SCRIPT_DIR/docker-compose.yml}"
ENV_FILE="${ENV_FILE:-$SCRIPT_DIR/../.env}"
IMAGE="${VOICE_ASSISTANT_IMAGE:-ghcr.io/maxmaxme/voice-assistant:latest}"
HEALTHCHECK_TIMEOUT_SECONDS="${HEALTHCHECK_TIMEOUT_SECONDS:-90}"

# Load .env so TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID are available.
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

log() { printf '[update.sh] %s\n' "$*"; }

notify() {
  local text="$1"
  if [[ -z "${TELEGRAM_BOT_TOKEN:-}" || -z "${TELEGRAM_CHAT_ID:-}" ]]; then
    log "telegram creds missing, skipping notify"
    return 0
  fi
  curl -fsS -X POST \
    "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d "chat_id=${TELEGRAM_CHAT_ID}" \
    --data-urlencode "text=${text}" \
    >/dev/null || log "telegram notify failed"
}

current_digest() {
  docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE" 2>/dev/null || echo ""
}

PREV_DIGEST=$(current_digest)
log "previous digest: ${PREV_DIGEST:-<none>}"

docker compose -f "$COMPOSE_FILE" pull voice-assistant

NEW_DIGEST=$(current_digest)
log "new digest: ${NEW_DIGEST:-<none>}"

if [[ "$PREV_DIGEST" == "$NEW_DIGEST" ]]; then
  log "no change"
  exit 0
fi

log "restarting voice-assistant"
docker compose -f "$COMPOSE_FILE" up -d voice-assistant
