/**
 * PCM16 resampling via linear interpolation.
 */
export function resamplePcm16(
  input: Buffer,
  fromRate: number,
  toRate: number,
): Buffer {
  if (fromRate === toRate) return Buffer.from(input);

  const inputSamples = input.length / 2;
  const ratio = toRate / fromRate;
  const outputSamples = Math.floor(inputSamples * ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i / ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;

    const s0 = readSample(input, srcIndex);
    const s1 = readSample(input, Math.min(srcIndex + 1, inputSamples - 1));
    const sample = Math.round(s0 + frac * (s1 - s0));
    output.writeInt16LE(clamp16(sample), i * 2);
  }

  return output;
}

function readSample(buf: Buffer, index: number): number {
  const offset = index * 2;
  if (offset + 1 >= buf.length) return 0;
  return buf.readInt16LE(offset);
}

function clamp16(v: number): number {
  return Math.max(-32768, Math.min(32767, v));
}

export function pcm16ToFloat32(pcm: Buffer): Float32Array {
  const samples = pcm.length / 2;
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    out[i] = pcm.readInt16LE(i * 2) / 32768;
  }
  return out;
}

export function float32ToPcm16(data: Float32Array): Buffer {
  const buf = Buffer.alloc(data.length * 2);
  for (let i = 0; i < data.length; i++) {
    const s = Math.max(-1, Math.min(1, data[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

export function mergePcm16Chunks(chunks: Buffer[]): Buffer {
  return Buffer.concat(chunks);
}
