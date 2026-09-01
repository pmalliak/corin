/**
 * Decides whether an utterance was addressed to the coach.
 *
 * This exists for one reason: money. Sending every word spoken in a voice
 * channel to a realtime model costs tens of cents a minute, and most of what is
 * said during a game is said to teammates. Transcription is roughly one
 * seventeenth of that price, so hearing everything cheaply and answering
 * expensively only when named is the difference between a coach you can leave
 * running and one you switch on for demos.
 *
 * The transcript is not thrown away. It is handed on, so the expensive model is
 * never asked to transcribe the same audio a second time.
 */

import { toWav } from "./audio.ts";
import type { Utterance } from "./listener.ts";

const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const MODEL_SAMPLE_RATE = 24_000;

/** Below this, one wrong letter is too much of the word to forgive. */
const FUZZY_FROM_LENGTH = 5;

export type Hearing = {
  addressed: boolean;
  text: string;
  /** False when the audio never reached the transcriber, so nothing was billed. */
  transcribed: boolean;
};

export type Gate = (utterance: Utterance, audio24kMono: Buffer) => Promise<Hearing>;

/**
 * Lowercases and strips accents, so that "Κόριν", "Κορίν" and "κοριν" are one
 * word. Speech to text puts accents wherever the sentence's melody suggests,
 * and a coach that answers only to correctly accented Greek is a coach that
 * mostly ignores you.
 */
export function normalise(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function tokenise(text: string): string[] {
  return normalise(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * True when one insertion, deletion or substitution turns one word into the
 * other. A name is the hardest thing for speech to text to get right, since it
 * cannot fall back on knowing the word: "Κόριν" comes back as "Corim" often
 * enough that demanding an exact match means being ignored half the time.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;

  if (a.length === b.length) {
    let differences = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i] && ++differences > 1) return false;
    }
    return differences === 1;
  }

  const [shorter, longer] = a.length < b.length ? [a, b] : [b, a];
  for (let i = 0, j = 0; j < longer.length; j++) {
    if (shorter[i] === longer[j]) i++;
    else if (j !== i) return false; // a second skip
  }
  return true;
}

export function isAddressed(text: string, wakeWords: string[]): boolean {
  const tokens = tokenise(text);
  const haystack = normalise(text);
  return wakeWords.some((wake) => {
    // A wake phrase of several words is matched whole, not token by token.
    if (wake.includes(" ")) return haystack.includes(wake);
    return tokens.some(
      (token) =>
        token === wake || (wake.length >= FUZZY_FROM_LENGTH && withinOneEdit(token, wake)),
    );
  });
}

/**
 * Vocabulary handed to the transcriber before it listens.
 *
 * Without it, short Greek speech comes back transliterated into Latin, and the
 * coach's own name with it: "Κόριν, τι χτίζω τώρα;" was heard as "Χωρίμτη φτίζω
 * τώρα", which no amount of fuzzy matching can rescue. With the vocabulary the
 * same audio comes back in Greek, correctly, and English is unaffected.
 *
 * Naming a language would work too, and is worse: half of what gets said in
 * this channel is English, and the coach must answer either.
 */
export function defaultTranscribePrompt(wakeWords: string[]): string {
  return [
    `${wakeWords.join(", ")}.`,
    "Συζήτηση για League of Legends στα ελληνικά και στα αγγλικά.",
    "Champion, lane, jungle, gank, ulti, cooldown, CS, KDA, gold, items, dragon, baron, inhibitor, ward.",
  ].join(" ");
}

/**
 * True when the transcriber handed back its own priming vocabulary instead of
 * transcribing anything.
 *
 * Whisper family models continue the prompt when the audio carries no speech
 * they can make out, so a cough returns the word list verbatim. That list
 * contains the coach's name by design, so without this check the coach answers
 * a question nobody asked. It happened on the first real session, twice.
 *
 * A contiguous run of the vocabulary is the signature: real speech is never a
 * substring of a list of unrelated terms. Very short transcripts are exempt,
 * since "corin" alone is legitimately inside the prompt and is also exactly
 * what someone shouting the name produces.
 */
export function isPromptEcho(text: string, prompt: string): boolean {
  if (!prompt) return false;
  const spoken = tokenise(text);
  if (spoken.length < 5) return false;
  return tokenise(prompt).join(" ").includes(spoken.join(" "));
}

/**
 * Loudness of an utterance, 0 to 1. Discord ends a turn on its own silence
 * timer, so what arrives here can be a keyboard, a chair, or a breath, and
 * paying to transcribe those is paying for nothing.
 */
export function loudness(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * 2) / 32_768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

export type WakeGateOptions = {
  apiKey: string;
  model: string;
  wakeWords: string[];
  prompt: string;
  /** ISO code, or empty to let the transcriber guess. */
  language: string;
  /** Below this loudness an utterance is treated as noise and never sent. */
  minLoudness: number;
};

/**
 * Whether a sentence deserves an answer once a conversation is already open.
 *
 * The name is not required any more, since nobody says it before every
 * sentence, but something has to be. A few words is the whole test: below that
 * it is an interjection to the room, not a question to the coach.
 */
export function createRelevance(wakeWords: string[], minWords: number): (text: string) => boolean {
  const words = wakeWords.map(normalise).filter(Boolean);
  return (text) => {
    if (isAddressed(text, words)) return true;
    return text.split(/\s+/).filter(Boolean).length >= minWords;
  };
}

export function createWakeGate(options: WakeGateOptions): Gate {
  const words = options.wakeWords.map(normalise).filter(Boolean);

  return async (utterance, audio24kMono) => {
    if (loudness(audio24kMono) < options.minLoudness) {
      return { addressed: false, text: "", transcribed: false };
    }

    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array(toWav(audio24kMono, MODEL_SAMPLE_RATE, 1))], { type: "audio/wav" }),
      "utterance.wav",
    );
    form.append("model", options.model);
    form.append("response_format", "json");
    if (options.language) form.append("language", options.language);
    if (options.prompt) form.append("prompt", options.prompt);

    const response = await fetch(TRANSCRIBE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`transcription failed with ${response.status}: ${detail.slice(0, 200)}`);
    }

    const text = ((await response.json()) as { text?: string }).text?.trim() ?? "";
    if (isPromptEcho(text, options.prompt)) return { addressed: false, text: "", transcribed: true };
    return { addressed: isAddressed(text, words), text, transcribed: true };
  };
}
