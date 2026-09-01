/**
 * Every secret and dial the voice host needs, read once at startup.
 *
 * Node loads `voice/.env` itself through `--env-file-if-exists`, so a missing
 * file is not a crash before our own code runs, it is one clear message naming
 * what to create. The distinction that matters is required now versus required
 * later: the echo sink needs Discord and nothing else, so an empty OpenAI key
 * must not stop it.
 */

export type SinkName = "coach" | "echo";

export type Config = {
  discordBotToken: string;
  discordGuildId: string;
  /** Empty is allowed, and only the coach sink minds. */
  openAiApiKey: string;
  /** `echo` plays you back to yourself, which is how the audio path is diagnosed. */
  sink: SinkName;
  coachModel: string;
  coachVoice: string;
  /** Empty lets Discord permissions decide; set it to pin the coach to one channel. */
  channelId: string;
  transcribeModel: string;
  /** Vocabulary given to the transcriber. Empty means the default for the wake words. */
  transcribePrompt: string;
  /** ISO code handed to the transcriber. Empty means let it guess. */
  transcribeLanguage: string;
  /** RMS below which an utterance is noise, 0 to 1. */
  minLoudness: number;
  /** Seconds after an answer during which a follow up needs no wake word. */
  followUpMs: number;
  /** Words below which a follow up is thinking aloud, not a question. */
  followUpMinWords: number;
  wakeWords: string[];
  workerUrl: string;
};

class MissingConfig extends Error {}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new MissingConfig(
      `${name} is not set. Copy voice/.env.example to voice/.env and fill it in.`,
    );
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

export function loadConfig(): Config {
  const sink = optional("CORIN_SINK", "coach");
  if (sink !== "coach" && sink !== "echo") {
    throw new MissingConfig(`CORIN_SINK must be "coach" or "echo", not "${sink}".`);
  }

  return {
    discordBotToken: required("DISCORD_BOT_TOKEN"),
    discordGuildId: required("DISCORD_GUILD_ID"),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    sink,
    // The mini model is a sixth of the price of the full one and the difference
    // is hard to hear on two sentences of advice. Raise it when it stops being.
    channelId: process.env.COACH_CHANNEL_ID?.trim() ?? "",
    // The mini model got League facts wrong: it described Lamb's Respite as
    // preventing damage and targeting, which it does not do. A coach that is
    // confidently wrong about the game is worth less than no coach, and the
    // difference is a fraction of a cent per answer.
    coachModel: optional("COACH_MODEL", "gpt-realtime-2.1"),
    // Chosen by ear against all ten, reading a Greek line with English League
    // terms in it. Deeper than the alternatives, which suits a server whose
    // channels are a Gatehouse and a Great Hall.
    coachVoice: optional("COACH_VOICE", "ash"),
    transcribeModel: optional("COACH_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe"),
    transcribePrompt: process.env.COACH_TRANSCRIBE_PROMPT?.trim() ?? "",
    // The players speak Greek with English League terms inside it. Naming the
    // language measured strictly better than letting the transcriber guess,
    // 5 of 5 wake words caught against 4, and the English terms survive intact:
    // guessing turned "Κόριν" into "Korim" and once into "Χωρίμτη".
    transcribeLanguage: optional("COACH_LANGUAGE", "el"),
    // Discord ends a turn on its own silence timer, so a cough arrives here as
    // an utterance. Anything quieter than this is never sent anywhere.
    minLoudness: Number.parseFloat(optional("COACH_MIN_LOUDNESS", "0.01")),
    // Long enough for "και τι cooldown έχει;" right after an answer, short
    // enough that the table's next conversation never reaches the model.
    followUpMs: Number.parseFloat(optional("COACH_FOLLOW_UP_SECONDS", "20")) * 1000,
    followUpMinWords: Number.parseInt(optional("COACH_FOLLOW_UP_MIN_WORDS", "3"), 10),
    // Both scripts, because the name is said in Greek sentences as often as
    // English ones and speech to text writes it the way it was spoken.
    wakeWords: optional("COACH_WAKE_WORDS", "corin,κοριν,coach,κοουτς")
      .split(",")
      .map((word) => word.trim())
      .filter(Boolean),
    workerUrl: process.env.CORIN_WORKER_URL?.trim() ?? "",
  };
}

/** The coach sink cannot exist without it; the echo sink never asks. */
export function requireOpenAiKey(config: Config): string {
  if (!config.openAiApiKey) {
    throw new MissingConfig(
      "OPENAI_API_KEY is not set, and the coach cannot speak without it. Set it in voice/.env, or set CORIN_SINK=echo.",
    );
  }
  return config.openAiApiKey;
}

export function isMissingConfig(error: unknown): error is MissingConfig {
  return error instanceof MissingConfig;
}
