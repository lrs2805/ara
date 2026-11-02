import { createServer, type Server as HttpServer } from "node:http";
import { EventEmitter } from "node:events";
import { WebSocketServer, WebSocket } from "ws";

export interface AudioIpcEvents {
  remoteAudio: (pcm48k: Buffer) => void;
  event: (event: { type: string; participant?: string; message?: string }) => void;
  ready: () => void;
  disconnected: () => void;
}

export declare interface AudioIpcServer {
  on<K extends keyof AudioIpcEvents>(
    event: K,
    listener: AudioIpcEvents[K],
  ): this;
  emit<K extends keyof AudioIpcEvents>(
    event: K,
    ...args: Parameters<AudioIpcEvents[K]>
  ): boolean;
}

/**
 * Localhost WebSocket bridge between Node and the headless bot page.
 * Binary frames = PCM16 @ 48kHz; text frames = JSON control/events.
 * Avoids base64-over-CDP for continuous audio.
 */
export class AudioIpcServer extends EventEmitter {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private client: WebSocket | null = null;
  private port = 0;

  async listen(): Promise<number> {
    if (this.port) return this.port;

    this.httpServer = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ara-audio-ipc");
    });

    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws) => {
      if (this.client && this.client.readyState === WebSocket.OPEN) {
        this.client.close();
      }
      this.client = ws;
      console.log("[AudioIPC] browser connected");
      this.emit("ready");

      ws.on("message", (data, isBinary) => {
        if (isBinary) {
          const buf = Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer);
          this.emit("remoteAudio", buf);
          return;
        }
        try {
          const event = JSON.parse(data.toString()) as {
            type: string;
            participant?: string;
            message?: string;
          };
          this.emit("event", event);
        } catch {
          // ignore malformed control frames
        }
      });

      ws.on("close", () => {
        if (this.client === ws) {
          this.client = null;
          this.emit("disconnected");
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.listen(0, "127.0.0.1", () => resolve());
      this.httpServer!.once("error", reject);
    });

    const addr = this.httpServer.address();
    if (!addr || typeof addr === "string") {
      throw new Error("AudioIPC failed to bind localhost port");
    }
    this.port = addr.port;
    console.log(`[AudioIPC] listening on ws://127.0.0.1:${this.port}`);
    return this.port;
  }

  getPort(): number {
    return this.port;
  }

  sendPcm(pcm48k: Buffer): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(pcm48k, { binary: true });
    }
  }

  sendControl(payload: Record<string, unknown>): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(payload));
    }
  }

  stopPlayback(): void {
    this.sendControl({ type: "stop-playback" });
  }

  async close(): Promise<void> {
    this.client?.close();
    this.client = null;
    await new Promise<void>((resolve) => {
      this.wss?.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      this.httpServer?.close(() => resolve());
    });
    this.wss = null;
    this.httpServer = null;
    this.port = 0;
  }
}
