import { BYTES_PER_SAMPLE, CHANNELS } from "./vban.ts";

const SAMPLES_PER_TICK = 480; // 10 ms at 48 kHz
const TICK_BYTES = SAMPLES_PER_TICK * CHANNELS * BYTES_PER_SAMPLE;

/** Mixes Discord's per-user streams into one fixed-clock VBAN signal. */
export class PcmMixer {
  #queues = new Map<string, Buffer>();
  #timer: NodeJS.Timeout | undefined;
  readonly #write: (pcm: Buffer) => void;

  constructor(write: (pcm: Buffer) => void) {
    this.#write = write;
  }

  push(speakerId: string, pcm: Buffer): void {
    const previous = this.#queues.get(speakerId) ?? Buffer.alloc(0);
    this.#queues.set(speakerId, Buffer.concat([previous, pcm]));
  }

  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => this.#tick(), 10);
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#queues.clear();
  }

  #tick(): void {
    const source = [...this.#queues.entries()].filter(([, pcm]) => pcm.length >= TICK_BYTES);
    if (source.length === 0) return;
    const mixed = Buffer.alloc(TICK_BYTES);
    for (const [id, pcm] of source) {
      const block = pcm.subarray(0, TICK_BYTES);
      this.#queues.set(id, pcm.subarray(TICK_BYTES));
      for (let offset = 0; offset < TICK_BYTES; offset += BYTES_PER_SAMPLE) {
        const sum = mixed.readInt16LE(offset) + block.readInt16LE(offset);
        mixed.writeInt16LE(Math.max(-32768, Math.min(32767, sum)), offset);
      }
    }
    this.#write(mixed);
  }
}
