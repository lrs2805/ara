import { describe, expect, it } from "vitest";
import { resamplePcm16, float32ToPcm16, pcm16ToFloat32 } from "./resampler.js";

describe("resamplePcm16", () => {
  it("returns a copy when rates match", () => {
    const input = Buffer.alloc(8);
    input.writeInt16LE(1000, 0);
    const out = resamplePcm16(input, 16000, 16000);
    expect(out.equals(input)).toBe(true);
    expect(out).not.toBe(input);
  });

  it("halves sample count when downsampling 2x", () => {
    // 4 samples @ 48k → 2 samples @ 24k
    const input = Buffer.alloc(8);
    for (let i = 0; i < 4; i++) input.writeInt16LE(i * 100, i * 2);
    const out = resamplePcm16(input, 48000, 24000);
    expect(out.length).toBe(4);
  });

  it("doubles sample count when upsampling 2x", () => {
    const input = Buffer.alloc(4);
    input.writeInt16LE(100, 0);
    input.writeInt16LE(200, 2);
    const out = resamplePcm16(input, 24000, 48000);
    expect(out.length).toBe(8);
  });
});

describe("pcm16 float conversion", () => {
  it("round-trips approximate amplitude", () => {
    const floats = new Float32Array([0, 0.5, -0.5, 1]);
    const pcm = float32ToPcm16(floats);
    const back = pcm16ToFloat32(pcm);
    expect(back[0]).toBeCloseTo(0, 2);
    expect(back[1]).toBeCloseTo(0.5, 2);
    expect(back[2]).toBeCloseTo(-0.5, 2);
    expect(back[3]).toBeCloseTo(1, 2);
  });
});
