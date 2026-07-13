import "dotenv/config";
import { defaultConfig } from "./config/default-personality.js";
import { EnvSchema, parseAraConfig } from "./config/types.js";
import { loadPersonality } from "./ai/personality.js";
import { RealtimeClient } from "./ai/realtime.js";
import { AudioBridge } from "./audio/bridge.js";
import { HandoffHandler } from "./handoff/handler.js";
import { DailyClient } from "./meeting/daily-client.js";
import { StateMachine } from "./meeting/states.js";
import { AraSession } from "./session.js";

async function main(): Promise<void> {
  const env = EnvSchema.parse(process.env);
  const config = parseAraConfig({ ...defaultConfig, name: env.ARA_NAME });
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

  const session = new AraSession({
    config,
    stateMachine,
    bridge,
    realtime,
    daily,
    handoff,
  });

  await realtime.connect();
  session.start();
  await daily.connect();
}

main().catch((err) => {
  console.error("[ARA] fatal:", err);
  process.exit(1);
});
