# ARA — AI Meeting Avatar

Autonomous AI voice agent that joins Daily.co video meetings, listens, responds, and handles sales conversations without the owner present.

## Quick Start

```bash
cp .env.example .env
# Fill in OPENAI_API_KEY, DAILY_API_KEY, DAILY_ROOM_URL

npm install
npm run dev
```

Open your Daily room in a browser, speak, and ARA responds by audio.

## Architecture

```
Daily Room → Puppeteer/daily-js → Audio Bridge → VAD (Silero) → GPT-4o Realtime → Daily Room
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | Yes | OpenAI key with Realtime API access |
| `DAILY_API_KEY` | Yes | Daily.co REST API key |
| `DAILY_ROOM_URL` | Yes | Full room URL to join |
| `ARA_NAME` | No | Bot display name (default: ARA) |
| `CHROME_PATH` | No | Path to Chrome/Chromium executable |
| `DEBUG_AUDIO` | No | Save VAD utterances as WAV (default: false) |

## Scripts

```bash
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm start            # Run compiled build
npm test             # Unit tests (Vitest)
npm run lint         # ESLint
npm run validate     # Smoke-load modules (+ optional API check)
npm run test:vad     # Test VAD in isolation
npm run test:realtime # Test OpenAI Realtime API
```

## Docker

```bash
docker compose up --build
```

Requires `.env` file with API keys.

## State Machine

```
IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING
                  ↘ ERROR → LISTENING
SPEAKING + interruption → LISTENING
* → HANDOFF → LISTENING (stub transfer; triggered by user ASR keywords)
```

## Validation Test

1. `npm run dev`
2. Join the Daily room from your browser
3. Say: "Olá ARA, conta-me sobre o produto"
4. ARA responds with audio

## Stack

- Node.js 22 + TypeScript
- Daily.co (Puppeteer + daily-js)
- OpenAI Realtime API (`gpt-realtime`)
- Silero VAD (avr-vad)
- Docker (Chrome + xvfb + pulseaudio)
