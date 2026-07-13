import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  OPENAI_RECONNECT_MS,
  OPENAI_RESPONSE_TIMEOUT_MS,
  OPENAI_TTFT_TIMEOUT_MS,
} from "../config/types.js";

const REALTIME_MODEL = "gpt-realtime";
const REALTIME_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

export interface RealtimeEvents {
  audioDelta: (pcm24k: Buffer) => void;
  responseDone: () => void;
  /** Final ASR of committed user audio (when input transcription is enabled). */
  inputTranscript: (text: string) => void;
  error: (err: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

export declare interface RealtimeClient {
  on<K extends keyof RealtimeEvents>(
    event: K,
    listener: RealtimeEvents[K],
  ): this;
  emit<K extends keyof RealtimeEvents>(
    event: K,
    ...args: Parameters<RealtimeEvents[K]>
  ): boolean;
}

export interface RealtimeOptions {
  apiKey: string;
  instructions: string;
  voice: string;
}

export class RealtimeClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly apiKey: string;
  private instructions: string;
  private voice: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private ttftTimer: ReturnType<typeof setTimeout> | null = null;
  private responseTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private destroyed = false;
  private connecting = false;
  private awaitingFirstAudio = false;

  constructor(options: RealtimeOptions) {
    super();
    this.apiKey = options.apiKey;
    this.instructions = options.instructions;
    this.voice = options.voice;
  }

  async connect(): Promise<void> {
    if (this.destroyed || this.connecting) return;
    if (this.ws?.readyState === WebSocket.OPEN) return;

    this.connecting = true;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(REALTIME_URL, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });

      const onOpen = () => {
        this.connecting = false;
        this.connected = true;
        this.configureSession();
        this.scheduleReconnect();
        this.emit("connected");
        resolve();
      };

      const onError = (err: Error) => {
        this.connecting = false;
        if (!this.connected) reject(err);
        this.emit("error", err);
      };

      this.ws.once("open", onOpen);
      this.ws.once("error", onError);

      this.ws.on("message", (data) => this.handleMessage(data));
      this.ws.on("close", () => {
        this.connecting = false;
        this.connected = false;
        this.emit("disconnected");
        if (!this.destroyed) {
          console.log("[OpenAI] WebSocket closed, reconnecting...");
          setTimeout(() => this.connect().catch(console.error), 2000);
        }
      });
    });
  }

  private configureSession(): void {
    this.send({
      type: "session.update",
      session: {
        type: "realtime",
        model: REALTIME_MODEL,
        output_modalities: ["audio"],
        instructions: this.instructions,
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            turn_detection: null,
            // Opt-in ASR so handoff can match spoken triggers on user turns.
            transcription: {
              model: "gpt-4o-mini-transcribe",
              language: "pt",
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24000 },
            voice: this.voice,
          },
        },
      },
    });
  }

  private handleMessage(data: WebSocket.RawData): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = event.type as string;

    switch (type) {
      case "session.created":
        console.log("[OpenAI] session created");
        break;

      case "response.output_audio.delta":
      case "response.audio.delta": {
        const delta = event.delta as string;
        if (delta) {
          if (this.awaitingFirstAudio) {
            this.awaitingFirstAudio = false;
            this.clearTtftTimer();
          }
          this.emit("audioDelta", Buffer.from(delta, "base64"));
        }
        break;
      }

      case "response.done":
      case "response.completed":
        this.clearAllResponseTimers();
        this.emit("responseDone");
        break;

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event.transcript as string | undefined;
        if (transcript?.trim()) {
          this.emit("inputTranscript", transcript.trim());
        }
        break;
      }

      case "conversation.item.input_audio_transcription.failed": {
        console.warn("[OpenAI] input transcription failed");
        break;
      }

      case "error": {
        const errObj = event.error as { message?: string; code?: string } | undefined;
        // Ignore benign cancels when nothing is in progress
        if (errObj?.code === "response_cancel_not_active") break;
        const err = new Error(errObj?.message ?? "OpenAI Realtime error");
        console.error("[OpenAI] error:", err.message);
        this.emit("error", err);
        break;
      }

      case "input_audio_buffer.speech_started":
        console.log("[OpenAI] server detected speech (ignored — local VAD)");
        break;
    }
  }

  appendAudio(pcm24k: Buffer): void {
    // Chunk large utterances into ~100ms slices to avoid huge WS frames
    const sliceBytes = Math.floor((24000 * 2 * 100) / 1000); // 100ms @ 24kHz pcm16
    for (let offset = 0; offset < pcm24k.length; offset += sliceBytes) {
      const slice = pcm24k.subarray(offset, offset + sliceBytes);
      this.send({
        type: "input_audio_buffer.append",
        audio: slice.toString("base64"),
      });
    }
  }

  commitAudio(): void {
    this.send({ type: "input_audio_buffer.commit" });
  }

  createResponse(): void {
    this.send({ type: "response.create" });
    this.startResponseTimers();
  }

  cancelResponse(): void {
    this.send({ type: "response.cancel" });
    this.clearAllResponseTimers();
  }

  clearInputBuffer(): void {
    this.send({ type: "input_audio_buffer.clear" });
  }

  sendTextMessage(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text }],
      },
    });
    this.createResponse();
  }

  updateInstructions(instructions: string, voice?: string): void {
    this.instructions = instructions;
    if (voice) this.voice = voice;
    if (this.connected) this.configureSession();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearAllResponseTimers();
    this.ws?.close();
    this.ws = null;
    this.removeAllListeners();
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    } else {
      console.warn("[OpenAI] send dropped — socket not open:", payload.type);
    }
  }

  private startResponseTimers(): void {
    this.clearAllResponseTimers();
    this.awaitingFirstAudio = true;

    this.ttftTimer = setTimeout(() => {
      this.emit("error", new Error("OpenAI TTFT timeout (no audio)"));
      this.cancelResponse();
    }, OPENAI_TTFT_TIMEOUT_MS);

    this.responseTimer = setTimeout(() => {
      this.emit("error", new Error("OpenAI response timeout"));
      this.cancelResponse();
    }, OPENAI_RESPONSE_TIMEOUT_MS);
  }

  private clearTtftTimer(): void {
    if (this.ttftTimer) {
      clearTimeout(this.ttftTimer);
      this.ttftTimer = null;
    }
  }

  private clearAllResponseTimers(): void {
    this.clearTtftTimer();
    if (this.responseTimer) {
      clearTimeout(this.responseTimer);
      this.responseTimer = null;
    }
    this.awaitingFirstAudio = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      console.log("[OpenAI] proactive reconnect before 60min expiry");
      this.ws?.close();
    }, OPENAI_RECONNECT_MS);
  }
}
