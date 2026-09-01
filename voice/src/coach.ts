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
import type { GameStateReader } from "./state.ts";

const REALTIME_URL = "wss://api.openai.com/v1/realtime";
const MODEL_SAMPLE_RATE = 24_000;
const RECONNECT_MS = 3_000;

const GAME_STATE_TOOL = {
  type: "function",
  name: "get_game_state",
  description:
    "The current League game of whichever player is speaking: their champion, level, KDA, CS, gold, items and ability ranks, " +
    "plus every ally and enemy by champion with their score and build, and the game clock. " +
    "Call this for any question about what is happening in their match right now. Never guess these numbers.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
} as const;

// The players speak Greek with English League terms inside it, so the coach
// does the same. Translating "cooldown" into Greek would be correct and
// useless: nobody in the channel says it that way.
//
// Every rule below was earned by a real answer. The bans on openers and closers
// came from a reply that began with a filler word and ended by offering to
// review the match together. The one sentence limit came from three sentence
// answers that were still too long to hear mid fight. And the coach once
// refused to say what cooldown an ultimate has, because an earlier version of
// these instructions told it, far too broadly, that it could not see the game.
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
  "Για το match που παίζεται ΤΩΡΑ έχεις το εργαλείο get_game_state, που σου δίνει την κατάσταση αυτού που μιλάει:",
  "champion, level, KDA, CS, gold, items, ability ranks, τον χρόνο του game και τους υπόλοιπους παίκτες ανά champion.",
  "Κάλεσέ το για κάθε ερώτηση που αφορά το τωρινό τους παιχνίδι, και απάντα από αυτό που γυρίζει.",
  "Το εργαλείο το καλείς ΣΙΩΠΗΛΑ. Μη λες τίποτα πριν ή ενώ το καλείς: ούτε Μισό, ούτε Τσεκάρω, ούτε Ένα δευτερόλεπτο.",
  "Ο παίκτης πρέπει να ακούσει μόνο μία φορά τη φωνή σου, και αυτή να είναι η απάντηση.",
  "Ποτέ μην εφεύρεις νούμερο για το τρέχον match. Αν το εργαλείο πει ότι δεν είναι συνδεδεμένος, πες τον λόγο σε μία πρόταση.",
].join(" ");

/**
 * True when this utterance is a follow up to an answer the coach just gave.
 *
 * From a real session: a question about an ultimate, an answer, then "Τι
 * cooldown έχει;" into silence, because the name was missing. Nobody says a
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
  /** Absent means the coach has no eyes on anybody's match, and says so. */
  readGameState?: GameStateReader;
};

type Asking = { userId: string; speaker: string };

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
  /** Whose question the current response belongs to. */
  let asking: Asking | undefined;
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

  /**
   * Answers the model's tool call with the asker's own game, then asks for the
   * spoken reply. The asker is captured before the fetch, because the response
   * that carried the call ends while the fetch is still in flight.
   */
  const serveGameState = async (callId: string, asker: Asking | undefined): Promise<void> => {
    let output: Record<string, unknown>;
    if (!options.readGameState) {
      output = { connected: false, why: "This deployment has no link to the game backend." };
    } else if (!asker) {
      output = { connected: false, why: "It is not clear which player is asking." };
    } else {
      try {
        output = await options.readGameState(asker.userId);
      } catch (error) {
        output = { connected: false, why: `Could not reach the backend: ${describe(error)}` };
      }
    }

    console.log(`[game] ${asker?.speaker ?? "someone"}: ${JSON.stringify(output).slice(0, 220)}`);
    if (closed || socket?.readyState !== WebSocket.OPEN) return;

    send({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: callId, output: JSON.stringify(output) },
    });
    asking = asker;
    send({ type: "response.create" });
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
      case "response.function_call_arguments.done":
        if (event.name === GAME_STATE_TOOL.name) void serveGameState(String(event.call_id), asking);
        break;
      case "response.done":
        console.log(`[cost] ${meter.answered((event.response as { usage?: Parameters<typeof meter.answered>[0] })?.usage ?? {})}`);
        if (asking !== undefined) {
          lastAnswered = { speaker: asking.speaker, at: Date.now() };
          asking = undefined;
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
          ...(options.readGameState ? { tools: [GAME_STATE_TOOL], tool_choice: "auto" } : {}),
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
      console.error("[coach] could not hear:", describe(error));
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
    asking = { userId: utterance.userId, speaker: utterance.speaker };
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
