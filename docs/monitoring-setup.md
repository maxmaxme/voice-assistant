# Monitoring (Netdata + Dozzle, behind Caddy + tinyauth)

Two monitoring UIs run alongside the assistant on the Pi, both gated by a
real HTML login page courtesy of [tinyauth](https://tinyauth.app):

- **Netdata** (`http://<pi-host>:19999`) — metrics for CPU, RAM, disk,
  network, temperature, per-container stats, plus built-in alerts.
- **Dozzle** (`http://<pi-host>:8888`) — live tail and search across all
  Docker container logs.

Network shape:

```
                ┌──────────────────── monitoring (bridge) ─────────────────┐
internet/LAN ──►│ caddy :19999 ──► netdata :19999                          │
                │ caddy :8888  ──► dozzle :8080      ┌───────────────┐     │
                │       └─────── forward_auth ─────► │ tinyauth :3000│◄────┼── login UI on :8890
                │                                    └───────────────┘     │
                └──────────────────────────────────────────────────────────┘
```

Netdata and Dozzle have **no host-published ports**. The host listens on
three ports: `:19999` and `:8888` (both Caddy), and `:8890` (tinyauth's
login page + session API).

A single tinyauth session cookie covers both `:19999` and `:8888` —
browsers don't isolate cookies by port on the same hostname.

## First-time setup

1. Generate a user entry. The interactive command also handles bcrypt and
   escapes every `$` to `$$` (required because docker-compose treats `$`
   as variable expansion in `.env`):

   ```bash
   docker run --rm -it ghcr.io/steveiliop56/tinyauth:v5 \
     user create --interactive --docker
   ```

   It prints a single line like `admin:$$2a$$10$$...`. TOTP is optional —
   say "no" unless you want it.

2. Decide on a public URL for the tinyauth login page. tinyauth requires
   a hostname with at least 2 labels and **rejects raw IPs**, so:
   - `http://<hostname>.local:8890` if mDNS works on your LAN — find the
     hostname with `dns-sd -B _workstation._tcp .` from a Mac, or
     `hostname` on the Pi itself.
   - `http://192-168-1-42.nip.io:8890` (replace dots with dashes) if you
     prefer to hit the LAN IP — nip.io is a public DNS that resolves
     such names back to the original IP, no setup needed.
   - `http://home.lan:8890` (or any 2+ label name) if you've added a
     local DNS entry on your router pointing at the Pi.

3. Put both into `.env` on the Pi:

   ```bash
   TINYAUTH_APPURL=http://pi.local:8890
   TINYAUTH_AUTH_USERS=admin:$$2a$$10$$...   # the full line from step 1
   ```

4. Bring everything up:

   ```bash
   cd /opt/voice-assistant/deploy
   docker compose up -d
   ```

   Open `http://<pi-host>:19999` — you'll be bounced to tinyauth's login
   page, sign in once, and land on the Netdata dashboard. `:8888` (Dozzle)
   uses the same cookie, no second login.

To rotate credentials later: regenerate the user line, update
`TINYAUTH_AUTH_USERS` in `.env`, then `docker compose up -d tinyauth`.
To kick everyone out, also wipe the `tinyauthdata` volume:
`docker compose down tinyauth && docker volume rm deploy_tinyauthdata`.

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
- Caddy and tinyauth serve plain HTTP. If you ever forward
  `:19999`/`:8888`/`:8890` past your router, terminate TLS upstream
  (Cloudflare Tunnel, Tailscale Funnel, or a real domain + Caddy `tls`
  block). Login over plain HTTP is fine on a LAN, **not** over the open
  internet.
- Dozzle has read-only access to the Docker socket (`:ro`). It can read
  any container's logs but cannot start, stop, or exec into anything.
- bcrypt cost 10+ makes offline brute-force impractical. The `.env` file
  is still the weak point; keep its permissions tight (`chmod 600`).
