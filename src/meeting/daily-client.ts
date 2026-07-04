import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOT_PAGE = join(__dirname, "../../public/bot-page.html");

export interface DailyClientOptions {
  roomUrl: string;
  userName: string;
  chromePath?: string;
}

export interface DailyClientEvents {
  joined: () => void;
  left: () => void;
  participantJoined: (name: string) => void;
  trackStarted: (participant: string) => void;
  remoteAudio: (pcm48k: Buffer) => void;
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

  constructor(options: DailyClientOptions) {
    super();
    this.options = options;
  }

  async connect(): Promise<void> {
    const chromePath = resolveChromePath(this.options.chromePath);

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
      console.warn("[Daily] browser disconnected");
      this.handleDisconnect();
    });

    this.page = await this.browser.newPage();

    await this.page.exposeFunction(
      "__araOnRemoteAudio",
      (base64: string) => {
        const pcm = Buffer.from(base64, "base64");
        this.emit("remoteAudio", pcm);
      },
    );

    await this.page.exposeFunction(
      "__araOnEvent",
      (event: { type: string; participant?: string; message?: string }) => {
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
          case "output-track-ready":
            console.log("[Daily] output track ready");
            break;
          case "error":
            this.emit("error", new Error(event.message ?? "Daily error"));
            break;
        }
      },
    );

    await this.page.goto(`file://${BOT_PAGE}`, { waitUntil: "networkidle0" });

    await this.page.evaluate(
      (config: { roomUrl: string; userName: string }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const bot = (globalThis as any).__araBot;
        return bot.initBot(config);
      },
      { roomUrl: this.options.roomUrl, userName: this.options.userName },
    );

    console.log(`[Daily] joined room as ${this.options.userName}`);
  }

  async publishAudio(pcm48k: Buffer): Promise<void> {
    if (!this.page) return;
    const base64 = pcm48k.toString("base64");
    await this.page.evaluate((b64: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).__araBot.publishAudio(b64);
    }, base64);
  }

  async disconnect(): Promise<void> {
    if (this.page) {
      await this.page
        .evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (globalThis as any).__araBot.leaveRoom();
        })
        .catch(() => {});
    }
    await this.browser?.close();
    this.browser = null;
    this.page = null;
  }

  private async handleDisconnect(): Promise<void> {
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
