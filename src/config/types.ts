import { z } from "zod";

export const PersonalityToneSchema = z.enum([
  "consultivo",
  "direto",
  "amigável",
  "formal",
]);

export const AraConfigSchema = z.object({
  name: z.string().default("ARA"),
  voice: z.string().default("alloy"),
  personality: z
    .object({
      tone: PersonalityToneSchema.default("consultivo"),
      speed: z.number().min(0.5).max(2).default(1.0),
    })
    .default({ tone: "consultivo", speed: 1.0 }),
  pitch: z.object({
    opening: z.string(),
    valueProposition: z.string(),
    caseStudies: z.array(z.string()),
    pricingOverview: z.string(),
  }),
  objections: z.record(z.string(), z.string()),
  limits: z.object({
    maxCallDuration: z.number().default(1800),
    handoffTriggers: z.array(z.string()),
  }),
});

export type AraConfig = z.infer<typeof AraConfigSchema>;
export type PersonalityTone = z.infer<typeof PersonalityToneSchema>;

export const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1),
  DAILY_API_KEY: z.string().min(1),
  DAILY_ROOM_URL: z.string().url(),
  ARA_NAME: z.string().default("ARA"),
  CHROME_PATH: z.string().optional(),
  DEBUG_AUDIO: z
    .string()
    .optional()
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof EnvSchema>;

export const SAMPLE_RATES = {
  daily: 48000,
  vad: 16000,
  openai: 24000,
} as const;

/** End-of-utterance silence before committing speech (lower = snappier replies). */
export const VAD_SILENCE_MS = 700;
export const SPEAKING_TIMEOUT_MS = 60_000;
/** How long to stay muted in HANDOFF waiting for a human before soft-resume. */
export const HANDOFF_HOLD_MS = 120_000;
/** Time-to-first-audio timeout — cleared when first audio delta arrives. */
export const OPENAI_TTFT_TIMEOUT_MS = 10_000;
/** Absolute max for a single model response stream. */
export const OPENAI_RESPONSE_TIMEOUT_MS = 60_000;
export const OPENAI_RECONNECT_MS = 55 * 60 * 1000;

/** Validate and normalize ARA runtime config (fails closed on bad input). */
export function parseAraConfig(input: unknown): AraConfig {
  return AraConfigSchema.parse(input);
}
