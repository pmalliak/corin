export type Config = {
  botToken: string;
  guildId: string;
  channelId: string;
  vmHost: string;
  vmReceivePort: number;
  localReceivePort: number;
  toGptStream: string;
  fromGptStream: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}

function port(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} must be a UDP port.`);
  return value;
}

function stream(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[\x20-\x7e]{1,16}$/.test(value)) throw new Error(`${name} must be 1–16 printable ASCII characters.`);
  return value;
}

export function loadConfig(): Config {
  return {
    botToken: required("DISCORD_BOT_TOKEN"),
    guildId: required("DISCORD_GUILD_ID"),
    channelId: process.env.CORIN_LOCAL_CHANNEL_ID?.trim() ?? "",
    vmHost: process.env.VM_HOST?.trim() || "127.0.0.1",
    vmReceivePort: port("VM_RECEIVE_PORT", 6980),
    localReceivePort: port("LOCAL_RECEIVE_PORT", 6981),
    toGptStream: stream("CORIN_TO_GPT_STREAM", "CORIN_TO_GPT"),
    fromGptStream: stream("GPT_TO_CORIN_STREAM", "GPT_TO_CORIN"),
  };
}
