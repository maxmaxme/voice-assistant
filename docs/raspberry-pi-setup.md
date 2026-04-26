# Raspberry Pi Setup

Targets Raspberry Pi 5 (8GB) with Raspberry Pi OS Bookworm 64-bit. Pi 4 also
works but the wake-word daemon is heavier (~10% idle CPU instead of ~3%).

## Hardware

- USB microphone (Jabra Speak, ReSpeaker 2-Mic HAT, generic UVC mic)
- USB or 3.5mm speakers (HDMI audio also fine)

## 1. OS preparation

1. Flash Raspberry Pi OS 64-bit (Bookworm or newer) using Pi Imager. In the
   imager's advanced options preconfigure: hostname, SSH, Wi-Fi, locale.
2. Boot, SSH in.
3. Update:
   ```bash
   sudo apt update && sudo apt full-upgrade -y
   sudo reboot
   ```

That is the entire host setup. Docker is installed by `deploy/install.sh` —
no Node, no Python, no build tools on the host.

## 2. Audio

Confirm the OS sees your devices:

```bash
arecord -l    # capture devices (mic)
aplay   -l    # playback devices (speaker)
```

Note the `card N` numbers — you may need to set `ALSA_CARD=N` in `.env` if
your mic isn't card 1.

Quick test (records 5s, plays back):

```bash
arecord -D plughw:1,0 -d 5 -f S16_LE -r 16000 -c 1 /tmp/test.wav
aplay /tmp/test.wav
```

The `pi` user must be in the `audio` group. It usually is by default:

```bash
groups pi | grep -q audio || sudo usermod -aG audio pi
```

## 3. Deploy

Get the project sources to `/opt/voice-assistant`. Two options:

**Option A — rsync from your dev machine:**

```bash
# from the dev machine
rsync -av --exclude node_modules --exclude .venv --exclude data --exclude .git \
  ./ pi@raspberrypi.local:/opt/voice-assistant/
```

Then on the Pi:

```bash
sudo /opt/voice-assistant/deploy/install.sh
```

**Option B — git clone via the install script:**

```bash
sudo REPO_URL=https://github.com/<you>/voice-assistant.git \
  /opt/voice-assistant/deploy/install.sh
```

The script:

- installs Docker if missing
- adds `pi` to the `docker` group
- copies `.env.example` → `.env` and resolves the host's `audio` group gid
- creates `models/` and `data/` directories
- pulls the prebuilt image from GHCR and starts the container
- installs and enables the `voice-assistant-update.timer` systemd timer

After it finishes, edit `/opt/voice-assistant/.env` to fill in real values
(`HA_URL`, `HA_TOKEN`, `OPENAI_API_KEY`, etc.) and restart:

```bash
cd /opt/voice-assistant/deploy
sudo -u pi docker compose up -d --force-recreate
```

## 4. Custom wake-word model (optional)

If you trained a `.onnx` via openWakeWord (see Colab notebook), copy it onto
the Pi and point `.env` at it:

```bash
# from the dev machine
rsync -av models/alisa.onnx pi@raspberrypi.local:/opt/voice-assistant/models/
```

In `/opt/voice-assistant/.env`:

```
WAKE_WORD_KEYWORD=models/alisa.onnx
WAKE_WORD_THRESHOLD=0.5
```

Then restart the container.

## 5. Observe

```bash
cd /opt/voice-assistant/deploy
sudo -u pi docker compose logs -f
```

The first boot prints `[wake] loading model: <kw>` and then
`Voice assistant running. Say the wake word to talk.` — that means the
healthcheck is about to flip to `healthy`.

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

Force an update right now:

```bash
sudo systemctl start voice-assistant-update.service
```

### `/update` Telegram command

The bot's `/update` command triggers an on-demand update by writing to a
named pipe (FIFO) on the host. A lightweight systemd service reads from it
and calls `deploy/update.sh`. Install it once after deploying:

```bash
sudo cp /opt/voice-assistant/deploy/va-update-listener.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now va-update-listener.service
```

Verify it's running:

```bash
systemctl status va-update-listener.service
```

The service creates `/tmp/va-update` (the FIFO) on startup. The FIFO is
mounted into the container via `docker-compose.yml` — no docker socket or
sudo inside the container is required.

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
sudo -u pi docker compose build voice-assistant
sudo -u pi docker compose up -d voice-assistant
```

## Troubleshooting

- **No audio inside container.** Run `docker exec voice-assistant arecord -l`.
  Empty list = device passthrough failed; check `docker-compose.yml` has the
  `/dev/snd` device line. If `arecord -l` works on host but not in
  container, the audio gid in `.env` (`AUDIO_GID`) doesn't match the host —
  re-run `getent group audio | cut -d: -f3` and update.
- **Wake-word never fires.** Add `WAKE_WORD_DEBUG=1` to `.env` and recreate
  the container. The daemon prints per-frame max score and RMS to stderr,
  visible in `docker compose logs -f`. RMS should go above ~1000 during
  speech; if it's stuck near zero, the mic isn't actually feeding audio.
  If score peaks below `WAKE_WORD_THRESHOLD`, lower the threshold.
- **Container restart loop.** `docker compose ps` and
  `docker inspect voice-assistant | grep -A5 Health`. Logs explain why.
- **High latency.** `ping api.openai.com` from the Pi. Move to 5 GHz Wi-Fi
  or wired Ethernet if RTT is high.
- **First boot slow (~30-60s).** Normal — `openwakeword` loads ONNX models
  on startup. The compose `healthcheck` has `start_period: 30s` for this.
- **Auto-update didn't fire / rolled back.** Check the timer and journal:
  `systemctl list-timers voice-assistant-update.timer` and
  `journalctl -u voice-assistant-update -n 200 --no-pager`. A rollback
  message in Telegram means the new image started but its healthcheck
  never went green within 90 s — the previous image is now active. Fix
  the breaking commit, push again, and the next 04:00 run picks it up.

## Verified deployments

(Fill in once you ship to a real Pi.)
