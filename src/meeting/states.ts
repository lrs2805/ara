import { EventEmitter } from "node:events";

export enum AraState {
  IDLE = "IDLE",
  LISTENING = "LISTENING",
  PROCESSING = "PROCESSING",
  SPEAKING = "SPEAKING",
  HANDOFF = "HANDOFF",
  ERROR = "ERROR",
}

const VALID_TRANSITIONS: Record<AraState, AraState[]> = {
  [AraState.IDLE]: [AraState.LISTENING, AraState.ERROR],
  [AraState.LISTENING]: [
    AraState.PROCESSING,
    AraState.HANDOFF,
    AraState.ERROR,
    AraState.IDLE,
  ],
  [AraState.PROCESSING]: [
    AraState.SPEAKING,
    AraState.LISTENING,
    AraState.HANDOFF,
    AraState.ERROR,
  ],
  [AraState.SPEAKING]: [
    AraState.LISTENING,
    AraState.PROCESSING,
    AraState.HANDOFF,
    AraState.ERROR,
  ],
  [AraState.HANDOFF]: [AraState.LISTENING, AraState.IDLE, AraState.ERROR],
  [AraState.ERROR]: [AraState.LISTENING, AraState.IDLE],
};

export interface StateMachineEvents {
  transition: (from: AraState, to: AraState) => void;
}

export declare interface StateMachine {
  on<K extends keyof StateMachineEvents>(
    event: K,
    listener: StateMachineEvents[K],
  ): this;
}

export class StateMachine extends EventEmitter {
  private _state: AraState = AraState.IDLE;

  get state(): AraState {
    return this._state;
  }

  transition(to: AraState): boolean {
    const from = this._state;
    const allowed = VALID_TRANSITIONS[from];

    if (!allowed.includes(to)) {
      console.warn(`[State] invalid transition ${from} → ${to}`);
      return false;
    }

    this._state = to;
    console.log(`[State] ${from} → ${to}`);
    this.emit("transition", from, to);
    return true;
  }

  isListening(): boolean {
    return this._state === AraState.LISTENING;
  }

  isSpeaking(): boolean {
    return this._state === AraState.SPEAKING;
  }

  isProcessing(): boolean {
    return this._state === AraState.PROCESSING;
  }

  isHandoff(): boolean {
    return this._state === AraState.HANDOFF;
  }
}
