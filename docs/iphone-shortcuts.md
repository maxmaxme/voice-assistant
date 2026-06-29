# iPhone Shortcuts integration

Drive the assistant from iOS **Shortcuts.app** over the HTTP API — record audio
(or dictate text) and POST it to the server.

## Server setup

The HTTP server runs as part of the single process:

```bash
npm run start
```

It listens on `http://<host>:3000` (override with `HTTP_SERVER_PORT`). The
`/text` and `/audio` endpoints only mount when their toggles are enabled on the
web panel's **HTTP API** page — turn the ones you need on. `GET /health` is
always available.

In Docker, expose the port (handled by the host stack in the `home-infra` repo):

```yaml
ports:
  - '3000:3000'
```

So the URL for Shortcuts is `http://<host>:3000`.

## Authentication (required)

HTTP auth is **DB-backed and mandatory** — there is no unauthenticated mode.
Mint a token for yourself and use it as a Bearer token:

```bash
npm run users -- add-user --name iphone        # if you don't have a principal yet
npm run users -- mint-http --user <id>         # prints the token ONCE
```

The raw token is never stored — only its sha256 hash. Every request must send
`Authorization: Bearer <token>`; an unknown token gets `401`. (You can also mint
tokens from the panel's **Users** page.) The token also picks the request's
memory scope — replies read that principal's `household ∪ personal` memory.

## Endpoints

| Endpoint      | Body                                              | Returns                  |
| ------------- | ------------------------------------------------- | ------------------------ |
| `POST /audio` | raw audio bytes (`Content-Type` sets the format)  | `{response, transcript}` |
| `POST /text`  | `application/x-www-form-urlencoded`, field `text` | `{response}`             |
| `GET /health` | —                                                 | `{status:"ok"}`          |

`/audio` is transcribed with OpenAI, then run through the agent. `/text` skips
transcription — handy when the Shortcut dictates text instead of recording.

## Creating the Shortcut (audio)

1. Open **Shortcuts.app** → new shortcut (`+`).
2. **Record Audio** (Actions → Media). Set _Show When Run_ off for a one-tap flow.
3. **Get Contents of URL** (Actions → Web):
   - URL: `http://<host>:3000/audio`
   - Method: `POST`
   - Request Body: **File** → the recorded audio
   - Headers:
     - `Authorization`: `Bearer <token>`
     - `Content-Type`: `audio/wav` (match your recording format)
4. **Get Dictionary Value** → `response` from the returned JSON.
5. **Show Result** (or **Speak Text**) to surface the reply.

### Text variant

Swap step 2 for **Dictate Text**, and in step 3 POST to `/text` with body
`Form` field `text` set to the dictated text. Read `response` from the JSON.

## Testing with curl

```bash
# Audio
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: audio/wav" \
  --data-binary @test.wav \
  http://localhost:3000/audio

# Text
curl -X POST \
  -H "Authorization: Bearer <token>" \
  --data-urlencode "text=turn on the kitchen light" \
  http://localhost:3000/text

# Health (no auth)
curl http://localhost:3000/health
```

## Audio format

- Anything the OpenAI transcription API accepts (WAV, OGG, MP3, …).
- Recommended: WAV, 16 kHz, 16-bit, mono.
- `/audio` is concurrency-limited on the server (Whisper + LLM are heavy on a
  Pi), and failed auths are rate-limited per IP.

## Exposing it beyond the LAN

If you reach the server from outside your network, put it behind HTTPS — a
reverse proxy (Caddy / nginx) with TLS, plus firewall rules. Tokens are bearer
credentials, so don't send them over plain HTTP across the internet.
