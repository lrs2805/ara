import { describe, expect, it } from "vitest";
import { defaultConfig } from "../config/default-personality.js";
import { buildSystemPrompt, loadPersonality } from "./personality.js";

describe("personality", () => {
  it("builds a PT-PT sales prompt with pitch and objections", () => {
    const prompt = buildSystemPrompt(defaultConfig);
    expect(prompt).toContain("ARA");
    expect(prompt).toContain("European Portuguese");
    expect(prompt).toContain(defaultConfig.pitch.valueProposition);
    expect(prompt).toContain("muito caro");
  });

  it("loadPersonality returns instructions and voice", () => {
    const loaded = loadPersonality(defaultConfig);
    expect(loaded.voice).toBe(defaultConfig.voice);
    expect(loaded.instructions.length).toBeGreaterThan(100);
  });
});
