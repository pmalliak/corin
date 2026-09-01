/**
 * The coach itself: a Realtime session that listens in one voice channel and
 * answers out loud.
 *
 * One session serves the whole channel rather than one per speaker, because a
 * coach that forgets the previous question is not a conversation, and because
 * the repeated part of a session's context bills at a fraction of fresh audio.
 * Discord tells us who spoke, and that name is put into the conversation so the
 * model never has to guess which player it is advising.
 *
 * Turn detection is switched off on purpose. Discord already knows precisely
 * when someone stopped talking, and letting the model listen continuously would
 * mean streaming the whole channel to it, which is the cost this design exists
 * to avoid.
 */

import { PassThrough } from "node:stream";
import WebSocket from "ws";
import {
  StreamType,
  createAudioPlayer,
  createAudioResource,
  type VoiceConnection,
} from "@discordjs/voice";
import { toDiscordAudio, toModelAudio } from "./audio.ts";
import type { Sink, Utterance } from "./listener.ts";
import type { Gate } from "./wake.ts";
import { createMeter } from "./meter.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const MODEL_SAMPLE_RATE = 24_000;
const RECONNECT_MS = 3_000;

// The players speak Greek with English League terms inside it, so the coach
// does the same. Translating "cooldown" into Greek would be correct and
// useless: nobody in the channel says it that way.
// The players speak Greek with English League terms inside it, so the coach
// does the same. Translating "cooldown" into Greek would be correct and
// useless: nobody in the channel says it that way.
//
// The bans are here because the first live answer earned every one of them: it
// opened with a filler word, ran to five sentences, and closed by offering to
// look at the match together. In a teamfight that is not help, it is noise.
// The players speak Greek with English League terms inside it, so the coach
// does the same. Translating "cooldown" into Greek would be correct and
// useless: nobody in the channel says it that way.
//
// Every rule below was earned by a real answer. The bans on openers and
// closers came from a reply that began "Έτσι," and ended by offering to review
// the match together. The one sentence limit came from three sentence answers
// that were still too long to hear mid fight. The narrow scope of the "no live
// data" rule came from the coach refusing to say what cooldown Lux's ultimate
// has, which is a fact about the game and not about anybody's match.
export const INSTRUCTIONS = [
  "Είσαι ο Κόριν, προπονητής League of Legends που μιλάει σε φωνητικό κανάλι Discord με μια παρέα φίλων, την ώρα που παίζουν.",
  "Απαντάς πάντα στα ελληνικά. Τους όρους του παιχνιδιού τους κρατάς στα αγγλικά, όπως τους λένε οι παίκτες:",
  "cooldown, ulti, gank, lane, jungle, CS, ward, engage, poke, split push, καθώς και τα ονόματα champions, items και objectives. Μην τα μεταφράζεις ποτέ.",
  "ΜΙΑ πρόταση. Δύο μόνο αν η ερώτηση πραγματικά δεν χωράει σε μία. Ποτέ τρεις.",
  "Σε ρωτάνε ενώ παίζουν. Κάθε δευτερόλεπτο που μιλάς είναι δευτερόλεπτο που δεν ακούν το παιχνίδι.",
  "Δώσε το νούμερο ή το συγκεκριμένο πράγμα και σταμάτα. Μη δικαιολογείς, μη γενικεύεις, μη συμβουλεύεις παραπάνω από όσο ρωτήθηκες.",
  "Ξεκίνα κατευθείαν από την απάντηση. Απαγορεύονται οι εισαγωγές Έτσι, Λοιπόν, Κοίτα, Ωραία, Μια στιγμή, Να το σκεφτώ.",
  "Απαγορεύονται τα κλεισίματα Αν θέλεις, Θες να δούμε, Πες μου αν, τσέκαρέ το στο wiki, δες το στο client, αν έχει αλλάξει σε πρόσφατο patch.",
  "Αν δεν ξέρεις, πες σκέτο ότι δεν το ξέρεις. Μία φράση, χωρίς επιφυλάξεις γύρω της.",
  "Πριν από τη φωνή κάθε παίκτη σου λέγεται ποιος μιλάει.",
  "Ξέρεις κανονικά το παιχνίδι και απαντάς ελεύθερα για champions, abilities, cooldowns, items, runes, objectives και matchups.",
  "Αυτό που ΔΕΝ βλέπεις είναι το match που παίζεται τώρα. Μόνο αν σε ρωτήσουν για τη δική τους τρέχουσα κατάσταση,",
  "δηλαδή πόσο CS έχουν αυτή τη στιγμή, τι έχουν χτίσει, πόσα kills, πόση ώρα παίζει το game, τι έχει ο αντίπαλός τους τώρα,",
  "πες σε μία πρόταση ότι η σύνδεση με το παιχνίδι δεν είναι ακόμα έτοιμη. Ποτέ μην εφεύρεις νούμερο για το τρέχον match.",
].join(" ");

/**
 * True when this utterance is a follow up to an answer the coach just gave.
 *
 * From a real session: "Κόριν, τι κάνει το ulti της Lux;", an answer, then
 * "Τι cooldown έχει;" into silence, because the name was missing. Nobody says a
 * person's name before every sentence of a conversation, and having to do so
 * makes the coach feel like a vending machine.
 *
 * Narrow on purpose: only the person the coach just answered, and only for a
 * short while, so the rest of the channel's chatter never reaches the
 * expensive model.
 */
export function isFollowUp(
  last: { speaker: string; at: number } | undefined,
  speaker: string,
  text: string,
  now: number,
  windowMs: number,
  minWords: number,
): boolean {
  if (windowMs <= 0 || last === undefined) return false;
  if (last.speaker !== speaker || now - last.at >= windowMs) return false;
  // A real follow up is a question. "Λοιπόν," is somebody gathering their
  // thoughts out loud, and answering it cost a turn and taught nobody anything.
  return text.split(/\s+/).filter(Boolean).length >= minWords;
}

export type Coach = { sink: Sink; close: () => void };

export type CoachOptions = {
  connection: VoiceConnection;
  apiKey: string;
  model: string;
  voice: string;
  /** How long after an answer a follow up needs no wake word. */
  followUpMs: number;
  /** A follow up shorter than this many words is somebody thinking aloud. */
  followUpMinWords: number;
  gate: Gate;
};

export function createCoach(options: CoachOptions): Coach {
  const player = createAudioPlayer();
  options.connection.subscribe(player);

  let socket: WebSocket | undefined;
  let closed = false;
  let lastSpeaker: string | undefined;
  /** The response being spoken right now, if any. */
  let speaking: { stream: PassThrough; carry: number } | undefined;
  /** Who the coach last answered, and when it stopped speaking to them. */
  let lastAnswered: { speaker: string; at: number } | undefined;
  let awaiting: string | undefined;
  const meter = createMeter();

  const send = (event: unknown): void => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
  };

  const stopSpeaking = (): void => {
    if (!speaking) return;
    speaking.stream.end();
    speaking = undefined;
    player.stop(true);
  };

  const beginSpeaking = (): PassThrough => {
    const stream = new PassThrough();
    speaking = { stream, carry: 0 };
    player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
    return stream;
  };

  const handle = (event: { type?: string; [key: string]: unknown }): void => {
    switch (event.type) {
      case "session.updated":
        console.log("[coach] session ready");
        break;
      case "response.output_audio.delta": {
        const chunk = Buffer.from(String(event.delta ?? ""), "base64");
        const target = speaking?.stream ?? beginSpeaking();
        const converted = toDiscordAudio(chunk, speaking?.carry ?? 0);
        if (speaking) speaking.carry = converted.carry;
        target.write(converted.pcm);
        break;
      }
      case "response.output_audio_transcript.done":
        console.log(`[coach] said: ${String(event.transcript ?? "").trim()}`);
        break;
      case "response.done":
        console.log(`[cost] ${meter.answered((event.response as { usage?: Parameters<typeof meter.answered>[0] })?.usage ?? {})}`);
        if (awaiting !== undefined) {
          lastAnswered = { speaker: awaiting, at: Date.now() };
          awaiting = undefined;
        }
        speaking?.stream.end();
        speaking = undefined;
        break;
      case "error":
        console.error("[coach] OpenAI reported:", JSON.stringify(event.error ?? event));
        break;
      default:
        break;
    }
  };

  const connect = (): void => {
    if (closed) return;
    socket = new WebSocket(`${REALTIME_URL}?model=${encodeURIComponent(options.model)}`, {
      headers: { Authorization: `Bearer ${options.apiKey}` },
    });

    socket.on("open", () => {
      console.log(`[coach] connected to ${options.model}`);
      lastSpeaker = undefined;
      send({
        type: "session.update",
        session: {
          type: "realtime",
          instructions: INSTRUCTIONS,
          output_modalities: ["audio"],
          audio: {
            input: {
              format: { type: "audio/pcm", rate: MODEL_SAMPLE_RATE },
              // Discord decides when a turn ended, not the model.
              turn_detection: null,
            },
            output: {
              format: { type: "audio/pcm", rate: MODEL_SAMPLE_RATE },
              voice: options.voice,
            },
          },
        },
      });
    });

    socket.on("message", (data: WebSocket.RawData) => {
      try {
        handle(JSON.parse(data.toString()) as { type?: string });
      } catch {
        console.error("[coach] could not parse an event from OpenAI");
      }
    });

    socket.on("error", (error: Error) => console.error("[coach] socket error:", error.message));

    socket.on("close", () => {
      stopSpeaking();
      if (closed) return;
      console.log(`[coach] disconnected, retrying in ${RECONNECT_MS / 1000}s`);
      setTimeout(connect, RECONNECT_MS).unref();
    });
  };

  connect();

  const sink: Sink = async (utterance: Utterance) => {
    // The gate is a network call, so an utterance can finish arriving after the
    // coach has already left the channel. Answering into a closed session is
    // noise in the log and, if it ever succeeded, a voice in an empty room.
    if (closed) return;
    const audio = toModelAudio(utterance.pcm);
    let heard;
    try {
      heard = await options.gate(utterance, audio);
    } catch (error) {
      console.error("[coach] could not hear:", error instanceof Error ? error.message : error);
      return;
    }

    const followUp = isFollowUp(
      lastAnswered,
      utterance.speaker,
      heard.text,
      Date.now(),
      options.followUpMs,
      options.followUpMinWords,
    );
    if (heard.transcribed) meter.heard(utterance.durationMs);
    console.log(
      `[hear] ${utterance.speaker}: ${heard.text || "(nothing intelligible)"}` +
        (followUp && !heard.addressed ? " (follow up)" : ""),
    );
    if (!heard.addressed && !followUp) return;
    if (!heard.text) return; // nothing was said, whatever the window thinks

    if (socket?.readyState !== WebSocket.OPEN) {
      console.error("[coach] addressed while disconnected from OpenAI, dropping the question");
      return;
    }

    // Someone talking to the coach mid-answer is interrupting it, which is what
    // they would do to a person.
    if (speaking) {
      send({ type: "response.cancel" });
      stopSpeaking();
    }

    if (utterance.speaker !== lastSpeaker) {
      send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `${utterance.speaker} is speaking.` }],
        },
      });
      lastSpeaker = utterance.speaker;
    }

    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_audio", audio: audio.toString("base64"), transcript: heard.text }],
      },
    });
    awaiting = utterance.speaker;
    send({ type: "response.create" });
  };

  return {
    sink,
    close: () => {
      closed = true;
      stopSpeaking();
      socket?.close();
    },
  };
}
