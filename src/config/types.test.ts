import { describe, expect, it } from "vitest";
import { defaultConfig } from "./default-personality.js";
import { AraConfigSchema, parseAraConfig } from "./types.js";

describe("parseAraConfig", () => {
  it("accepts the default personality config", () => {
    const parsed = parseAraConfig(defaultConfig);
    expect(parsed.name).toBe("ARA");
    expect(parsed.limits.handoffTriggers.length).toBeGreaterThan(0);
  });

  it("applies Zod defaults for optional fields", () => {
    const parsed = AraConfigSchema.parse({
      pitch: {
        opening: "oi",
        valueProposition: "valor",
        caseStudies: [],
        pricingOverview: "preço",
      },
      objections: {},
      limits: { handoffTriggers: ["humano"] },
    });
    expect(parsed.name).toBe("ARA");
    expect(parsed.voice).toBe("alloy");
    expect(parsed.personality.tone).toBe("consultivo");
    expect(parsed.limits.maxCallDuration).toBe(1800);
  });

  it("rejects invalid personality speed", () => {
    expect(() =>
      parseAraConfig({
        ...defaultConfig,
        personality: { tone: "consultivo", speed: 9 },
      }),
    ).toThrow();
  });
});
