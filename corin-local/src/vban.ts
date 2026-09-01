import dgram from "node:dgram";
import { EventEmitter } from "node:events";

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const BYTES_PER_SAMPLE = 2;
const HEADER_BYTES = 28;
const PCM_16 = 0x01;
const RATE_48K_INDEX = 3;
const MAX_SAMPLES = 256;

export type AudioPacket = { pcm: Buffer; samples: number };

function streamName(buffer: Buffer): string {
  return buffer.subarray(8, 24).toString("ascii").replace(/\0+$/, "");
}

/** Minimal PCM-audio VBAN endpoint. No sound driver is involved: Voicemeeter owns it. */
export class VbanEndpoint extends EventEmitter {
  #socket = dgram.createSocket("udp4");
  #frame = 0;
  readonly #target: { host: string; port: number; stream: string };
  readonly #source: { port: number; stream: string };

  constructor(
    target: { host: string; port: number; stream: string },
    source: { port: number; stream: string },
  ) {
    super();
    this.#target = target;
    this.#source = source;
    this.#socket.on("error", (error) => this.emit("error", error));
    this.#socket.on("message", (message) => this.#read(message));
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.#socket.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.#socket.off("error", onError);
        resolve();
      };
      this.#socket.once("error", onError);
      this.#socket.once("listening", onListening);
      this.#socket.bind(this.#source.port, "127.0.0.1");
    });
  }

  sendPcm(pcm: Buffer): void {
    const bytesPerFrame = CHANNELS * BYTES_PER_SAMPLE;
    if (pcm.length % bytesPerFrame !== 0) throw new Error("VBAN PCM must contain complete stereo frames.");
    let offset = 0;
    while (offset < pcm.length) {
      const available = (pcm.length - offset) / bytesPerFrame;
      const samples = Math.min(MAX_SAMPLES, available);
      const payload = pcm.subarray(offset, offset + samples * bytesPerFrame);
      const packet = Buffer.allocUnsafe(HEADER_BYTES + payload.length);
      packet.write("VBAN", 0, "ascii");
      packet[4] = RATE_48K_INDEX;
      packet[5] = samples - 1;
      packet[6] = CHANNELS - 1;
      packet[7] = PCM_16;
      packet.fill(0, 8, 24);
      packet.write(this.#target.stream, 8, "ascii");
      packet.writeUInt32LE(this.#frame++ >>> 0, 24);
      payload.copy(packet, HEADER_BYTES);
      this.#socket.send(packet, this.#target.port, this.#target.host, (error) => error && this.emit("error", error));
      offset += payload.length;
    }
  }

  close(): void {
    this.#socket.close();
  }

  #read(message: Buffer): void {
    if (message.length < HEADER_BYTES || message.subarray(0, 4).toString("ascii") !== "VBAN") return;
    if (streamName(message) !== this.#source.stream) return;
    // Audio subprotocol, 48 kHz, two channels, native signed 16-bit PCM.
    if (message[4] !== RATE_48K_INDEX || message[6] !== CHANNELS - 1 || message[7] !== PCM_16) return;
    const samples = message[5] + 1;
    const pcm = message.subarray(HEADER_BYTES);
    if (pcm.length !== samples * CHANNELS * BYTES_PER_SAMPLE) return;
    this.emit("audio", { pcm, samples } satisfies AudioPacket);
  }
}
