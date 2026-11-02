import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config/default-personality.js";
import { HandoffHandler } from "./handler.js";

describe("HandoffHandler", () => {
  it("detects configured trigger phrases (case-insensitive)", () => {
    const handler = new HandoffHandler(defaultConfig);
    const onTriggered = vi.fn();
    handler.on("triggered", onTriggered);

    expect(handler.checkTranscript("Quero Falar Com Humano já")).toBe(true);
    expect(onTriggered).toHaveBeenCalledWith(
      "falar com humano",
      "Quero Falar Com Humano já",
    );
  });

  it("returns false when no trigger matches", () => {
    const handler = new HandoffHandler(defaultConfig);
    const onTriggered = vi.fn();
    handler.on("triggered", onTriggered);

    expect(handler.checkTranscript("conta-me o preço")).toBe(false);
    expect(onTriggered).not.toHaveBeenCalled();
  });
});
