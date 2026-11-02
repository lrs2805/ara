import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { AudioIpcServer } from "./ipc-server.js";

describe("AudioIpcServer", () => {
  it("exchanges binary PCM and JSON events over localhost WS", async () => {
    const server = new AudioIpcServer();
    const port = await server.listen();
    expect(port).toBeGreaterThan(0);

    const remoteChunks: Buffer[] = [];
    const events: Array<{ type: string }> = [];
    server.on("remoteAudio", (b) => remoteChunks.push(b));
    server.on("event", (e) => events.push(e));

    const ready = new Promise<void>((resolve) => server.on("ready", () => resolve()));
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    await ready;

    ws.send(JSON.stringify({ type: "joined-meeting" }));
    ws.send(Buffer.from([1, 2, 3, 4]));

    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === "joined-meeting")).toBe(true);
    expect(remoteChunks[0]?.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);

    const received: Buffer[] = [];
    ws.on("message", (data, isBinary) => {
      if (isBinary) received.push(Buffer.from(data as Buffer));
    });
    server.sendPcm(Buffer.from([9, 8, 7, 6]));
    await new Promise((r) => setTimeout(r, 50));
    expect(received[0]?.equals(Buffer.from([9, 8, 7, 6]))).toBe(true);

    ws.close();
    await server.close();
  });
});
