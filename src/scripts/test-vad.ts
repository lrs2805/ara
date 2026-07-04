#!/usr/bin/env tsx
/**
 * Test VAD in isolation — reads a WAV file or generates silence+tone.
 * Usage: npm run test:vad
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { VoiceActivityDetector } from "../audio/vad.js";
import { SAMPLE_RATES } from "../config/types.js";

async function main(): Promise<void> {
  console.log("[test:vad] initializing VAD...");

  let utteranceCount = 0;

  const vad = new VoiceActivityDetector({
    debugAudio: true,
    onSpeechStart: () => console.log("[test:vad] speech start"),
    onSpeechEnd: (pcm) => {
      utteranceCount++;
      console.log(
        `[test:vad] utterance #${utteranceCount}: ${pcm.length} bytes (${(pcm.length / 2 / SAMPLE_RATES.vad).toFixed(2)}s)`,
      );
    },
  });

  await vad.init();

  // Generate 3s of synthetic speech-like signal (440Hz tone bursts)
  const sampleRate = SAMPLE_RATES.daily;
  const durationSec = 3;
  const totalSamples = sampleRate * durationSec;
  const pcm = Buffer.alloc(totalSamples * 2);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const inSpeech = (t % 1.0) < 0.6;
    const sample = inSpeech ? Math.sin(2 * Math.PI * 440 * t) * 16000 : 0;
    pcm.writeInt16LE(Math.round(sample), i * 2);
  }

  const chunkSize = Math.floor(sampleRate * 0.2) * 2;
  for (let offset = 0; offset < pcm.length; offset += chunkSize) {
    vad.process(pcm.subarray(offset, offset + chunkSize), sampleRate);
    await new Promise((r) => setTimeout(r, 50));
  }

  // Silence to trigger end-of-speech
  const silence = Buffer.alloc(chunkSize);
  for (let i = 0; i < 10; i++) {
    vad.process(silence, sampleRate);
    await new Promise((r) => setTimeout(r, 200));
  }

  vad.destroy();

  mkdirSync("/tmp/ara-debug", { recursive: true });
  writeFileSync("/tmp/ara-debug/test-input.raw", pcm);
  console.log(`[test:vad] done — ${utteranceCount} utterances detected`);
  console.log("[test:vad] debug WAVs in /tmp/ara-debug/");
}

main().catch(console.error);
