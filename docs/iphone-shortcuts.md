# iPhone Shortcuts Integration

Control the voice assistant from iPhone using Shortcuts.app.

## Server Setup

### Running the HTTP Server Locally

```bash
npm run http
# or
AGENT_MODE=http HTTP_SERVER_PORT=3000 node src/cli/unified.ts
```

The server listens on `http://localhost:3000` (default port).

### Running on Raspberry Pi

If the service is running in Docker:

```bash
# In docker-compose.yml ensure port 3000 is exposed
ports:
  - "3000:3000"
```

URL for Shortcuts: `http://<pi-ip>:3000`

## Creating a Shortcut in iOS

1. Open **Shortcuts.app** on iPhone
2. Create a new shortcut (tap `+`)
3. Add actions in the following order:

### Step 1: Record Audio

```
Actions → Audio → Record Audio
- Show when run: OFF
```

### Step 2: Send to Server

```
Actions → Web → Get Contents of URL
- URL: http://<SERVER_IP>:3000/audio
- Method: POST
- Request Body: File (drag "Recorded Audio" here)
- Headers:
  - Content-Type: audio/wav (or audio/ogg if using a different format)
  - Authorization: Bearer <your-api-key>
```

### Step 3: Display Response (optional)

```
Actions → Scripting → Show Result
```

## Example Shortcut with Script

For more complex logic, use Run JavaScript over HTTP:

```javascript
const audioData = shortcut.getVariable('RecordedAudio');
const response = await fetch('http://<SERVER_IP>:3000/audio', {
  method: 'POST',
  headers: {
    'Content-Type': 'audio/wav',
    Authorization: 'Bearer <your-api-key>',
  },
  body: audioData,
});
const result = await response.json();
console.log(result);
```

## Testing with curl

```bash
# Test with API key
curl -X POST \
  -H "Authorization: Bearer device1-key" \
  -H "Content-Type: audio/wav" \
  --data-binary @test.wav \
  http://localhost:3000/audio

# Health check
curl http://localhost:3000/health
```

## Audio Format

- Supported formats: WAV, OGG, MP3 (anything OpenAI API accepts)
- Recommended: WAV (16 kHz, 16 bit, mono)
- Maximum size: server-dependent (unlimited by default)

## Debugging

All received audio files are saved to `/tmp/audio-<timestamp>.wav` for analysis.

Server logs will show:

```
[http] Received audio POST
[http] Content-Type: audio/wav
[http] Content-Length: 44 bytes
[http] Saved to /tmp/audio-1777220549398.wav
```

## Security

⚠️ **Important:** By default, the HTTP server listens without authentication. Configure API keys to protect against unauthorized access.

### API Keys

Set the `HTTP_API_KEYS` environment variable with a comma-separated list of keys:

```bash
HTTP_API_KEYS="device1-key,device2-key,smartphone-key" npm run http
```

Each request to `/audio` must include the Authorization header:

```
Authorization: Bearer <your-key>
```

Example with curl:

```bash
curl -X POST \
  -H "Authorization: Bearer device1-key" \
  -H "Content-Type: audio/wav" \
  --data-binary @audio.wav \
  http://localhost:3000/audio
```

In Shortcuts.app, add the Authorization header in the "Get Contents of URL" action:

```
Headers:
  - Authorization: Bearer device1-key
```

### For Production on Internet

Additionally configure:

1. Reverse proxy with HTTPS (nginx, Caddy)
2. Rate limiting
3. Firewall rules to restrict access

## Next Steps

- Integration with Home Assistant for automation
- Command history storage
- Custom responses instead of just saving
