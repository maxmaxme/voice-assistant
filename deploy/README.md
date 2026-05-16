# deploy/ — Pi-side install notes

This directory holds the systemd units, Docker compose stack, and shell
scripts that run on the Raspberry Pi. Most of the wiring is automated by
`install.sh`; this README captures the bits that need a human after the
first deploy.

## ru-meters-bot — one-time Pi setup

After the first deploy that includes the meters-bot service, register the
systemd timer:

```bash
sudo cp /opt/voice-assistant/deploy/meters-bot.service /etc/systemd/system/
sudo cp /opt/voice-assistant/deploy/meters-bot.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now meters-bot.timer
systemctl list-timers meters-bot.timer   # confirm the next fire
```

Manual run (e.g. to test before the window opens):

```bash
cd /opt/voice-assistant/deploy
docker compose run --rm meters-bot --force
```

Logs:

```bash
journalctl -u meters-bot.service --since today
sqlite3 /opt/voice-assistant/data/meters/meters.sqlite \
  'SELECT portal, period, status, attempts, last_error FROM submissions;'
```
