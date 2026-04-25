# Pi Auto-Update via GitHub Actions + GHCR

## Goal

Push to `main` → updated voice-assistant runs on the Raspberry Pi 5 within
~30 minutes, without me ssh'ing in. Old container exits cleanly, new one
starts. If the new image is broken, fall back to the previous one
automatically and notify via Telegram.

## Non-goals

- True zero-downtime / blue-green. The single ALSA mic + speaker makes
  parallel containers pointless. A 5-second restart window is acceptable.
- Idle-gated restart (waiting for FSM `state === 'idle'` before exit).
  Worth doing later, but the v1 cron window (4:00 AM local) makes it
  unnecessary for a single-user home setup.
- Updating the bundled Home Assistant container. HA tracks its own image
  (`ghcr.io/home-assistant/home-assistant:stable`); leave its update
  cadence to its own conventions.
- Self-hosted GHA runner on the Pi. Public CI builds are free, the Pi is
  for runtime only.

## Architecture

Three independent pieces that each do one thing.

### 1. CI build (GitHub Actions)

Workflow `.github/workflows/build-image.yml`.

- **Trigger:** push to `main`, plus manual `workflow_dispatch`.
- **Runner:** `ubuntu-latest` with `docker/setup-qemu-action` +
  `docker/setup-buildx-action`. Cross-build `linux/arm64` only — Pi 5 is
  the sole target, multi-arch wastes minutes.
- **Auth:** the workflow's default `GITHUB_TOKEN` with
  `packages: write` permission. No PATs, no secrets.
- **Tags pushed to `ghcr.io/<owner>/voice-assistant`:**
  - `:latest` — moving pointer the Pi follows
  - `:sha-<short-git-sha>` — immutable, used for rollback
- **Cache:** GHA cache backend (`type=gha`) so incremental builds
  finish in ~1–2 minutes after the first run.
- **Image visibility:** package set to public. Same auth model as
  the source repo; nothing secret in the image (env comes from `.env`
  on the Pi). Public GHCR avoids credential setup on the Pi.

### 2. Pi update script (`deploy/update.sh`)

Run by a systemd timer (or cron). Idempotent — safe to run every
invocation, no-ops when there's nothing new.

```
1. record current image digest:    PREV=$(docker inspect ... voice-assistant)
2. docker compose pull voice-assistant
3. record new digest:               NEXT=$(docker inspect ... voice-assistant:latest)
4. if PREV == NEXT: exit 0
5. docker compose up -d voice-assistant
6. wait up to 90s for healthcheck = healthy
7. on success:  log + telegram "✓ updated to <sha>"
   on failure:  retag PREV as :rollback, edit compose to use :rollback,
                up -d again, telegram "✗ rolled back from <sha>"
```

The healthcheck used is the one already in
[`deploy/docker-compose.yml`](deploy/docker-compose.yml): both the Node
process and the wake-word daemon must be alive. That covers the realistic
break-modes (bad TS edit crashes Node; missing model file kills the
wake-word daemon).

Telegram messages reuse the same bot/chat as the agent's
`send_to_telegram` tool — the credentials are already in `.env`. The
script reads them directly via `set -a; . /opt/voice-assistant/.env;
set +a` and `curl`s to the Bot API. No Node involvement, so update
notifications still work even when the Node app is broken.

### 3. Pi schedule (systemd timer)

`deploy/voice-assistant-update.{service,timer}` installed to
`/etc/systemd/system/`.

- **Schedule:** `OnCalendar=*-*-* 04:00:00` plus
  `Persistent=true` so a missed run after reboot still fires once.
- **Service:** oneshot, runs `update.sh`. `User=` set to whoever owns
  the docker socket (typically `pi` in the `docker` group).
- **Why not Watchtower:** Watchtower has no rollback semantics and
  no hook into our healthcheck-based decision. A 50-line bash script
  is less code than configuring Watchtower correctly, and we keep
  full control over what "healthy" means.

## Compose changes

`deploy/docker-compose.yml`:

- Replace the `build:` block on `voice-assistant` with
  `image: ghcr.io/<owner>/voice-assistant:latest`.
- Keep the `build:` definition available behind a `profiles: ["build"]`
  toggle, so a developer on the Pi can still
  `docker compose --profile build build` when iterating without CI.

`deploy/Dockerfile` is unchanged.

## Repository setup (one-time)

These steps are not code changes; they go in the implementation plan as
manual gates.

1. Push the repo to GitHub (currently no remote). Public repo → GHA
   minutes are unmetered; private repo → 2000 free min/mo, plenty.
2. After the first GHA run, in GHCR settings: change the
   `voice-assistant` package visibility to **public**, link it to the
   source repo for inherited permissions.
3. On the Pi: `git pull`, `bash deploy/install.sh` (extended to install
   the systemd unit + timer). First update.sh run pulls `:latest`,
   replaces the locally-built image.

## Failure modes considered

| What breaks | What happens |
|---|---|
| GHA build fails | Pi keeps running the old image. No update fires. GitHub emails on workflow failure. |
| New image starts but unhealthy | `update.sh` rolls back to the previous digest, sends Telegram. |
| New image starts healthy but is buggy in practice | Rollback is manual: ssh + `docker compose up -d` with `:sha-<good>`. The `:sha-<...>` tags retained on GHCR make this trivial. |
| Pi offline at 4 AM | `Persistent=true` on the timer fires on next boot. |
| GHCR rate-limits anonymous pulls | Docs say 60/hr unauthenticated, far above one-pull-a-day. If we ever hit it, add a read-only PAT to the Pi. |
| Disk fills with old images | `update.sh` ends with `docker image prune -f --filter "until=720h"` (30 days), preserving recent rollback targets. |

## Out of scope (deferred)

- Idle-gated restart driven by the orchestrator FSM. Open question: does
  the FSM expose state externally? If not, doing this means adding a
  Unix-socket status server to the Node process. Worth a follow-up spec
  if 4-AM-cron-lottery ever bites.
- Multi-Pi fleets (currently one Pi).
- Auto-rollback on runtime errors detected post-deploy (e.g.
  Sentry-style telemetry). The healthcheck-only signal is enough for v1.

## Testing strategy

CI build:
- Lint the workflow with `actionlint` locally.
- First merge to `main` is the live test — verify image lands in GHCR,
  is pullable on the Pi.

Update script:
- Unit-test the digest-comparison and rollback logic with `bats` or a
  plain shell test harness against `docker` in dry-run mode (mock
  `docker` and `curl` via `PATH` shimming).
- Integration test on the Pi by manually pushing two consecutive
  commits and watching `journalctl -u voice-assistant-update`.

Health verification:
- After the first auto-update, intentionally push a commit that breaks
  the wake-word daemon (e.g. wrong `WAKE_WORD_PYTHON`), confirm rollback
  and Telegram message fire. Then revert.
