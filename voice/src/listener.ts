/**
 * Turns "someone in the channel is talking" into a finished utterance of PCM.
 *
 * This is the seam the rest of the project hangs off. Phase A hands utterances
 * to an echo sink; phase B will hand the same utterances to OpenAI without any
 * of this file changing. Discord gives one audio stream per speaker, so who
 * asked is never a guess, which is the whole reason the coach can safely answer
 * from one player's private game state.
 */

import { EndBehaviorType, type VoiceConnection } from "@discordjs/voice";
import prism from "prism-media";

/** Discord voice is 48 kHz stereo, and 20 ms of it is 960 samples per channel. */
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SIZE = 960;
const BYTES_PER_SAMPLE = 2;

/**
 * How much quiet ends an utterance. Long enough to survive the pause in the
 * middle of a sentence, short enough that the coach does not feel deaf.
 */
const SILENCE_MS = 800;

/** Anything this short is a cough, a keyboard, or the tail of someone else. */
const MIN_UTTERANCE_MS = 300;

export type Utterance = {
  userId: string;
  speaker: string;
  /** Signed 16 bit little endian, 48 kHz, stereo. What Discord speaks natively. */
  pcm: Buffer;
  durationMs: number;
};

export type Sink = (utterance: Utterance) => void | Promise<void>;

export type Listener = { stop: () => void };

export function listen(
  connection: VoiceConnection,
  nameOf: (userId: string) => string,
  sink: Sink,
): Listener {
  const receiver = connection.receiver;
  /** One subscription per speaker at a time; `start` fires again mid-utterance. */
  const active = new Set<string>();

  const onStart = (userId: string): void => {
    if (active.has(userId)) return;
    active.add(userId);

    const opus = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
    });
    const decoder = new prism.opus.Decoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: FRAME_SIZE,
    });

    const chunks: Buffer[] = [];
    decoder.on("data", (chunk: Buffer) => chunks.push(chunk));

    const finish = (error?: Error): void => {
      if (!active.delete(userId)) return;
      if (error) {
        console.error(`[listen] ${nameOf(userId)}: ${error.message}`);
        return;
      }
      const pcm = Buffer.concat(chunks);
      const durationMs = Math.round((pcm.length / (SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE)) * 1000);
      if (durationMs < MIN_UTTERANCE_MS) return;
      void sink({ userId, speaker: nameOf(userId), pcm, durationMs });
    };

    decoder.on("end", () => finish());
    decoder.on("error", finish);
    opus.on("error", finish);
    opus.pipe(decoder);
  };

  receiver.speaking.on("start", onStart);
  return { stop: () => receiver.speaking.off("start", onStart) };
}
