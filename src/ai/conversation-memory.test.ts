import { describe, expect, it } from "vitest";
import { ConversationMemory } from "./conversation-memory.js";

describe("ConversationMemory", () => {
  it("stores user and assistant turns in order", () => {
    const mem = new ConversationMemory();
    mem.addUser("olá");
    mem.addAssistant("olá, em que posso ajudar?");
    expect(mem.snapshot()).toEqual([
      { role: "user", text: "olá" },
      { role: "assistant", text: "olá, em que posso ajudar?" },
    ]);
  });

  it("trims empty and respects maxTurns", () => {
    const mem = new ConversationMemory(2);
    mem.addUser("   ");
    mem.addUser("um");
    mem.addAssistant("dois");
    mem.addUser("três");
    expect(mem.size).toBe(2);
    expect(mem.snapshot().map((t) => t.text)).toEqual(["dois", "três"]);
  });
});
