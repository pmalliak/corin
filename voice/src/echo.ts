/**
 * Phase A's sink: play the utterance straight back into the channel.
 *
 * It proves the whole audio path in both directions, which is the only part of
 * voice that cannot be proven by reading documentation: Discord's UDP reaches
 * us, the Opus decodes, PCM re-encodes, and the result arrives in the channel
 * recognisably. Once a friend hears themselves, phase B is only a matter of
 * putting OpenAI where this playback is.
 *
 * A bot never receives its own audio, so echoing into the same channel cannot
 * feed back on itself.
 */

import { Readable } from "node:stream";
import {
  AudioPlayerStatus,
  StreamType,
  createAudioPlayer,
  createAudioResource,
  entersState,
  type VoiceConnection,
} from "@discordjs/voice";
import type { Sink, Utterance } from "./listener.ts";

export function createEchoSink(connection: VoiceConnection): Sink {
  const player = createAudioPlayer();
  connection.subscribe(player);

  /** Two people talking over each other must not talk over each other twice. */
  const queue: Utterance[] = [];
  let speaking = false;

  const drain = async (): Promise<void> => {
    if (speaking) return;
    speaking = true;
    try {
      let next = queue.shift();
      while (next) {
        console.log(`[echo] playing back ${next.durationMs} ms from ${next.speaker}`);
        player.play(
          createAudioResource(Readable.from(next.pcm), { inputType: StreamType.Raw }),
        );
        await entersState(player, AudioPlayerStatus.Playing, 5_000);
        await entersState(player, AudioPlayerStatus.Idle, 60_000);
        next = queue.shift();
      }
    } catch (error) {
      console.error("[echo] playback failed:", error instanceof Error ? error.message : error);
      queue.length = 0;
    } finally {
      speaking = false;
    }
  };

  return (utterance: Utterance) => {
    console.log(`[hear] ${utterance.speaker} spoke for ${utterance.durationMs} ms`);
    queue.push(utterance);
    void drain();
  };
}
