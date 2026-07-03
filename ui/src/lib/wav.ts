// Encode raw Float32 PCM (as captured from a Web Audio tap) into a 16 kHz mono 16-bit WAV.
//
// Why this exists: the compose-bar live dictation needs to transcribe the audio *while it is
// still being spoken*. An iOS `MediaRecorder` mp4 writes its `moov` atom only on stop, so a
// mid-recording clip cannot be demuxed — but a WAV built from the PCM captured so far is valid
// at *every* prefix. So we tap the mic with Web Audio, accumulate Float32 frames, and encode a
// fresh WAV each interim tick. 16 kHz mono matches what whisper.cpp wants and keeps the upload
// small (~32 KB/s), which matters because each tick re-sends the whole growing clip.

/** Concatenate the captured Float32 frames into one contiguous buffer. */
function mergeChunks(chunks: Float32Array[]): Float32Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Float32Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Linear-interpolation resample from `inRate` to `outRate`. Identity when the rates match. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLen = Math.max(0, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    out[i] = input[i0]! * (1 - (pos - i0)) + input[i1]! * (pos - i0);
  }
  return out;
}

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
}

/** Encode mono Float32 samples as a 16-bit PCM WAV (44-byte header + data). */
export function encodeWav16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const byteRate = sampleRate * 2; // mono, 2 bytes/sample
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return buffer;
}

/** Merge + resample captured PCM frames to `targetRate` mono and encode a 16-bit WAV buffer. */
export function pcmChunksToWav(
  chunks: Float32Array[],
  inputRate: number,
  targetRate = 16000,
): ArrayBuffer {
  return encodeWav16(resample(mergeChunks(chunks), inputRate, targetRate), targetRate);
}

/** Browser convenience: the same as {@link pcmChunksToWav}, wrapped as an `audio/wav` Blob. */
export function pcmChunksToWavBlob(
  chunks: Float32Array[],
  inputRate: number,
  targetRate = 16000,
): Blob {
  return new Blob([pcmChunksToWav(chunks, inputRate, targetRate)], { type: "audio/wav" });
}
