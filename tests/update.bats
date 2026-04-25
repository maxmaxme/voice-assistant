#!/usr/bin/env bats

setup() {
  TMP="$(mktemp -d)"
  export DOCKER_LOG="$TMP/docker.log"
  export CURL_LOG="$TMP/curl.log"
  export DIGEST_STATE_FILE="$TMP/digest_state"
  export PATH="$BATS_TEST_DIRNAME/fixtures/update/bin:$PATH"
  export TELEGRAM_BOT_TOKEN="test-token"
  export TELEGRAM_CHAT_ID="42"
  export COMPOSE_FILE="$BATS_TEST_DIRNAME/../deploy/docker-compose.yml"
  export VOICE_ASSISTANT_IMAGE="ghcr.io/maxmaxme/voice-assistant:latest"
  export HEALTHCHECK_TIMEOUT_SECONDS=2  # speed up tests
}

teardown() { rm -rf "$TMP"; }

run_update() {
  bash "$BATS_TEST_DIRNAME/../deploy/update.sh" "$@"
}

@test "no-op when digest unchanged" {
  export DIGEST_PREV="sha256:same"
  export DIGEST_NEXT="sha256:same"
  run run_update
  [ "$status" -eq 0 ]
  run grep -q "compose up" "$DOCKER_LOG"
  [ "$status" -ne 0 ]
  run grep -q "sendMessage" "$CURL_LOG"
  [ "$status" -ne 0 ]
}

@test "restart and notify when digest changes and health goes green" {
  export DIGEST_PREV="sha256:old"
  export DIGEST_NEXT="sha256:new"
  export HEALTH_STATUS="healthy"
  run run_update
  [ "$status" -eq 0 ]
  grep -qE "compose .*up -d voice-assistant" "$DOCKER_LOG"
  grep -q "sendMessage" "$CURL_LOG"
  grep -q "✓" "$CURL_LOG"
  grep -q "updated" "$CURL_LOG"
}

@test "rollback when new image stays unhealthy" {
  export DIGEST_PREV="sha256:old"
  export DIGEST_NEXT="sha256:new"
  export HEALTH_STATUS="unhealthy"
  run run_update
  [ "$status" -ne 0 ]
  grep -q "image tag" "$DOCKER_LOG"        # rollback retag
  grep -q "✗" "$CURL_LOG"
  grep -q "rolled back" "$CURL_LOG"
}
