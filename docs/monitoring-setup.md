# Monitoring (Netdata + Dozzle)

Two extra containers run alongside the assistant on the Pi:

- **Netdata** (`http://<pi-host>:19999`) — metrics for CPU, RAM, disk,
  network, temperature, per-container stats, plus built-in alerts.
- **Dozzle** (`http://<pi-host>:8888`) — live tail and search across all
  Docker container logs.

Both are added to `deploy/docker-compose.yml`. After `git pull` on the Pi:

```bash
cd /opt/voice-assistant/deploy
docker compose up -d netdata dozzle
```

Netdata's first start takes ~30 s (it builds the initial metrics database).

## Telegram alerts

Netdata ships with hundreds of preconfigured alerts (high CPU, low memory,
high temperature, disk filling up, container restarting, ...). Telegram
routing is wired up automatically by the `netdata-init` one-shot service
in `docker-compose.yml` — it writes a minimal override into
`/etc/netdata/health_alarm_notify.conf` using `TELEGRAM_BOT_TOKEN` and
`TELEGRAM_CHAT_ID` from `.env` (the same bot the assistant uses). The
file is rewritten every `docker compose up`, so manual edits there are
not preserved — change the `.env` values instead.

Send a test notification to confirm everything works:

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

- `network_mode: host` on Netdata is required so it can see real host
  network interfaces; it binds only to `:19999`.
- Dozzle has read-only access to the Docker socket (`:ro`). It can read
  any container's logs but cannot start, stop, or exec into anything.
- Both UIs are unauthenticated by default. **If your Pi is reachable
  from outside your LAN** (port-forward, public IP, anything other
  than Tailscale/Wireguard), add auth:
  - Netdata: see [the docs on basic auth via reverse proxy](https://learn.netdata.cloud/docs/netdata-agent/securing-agent).
  - Dozzle: uncomment `DOZZLE_AUTH_PROVIDER=simple` in
    `docker-compose.yml` and follow [Dozzle auth setup](https://dozzle.dev/guide/authentication).
