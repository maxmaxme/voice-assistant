# Monitoring (Netdata + Dozzle, behind Caddy)

Two monitoring UIs run alongside the assistant on the Pi, both gated by
HTTP basic auth via a tiny Caddy reverse proxy:

- **Netdata** (`http://<pi-host>:19999`) — metrics for CPU, RAM, disk,
  network, temperature, per-container stats, plus built-in alerts.
- **Dozzle** (`http://<pi-host>:8888`) — live tail and search across all
  Docker container logs.

Network shape:

```
                ┌──────────────────── monitoring (bridge) ─────────────────┐
internet/LAN ──►│ caddy :19999 ──► netdata :19999                          │
                │ caddy :8888  ──► dozzle :8080                            │
                └──────────────────────────────────────────────────────────┘
```

Netdata and Dozzle have **no host-published ports** — the only thing
listening on the host is Caddy.

## First-time setup

1. Generate a bcrypt hash for your monitoring password (run anywhere with
   docker, e.g. on the Pi):

   ```bash
   docker run --rm caddy:2-alpine caddy hash-password --plaintext 'your-password'
   ```

   It prints a string starting with `$2a$14$...`.

2. Put the credentials into `.env` on the Pi (next to the rest of the
   secrets — `MONITOR_USER` and `MONITOR_PASSWORD_HASH` are already in
   `.env.example`):

   ```bash
   MONITOR_USER=admin
   MONITOR_PASSWORD_HASH=$2a$14$...   # the full hash, all $ characters intact
   ```

3. Bring everything up:

   ```bash
   cd /opt/voice-assistant/deploy
   docker compose up -d
   ```

   Netdata's first start takes ~30 s (it builds the initial metrics
   database). Open `http://<pi-host>:19999` and `http://<pi-host>:8888`,
   log in with the credentials from step 2.

To rotate the password later: regenerate the hash, update `.env`,
`docker compose up -d monitoring-proxy` (only the proxy needs to restart).

## Telegram alerts

Netdata ships with hundreds of preconfigured alerts (high CPU, low memory,
high temperature, disk filling up, container restarting, ...). Telegram
routing is wired up automatically by the `netdata-init` one-shot service
in `docker-compose.yml` — it writes a minimal override into
`/etc/netdata/health_alarm_notify.conf` using `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` from `.env` (the same bot the assistant uses). The
file is rewritten on every `docker compose up`, so manual edits there
are not preserved — change the `.env` values instead.

Send a test notification:

```bash
docker exec netdata bash -c '/usr/libexec/netdata/plugins.d/alarm-notify.sh test'
```

You should get three Telegram messages (warning / critical / clear).

## Tuning thresholds for a Raspberry Pi

The defaults are conservative but server-oriented. On a Pi 5 the two
alerts most worth raising eyebrows over:

- **CPU temperature.** Defaults trigger CRITICAL at 90°C. The Pi 5
  starts thermal-throttling at 80–85°C, so consider lowering. Edit
  `health.d/cpu.conf`:

  ```bash
  docker exec -it netdata /etc/netdata/edit-config health.d/cpu.conf
  ```

  and tweak the `cpu_temp` alarm `warn`/`crit` lines.

- **RAM usage.** Default WARN at 80%, CRIT at 90% in `health.d/ram.conf`
  is fine — the assistant is the only memory-heavy process.

## Security notes

- Netdata runs in **bridge** networking (not host) so it cannot bind to
  the host's `:19999` directly. It still sees real host metrics through
  the `/host/proc`, `/host/sys`, and `/host/var/log` mounts.
- Caddy serves plain HTTP. If you ever forward `:19999`/`:8888` past
  your router, terminate TLS upstream (Cloudflare Tunnel, Tailscale
  Funnel, or a real domain + Caddy `tls` block) — basic auth over plain
  HTTP is fine on a LAN, **not** over the open internet.
- Dozzle has read-only access to the Docker socket (`:ro`). It can read
  any container's logs but cannot start, stop, or exec into anything.
- Caddy's bcrypt cost is 14 by default — brute-forcing the hash
  offline is not realistic. The `.env` file is still the weak point;
  keep its permissions tight (`chmod 600`).
