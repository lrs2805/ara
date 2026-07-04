#!/usr/bin/env tsx
/**
 * Test OpenAI Realtime API in isolation.
 * Requires OPENAI_API_KEY in .env
 * Usage: npm run test:realtime
 */
import "dotenv/config";
import { RealtimeClient } from "../ai/realtime.js";
import { defaultConfig } from "../config/default-personality.js";
import { loadPersonality } from "../ai/personality.js";
import { EnvSchema } from "../config/types.js";

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  const personality = loadPersonality(defaultConfig);

  console.log("[test:realtime] connecting to OpenAI Realtime API...");

  const client = new RealtimeClient({
    apiKey: env.OPENAI_API_KEY,
    instructions: personality.instructions,
    voice: personality.voice,
  });

  let audioChunks = 0;

  client.on("connected", () => {
    console.log("[test:realtime] connected — sending test prompt via text");
    client.sendTextMessage(
      "Olá ARA, conta-me sobre o produto em duas frases.",
    );
  });

  client.on("audioDelta", (pcm) => {
    audioChunks++;
    console.log(`[test:realtime] audio delta #${audioChunks}: ${pcm.length} bytes`);
  });

  client.on("responseDone", () => {
    console.log(`[test:realtime] response done (${audioChunks} audio chunks)`);
    client.destroy();
    process.exit(0);
  });

  client.on("error", (err) => {
    console.error("[test:realtime] error:", err.message);
    client.destroy();
    process.exit(1);
  });

  await client.connect();

  setTimeout(() => {
    console.error("[test:realtime] timeout after 30s");
    client.destroy();
    process.exit(1);
  }, 30_000);
}

main().catch(console.error);
