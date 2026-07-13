import { EventEmitter } from "node:events";
import { SAMPLE_RATES, BUFFER_MS } from "../config/types.js";
import { resamplePcm16 } from "./resampler.js";
import { VoiceActivityDetector } from "./vad.js";

export interface AudioBridgeEvents {
  utterance: (pcm24k: Buffer) => void;
  speechStart: () => void;
}

export declare interface AudioBridge {
  on<K extends keyof AudioBridgeEvents>(
    event: K,
    listener: AudioBridgeEvents[K],
  ): this;
  emit<K extends keyof AudioBridgeEvents>(
    event: K,
    ...args: Parameters<AudioBridgeEvents[K]>
  ): boolean;
}

/**
 * Input modes:
 * - listening: full VAD (speech start + end → utterance)
 * - speaking: VAD stays on for barge-in (speechStart only triggers interrupt upstream)
 * - muted: ignore remote audio (PROCESSING)
 */
export type BridgeInputMode = "listening" | "speaking" | "muted";

export class AudioBridge extends EventEmitter {
  private vad: VoiceActivityDetector;
  private circularBuffer: Buffer[] = [];
  private circularBufferBytes = 0;
  private readonly maxBufferBytes: number;
  private mode: BridgeInputMode = "listening";

  constructor(options: { debugAudio?: boolean } = {}) {
    super();
    this.maxBufferBytes = Math.ceil(
      (SAMPLE_RATES.daily * 2 * BUFFER_MS) / 1000,
    );

    this.vad = new VoiceActivityDetector({
      debugAudio: options.debugAudio,
      onSpeechStart: () => {
        this.emit("speechStart");
      },
      onSpeechEnd: (utterance16k) => {
        // During SPEAKING barge-in, still accept the interrupting utterance
        if (this.mode === "muted") return;
        const pcm24k = resamplePcm16(
          utterance16k,
          SAMPLE_RATES.vad,
          SAMPLE_RATES.openai,
        );
        this.emit("utterance", pcm24k);
      },
    });
  }

  async init(): Promise<void> {
    await this.vad.init();
  }

  /** Receive PCM16 48kHz chunk from Daily browser bridge. */
  ingestRemoteAudio(pcm48k: Buffer): void {
    if (this.mode === "muted") return;

    this.pushCircular(pcm48k);
    this.vad.process(pcm48k, SAMPLE_RATES.daily);
  }

  /** Resample OpenAI output (24kHz) to Daily publish rate (48kHz). */
  prepareOutputAudio(pcm24k: Buffer): Buffer {
    return resamplePcm16(pcm24k, SAMPLE_RATES.openai, SAMPLE_RATES.daily);
  }

  setInputMode(mode: BridgeInputMode): void {
    this.mode = mode;
    const enabled = mode !== "muted";
    this.vad.setEnabled(enabled);
    if (!enabled) {
      this.circularBuffer = [];
      this.circularBufferBytes = 0;
    }
  }

  /** @deprecated Prefer setInputMode */
  setInputEnabled(enabled: boolean): void {
    this.setInputMode(enabled ? "listening" : "muted");
  }

  destroy(): void {
    this.vad.destroy();
    this.removeAllListeners();
  }

  private pushCircular(chunk: Buffer): void {
    this.circularBuffer.push(chunk);
    this.circularBufferBytes += chunk.length;

    while (this.circularBufferBytes > this.maxBufferBytes) {
      const removed = this.circularBuffer.shift();
      if (removed) {
        this.circularBufferBytes -= removed.length;
      }
    }
  }
}
