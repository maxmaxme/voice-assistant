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

log() { printf '[%s update.sh] %s\n' "$(date -Iseconds)" "$*"; }

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

log "checking image: $IMAGE (compose: $COMPOSE_FILE)"

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

wait_for_health() {
  local deadline=$(( SECONDS + HEALTHCHECK_TIMEOUT_SECONDS ))
  while (( SECONDS < deadline )); do
    local status
    status=$(docker inspect --format='{{.State.Health.Status}}' voice-assistant 2>/dev/null || echo "missing")
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    sleep 3
  done
  return 1
}

if wait_for_health; then
  notify "✓ voice-assistant updated to ${NEW_DIGEST}"
  log "update healthy"
  # Retain :latest's previous digest as :rollback for manual recovery.
  docker image tag "$PREV_DIGEST" ghcr.io/maxmaxme/voice-assistant:rollback || true
  # Drop images older than 30d, keeping :latest, :rollback, and recent :sha-* tags.
  docker image prune -f --filter "until=720h" || true
  exit 0
fi

log "new image unhealthy — rolling back"
docker image tag "$PREV_DIGEST" ghcr.io/maxmaxme/voice-assistant:rollback
# Rewrite compose to use the rollback tag for this restart only.
ROLLBACK_OVERRIDE=$(mktemp)
cat >"$ROLLBACK_OVERRIDE" <<EOF
services:
  voice-assistant:
    image: ghcr.io/maxmaxme/voice-assistant:rollback
EOF
docker compose -f "$COMPOSE_FILE" -f "$ROLLBACK_OVERRIDE" up -d voice-assistant
rm -f "$ROLLBACK_OVERRIDE"
notify "✗ voice-assistant rolled back from ${NEW_DIGEST}"
exit 1
