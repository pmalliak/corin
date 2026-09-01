import { Readable } from "node:stream";
import { BYTES_PER_SAMPLE, CHANNELS, SAMPLE_RATE } from "./vban.ts";

const BYTES_PER_MS = (SAMPLE_RATE / 1000) * CHANNELS * BYTES_PER_SAMPLE;
const FRAME_BYTES = 20 * BYTES_PER_MS; // one Discord frame
// The player deliberately asks for about LEAD_MS of audio early.  Starting
// with only two frames meant it immediately drained the buffer below one
// frame, declared an underrun, and inserted silence repeatedly.  Keep enough
// in reserve for that encoder lead plus normal Windows/VBAN packet jitter.
const PREFILL_BYTES = FRAME_BYTES * 8; // 160 ms
const MAX_BYTES = FRAME_BYTES * 150; // 3 s: absorbs large localhost VBAN bursts
const LEAD_MS = 80; // how far ahead of real time the Opus encoder may run
const RESYNC_MS = 500;
const FADE_BYTES = 5 * BYTES_PER_MS; // avoids clicks at speech boundaries

/**
 * Feeds the Discord player at real-time speed and never runs dry.
 *
 * Voicemeeter's VBAN packets arrive in bursts, and a player that reads an empty
 * stream stutters, so a late packet becomes silence instead of a gap. The stream
 * also paces itself: left unpaced, the Opus encoder pulls 420 ms ahead and that
 * head start becomes permanent latency.
 */
export class JitterBuffer extends Readable {
  #chunks: Buffer[] = [];
  #bytes = 0;
  #filling = true;
  #wasSilent = true;
  #due = 0;
  #timer: NodeJS.Timeout | undefined;

  constructor() {
    super({ highWaterMark: FRAME_BYTES });
  }

  write(pcm: Buffer): void {
    this.#chunks.push(pcm);
    this.#bytes += pcm.length;
    while (this.#bytes > MAX_BYTES) {
      const oldest = this.#chunks.shift();
      if (!oldest) break;
      this.#bytes -= oldest.length;
    }
    if (this.#bytes >= PREFILL_BYTES) this.#filling = false;
  }

  close(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#chunks = [];
    this.#bytes = 0;
    this.push(null);
  }

  _read(size: number): void {
    const now = performance.now();
    if (this.#due === 0 || now - this.#due > RESYNC_MS) this.#due = now;
    const wait = this.#due - now - LEAD_MS;
    if (wait > 0) {
      this.#timer = setTimeout(() => this.#serve(size), wait);
      return;
    }
    this.#serve(size);
  }

  #serve(_requestedSize: number): void {
    this.#timer = undefined;
    // Readable consumers can request a large high-water-mark sized chunk.
    // Feeding that request verbatim drained 80+ ms at once, even though Discord
    // encodes in 20 ms Opus frames, causing a refill/click at each phrase edge.
    this.#due += FRAME_BYTES / BYTES_PER_MS;
    this.push(this.#take(FRAME_BYTES));
  }

  /** Silence while refilling, so the stream never runs dry mid-sentence. */
  #take(size: number): Buffer {
    if (this.#filling || this.#bytes < size) {
      if (this.#bytes < PREFILL_BYTES) return Buffer.alloc(size);
      this.#filling = false;
    }
    const available = Math.min(size, this.#bytes);
    const frame = Buffer.alloc(size);
    let filled = 0;
    while (filled < available) {
      const head = this.#chunks[0]!;
      const take = Math.min(head.length, available - filled);
      head.copy(frame, filled, 0, take);
      filled += take;
      this.#bytes -= take;
      if (take === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(take);
    }
    if (this.#wasSilent) this.#fade(frame, 0, Math.min(FADE_BYTES, available), false);
    if (available < size || this.#bytes === 0) {
      this.#fade(frame, Math.max(0, available - FADE_BYTES), available, true);
      this.#filling = true;
      this.#wasSilent = true;
    } else {
      this.#wasSilent = false;
    }
    return frame;
  }

  /** Apply a short linear fade to signed 16-bit stereo PCM. */
  #fade(pcm: Buffer, start: number, end: number, out: boolean): void {
    const frames = Math.floor((end - start) / (CHANNELS * BYTES_PER_SAMPLE));
    for (let frame = 0; frame < frames; frame += 1) {
      const gain = out ? 1 - (frame + 1) / frames : (frame + 1) / frames;
      const offset = start + frame * CHANNELS * BYTES_PER_SAMPLE;
      for (let channel = 0; channel < CHANNELS; channel += 1) {
        const sampleOffset = offset + channel * BYTES_PER_SAMPLE;
        pcm.writeInt16LE(Math.round(pcm.readInt16LE(sampleOffset) * gain), sampleOffset);
      }
    }
  }
}
