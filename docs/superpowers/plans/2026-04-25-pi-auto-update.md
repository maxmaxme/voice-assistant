# Pi Auto-Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push to `main` → arm64 image on GHCR → Pi auto-pulls at 04:00 with healthcheck-driven rollback and Telegram alerts.

**Architecture:** A GitHub Actions workflow cross-builds the existing `deploy/Dockerfile` for `linux/arm64` and pushes to `ghcr.io/maxmaxme/voice-assistant`. On the Pi, a systemd timer fires `deploy/update.sh` at 04:00 daily. The script pulls `:latest`, restarts the container if the digest changed, waits up to 90 s for the existing healthcheck, rolls back to the previous image on failure, and posts the outcome to the same Telegram bot the agent already uses.

**Tech Stack:** GitHub Actions (`docker/build-push-action`, `setup-buildx-action`), GHCR, Docker Compose v2, bash, systemd, `bats-core` for shell tests, `shellcheck` for linting.

**Spec:** [docs/superpowers/specs/2026-04-25-pi-auto-update-design.md](docs/superpowers/specs/2026-04-25-pi-auto-update-design.md)

---

## File Structure

**New files:**

- `.github/workflows/build-image.yml` — CI build + push.
- `deploy/update.sh` — pull / restart / rollback / notify orchestrator. Bash, runs on Pi host.
- `deploy/voice-assistant-update.service` — systemd oneshot for the script.
- `deploy/voice-assistant-update.timer` — systemd timer (04:00 daily, persistent).
- `tests/update.bats` — bats tests for `update.sh` with PATH-shimmed `docker` and `curl`.
- `tests/fixtures/update/bin/docker` — fake `docker` used by bats.
- `tests/fixtures/update/bin/curl` — fake `curl` used by bats.

**Modified files:**

- `deploy/docker-compose.yml` — replace `build:` with `image:`; add `build` profile to keep ad-hoc local builds available.
- `deploy/install.sh` — install systemd unit + timer, drop the `docker compose build` step.
- `package.json` — add `test:shell` script (`bats tests/update.bats`).
- `CLAUDE.md` — note the new entry points and the auto-update flow.
- `README.md` — Status / deployment section.

`update.sh` is intentionally in bash, not Node: it has to keep working when the Node app is broken (rollback path). Its only host requirements are `docker`, `curl`, and `bash` — all already required to run the stack.

---

## Task 1: GitHub Actions workflow

**Files:**

- Create: `.github/workflows/build-image.yml`

- [ ] **Step 1: Add the workflow file**

```yaml
name: build-image

on:
  push:
    branches: [main]
  workflow_dispatch: {}

permissions:
  contents: read
  packages: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3
        with:
          platforms: arm64

      - uses: docker/setup-buildx-action@v3

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute short SHA
        id: sha
        run: echo "short=$(git rev-parse --short HEAD)" >> "$GITHUB_OUTPUT"

      - uses: docker/build-push-action@v6
        with:
          context: .
          file: deploy/Dockerfile
          platforms: linux/arm64
          push: true
          tags: |
            ghcr.io/maxmaxme/voice-assistant:latest
            ghcr.io/maxmaxme/voice-assistant:sha-${{ steps.sha.outputs.short }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Lint locally**

Run: `actionlint .github/workflows/build-image.yml`
(install: `brew install actionlint`)
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build-image.yml
git commit -m "ci: arm64 image build to GHCR"
```

---

## Task 2: Switch compose to remote image, keep build profile

**Files:**

- Modify: `deploy/docker-compose.yml` — `voice-assistant` service top half.

- [ ] **Step 1: Edit `deploy/docker-compose.yml`**

Replace the `voice-assistant` service `build:` block with `image:` plus a `build` profile so developers can still build locally on demand.

```yaml
services:
  voice-assistant:
    image: ghcr.io/maxmaxme/voice-assistant:latest
    pull_policy: always
    build:
      context: ..
      dockerfile: deploy/Dockerfile
    profiles: ['', 'build']
    container_name: voice-assistant
    restart: unless-stopped
    # ... rest unchanged ...
```

The empty-string profile keeps the service in the default set (compose's normal behavior); listing `build` alongside it lets a developer run `docker compose --profile build build voice-assistant` to compile from source. `pull_policy: always` makes `docker compose up -d` re-pull `:latest` when invoked directly (belt-and-braces alongside the explicit `pull` in `update.sh`).

- [ ] **Step 2: Verify compose parses**

Run: `cd deploy && docker compose config >/dev/null`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add deploy/docker-compose.yml
git commit -m "deploy: track ghcr image, gate local build behind profile"
```

---

## Task 3: Bats test harness for `update.sh`

We write the tests first so each subsequent task targets a concrete failing case.

**Files:**

- Create: `tests/update.bats`
- Create: `tests/fixtures/update/bin/docker`
- Create: `tests/fixtures/update/bin/curl`
- Modify: `package.json` — add `"test:shell": "bats tests/update.bats"`.

- [ ] **Step 1: Add the fake `docker` shim**

`tests/fixtures/update/bin/docker`:

```bash
#!/usr/bin/env bash
# Records every invocation to $DOCKER_LOG and returns canned output
# determined by env vars set by the test.
set -euo pipefail
echo "$@" >> "${DOCKER_LOG:-/dev/null}"

case "$1 $2" in
  "inspect --format='{{index")  # digest probe: docker inspect --format='...' name
    # Tests set DIGEST_NEXT after pull; before pull, DIGEST_PREV.
    if [[ -n "${DIGEST_OVERRIDE:-}" ]]; then
      echo "$DIGEST_OVERRIDE"
    else
      echo "${DIGEST_PREV:-sha256:aaa}"
    fi
    ;;
  "compose pull")
    # Simulate the pull populating a new digest for subsequent inspects.
    export DIGEST_OVERRIDE="${DIGEST_NEXT:-$DIGEST_PREV}"
    # Persist for the next docker invocation in the same script run by
    # writing it to a side-file the next inspect will read.
    echo "${DIGEST_NEXT:-$DIGEST_PREV}" > "$DIGEST_STATE_FILE"
    ;;
  "compose up")
    : # no-op, success
    ;;
  "inspect --format='{{.State.Health.Status}}'")
    echo "${HEALTH_STATUS:-healthy}"
    ;;
  "image tag" | "image prune")
    : # no-op
    ;;
  *)
    : # default success
    ;;
esac
```

(Implementation note: the production `update.sh` will call
`docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE"` for digest
checks and `docker inspect --format='{{.State.Health.Status}}' voice-assistant`
for health. The shim above branches on those two formats. The
`DIGEST_STATE_FILE` is set by the bats `setup` block to a temp path
shared across docker invocations.)

- [ ] **Step 2: Add the fake `curl` shim**

`tests/fixtures/update/bin/curl`:

```bash
#!/usr/bin/env bash
echo "$@" >> "${CURL_LOG:-/dev/null}"
exit 0
```

- [ ] **Step 3: Make shims executable**

```bash
chmod +x tests/fixtures/update/bin/docker tests/fixtures/update/bin/curl
```

- [ ] **Step 4: Write the bats file**

`tests/update.bats`:

```bash
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
  ! grep -q "compose up" "$DOCKER_LOG"
  ! grep -q "sendMessage" "$CURL_LOG"
}

@test "restart and notify when digest changes and health goes green" {
  export DIGEST_PREV="sha256:old"
  export DIGEST_NEXT="sha256:new"
  export HEALTH_STATUS="healthy"
  run run_update
  [ "$status" -eq 0 ]
  grep -q "compose up -d voice-assistant" "$DOCKER_LOG"
  grep -q "sendMessage" "$CURL_LOG"
  grep -q "updated" "$CURL_LOG"
}

@test "rollback when new image stays unhealthy" {
  export DIGEST_PREV="sha256:old"
  export DIGEST_NEXT="sha256:new"
  export HEALTH_STATUS="unhealthy"
  run run_update
  [ "$status" -ne 0 ]
  grep -q "image tag" "$DOCKER_LOG"        # rollback retag
  grep -q "rolled back" "$CURL_LOG"
}
```

- [ ] **Step 5: Add npm script**

In `package.json`, add to the `"scripts"` object:

```json
"test:shell": "bats tests/update.bats"
```

- [ ] **Step 6: Run bats — expect failure**

Install bats locally first if missing: `brew install bats-core`.
Run: `npm run test:shell`
Expected: fails with "deploy/update.sh: No such file or directory" — `update.sh` doesn't exist yet.

- [ ] **Step 7: Commit**

```bash
git add tests/update.bats tests/fixtures/update package.json
git commit -m "test(deploy): bats harness for update.sh"
```

---

## Task 4: `update.sh` — happy path (digest compare + restart)

**Files:**

- Create: `deploy/update.sh`

- [ ] **Step 1: Write the script targeting tests 1 and 2**

`deploy/update.sh`:

```bash
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
```

- [ ] **Step 2: Make executable + lint**

```bash
chmod +x deploy/update.sh
shellcheck deploy/update.sh
```

Expected: no output.

- [ ] **Step 3: Run bats — expect tests 1 and 2 to pass, test 3 to fail**

Run: `npm run test:shell`
Expected: 2 of 3 pass; the rollback test fails because we haven't written rollback yet.

- [ ] **Step 4: Commit**

```bash
git add deploy/update.sh
git commit -m "deploy: update.sh — pull, restart on digest change"
```

---

## Task 5: `update.sh` — healthcheck wait + rollback

**Files:**

- Modify: `deploy/update.sh` — append.

- [ ] **Step 1: Append rollback logic**

Add to the bottom of `deploy/update.sh`:

```bash
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
```

- [ ] **Step 2: Lint + run bats**

```bash
shellcheck deploy/update.sh
npm run test:shell
```

Expected: shellcheck quiet, all 3 bats tests pass.

- [ ] **Step 3: Commit**

```bash
git add deploy/update.sh
git commit -m "deploy: update.sh — healthcheck wait + rollback + telegram"
```

---

## Task 6: systemd unit + timer

**Files:**

- Create: `deploy/voice-assistant-update.service`
- Create: `deploy/voice-assistant-update.timer`

- [ ] **Step 1: Write the service unit**

`deploy/voice-assistant-update.service`:

```ini
[Unit]
Description=Pull latest voice-assistant image and restart with rollback
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
User=pi
Group=docker
WorkingDirectory=/opt/voice-assistant
ExecStart=/opt/voice-assistant/deploy/update.sh
StandardOutput=journal
StandardError=journal
```

- [ ] **Step 2: Write the timer unit**

`deploy/voice-assistant-update.timer`:

```ini
[Unit]
Description=Daily auto-update for voice-assistant

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true
RandomizedDelaySec=10min
Unit=voice-assistant-update.service

[Install]
WantedBy=timers.target
```

`Persistent=true` runs a missed update on next boot.
`RandomizedDelaySec=10min` smears the wakeup so it doesn't always hit GHCR at 04:00:00 sharp.

- [ ] **Step 3: Commit**

```bash
git add deploy/voice-assistant-update.service deploy/voice-assistant-update.timer
git commit -m "deploy: systemd unit + timer for auto-update"
```

---

## Task 7: Extend `install.sh`

**Files:**

- Modify: `deploy/install.sh`

- [ ] **Step 1: Replace the build-and-start step (currently step 8)**

In `deploy/install.sh`, replace the section beginning `# 8. Build and start`:

```bash
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
```

- [ ] **Step 2: shellcheck**

Run: `shellcheck deploy/install.sh`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add deploy/install.sh
git commit -m "deploy: install.sh — pull image, install update timer"
```

---

## Task 8: Doc updates

**Files:**

- Modify: `CLAUDE.md` — Commands section + new "Auto-update" subsection in Architecture.
- Modify: `README.md` — Status / deployment.
- Modify: `docs/raspberry-pi-setup.md` — install description, Updating section, Troubleshooting.

- [ ] **Step 1: Update `CLAUDE.md` Commands section**

Add to the bash code block under `## Commands`:

```bash
npm run test:shell                 # bats tests for deploy/update.sh
```

- [ ] **Step 2: Add an Auto-update note to `CLAUDE.md`**

Append a short subsection under `## Architecture`, after the MCP client section:

```markdown
### Deployment & auto-update (`deploy/`)

CI (`.github/workflows/build-image.yml`) cross-builds an arm64 image on every push to `main` and publishes it to `ghcr.io/maxmaxme/voice-assistant`. The Pi pulls via `deploy/update.sh`, run by `voice-assistant-update.timer` at 04:00 daily. The script bails when the digest hasn't changed, rolls back to the previous image if the existing healthcheck doesn't go green within 90 s, and posts the outcome to the same Telegram bot the agent uses. There is no blue/green: a single ALSA mic forces a serial restart, and 5 s of unavailability at 04:00 is invisible.
```

- [ ] **Step 3: Update README Status section**

Add a bullet under the existing iteration list noting that auto-update via GHA + GHCR is live.

- [ ] **Step 4: Update `docs/raspberry-pi-setup.md`**

Three edits:

a) Replace the bullet on line 81 (`- builds the image and starts the container`) with:

```
- pulls the prebuilt image from GHCR and starts the container
- installs and enables the `voice-assistant-update.timer` systemd timer
```

b) Replace the entire `## Updating` section (lines 122–128) with:

````markdown
## Updating

The `voice-assistant-update.timer` systemd unit fires `deploy/update.sh`
daily at 04:00 (with up to 10 min jitter). The script pulls
`ghcr.io/maxmaxme/voice-assistant:latest`, restarts the container if the
digest changed, waits up to 90 s for the healthcheck, and rolls back to
the previous image on failure. Outcome (success or rollback) is posted
to the same Telegram bot the agent uses.

Inspect:

```bash
systemctl list-timers voice-assistant-update.timer
journalctl -u voice-assistant-update -n 100 --no-pager
```
````

Force an update right now:

```bash
sudo systemctl start voice-assistant-update.service
```

Manual rollback to the previous image (kept locally as `:rollback`):

```bash
cd /opt/voice-assistant/deploy
sudo -u pi docker compose -f docker-compose.yml \
  up -d --no-deps \
  --pull never \
  voice-assistant
# then edit the image: line back to :latest after fixing CI
```

Build locally on the Pi (no GHCR roundtrip — useful when iterating
on a hot-fix):

```bash
cd /opt/voice-assistant/deploy
sudo -u pi docker compose --profile build build voice-assistant
sudo -u pi docker compose up -d voice-assistant
```

````

c) Append to `## Troubleshooting`:

```markdown
- **Auto-update didn't fire / rolled back.** Check the timer and journal:
  `systemctl list-timers voice-assistant-update.timer` and
  `journalctl -u voice-assistant-update -n 200 --no-pager`. A rollback
  message in Telegram means the new image started but its healthcheck
  never went green within 90 s — the previous image is now active. Fix
  the breaking commit, push again, and the next 04:00 run picks it up.
````

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md README.md docs/raspberry-pi-setup.md
git commit -m "docs: auto-update flow"
```

---

## Task 9: Live CI bring-up (manual)

This task can't be TDD'd — it's a one-time external state change.

- [ ] **Step 1: Push branch, watch GHA**

```bash
git push -u origin main
```

Open the Actions tab on GitHub. Expected: workflow runs, finishes in ~5–10 min on first run (no cache), arm64 image lands in `ghcr.io/maxmaxme/voice-assistant`.

- [ ] **Step 2: Make package public**

GitHub → Profile → Packages → `voice-assistant` → Package settings → change visibility to **Public**, link to source repo. This avoids needing a PAT on the Pi.

- [ ] **Step 3: Verify image is pullable anonymously**

From any machine without GHCR auth:

```bash
docker pull ghcr.io/maxmaxme/voice-assistant:latest
```

Expected: pulls without prompting for credentials.

- [ ] **Step 4: Tag the rollback baseline**

So the very first auto-update has a `:rollback` target if it ever needs one:

```bash
docker pull ghcr.io/maxmaxme/voice-assistant:latest
docker tag ghcr.io/maxmaxme/voice-assistant:latest ghcr.io/maxmaxme/voice-assistant:rollback
docker push ghcr.io/maxmaxme/voice-assistant:rollback
```

(Optional — `update.sh` retags on each successful update; this is just a safety net before the first auto-update fires.)

---

## Task 10: Pi bring-up (manual)

- [ ] **Step 1: Pull updated repo on Pi**

```bash
ssh pi@<pi-host>
cd /opt/voice-assistant
git pull
```

- [ ] **Step 2: Re-run install**

```bash
sudo /opt/voice-assistant/deploy/install.sh
```

Expected: pulls the GHCR image, restarts the container, installs the systemd units, enables the timer.

- [ ] **Step 3: Verify timer is armed**

```bash
systemctl list-timers voice-assistant-update.timer
```

Expected: a NEXT entry close to 04:00 tomorrow.

- [ ] **Step 4: Force one update run to smoke-test the script in prod**

```bash
sudo systemctl start voice-assistant-update.service
journalctl -u voice-assistant-update -n 50 --no-pager
```

Expected: `[update.sh] no change` (digest is identical, since nothing new was pushed). No Telegram message.

- [ ] **Step 5: End-to-end test with a trivial commit**

From the Mac, push a comment-only change to `main`. Wait for GHA to finish. On the Pi, run the service manually again. Expected: digest changes, container restarts, healthcheck goes green within 90 s, Telegram sends "✓ voice-assistant updated to sha256:…". Confirm in `journalctl`.

---

## Self-Review Notes

**Spec coverage.**

- CI build (spec §1) — Task 1.
- Pi update script with digest check, healthcheck wait, rollback, Telegram (spec §2) — Tasks 4, 5.
- Pi schedule (spec §3) — Task 6.
- Compose changes (spec "Compose changes") — Task 2.
- One-time repo setup (spec "Repository setup") — Tasks 9, 10.
- Failure modes table — covered: healthcheck rollback (Task 5), persistent timer (Task 6 timer config), disk prune (Task 5), GHA failure (no extra task — failed workflow simply doesn't push, Pi keeps old digest).
- Testing strategy: bats unit tests (Task 3), shellcheck (Tasks 4–5), live verification (Tasks 9–10).
- Deferred items (idle-gating, multi-Pi, Sentry rollback) — explicitly out of scope, no tasks.

**Type / name consistency.**

- Image name `ghcr.io/maxmaxme/voice-assistant` is used identically in workflow, compose, update.sh, install.sh, and docs.
- `:latest`, `:sha-<short>`, `:rollback` tag triplet referenced consistently.
- `voice-assistant-update.{service,timer}` names match across install.sh and the unit files.
- Env vars `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` match `loadConfig()` in `src/config.ts` so the Pi `.env` already has them.

**Placeholders.** None — every code block is complete.
