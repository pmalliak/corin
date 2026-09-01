import { BYTES_PER_SAMPLE, CHANNELS, SAMPLE_RATE } from "./vban.ts";

const TICK_MS = 10;
const TICK_BYTES = (SAMPLE_RATE / (1000 / TICK_MS)) * CHANNELS * BYTES_PER_SAMPLE;
const MAX_QUEUE_BYTES = TICK_BYTES * 20; // 200 ms per speaker
const MAX_CATCHUP_TICKS = 8;

/**
 * Mixes Discord's per-user streams into one gap-free VBAN signal. It writes on
 * every tick, silence included, because Voicemeeter treats a stream that stops
 * arriving as a dropout. Windows timers are coarse, so the clock is absolute and
 * catches up rather than drifting behind real time.
 */
export class PcmMixer {
  #queues = new Map<string, Buffer>();
  #timer: NodeJS.Timeout | undefined;
  #due = 0;
  readonly #write: (pcm: Buffer) => void;

  constructor(write: (pcm: Buffer) => void) {
    this.#write = write;
  }

  push(speakerId: string, pcm: Buffer): void {
    const previous = this.#queues.get(speakerId);
    let queued = previous?.length ? Buffer.concat([previous, pcm]) : pcm;
    if (queued.length > MAX_QUEUE_BYTES) queued = queued.subarray(queued.length - MAX_QUEUE_BYTES);
    this.#queues.set(speakerId, queued);
  }

  forget(speakerId: string): void {
    this.#queues.delete(speakerId);
  }

  start(): void {
    if (this.#timer) return;
    this.#due = performance.now();
    this.#timer = setInterval(() => this.#drain(), 5);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#queues.clear();
  }

  #drain(): void {
    const now = performance.now();
    if (now - this.#due > TICK_MS * MAX_CATCHUP_TICKS) this.#due = now;
    for (let ticks = 0; this.#due <= now && ticks < MAX_CATCHUP_TICKS; ticks += 1) {
      this.#tick();
      this.#due += TICK_MS;
    }
  }

  #tick(): void {
    const mixed = Buffer.alloc(TICK_BYTES);
    for (const [id, pcm] of this.#queues) {
      if (pcm.length < TICK_BYTES) continue;
      for (let offset = 0; offset < TICK_BYTES; offset += BYTES_PER_SAMPLE) {
        const sum = mixed.readInt16LE(offset) + pcm.readInt16LE(offset);
        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), offset);
      }
      this.#queues.set(id, pcm.subarray(TICK_BYTES));
    }
    this.#write(mixed);
  }
}
