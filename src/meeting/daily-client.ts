import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { AudioIpcServer } from "../audio/ipc-server.js";
import { createMeetingToken } from "./daily-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_PAGE = join(__dirname, "../../public/bot-page.html");

export interface DailyClientOptions {
  roomUrl: string;
  userName: string;
  apiKey?: string;
  chromePath?: string;
}

export interface DailyClientEvents {
  joined: () => void;
  left: () => void;
  participantJoined: (name: string) => void;
  trackStarted: (participant: string) => void;
  activeSpeakerChange: (participant: string) => void;
  remoteAudio: (pcm48k: Buffer) => void;
  playbackDone: () => void;
  playbackStopped: () => void;
  error: (err: Error) => void;
}

export declare interface DailyClient {
  on<K extends keyof DailyClientEvents>(
    event: K,
    listener: DailyClientEvents[K],
  ): this;
  emit<K extends keyof DailyClientEvents>(
    event: K,
    ...args: Parameters<DailyClientEvents[K]>
  ): boolean;
}

function resolveChromePath(custom?: string): string {
  if (custom && existsSync(custom)) return custom;

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "linux"
        ? [
            "/usr/bin/google-chrome-stable",
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
          ]
        : [
            "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
            "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          ];

  for (const p of candidates) {
    if (existsSync(p)) return p;
  }

  throw new Error(
    "Chrome not found. Set CHROME_PATH env var to your Chrome executable.",
  );
}

export class DailyClient extends EventEmitter {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly options: DailyClientOptions;
  private reconnectAttempts = 0;
  private readonly maxReconnects = 3;
  private intentionalDisconnect = false;
  private audioIpc: AudioIpcServer | null = null;
  private ipcWired = false;

  constructor(options: DailyClientOptions) {
    super();
    this.options = options;
  }

  async connect(): Promise<void> {
    this.intentionalDisconnect = false;
    const chromePath = resolveChromePath(this.options.chromePath);

    let token: string | undefined;
    if (this.options.apiKey) {
      try {
        token = await createMeetingToken({
          apiKey: this.options.apiKey,
          roomUrl: this.options.roomUrl,
          userName: this.options.userName,
        });
        console.log("[Daily] meeting token created");
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        throw new Error(
          `Daily meeting token required but creation failed: ${message}`,
        );
      }
    } else {
      console.warn(
        "[Daily] no API key — joining without meeting token (dev only)",
      );
    }

    if (!this.audioIpc) {
      this.audioIpc = new AudioIpcServer();
      await this.audioIpc.listen();
      this.wireAudioIpc();
    }

    // Close previous browser if reconnecting
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.page = null;
    }

    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-gpu",
        "--window-size=1280,720",
      ],
      defaultViewport: { width: 1280, height: 720 },
    });

    this.browser.on("disconnected", () => {
      if (this.intentionalDisconnect) return;
      console.warn("[Daily] browser disconnected");
      this.handleDisconnect();
    });

    this.page = await this.browser.newPage();

    const ipcReady = new Promise<void>((resolve) => {
      const onReady = () => {
        this.audioIpc?.off("ready", onReady);
        resolve();
      };
      this.audioIpc?.on("ready", onReady);
    });

    await this.page.goto(`file://${BOT_PAGE}`, { waitUntil: "networkidle0" });

    await this.page.evaluate(
      (config: {
        roomUrl: string;
        userName: string;
        token?: string;
        audioIpcPort: number;
      }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bot = (globalThis as any).__araBot;
        return bot.initBot(config);
      },
      {
        roomUrl: this.options.roomUrl,
        userName: this.options.userName,
        token,
        audioIpcPort: this.audioIpc.getPort(),
      },
    );

    await Promise.race([
      ipcReady,
      new Promise<void>((_, reject) =>
        setTimeout(
          () => reject(new Error("Audio IPC connect timeout")),
          15_000,
        ),
      ),
    ]);

    console.log(`[Daily] joined room as ${this.options.userName}`);
  }

  private wireAudioIpc(): void {
    if (!this.audioIpc || this.ipcWired) return;
    this.ipcWired = true;

    this.audioIpc.on("remoteAudio", (pcm) => {
      this.emit("remoteAudio", pcm);
    });

    this.audioIpc.on("event", (event) => {
      switch (event.type) {
        case "joined-meeting":
          this.reconnectAttempts = 0;
          this.emit("joined");
          break;
        case "left-meeting":
          this.emit("left");
          break;
        case "participant-joined":
          if (event.participant) {
            this.emit("participantJoined", event.participant);
          }
          break;
        case "track-started":
          if (event.participant) {
            this.emit("trackStarted", event.participant);
          }
          break;
        case "active-speaker-change":
          if (event.participant) {
            this.emit("activeSpeakerChange", event.participant);
          }
          break;
        case "output-track-ready":
          console.log("[Daily] output track ready");
          break;
        case "playback-done":
          this.emit("playbackDone");
          break;
        case "playback-stopped":
          this.emit("playbackStopped");
          break;
        case "error":
          this.emit("error", new Error(event.message ?? "Daily error"));
          break;
      }
    });
  }

  async publishAudio(pcm48k: Buffer): Promise<{ remainingSec: number }> {
    this.audioIpc?.sendPcm(pcm48k);
    return { remainingSec: 0 };
  }

  async stopPlayback(): Promise<void> {
    this.audioIpc?.stopPlayback();
  }

  async disconnect(): Promise<void> {
    this.intentionalDisconnect = true;
    if (this.page) {
      await this.page
        .evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (globalThis as any).__araBot.leaveRoom();
        })
        .catch(() => {});
    }
    await this.browser?.close().catch(() => {});
    this.browser = null;
    this.page = null;
    await this.audioIpc?.close();
    this.audioIpc = null;
    this.ipcWired = false;
  }

  private async handleDisconnect(): Promise<void> {
    if (this.intentionalDisconnect) return;

    if (this.reconnectAttempts >= this.maxReconnects) {
      this.emit("error", new Error("Daily reconnect limit exceeded"));
      return;
    }

    const delay = Math.pow(2, this.reconnectAttempts) * 1000;
    this.reconnectAttempts++;
    console.log(
      `[Daily] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );

    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.connect();
    } catch (err) {
      this.emit(
        "error",
        err instanceof Error ? err : new Error(String(err)),
      );
    }
  }
}
