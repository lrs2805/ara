# AGENTS.md

## Cursor Cloud specific instructions

ARA is a **single Node.js 22 + TypeScript service** — an autonomous voice agent that
uses Puppeteer + `daily-js` to join a Daily.co room, runs Silero VAD on remote audio,
and talks to the OpenAI Realtime API. There is one process, no database, no web server
to browse. See `README.md` for the architecture, scripts, and env-var reference.

### Running things
- Standard commands are in `package.json` scripts and `README.md`; don't duplicate them here.
- Dependencies are installed by the startup update script (`npm ci`). No extra setup is needed for
  lint/build/test/validate.
- `npm run lint`, `npm run build`, and `npm test` (Vitest, 19 unit tests) all run offline with no secrets.
- `npm run validate` and `npm run test:vad` also run offline; they initialize the real Silero VAD model.

### Non-obvious caveats
- **`npm run dev` / `npm start` require three secrets** and fail immediately at startup with a Zod
  error if any are missing: `OPENAI_API_KEY`, `DAILY_API_KEY`, `DAILY_ROOM_URL`. Env is validated by
  `EnvSchema` in `src/config/types.ts` *before* anything else runs, so there is no partial boot without them.
- **Chrome is already installed** at `/usr/bin/google-chrome-stable` (also `/usr/local/bin/google-chrome`).
  `puppeteer-core` auto-detects it via `resolveChromePath()`; `CHROME_PATH` only needs setting if you use a
  different binary. Do not add `google-chrome` to the update script — it is a system dependency baked into
  the base image.
- **`npm run test:vad` reports `0 utterances` by design** — it feeds a pure 440 Hz sine tone, which Silero
  correctly rejects as non-speech. That is a passing run, not a failure. Real (or speech-like) audio does
  trigger detection.
- Silero VAD frames are 512 samples @ 16 kHz; audio is resampled 48 kHz (Daily) → 16 kHz (VAD) → 24 kHz (OpenAI).
- ESM + `NodeNext`: intra-repo imports must use `.js` extensions even though sources are `.ts`.
- Debug WAVs (when `DEBUG_AUDIO=true`) are written to `/tmp/ara-debug/`.

### Testing the full product end-to-end
Requires the three secrets above **plus** a live Daily room. With them set, `npm run dev` launches headless
Chrome, joins the room, and the validation flow is: join the Daily room from a browser, say
"Olá ARA, conta-me sobre o produto", and ARA replies with audio. Without the secrets, the closest offline
proof of core functionality is `npm run validate` (loads all modules + inits VAD) and feeding speech into
the `VoiceActivityDetector` (emits speech-start / utterance events).
