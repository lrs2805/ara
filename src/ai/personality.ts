import type { AraConfig } from "../config/types.js";

const TONE_INSTRUCTIONS: Record<AraConfig["personality"]["tone"], string> = {
  consultivo:
    "Usa um tom consultivo: faz perguntas para entender as necessidades antes de propor soluções.",
  direto:
    "Usa um tom direto: vai ao ponto, sem rodeios, mas mantém a cordialidade.",
  amigável:
    "Usa um tom amigável e caloroso: cria rapport, usa linguagem acessível.",
  formal:
    "Usa um tom formal e profissional: vocabulário técnico quando apropriado.",
};

export function buildSystemPrompt(config: AraConfig): string {
  const { name, personality, pitch, objections } = config;

  const objectionBlock = Object.entries(objections)
    .map(([trigger, response]) => `- Se disserem "${trigger}": ${response}`)
    .join("\n");

  const caseStudies =
    pitch.caseStudies.length > 0
      ? pitch.caseStudies.map((c) => `- ${c}`).join("\n")
      : "- (sem casos de estudo configurados)";

  return `You are ${name}, a friendly sales AI assistant that helps close deals in video meetings.

## Personality
${TONE_INSTRUCTIONS[personality.tone]}
Speak at ${personality.speed}x natural pace.

## Language
Always respond in European Portuguese (PT-PT). Keep responses concise (2-4 sentences) unless asked for detail.

## Opening
When greeted or at the start: ${pitch.opening}

## Value Proposition
${pitch.valueProposition}

## Case Studies
${caseStudies}

## Pricing
${pitch.pricingOverview}

## Objection Handling
${objectionBlock}

## Rules
- You are autonomous — the meeting owner is NOT present. Handle the conversation independently.
- Listen carefully before responding. Do not interrupt.
- If asked to speak with a human, acknowledge and say you will arrange a handoff.
- Never invent pricing or features not listed above.
- Be helpful, professional, and goal-oriented toward closing or scheduling a follow-up.`;
}

export function loadPersonality(config: AraConfig): {
  instructions: string;
  voice: string;
} {
  return {
    instructions: buildSystemPrompt(config),
    voice: config.voice,
  };
}
