import { HANDOFF_HOLD_MS, SPEAKING_TIMEOUT_MS } from "./config/types.js";
import type { AraConfig } from "./config/types.js";
import type { RealtimeClient } from "./ai/realtime.js";
import type { AudioBridge } from "./audio/bridge.js";
import type { HandoffHandler } from "./handoff/handler.js";
import type { DailyClient } from "./meeting/daily-client.js";
import { AraState, type StateMachine } from "./meeting/states.js";

const ERROR_RECOVER_MS = 1000;
const DAILY_ERROR_RECOVER_MS = 2000;

const HANDOFF_PROMPT =
  "O utilizador pediu para falar com um humano. Confirma em 1-2 frases em português europeu que vais transferir a chamada e pede que aguarde um momento.";

export interface AraSessionDeps {
  config: AraConfig;
  stateMachine: StateMachine;
  bridge: AudioBridge;
  realtime: RealtimeClient;
  daily: DailyClient;
  handoff: HandoffHandler;
}

/**
 * Owns turn-taking, TTS queue, barge-in, handoff, and recovery side effects.
 * Composition root (`index.ts`) builds dependencies; this class wires them.
 */
export class AraSession {
  private readonly config: AraConfig;
  private readonly stateMachine: StateMachine;
  private readonly bridge: AudioBridge;
  private readonly realtime: RealtimeClient;
  private readonly daily: DailyClient;
  private readonly handoff: HandoffHandler;

  private speakingTimer: ReturnType<typeof setTimeout> | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private handoffHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private errorRecoverTimer: ReturnType<typeof setTimeout> | null = null;
  private outputQueue: Buffer[] = [];
  private isPlayingOutput = false;
  /** Model stream finished; wait for browser playback to drain before LISTENING. */
  private responseStreamDone = false;
  /** At least one TTS chunk was scheduled for this response. */
  private hasScheduledAudio = false;
  /** True while waiting muted for a human after handoff announcement. */
  private handoffPending = false;
  private shuttingDown = false;
  private started = false;

  constructor(deps: AraSessionDeps) {
    this.config = deps.config;
    this.stateMachine = deps.stateMachine;
    this.bridge = deps.bridge;
    this.realtime = deps.realtime;
    this.daily = deps.daily;
    this.handoff = deps.handoff;
  }

  /** Wire event handlers. Call after deps are connected (realtime/daily ready). */
  start(): void {
    if (this.started) return;
    this.started = true;

    this.stateMachine.on("transition", (_from, to) => {
      this.onStateTransition(to);
    });

    this.realtime.on("audioDelta", (pcm24k) => this.onAudioDelta(pcm24k));
    this.realtime.on("responseDone", () => this.onResponseDone());
    this.realtime.on("inputTranscript", (text) => this.onInputTranscript(text));
    this.realtime.on("sessionRestored", (n) => {
      if (n > 0) console.log(`[ARA] conversation restored (${n} turns)`);
    });
    this.realtime.on("error", (err) => this.onRealtimeError(err));

    this.bridge.on("speechStart", () => {
      if (this.handoffPending) return;
      if (this.stateMachine.isSpeaking()) {
        this.interruptSpeaking("remote speech_start");
      }
    });

    this.bridge.on("utterance", (pcm24k) => this.onUtterance(pcm24k));

    this.daily.on("remoteAudio", (pcm48k) => {
      this.bridge.ingestRemoteAudio(pcm48k);
    });

    this.daily.on("joined", () => {
      if (
        this.stateMachine.state === AraState.IDLE ||
        this.stateMachine.state === AraState.ERROR
      ) {
        this.stateMachine.transition(AraState.LISTENING);
      }
    });

    this.daily.on("playbackDone", () => this.onPlaybackDone());

    this.daily.on("participantJoined", (name) => {
      console.log(`[Daily] participant joined: ${name}`);
      if (this.handoffPending) {
        console.log(
          `[Handoff] human may have joined (${name}) — bot stays muted`,
        );
      }
    });

    this.daily.on("trackStarted", (participant) => {
      console.log(`[Daily] audio track from: ${participant}`);
    });

    this.daily.on("error", (err) => this.onDailyError(err));

    this.handoff.on("triggered", (trigger, transcript) => {
      this.onHandoffTriggered(trigger, transcript);
    });

    const maxDuration = this.config.limits.maxCallDuration * 1000;
    this.maxDurationTimer = setTimeout(() => {
      console.log("[ARA] max call duration reached, shutting down");
      void this.shutdown();
    }, maxDuration);

    process.on("SIGINT", () => void this.shutdown());
    process.on("SIGTERM", () => void this.shutdown());

    console.log("[ARA] ready — waiting for participants to speak");
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.maxDurationTimer) clearTimeout(this.maxDurationTimer);
    if (this.handoffHoldTimer) clearTimeout(this.handoffHoldTimer);
    if (this.errorRecoverTimer) clearTimeout(this.errorRecoverTimer);
    this.clearSpeakingTimer();

    console.log("[ARA] shutting down...");
    this.bridge.destroy();
    this.realtime.destroy();
    await this.daily.disconnect();
    process.exit(0);
  }

  private onStateTransition(to: AraState): void {
    switch (to) {
      case AraState.LISTENING:
        this.bridge.setInputMode("listening");
        this.responseStreamDone = false;
        this.hasScheduledAudio = false;
        break;
      case AraState.PROCESSING:
        this.bridge.setInputMode("muted");
        this.responseStreamDone = false;
        this.hasScheduledAudio = false;
        break;
      case AraState.SPEAKING:
        // Keep input muted during handoff announcement; otherwise enable barge-in.
        this.bridge.setInputMode(this.handoffPending ? "muted" : "speaking");
        this.startSpeakingTimer();
        break;
      case AraState.HANDOFF:
        this.bridge.setInputMode("muted");
        this.responseStreamDone = false;
        this.hasScheduledAudio = false;
        break;
      case AraState.ERROR:
        this.bridge.setInputMode("listening");
        this.responseStreamDone = false;
        this.hasScheduledAudio = false;
        break;
    }
  }

  private startSpeakingTimer(): void {
    if (this.speakingTimer) clearTimeout(this.speakingTimer);
    this.speakingTimer = setTimeout(() => {
      console.warn("[ARA] speaking timeout");
      this.realtime.cancelResponse();
      void this.daily.stopPlayback();
      this.outputQueue = [];
      this.finishSpeakingTurn();
    }, SPEAKING_TIMEOUT_MS);
  }

  private clearSpeakingTimer(): void {
    if (this.speakingTimer) {
      clearTimeout(this.speakingTimer);
      this.speakingTimer = null;
    }
  }

  /** After TTS drains: resume LISTENING, or return to HANDOFF hold. */
  private finishSpeakingTurn(): void {
    this.clearSpeakingTimer();
    if (this.handoffPending) {
      this.stateMachine.transition(AraState.HANDOFF);
      return;
    }
    this.stateMachine.transition(AraState.LISTENING);
  }

  /** Enter post-speak state only after model done AND local TTS queue drained AND browser finished playing. */
  private tryFinishAfterPlayback(): void {
    if (!this.responseStreamDone) return;
    if (this.outputQueue.length > 0 || this.isPlayingOutput) return;
    if (!this.stateMachine.isSpeaking()) return;

    if (this.hasScheduledAudio) {
      // Browser will emit playbackDone when BufferSources finish
      return;
    }

    this.finishSpeakingTurn();
  }

  private async playOutputQueue(): Promise<void> {
    if (this.isPlayingOutput) return;
    this.isPlayingOutput = true;

    while (this.outputQueue.length > 0) {
      const chunk = this.outputQueue.shift()!;
      const pcm48k = this.bridge.prepareOutputAudio(chunk);
      await this.daily.publishAudio(pcm48k);
    }

    this.isPlayingOutput = false;
    this.tryFinishAfterPlayback();
  }

  private interruptSpeaking(reason: string): void {
    console.log(`[ARA] interruption: ${reason}`);
    this.realtime.cancelResponse();
    this.outputQueue = [];
    this.responseStreamDone = false;
    this.hasScheduledAudio = false;
    this.clearSpeakingTimer();
    void this.daily.stopPlayback();
    this.stateMachine.transition(AraState.LISTENING);
  }

  private onAudioDelta(pcm24k: Buffer): void {
    if (this.stateMachine.state === AraState.PROCESSING) {
      this.stateMachine.transition(AraState.SPEAKING);
    } else if (
      this.stateMachine.state === AraState.HANDOFF &&
      this.handoffPending
    ) {
      // Announcement audio after handoff trigger
      this.stateMachine.transition(AraState.SPEAKING);
    }
    if (!this.stateMachine.isSpeaking()) return;
    this.hasScheduledAudio = true;
    this.outputQueue.push(pcm24k);
    void this.playOutputQueue();
  }

  private onResponseDone(): void {
    this.responseStreamDone = true;
    this.tryFinishAfterPlayback();
  }

  private onInputTranscript(text: string): void {
    console.log(`[ARA] user transcript: ${text}`);
    if (this.handoffPending || this.stateMachine.state === AraState.HANDOFF) {
      return;
    }
    this.handoff.checkTranscript(text);
  }

  private onRealtimeError(err: Error): void {
    console.error("[ARA] OpenAI error:", err.message);
    this.outputQueue = [];
    this.responseStreamDone = false;
    this.hasScheduledAudio = false;
    void this.daily.stopPlayback();
    if (this.stateMachine.transition(AraState.ERROR)) {
      if (this.errorRecoverTimer) clearTimeout(this.errorRecoverTimer);
      this.errorRecoverTimer = setTimeout(() => {
        this.handoffPending = false;
        this.stateMachine.transition(AraState.LISTENING);
      }, ERROR_RECOVER_MS);
    }
  }

  private onUtterance(pcm24k: Buffer): void {
    if (this.handoffPending) return;

    if (this.stateMachine.isSpeaking()) {
      this.interruptSpeaking("remote utterance during speak");
    }

    if (!this.stateMachine.isListening()) {
      return;
    }

    this.stateMachine.transition(AraState.PROCESSING);
    this.realtime.clearInputBuffer();
    this.realtime.appendAudio(pcm24k);
    this.realtime.commitAudio();
    this.realtime.createResponse();
  }

  private onPlaybackDone(): void {
    console.log("[ARA] playback drained");
    if (!this.responseStreamDone) return;
    if (this.outputQueue.length > 0 || this.isPlayingOutput) return;
    if (!this.stateMachine.isSpeaking()) return;
    this.finishSpeakingTurn();
  }

  private onDailyError(err: Error): void {
    console.error("[Daily] error:", err.message);
    if (this.stateMachine.transition(AraState.ERROR)) {
      if (this.errorRecoverTimer) clearTimeout(this.errorRecoverTimer);
      this.errorRecoverTimer = setTimeout(() => {
        if (this.stateMachine.state === AraState.ERROR) {
          this.handoffPending = false;
          this.stateMachine.transition(AraState.LISTENING);
        }
      }, DAILY_ERROR_RECOVER_MS);
    }
  }

  private onHandoffTriggered(trigger: string, transcript?: string): void {
    if (this.handoffPending) return;

    console.log(
      `[Handoff] transferring (trigger: ${trigger}${transcript ? `, transcript: "${transcript}"` : ""})`,
    );

    this.realtime.cancelResponse();
    this.outputQueue = [];
    this.responseStreamDone = false;
    this.hasScheduledAudio = false;
    this.clearSpeakingTimer();
    void this.daily.stopPlayback();

    this.handoffPending = true;
    if (!this.stateMachine.transition(AraState.HANDOFF)) {
      // Try from current state via ERROR path is worse; force soft hold anyway
      this.handoffPending = false;
      return;
    }

    // Speak a short acknowledgment, then stay muted waiting for a human.
    this.realtime.promptModel(HANDOFF_PROMPT);

    if (this.handoffHoldTimer) clearTimeout(this.handoffHoldTimer);
    this.handoffHoldTimer = setTimeout(() => {
      console.log(
        "[Handoff] no human transfer completed — soft resume listening",
      );
      this.handoffPending = false;
      if (
        this.stateMachine.state === AraState.HANDOFF ||
        this.stateMachine.state === AraState.SPEAKING
      ) {
        this.realtime.cancelResponse();
        void this.daily.stopPlayback();
        this.outputQueue = [];
        this.stateMachine.transition(AraState.LISTENING);
      }
    }, HANDOFF_HOLD_MS);
  }
}
