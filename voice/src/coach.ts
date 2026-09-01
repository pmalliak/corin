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

/** Roughly a hundred milliseconds of model audio per websocket message. */
const APPEND_BYTES = 4_800;

/** How stale the match may get while a conversation is open. */
const STATE_REFRESH_MS = 10_000;

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
  "Πριν από κάθε ερώτηση σου δίνεται η ΤΡΕΧΟΥΣΑ κατάσταση του παιχνιδιού αυτού που ρωτάει, ως GAME STATE:",
  "champion, level, KDA, CS, gold, items, ability ranks, ο χρόνος του game και οι υπόλοιποι παίκτες ανά champion.",
  "Είναι ήδη μπροστά σου. Δεν χρειάζεται να το ζητήσεις, να το τσεκάρεις ή να πεις ότι θα το κοιτάξεις. Απάντα κατευθείαν από αυτό.",
  "Ποτέ μην εφεύρεις νούμερο για το τρέχον match. Αν το GAME STATE λέει connected false, πες τον λόγο σε μία πρόταση.",
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

export type Coach = {
  sink: Sink;
  /** True while this speaker is on the streaming path, so the gated one leaves them alone. */
  isStreaming: (userId: string) => boolean;
  /** Opens a Realtime line without requiring a wake word while the local PTT key is held. */
  startPushToTalk: (asker: Asking) => void;
  /** Stops the PTT line immediately when the key is released. */
  stopPushToTalk: () => void;
  close: () => void;
};

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
  /** Named so the open line can transcribe with the same ear as the gated path. */
  transcribeModel: string;
  language: string;
  /** Opens a continuous line from one speaker. Absent keeps every turn on the gated path. */
  startStream?: (userId: string, onPcm: (pcm: Buffer) => void) => () => void;
};

type Asking = { userId: string; speaker: string };
type ResponseTiming = { speaker: string; requestedAt: number; turnStartedAt: number; firstAudio: boolean };

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
  /** Lets the live logs separate transcription, state lookup and model delay. */
  let responseTiming: ResponseTiming | undefined;
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

  const requestResponse = (asker: Asking, turnStartedAt = performance.now()): void => {
    asking = asker;
    responseTiming = { speaker: asker.speaker, requestedAt: performance.now(), turnStartedAt, firstAudio: false };
    console.log(`[latency] ${asker.speaker}: response requested after ${Math.round(performance.now() - turnStartedAt)}ms`);
    send({ type: "response.create" });
  };

  /**
   * The whole session, every time.
   *
   * A partial session.update is a gamble on whether the server merges or
   * replaces, and losing that gamble costs the instructions and the voice on the
   * first mode switch. Only turn detection ever differs between the two modes,
   * so sending everything is both safer and shorter than reasoning about it.
   */
  const sessionConfig = (turnDetection: Record<string, unknown> | null): Record<string, unknown> => ({
    type: "realtime",
    instructions: INSTRUCTIONS,
    output_modalities: ["audio"],
    audio: {
      input: {
        format: { type: "audio/pcm", rate: MODEL_SAMPLE_RATE },
        turn_detection: turnDetection,
        transcription: turnDetection
          ? { model: options.transcribeModel, ...(options.language ? { language: options.language } : {}) }
          : null,
      },
      output: { format: { type: "audio/pcm", rate: MODEL_SAMPLE_RATE }, voice: options.voice },
    },
  });

  let stateItems = 0;
  let previousStateItemId: string | undefined;

  /**
   * Hands the asker's current match over together with their question.
   *
   * This was a tool the model could call, and the model narrated every single
   * call: "Μια στιγμή, θα σου πω" and then, in a second spoken turn, the answer.
   * Two mouthfuls of a player's attention where one was asked for, and two
   * billed responses instead of one. Fetching it here costs one request to our
   * own Worker and removes both.
   *
   * The previous turn's state is deleted rather than left in the conversation.
   * It is expensive to keep, and it is wrong: a match moves on, and a model that
   * can see two clocks may read the older one.
   */
  const sendGameState = async (asker: Asking): Promise<void> => {
    const read = options.readGameState;
    if (!read) return;

    const startedAt = performance.now();
    let state: Record<string, unknown>;
    try {
      state = await read(asker.userId);
    } catch (error) {
      state = { connected: false, why: "Could not reach the backend: " + describe(error) };
    }
    if (closed || socket?.readyState !== WebSocket.OPEN) return;

    const id = "item_state_" + ++stateItems;
    send({
      type: "conversation.item.create",
      item: {
        id,
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "GAME STATE (" + asker.speaker + "): " + JSON.stringify(state) }],
      },
    });
    if (previousStateItemId) send({ type: "conversation.item.delete", item_id: previousStateItemId });
    previousStateItemId = id;
    console.log("[game] " + asker.speaker + ": " + JSON.stringify(state).slice(0, 170));
    console.log(`[latency] ${asker.speaker}: game state in ${Math.round(performance.now() - startedAt)}ms`);
  };


  /**
   * An open conversation with one speaker, where their audio goes up as they
   * say it and the model decides for itself when the turn ended.
   *
   * The gated path waits for eight hundred milliseconds of silence, then spends
   * a transcription round trip deciding whether to bother, and only then does
   * the model start thinking. That is the right trade when nobody is talking to
   * the coach and the wrong one the moment somebody is.
   *
   * The model detects the turn but never answers on its own: create_response is
   * false. In a game channel most sentences are said to teammates, and a coach
   * that replies to those is worse than a slow one.
   */
  type Conversation = { userId: string; speaker: string; startedAt: number; stop: () => void; timers: NodeJS.Timeout[] };
  let conversation: Conversation | undefined;
  let pushToTalkUserId: string | undefined;
  let pushToTalkResponseUserId: string | undefined;
  let pendingPushToTalkResponse: { asker: Asking; turnStartedAt: number } | undefined;
  let pending = Buffer.alloc(0);
  let appendedBytes = 0;

  const flushAudio = (): void => {
    if (pending.length === 0) return;
    send({ type: "input_audio_buffer.append", audio: pending.toString("base64") });
    appendedBytes += pending.length;
    pending = Buffer.alloc(0);
  };

  const listenContinuously = (): void => {
    if (!conversation) return;
    // The model says when the sentence ended. Whether it gets answered is ours.
    send({
      type: "session.update",
      session: sessionConfig({ type: "semantic_vad", eagerness: "high", create_response: false }),
    });
  };

  const endConversation = (reason: string): void => {
    if (!conversation) return;
    const seconds = (appendedBytes / (MODEL_SAMPLE_RATE * 2)).toFixed(1);
    console.log("[flow] closing the line with " + conversation.speaker + ": " + reason + " (sent " + seconds + "s of audio)");
    appendedBytes = 0;
    for (const timer of conversation.timers) clearTimeout(timer);
    conversation.stop();
    conversation = undefined;
    pending = Buffer.alloc(0);
    send({ type: "input_audio_buffer.clear" });
    send({ type: "session.update", session: sessionConfig(null) });
  };

  const holdConversationOpen = (): void => {
    if (!conversation) return;
    for (const timer of conversation.timers) clearTimeout(timer);
    if (pushToTalkUserId === conversation.userId) return;
    conversation.timers = [
      setTimeout(() => endConversation("nobody said anything more"), options.followUpMs),
      setInterval(() => {
        if (conversation) void sendGameState({ userId: conversation.userId, speaker: conversation.speaker });
      }, STATE_REFRESH_MS) as unknown as NodeJS.Timeout,
    ];
  };

  const beginConversation = (asker: Asking): void => {
    const open = options.startStream;
    if (!open || closed || socket?.readyState !== WebSocket.OPEN) return;
    if (conversation?.userId === asker.userId) {
      holdConversationOpen();
      return;
    }
    endConversation("somebody else is talking now");

    console.log(`[flow] open line with ${asker.speaker}`);
    const stop = open(asker.userId, (pcm) => {
      pending = Buffer.concat([pending, toModelAudio(pcm)]);
      if (pending.length >= APPEND_BYTES) flushAudio();
    });
    conversation = { userId: asker.userId, speaker: asker.speaker, startedAt: performance.now(), stop, timers: [] };
    listenContinuously();
    holdConversationOpen();
  };

  const startPushToTalk = (asker: Asking): void => {
    if (pushToTalkUserId === asker.userId && conversation?.userId === asker.userId) return;
    if (speaking) {
      send({ type: "response.cancel" });
      stopSpeaking();
    }
    endConversation("starting push-to-talk");
    pushToTalkUserId = asker.userId;
    const open = options.startStream;
    if (!open || closed || socket?.readyState !== WebSocket.OPEN) return;
    const stop = open(asker.userId, (pcm) => {
      pending = Buffer.concat([pending, toModelAudio(pcm)]);
      if (pending.length >= APPEND_BYTES) flushAudio();
    });
    conversation = { userId: asker.userId, speaker: asker.speaker, startedAt: performance.now(), stop, timers: [] };
    // Releasing Shift defines the turn boundary, so the client commits audio
    // directly instead of waiting for a silence detector to guess.
    send({ type: "session.update", session: sessionConfig(null) });
  };

  const stopPushToTalk = (): void => {
    const userId = pushToTalkUserId;
    pushToTalkUserId = undefined;
    const active = conversation;
    if (!userId || !active || active.userId !== userId) return;
    active.stop();
    conversation = undefined;
    flushAudio();
    if (appendedBytes === 0) return;
    pushToTalkResponseUserId = userId;
    void (async () => {
      if (active.speaker !== lastSpeaker) {
        send({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: `${active.speaker} is speaking.` }],
          },
        });
        lastSpeaker = active.speaker;
      }
      await sendGameState({ userId: active.userId, speaker: active.speaker });
      if (closed || socket?.readyState !== WebSocket.OPEN) return;
      pendingPushToTalkResponse = {
        asker: { userId: active.userId, speaker: active.speaker },
        turnStartedAt: active.startedAt,
      };
      send({ type: "input_audio_buffer.commit" });
    })();
  };

  /** A sentence the open line just finished hearing.
   *
   * This line belongs to exactly one person, who has just explicitly addressed
   * Corin. Once it is open, treating "ναι", "όχι" or "και μετά;" as ordinary
   * room chatter makes the exchange feel like a command interface. A phone
   * conversation does not ask for a wake word or three words between turns, so
   * neither does this private follow-up line. Everyone else remains on the
   * gated path below.
   */
  let lineSpeechStartedAt: number | undefined;

  const heardOnTheLine = (itemId: string, transcript: string): void => {
    if (!conversation) return;
    const text = transcript.trim();
    console.log(`[flow] ${conversation.speaker}: ${text || "(nothing)"}`);
    if (!text) {
      // Left in the conversation it would be paid for on every later turn.
      send({ type: "conversation.item.delete", item_id: itemId });
      return;
    }
    const turnStartedAt = lineSpeechStartedAt ?? performance.now();
    console.log(`[latency] ${conversation.speaker}: live transcription in ${Math.round(performance.now() - turnStartedAt)}ms`);
    lineSpeechStartedAt = undefined;
    holdConversationOpen();
    requestResponse({ userId: conversation.userId, speaker: conversation.speaker }, turnStartedAt);
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
        if (responseTiming && !responseTiming.firstAudio) {
          responseTiming.firstAudio = true;
          const now = performance.now();
          console.log(
            `[latency] ${responseTiming.speaker}: first audio ${Math.round(now - responseTiming.requestedAt)}ms after request, ${Math.round(now - responseTiming.turnStartedAt)}ms total`,
          );
        }
        const chunk = Buffer.from(String(event.delta ?? ""), "base64");
        const target = speaking?.stream ?? beginSpeaking();
        const converted = toDiscordAudio(chunk, speaking?.carry ?? 0);
        if (speaking) speaking.carry = converted.carry;
        target.write(converted.pcm);
        break;
      }
      case "input_audio_buffer.committed": {
        const pending = pendingPushToTalkResponse;
        pendingPushToTalkResponse = undefined;
        if (pending) requestResponse(pending.asker, pending.turnStartedAt);
        break;
      }
      case "response.output_audio_transcript.done":
        console.log(`[coach] said: ${String(event.transcript ?? "").trim()}`);
        break;
      case "response.done":
        if (responseTiming) {
          console.log(`[latency] ${responseTiming.speaker}: response complete in ${Math.round(performance.now() - responseTiming.requestedAt)}ms`);
          responseTiming = undefined;
        }
        console.log(`[cost] ${meter.answered((event.response as { usage?: Parameters<typeof meter.answered>[0] })?.usage ?? {})}`);
        if (asking !== undefined) {
          lastAnswered = { speaker: asking.speaker, at: Date.now() };
          if (pushToTalkResponseUserId === asking.userId) {
            pushToTalkResponseUserId = undefined;
          } else {
            beginConversation(asking);
          }
          asking = undefined;
        }
        speaking?.stream.end();
        speaking = undefined;
        break;
      case "input_audio_buffer.speech_started":
        if (conversation) {
          lineSpeechStartedAt = performance.now();
          console.log("[flow] hears speech");
        }
        break;
      case "input_audio_buffer.speech_stopped":
        if (conversation) console.log("[flow] turn ended");
        break;
      case "conversation.item.input_audio_transcription.failed":
        console.error("[flow] could not transcribe:", JSON.stringify(event.error ?? event).slice(0, 200));
        break;
      case "conversation.item.input_audio_transcription.completed":
        heardOnTheLine(String(event.item_id ?? ""), String(event.transcript ?? ""));
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
      previousStateItemId = undefined;
      // Outside a conversation Discord decides when a turn ended, not the model.
      send({ type: "session.update", session: sessionConfig(null) });
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
      endConversation("the connection to OpenAI dropped");
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
    const turnStartedAt = performance.now();
    const audio = toModelAudio(utterance.pcm);
    let heard;
    try {
      heard = await options.gate(utterance, audio);
    } catch (error) {
      console.error("[coach] could not hear:", describe(error));
      return;
    }
    console.log(`[latency] ${utterance.speaker}: wake transcription in ${Math.round(performance.now() - turnStartedAt)}ms`);

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

    await sendGameState({ userId: utterance.userId, speaker: utterance.speaker });
    if (closed || socket?.readyState !== WebSocket.OPEN) return;

    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_audio", audio: audio.toString("base64"), transcript: heard.text }],
      },
    });
    requestResponse({ userId: utterance.userId, speaker: utterance.speaker }, turnStartedAt);
  };

  return {
    sink,
    isStreaming: (userId) => conversation?.userId === userId,
    startPushToTalk,
    stopPushToTalk,
    close: () => {
      closed = true;
      pushToTalkUserId = undefined;
      pendingPushToTalkResponse = undefined;
      endConversation("the coach is leaving");
      stopSpeaking();
      socket?.close();
    },
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
