#!/bin/sh
# Parses a vless:// URL from the RU_PROXY_URL env var, builds a sing-box
# config.json on the fly, and execs sing-box. Keeps the secret (UUID) in
# the env file — config.json is regenerated on every container start.
#
# Supported URL shape (vpn.lease's RU node):
#   vless://UUID@HOST:PORT?security=reality&type=tcp&flow=...&sni=...&fp=...&pbk=...&sid=...#tag
#
# Only the fields we actually need are extracted; anything else in the URL
# is ignored.

set -eu

: "${RU_PROXY_URL:?RU_PROXY_URL must be set (vless:// URL)}"

raw="${RU_PROXY_URL#vless://}"
uuid="${raw%%@*}"
rest="${raw#*@}"
hostport="${rest%%\?*}"
host="${hostport%:*}"
port="${hostport##*:}"
query_and_tag="${rest#*\?}"
query="${query_and_tag%%#*}"

qv() {
  # Print the value of query parameter $1 (urlencoded values pass through;
  # for the fields we use here — UUIDs, hex sids, hostnames — that's fine).
  printf '%s' "$query" | tr '&' '\n' | grep "^$1=" | head -n1 | sed "s/^$1=//"
}

pbk=$(qv pbk)
sid=$(qv sid)
sni=$(qv sni)
fp=$(qv fp)
flow=$(qv flow)
ttype=$(qv type)

# Only set `transport` for non-raw TCP flows (ws/grpc/h2). vpn.lease's RU
# node is plain TCP, so we omit it there.
transport=""
if [ -n "$ttype" ] && [ "$ttype" != "tcp" ] && [ "$ttype" != "raw" ]; then
  transport=",\"transport\": { \"type\": \"$ttype\" }"
fi

cat >/tmp/sing-box.json <<JSON
{
  "log": { "level": "warn", "timestamp": true },
  "inbounds": [
    {
      "type": "mixed",
      "tag": "in",
      "listen": "0.0.0.0",
      "listen_port": 7890
    }
  ],
  "outbounds": [
    {
      "type": "vless",
      "tag": "vless-out",
      "server": "$host",
      "server_port": $port,
      "uuid": "$uuid",
      "flow": "$flow",
      "tls": {
        "enabled": true,
        "server_name": "$sni",
        "utls": { "enabled": true, "fingerprint": "$fp" },
        "reality": { "enabled": true, "public_key": "$pbk", "short_id": "$sid" }
      }$transport
    },
    { "type": "direct", "tag": "direct" }
  ],
  "route": {
    "rules": [{ "inbound": "in", "outbound": "vless-out" }]
  }
}
JSON

echo "[sing-box entrypoint] config built: server=$host:$port type=${ttype:-tcp}"
exec /sbin/sing-box run -c /tmp/sing-box.json
