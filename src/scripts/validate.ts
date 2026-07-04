#!/usr/bin/env tsx
/**
 * Smoke test — validates all modules load and optional API connectivity.
 * Usage: npm run validate
 */
import "dotenv/config";
import { defaultConfig } from "../config/default-personality.js";
import { loadPersonality } from "../ai/personality.js";
import { AudioBridge } from "../audio/bridge.js";
import { resamplePcm16 } from "../audio/resampler.js";
import { HandoffHandler } from "../handoff/handler.js";
import { AraState, StateMachine } from "../meeting/states.js";

async function main(): Promise<void> {
  console.log("[validate] checking modules...");

  const sm = new StateMachine();
  sm.transition(AraState.LISTENING);
  console.log("[validate] state machine OK");

  const personality = loadPersonality(defaultConfig);
  console.log(`[validate] personality OK (${personality.instructions.length} chars)`);

  const bridge = new AudioBridge();
  await bridge.init();
  bridge.destroy();
  console.log("[validate] audio bridge OK");

  const handoff = new HandoffHandler(defaultConfig);
  const triggered = handoff.checkTranscript("quero falar com humano");
  console.log(`[validate] handoff OK (triggered=${triggered})`);

  const pcm = Buffer.alloc(960);
  const resampled = resamplePcm16(pcm, 48000, 24000);
  console.log(`[validate] resampler OK (${pcm.length} → ${resampled.length})`);

  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasDaily = !!process.env.DAILY_API_KEY && !!process.env.DAILY_ROOM_URL;

  console.log(`[validate] OPENAI_API_KEY: ${hasOpenAI ? "set" : "missing"}`);
  console.log(`[validate] DAILY_ROOM_URL: ${hasDaily ? "set" : "missing"}`);

  if (hasOpenAI) {
    const { RealtimeClient } = await import("../ai/realtime.js");
    const client = new RealtimeClient({
      apiKey: process.env.OPENAI_API_KEY!,
      instructions: personality.instructions,
      voice: personality.voice,
    });

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("connect timeout")), 15_000);
      client.on("connected", () => {
        clearTimeout(timeout);
        console.log("[validate] OpenAI Realtime connected");
        client.destroy();
        resolve();
      });
      client.on("error", reject);
      client.connect().catch(reject);
    });
  }

  console.log("[validate] all checks passed");
}

main().catch((err) => {
  console.error("[validate] failed:", err);
  process.exit(1);
});
