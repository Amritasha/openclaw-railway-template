# OpenClaw Railway Template

One-click Railway deployment for [OpenClaw](https://github.com/openclaw/openclaw) — your self-hosted personal AI assistant.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/YOUR_TEMPLATE_ID)

## What's included

- OpenClaw gateway running inside a Docker container
- Password-protected `/setup` wizard to configure your AI provider
- Automatic proxy to the OpenClaw Control UI at `/openclaw`
- Persistent storage via Railway Volume (config & workspace survive redeploys)
- Health check at `/healthz`

## Deploy in 3 steps

1. **Click Deploy** — Railway builds and starts the container.
2. **Add a Volume** — In your service settings, attach a volume mounted at `/data`.
3. **Set env vars** — At minimum set `SETUP_PASSWORD`. See variables below.

## Required environment variables

| Variable | Description |
|---|---|
| `SETUP_PASSWORD` | Password to access `/setup`. Generate: `openssl rand -base64 18` |
| `OPENCLAW_STATE_DIR` | Must be `/data/.openclaw` (inside the volume) |
| `OPENCLAW_WORKSPACE_DIR` | Must be `/data/workspace` (inside the volume) |

## Recommended variables

| Variable | Description |
|---|---|
| `OPENCLAW_GATEWAY_TOKEN` | Stable admin token. Generate: `openssl rand -hex 32` |

## After deployment

1. Visit `https://your-app.up.railway.app/setup` and log in.
2. Enter your AI provider API key and save.
3. Click **Open OpenClaw UI** to connect your channels (Telegram, WhatsApp, Slack, etc.).

## Local development

```bash
cp .env.example .env
# Edit .env with your values
npm install
node src/server.js
```

## License

MIT
