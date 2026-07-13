import "dotenv/config";
import { defaultConfig } from "./config/default-personality.js";
import { EnvSchema, SPEAKING_TIMEOUT_MS } from "./config/types.js";
import { loadPersonality } from "./ai/personality.js";
import { RealtimeClient } from "./ai/realtime.js";
import { AudioBridge } from "./audio/bridge.js";
import { HandoffHandler } from "./handoff/handler.js";
import { DailyClient } from "./meeting/daily-client.js";
import { AraState, StateMachine } from "./meeting/states.js";

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  const config = { ...defaultConfig, name: env.ARA_NAME };
  const personality = loadPersonality(config);

  console.log(`[ARA] starting ${config.name}...`);
  console.log(`[ARA] room: ${env.DAILY_ROOM_URL}`);

  const stateMachine = new StateMachine();
  const handoff = new HandoffHandler(config);
  const bridge = new AudioBridge({ debugAudio: env.DEBUG_AUDIO });
  await bridge.init();

  const realtime = new RealtimeClient({
    apiKey: env.OPENAI_API_KEY,
    instructions: personality.instructions,
    voice: personality.voice,
  });

  const daily = new DailyClient({
    roomUrl: env.DAILY_ROOM_URL,
    userName: config.name,
    apiKey: env.DAILY_API_KEY,
    chromePath: env.CHROME_PATH,
  });

  let speakingTimer: ReturnType<typeof setTimeout> | null = null;
  let outputQueue: Buffer[] = [];
  let isPlayingOutput = false;
  /** Model stream finished; wait for browser playback to drain before LISTENING. */
  let responseStreamDone = false;
  /** At least one TTS chunk was scheduled for this response. */
  let hasScheduledAudio = false;
  let shuttingDown = false;

  // --- State machine side effects ---
  stateMachine.on("transition", (_from, to) => {
    switch (to) {
      case AraState.LISTENING:
        bridge.setInputMode("listening");
        responseStreamDone = false;
        hasScheduledAudio = false;
        break;
      case AraState.PROCESSING:
        bridge.setInputMode("muted");
        responseStreamDone = false;
        hasScheduledAudio = false;
        break;
      case AraState.SPEAKING:
        bridge.setInputMode("speaking");
        startSpeakingTimer();
        break;
      case AraState.ERROR:
        bridge.setInputMode("listening");
        responseStreamDone = false;
        hasScheduledAudio = false;
        break;
    }
  });

  function startSpeakingTimer(): void {
    if (speakingTimer) clearTimeout(speakingTimer);
    speakingTimer = setTimeout(() => {
      console.warn("[ARA] speaking timeout");
      realtime.cancelResponse();
      void daily.stopPlayback();
      outputQueue = [];
      stateMachine.transition(AraState.LISTENING);
    }, SPEAKING_TIMEOUT_MS);
  }

  function clearSpeakingTimer(): void {
    if (speakingTimer) {
      clearTimeout(speakingTimer);
      speakingTimer = null;
    }
  }

  /** Enter LISTENING only after model done AND local TTS queue drained AND browser finished playing. */
  function tryEnterListeningAfterPlayback(): void {
    if (!responseStreamDone) return;
    if (outputQueue.length > 0 || isPlayingOutput) return;
    if (!stateMachine.isSpeaking()) return;

    if (hasScheduledAudio) {
      // Browser will emit playbackDone when BufferSources finish
      return;
    }

    clearSpeakingTimer();
    stateMachine.transition(AraState.LISTENING);
  }

  async function playOutputQueue(): Promise<void> {
    if (isPlayingOutput) return;
    isPlayingOutput = true;

    while (outputQueue.length > 0) {
      const chunk = outputQueue.shift()!;
      const pcm48k = bridge.prepareOutputAudio(chunk);
      await daily.publishAudio(pcm48k);
    }

    isPlayingOutput = false;
    tryEnterListeningAfterPlayback();
  }

  function interruptSpeaking(reason: string): void {
    console.log(`[ARA] interruption: ${reason}`);
    realtime.cancelResponse();
    outputQueue = [];
    responseStreamDone = false;
    hasScheduledAudio = false;
    clearSpeakingTimer();
    void daily.stopPlayback();
    stateMachine.transition(AraState.LISTENING);
  }

  // --- OpenAI Realtime ---
  await realtime.connect();

  realtime.on("audioDelta", (pcm24k) => {
    if (stateMachine.state === AraState.PROCESSING) {
      stateMachine.transition(AraState.SPEAKING);
    }
    if (!stateMachine.isSpeaking()) return;
    hasScheduledAudio = true;
    outputQueue.push(pcm24k);
    void playOutputQueue();
  });

  realtime.on("responseDone", () => {
    responseStreamDone = true;
    tryEnterListeningAfterPlayback();
  });

  realtime.on("error", (err) => {
    console.error("[ARA] OpenAI error:", err.message);
    outputQueue = [];
    responseStreamDone = false;
    hasScheduledAudio = false;
    void daily.stopPlayback();
    if (stateMachine.transition(AraState.ERROR)) {
      setTimeout(() => stateMachine.transition(AraState.LISTENING), 1000);
    }
  });

  // --- Barge-in: speech while ARA is speaking ---
  bridge.on("speechStart", () => {
    if (stateMachine.isSpeaking()) {
      interruptSpeaking("remote speech_start");
    }
  });

  // --- Audio Bridge → OpenAI ---
  bridge.on("utterance", (pcm24k) => {
    if (stateMachine.isSpeaking()) {
      interruptSpeaking("remote utterance during speak");
    }

    if (!stateMachine.isListening()) {
      return;
    }

    stateMachine.transition(AraState.PROCESSING);
    realtime.clearInputBuffer();
    realtime.appendAudio(pcm24k);
    realtime.commitAudio();
    realtime.createResponse();
  });

  // --- Daily remote audio → Bridge ---
  daily.on("remoteAudio", (pcm48k) => {
    bridge.ingestRemoteAudio(pcm48k);
  });

  daily.on("joined", () => {
    if (
      stateMachine.state === AraState.IDLE ||
      stateMachine.state === AraState.ERROR
    ) {
      stateMachine.transition(AraState.LISTENING);
    }
  });

  daily.on("playbackDone", () => {
    console.log("[ARA] playback drained");
    if (!responseStreamDone) return;
    if (outputQueue.length > 0 || isPlayingOutput) return;
    if (!stateMachine.isSpeaking()) return;
    clearSpeakingTimer();
    stateMachine.transition(AraState.LISTENING);
  });

  daily.on("participantJoined", (name) => {
    console.log(`[Daily] participant joined: ${name}`);
  });

  daily.on("trackStarted", (participant) => {
    console.log(`[Daily] audio track from: ${participant}`);
  });

  daily.on("error", (err) => {
    console.error("[Daily] error:", err.message);
    if (stateMachine.transition(AraState.ERROR)) {
      setTimeout(() => {
        if (stateMachine.state === AraState.ERROR) {
          stateMachine.transition(AraState.LISTENING);
        }
      }, 2000);
    }
  });

  // --- Handoff ---
  handoff.on("triggered", (trigger) => {
    console.log(`[Handoff] would transfer to human (trigger: ${trigger})`);
    stateMachine.transition(AraState.HANDOFF);
    setTimeout(() => stateMachine.transition(AraState.LISTENING), 2000);
  });

  // --- Connect to Daily room ---
  await daily.connect();

  // --- Max call duration ---
  const maxDuration = config.limits.maxCallDuration * 1000;
  const maxDurationTimer = setTimeout(() => {
    console.log("[ARA] max call duration reached, shutting down");
    void shutdown();
  }, maxDuration);

  // --- Graceful shutdown ---
  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(maxDurationTimer);
    clearSpeakingTimer();
    console.log("[ARA] shutting down...");
    bridge.destroy();
    realtime.destroy();
    await daily.disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  console.log("[ARA] ready — waiting for participants to speak");
}

main().catch((err) => {
  console.error("[ARA] fatal:", err);
  process.exit(1);
});
