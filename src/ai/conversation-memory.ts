/**
 * Ring buffer of recent user/assistant text turns for Realtime reconnect continuity.
 */
export interface ConversationTurn {
  role: "user" | "assistant";
  text: string;
}

export class ConversationMemory {
  private turns: ConversationTurn[] = [];
  private readonly maxTurns: number;

  constructor(maxTurns = 24) {
    this.maxTurns = maxTurns;
  }

  addUser(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.push({ role: "user", text: trimmed });
  }

  addAssistant(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    this.push({ role: "assistant", text: trimmed });
  }

  snapshot(): ConversationTurn[] {
    return this.turns.map((t) => ({ ...t }));
  }

  clear(): void {
    this.turns = [];
  }

  get size(): number {
    return this.turns.length;
  }

  private push(turn: ConversationTurn): void {
    this.turns.push(turn);
    while (this.turns.length > this.maxTurns) {
      this.turns.shift();
    }
  }
}
