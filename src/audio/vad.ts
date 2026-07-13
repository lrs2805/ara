import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RealTimeVAD } from "avr-vad";
import { SAMPLE_RATES, VAD_SILENCE_MS } from "../config/types.js";
import { pcm16ToFloat32, resamplePcm16 } from "./resampler.js";

export interface VadOptions {
  silenceMs?: number;
  debugAudio?: boolean;
  onSpeechStart?: () => void;
  onSpeechEnd?: (utterance: Buffer) => void;
}

// ~32ms per frame at 16kHz with 512 samples (avr-vad v5 default)
const FRAME_SAMPLES = 512;
const FRAME_MS = (FRAME_SAMPLES / SAMPLE_RATES.vad) * 1000;

export class VoiceActivityDetector {
  private vad: RealTimeVAD | null = null;
  private enabled = true;
  private leftover: Float32Array = new Float32Array(0);
  private readonly silenceMs: number;
  private readonly debugAudio: boolean;
  private readonly onSpeechStart?: () => void;
  private readonly onSpeechEnd?: (utterance: Buffer) => void;

  constructor(options: VadOptions = {}) {
    this.silenceMs = options.silenceMs ?? VAD_SILENCE_MS;
    this.debugAudio = options.debugAudio ?? false;
    this.onSpeechStart = options.onSpeechStart;
    this.onSpeechEnd = options.onSpeechEnd;
  }

  async init(): Promise<void> {
    const redemptionFrames = Math.ceil(this.silenceMs / FRAME_MS);

    this.vad = await RealTimeVAD.new({
      model: "v5",
      positiveSpeechThreshold: 0.5,
      negativeSpeechThreshold: 0.35,
      preSpeechPadFrames: 2,
      redemptionFrames,
      frameSamples: FRAME_SAMPLES,
      minSpeechFrames: 3,
      onSpeechStart: () => {
        this.onSpeechStart?.();
        console.log("[VAD] speech started");
      },
      onSpeechEnd: (audio: Float32Array) => {
        const pcm = float32ToPcm16Buffer(audio);
        this.onSpeechEnd?.(pcm);
        if (this.debugAudio) {
          this.saveDebugWav(pcm);
        }
        console.log(
          `[VAD] speech ended (${(pcm.length / 2 / SAMPLE_RATES.vad).toFixed(2)}s)`,
        );
      },
    });

    await this.vad.start();
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.leftover = new Float32Array(0);
    }
  }

  /** Process PCM16 audio at the given sample rate (typically 48kHz from Daily). */
  process(pcm48k: Buffer, inputRate = SAMPLE_RATES.daily): void {
    if (!this.enabled || !this.vad) return;

    const pcm16k = resamplePcm16(pcm48k, inputRate, SAMPLE_RATES.vad);
    const float32 = pcm16ToFloat32(pcm16k);

    const merged = new Float32Array(this.leftover.length + float32.length);
    merged.set(this.leftover, 0);
    merged.set(float32, this.leftover.length);

    let offset = 0;
    while (offset + FRAME_SAMPLES <= merged.length) {
      const frame = merged.subarray(offset, offset + FRAME_SAMPLES);
      this.vad.processAudio(frame);
      offset += FRAME_SAMPLES;
    }

    this.leftover = merged.subarray(offset);
  }

  destroy(): void {
    this.vad?.destroy();
    this.vad = null;
    this.leftover = new Float32Array(0);
  }

  private saveDebugWav(pcm: Buffer): void {
    const dir = "/tmp/ara-debug";
    mkdirSync(dir, { recursive: true });
    const filename = join(dir, `utterance-${Date.now()}.wav`);
    writeFileSync(filename, createWav(pcm, SAMPLE_RATES.vad));
    console.log(`[VAD] debug saved: ${filename}`);
  }
}

function float32ToPcm16Buffer(data: Float32Array): Buffer {
  const buf = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

function createWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm]);
}
