/**
 * Every secret the voice host needs, read once at startup.
 *
 * Node loads `voice/.env` itself through `--env-file-if-exists`, so a missing
 * file is not a crash before our own code runs, it is one clear message naming
 * what to create. The distinction that matters is required now versus required
 * later: phase A joins a voice channel and echoes audio back, which needs
 * Discord and nothing else, so an empty OpenAI key must not stop it.
 */

export type Config = {
  discordBotToken: string;
  discordGuildId: string;
  /** Empty until phase B. Read through `requireOpenAiKey` at the point of use. */
  openAiApiKey: string;
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

export function loadConfig(): Config {
  return {
    discordBotToken: required("DISCORD_BOT_TOKEN"),
    discordGuildId: required("DISCORD_GUILD_ID"),
    openAiApiKey: process.env.OPENAI_API_KEY?.trim() ?? "",
    workerUrl: process.env.CORIN_WORKER_URL?.trim() ?? "",
  };
}

/** Phase B onward. Kept separate so phase A runs without an OpenAI account. */
export function requireOpenAiKey(config: Config): string {
  if (!config.openAiApiKey) {
    throw new MissingConfig(
      "OPENAI_API_KEY is not set, and the coach cannot speak without it. Set it in voice/.env.",
    );
  }
  return config.openAiApiKey;
}

export function isMissingConfig(error: unknown): error is MissingConfig {
  return error instanceof MissingConfig;
}
