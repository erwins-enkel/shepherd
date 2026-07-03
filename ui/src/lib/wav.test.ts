import { describe, it, expect } from "vitest";
import { resample, encodeWav16, pcmChunksToWav } from "./wav";

function readAscii(view: DataView, offset: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe("resample", () => {
  it("is identity when rates match", () => {
    const input = new Float32Array([0, 0.5, -0.5, 1]);
    expect(resample(input, 16000, 16000)).toBe(input);
  });

  it("halves the length when downsampling 2:1", () => {
    const input = new Float32Array(100).fill(0.25);
    const out = resample(input, 32000, 16000);
    expect(out.length).toBe(50);
    // constant signal stays constant through linear interpolation
    expect(out[10]).toBeCloseTo(0.25, 5);
  });

  it("handles empty input", () => {
    expect(resample(new Float32Array(0), 48000, 16000).length).toBe(0);
  });
});

describe("encodeWav16", () => {
  it("writes a valid 44-byte mono 16-bit PCM header", () => {
    const samples = new Float32Array([0, 1, -1]);
    const buf = encodeWav16(samples, 16000);
    const view = new DataView(buf);
    expect(buf.byteLength).toBe(44 + samples.length * 2);
    expect(readAscii(view, 0, 4)).toBe("RIFF");
    expect(readAscii(view, 8, 4)).toBe("WAVE");
    expect(readAscii(view, 12, 4)).toBe("fmt ");
    expect(readAscii(view, 36, 4)).toBe("data");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16000); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(view.getUint32(40, true)).toBe(samples.length * 2); // data size
  });

  it("clamps and scales samples to int16", () => {
    const view = new DataView(encodeWav16(new Float32Array([1, -1, 2, -2]), 16000));
    expect(view.getInt16(44, true)).toBe(0x7fff); // +1 full scale
    expect(view.getInt16(46, true)).toBe(-0x8000); // -1 full scale
    expect(view.getInt16(48, true)).toBe(0x7fff); // +2 clamped
    expect(view.getInt16(50, true)).toBe(-0x8000); // -2 clamped
  });
});

describe("pcmChunksToWav", () => {
  it("merges chunks and downsamples before encoding", () => {
    const chunks = [new Float32Array(64).fill(0.1), new Float32Array(64).fill(0.1)];
    const buf = pcmChunksToWav(chunks, 48000, 16000);
    const view = new DataView(buf);
    // 128 samples @48k → ~42 samples @16k
    const dataBytes = view.getUint32(40, true);
    expect(dataBytes).toBe(Math.floor(128 / 3) * 2);
    expect(view.getUint32(24, true)).toBe(16000);
  });
});
