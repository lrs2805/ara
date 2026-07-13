import { describe, expect, it } from "vitest";
import { AraState, StateMachine } from "../meeting/states.js";

describe("StateMachine", () => {
  it("starts in IDLE", () => {
    const sm = new StateMachine();
    expect(sm.state).toBe(AraState.IDLE);
  });

  it("allows IDLE → LISTENING → PROCESSING → SPEAKING → LISTENING", () => {
    const sm = new StateMachine();
    expect(sm.transition(AraState.LISTENING)).toBe(true);
    expect(sm.transition(AraState.PROCESSING)).toBe(true);
    expect(sm.transition(AraState.SPEAKING)).toBe(true);
    expect(sm.transition(AraState.LISTENING)).toBe(true);
  });

  it("allows PROCESSING → HANDOFF for transcript-driven transfers", () => {
    const sm = new StateMachine();
    sm.transition(AraState.LISTENING);
    sm.transition(AraState.PROCESSING);
    expect(sm.transition(AraState.HANDOFF)).toBe(true);
    expect(sm.isHandoff()).toBe(true);
  });

  it("rejects invalid transitions", () => {
    const sm = new StateMachine();
    expect(sm.transition(AraState.SPEAKING)).toBe(false);
    expect(sm.state).toBe(AraState.IDLE);
  });

  it("emits transition events", () => {
    const sm = new StateMachine();
    const seen: Array<[AraState, AraState]> = [];
    sm.on("transition", (from, to) => seen.push([from, to]));
    sm.transition(AraState.LISTENING);
    expect(seen).toEqual([[AraState.IDLE, AraState.LISTENING]]);
  });
});
