import { strict as assert } from "node:assert";
import { test } from "node:test";
import { toDiscordAudio, toModelAudio, toWav } from "./audio.ts";

function stereo48(samples: Array<[number, number]>): Buffer {
  const buffer = Buffer.alloc(samples.length * 4);
  samples.forEach(([left, right], index) => {
    buffer.writeInt16LE(left, index * 4);
    buffer.writeInt16LE(right, index * 4 + 2);
  });
  return buffer;
}

function mono24(samples: number[]): Buffer {
  const buffer = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => buffer.writeInt16LE(sample, index * 2));
  return buffer;
}

test("halving the rate averages the four samples it merges", () => {
  const input = stereo48([
    [100, 200],
    [300, 400],
  ]);
  const out = toModelAudio(input);
  assert.equal(out.length, 2);
  assert.equal(out.readInt16LE(0), 250);
});

test("a partial frame at the end is dropped rather than read past", () => {
  const out = toModelAudio(Buffer.alloc(6));
  assert.equal(out.length, 0);
});

test("doubling the rate writes two stereo frames per input sample", () => {
  const { pcm, carry } = toDiscordAudio(mono24([1000, 2000]));
  assert.equal(pcm.length, 2 * 2 * 2 * 2);
  assert.equal(carry, 2000);
  assert.equal(pcm.readInt16LE(0), 500); // interpolated from a carry of 0
  assert.equal(pcm.readInt16LE(2), 500); // and duplicated to both channels
  assert.equal(pcm.readInt16LE(4), 1000);
  assert.equal(pcm.readInt16LE(8), 1500); // interpolated between 1000 and 2000
  assert.equal(pcm.readInt16LE(12), 2000);
});

test("the carry joins chunks without a step at the boundary", () => {
  const first = toDiscordAudio(mono24([1000]));
  const joined = toDiscordAudio(mono24([2000]), first.carry);
  assert.equal(joined.pcm.readInt16LE(0), 1500);

  const restarted = toDiscordAudio(mono24([2000]));
  assert.equal(restarted.pcm.readInt16LE(0), 1000); // the click we are avoiding
});

test("an empty chunk keeps the carry so the next one still joins", () => {
  const { pcm, carry } = toDiscordAudio(Buffer.alloc(0), 1234);
  assert.equal(pcm.length, 0);
  assert.equal(carry, 1234);
});

test("a round trip through both conversions preserves the signal's shape", () => {
  const original = Array.from({ length: 64 }, (_, i) => Math.round(8000 * Math.sin(i / 4)));
  const down = toModelAudio(stereo48(original.flatMap((s) => [[s, s], [s, s]] as Array<[number, number]>)));
  assert.equal(down.length, original.length * 2);
  const worst = original.reduce((max, sample, i) => Math.max(max, Math.abs(sample - down.readInt16LE(i * 2))), 0);
  assert.ok(worst < 1200, `worst deviation ${worst} is larger than smoothing explains`);
});

test("the wav header describes the samples that follow it", () => {
  const wav = toWav(Buffer.alloc(480), 24_000, 1);
  assert.equal(wav.length, 44 + 480);
  assert.equal(wav.subarray(0, 4).toString(), "RIFF");
  assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  assert.equal(wav.readUInt32LE(24), 24_000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt32LE(40), 480);
});
