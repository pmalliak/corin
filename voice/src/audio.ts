/**
 * The two conversions between Discord's audio and OpenAI's.
 *
 * Discord speaks 48 kHz stereo signed 16 bit; the Realtime API speaks 24 kHz
 * mono of the same sample format. Nothing else in the project needs to know
 * that, so the difference is confined here.
 *
 * Both directions are cheap arithmetic on a Buffer. Halving the rate averages
 * the two samples being merged rather than discarding one, which is a crude
 * low pass and keeps the high end from folding back down as a whistle.
 */

const BYTES_PER_SAMPLE = 2;

/** Discord to OpenAI: 48 kHz stereo becomes 24 kHz mono. */
export function toModelAudio(pcm48Stereo: Buffer): Buffer {
  // Four samples in (two frames, two channels) make one sample out.
  const outSamples = Math.floor(pcm48Stereo.length / (BYTES_PER_SAMPLE * 4));
  const out = Buffer.allocUnsafe(outSamples * BYTES_PER_SAMPLE);
  for (let i = 0; i < outSamples; i++) {
    const base = i * 8;
    const sum =
      pcm48Stereo.readInt16LE(base) +
      pcm48Stereo.readInt16LE(base + 2) +
      pcm48Stereo.readInt16LE(base + 4) +
      pcm48Stereo.readInt16LE(base + 6);
    out.writeInt16LE(Math.round(sum / 4), i * BYTES_PER_SAMPLE);
  }
  return out;
}

/**
 * OpenAI to Discord: 24 kHz mono becomes 48 kHz stereo.
 *
 * `carry` is the last sample of the previous chunk. The coach's voice arrives
 * in many small deltas, and interpolating from zero at every boundary would
 * put a click between each one.
 */
export function toDiscordAudio(pcm24Mono: Buffer, carry = 0): { pcm: Buffer; carry: number } {
  const inSamples = Math.floor(pcm24Mono.length / BYTES_PER_SAMPLE);
  if (inSamples === 0) return { pcm: Buffer.alloc(0), carry };

  // Each input sample becomes two frames, each frame two channels.
  const out = Buffer.allocUnsafe(inSamples * 2 * 2 * BYTES_PER_SAMPLE);
  let previous = carry;
  for (let i = 0; i < inSamples; i++) {
    const current = pcm24Mono.readInt16LE(i * BYTES_PER_SAMPLE);
    const between = Math.round((previous + current) / 2);
    const base = i * 8;
    out.writeInt16LE(between, base);
    out.writeInt16LE(between, base + 2);
    out.writeInt16LE(current, base + 4);
    out.writeInt16LE(current, base + 6);
    previous = current;
  }
  return { pcm: out, carry: previous };
}

/**
 * Wraps raw PCM as a WAV file.
 *
 * The transcription endpoint takes files, not streams of samples, and refuses
 * to guess a format. A 44 byte header is the whole difference.
 */
export function toWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * BYTES_PER_SAMPLE;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // PCM header length
  header.writeUInt16LE(1, 20); // format 1 is uncompressed PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
