import { Readable } from "node:stream";
import { BYTES_PER_SAMPLE, CHANNELS, SAMPLE_RATE } from "./vban.ts";

const BYTES_PER_MS = (SAMPLE_RATE / 1000) * CHANNELS * BYTES_PER_SAMPLE;
const FRAME_BYTES = 20 * BYTES_PER_MS; // one Discord frame
const PREFILL_BYTES = FRAME_BYTES * 2;
const MAX_BYTES = FRAME_BYTES * 15;
const LEAD_MS = 80; // how far ahead of real time the Opus encoder may run
const RESYNC_MS = 500;

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

  #serve(size: number): void {
    this.#timer = undefined;
    this.#due += size / BYTES_PER_MS;
    this.push(this.#take(size));
  }

  /** Silence while refilling, so the stream never runs dry mid-sentence. */
  #take(size: number): Buffer {
    if (this.#filling || this.#bytes < size) {
      this.#filling = true;
      return Buffer.alloc(size);
    }
    const frame = Buffer.allocUnsafe(size);
    let filled = 0;
    while (filled < size) {
      const head = this.#chunks[0]!;
      const take = Math.min(head.length, size - filled);
      head.copy(frame, filled, 0, take);
      filled += take;
      this.#bytes -= take;
      if (take === head.length) this.#chunks.shift();
      else this.#chunks[0] = head.subarray(take);
    }
    return frame;
  }
}
