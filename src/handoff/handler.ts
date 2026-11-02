import { EventEmitter } from "node:events";
import type { AraConfig } from "../config/types.js";

export interface HandoffEvents {
  triggered: (trigger: string, transcript?: string) => void;
}

export declare interface HandoffHandler {
  on<K extends keyof HandoffEvents>(
    event: K,
    listener: HandoffEvents[K],
  ): this;
}

export class HandoffHandler extends EventEmitter {
  private readonly triggers: string[];

  constructor(config: AraConfig) {
    super();
    this.triggers = config.limits.handoffTriggers.map((t) =>
      t.toLowerCase(),
    );
  }

  /**
   * Check transcript text for handoff triggers.
   * Live path: AraSession calls this on Realtime input transcripts.
   * Transfer itself remains a stub (emit + HANDOFF state).
   */
  checkTranscript(text: string): boolean {
    const lower = text.toLowerCase();
    for (const trigger of this.triggers) {
      if (lower.includes(trigger)) {
        console.log(`[Handoff] trigger detected: "${trigger}"`);
        this.emit("triggered", trigger, text);
        return true;
      }
    }
    return false;
  }
}
