/**
 * Answers one question before any bot code exists: are the credentials in
 * `voice/.env` real, and do they have what the coach will need?
 *
 * Each check is a single cheap call to the service itself, because the only
 * proof a key works is the service saying so. A key can be perfectly formatted,
 * pasted into the right file, and still be revoked, scoped read only, or
 * attached to an account with no credit.
 *
 * It reads the environment directly rather than through `loadConfig`, so that a
 * credential you have not created yet reports as one missing row instead of
 * stopping the checks that could have passed.
 */

type Result = { label: string; ok: boolean; detail: string };

const NOT_SET = "not set in voice/.env yet.";

function read(name: string): string {
  return process.env[name]?.trim() ?? "";
}

async function checkDiscord(): Promise<Result> {
  const label = "Discord bot token";
  const token = read("DISCORD_BOT_TOKEN");
  if (!token) return { label, ok: false, detail: NOT_SET };
  try {
    const response = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });
    if (response.status === 401) {
      return { label, ok: false, detail: "rejected. Reset the token in the Developer Portal and paste the new one." };
    }
    if (!response.ok) return { label, ok: false, detail: `Discord answered ${response.status}.` };
    const bot = (await response.json()) as { username?: string; id?: string };
    return { label, ok: true, detail: `logged in as ${bot.username ?? "unknown"} (${bot.id ?? "?"}).` };
  } catch (error) {
    return { label, ok: false, detail: `could not reach Discord: ${describe(error)}` };
  }
}

async function checkOpenAi(): Promise<Result> {
  const label = "OpenAI API key";
  const key = read("OPENAI_API_KEY");
  if (!key) return { label, ok: false, detail: NOT_SET };
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (response.status === 401) {
      return { label, ok: false, detail: "rejected. It must be a project key from platform.openai.com, not a ChatGPT login." };
    }
    if (response.status === 403) {
      return { label, ok: false, detail: "forbidden. The key is probably read only; it needs model capabilities set to Write." };
    }
    if (response.status === 429) {
      return { label, ok: false, detail: "out of quota. Add credit in Billing before the coach can speak." };
    }
    if (!response.ok) return { label, ok: false, detail: `OpenAI answered ${response.status}.` };
    const body = (await response.json()) as { data?: Array<{ id?: string }> };
    const realtime = (body.data ?? []).map((model) => model.id ?? "").filter((id) => id.includes("realtime")).sort();
    if (realtime.length === 0) {
      return { label, ok: false, detail: "valid, but this project lists no realtime model, and voice needs one." };
    }
    return { label, ok: true, detail: `valid. Realtime models available: ${realtime.join(", ")}.` };
  } catch (error) {
    return { label, ok: false, detail: `could not reach OpenAI: ${describe(error)}` };
  }
}


function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function checkGuild(): Promise<Result> {
  const label = "Discord guild";
  const guild = read("DISCORD_GUILD_ID");
  const token = read("DISCORD_BOT_TOKEN");
  if (!guild) return { label, ok: false, detail: NOT_SET };
  if (!/^[0-9]{17,20}$/.test(guild)) {
    return { label, ok: false, detail: "does not look like a snowflake. Right click the server with Developer Mode on and copy the id." };
  }
  if (!token) return { label, ok: false, detail: `id looks right (${guild}), but membership needs the bot token to check.` };
  try {
    // Asks for the channel list rather than the guild, because it answers two
    // questions at once: whether the bot is actually in this server, and which
    // voice channels it can see. A valid snowflake the bot was never invited to
    // fails much later and much more confusingly.
    const response = await fetch(`https://discord.com/api/v10/guilds/${guild}/channels`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (response.status === 403 || response.status === 404) {
      // Almost always the same cause: the app was installed with the
      // `applications.commands` scope alone, which is enough for slash commands
      // and gives you no bot member at all. Voice needs the `bot` scope.
      return { label, ok: false, detail: "no bot member here. If slash commands work, the app was installed with applications.commands only; reinvite it with the bot scope. Otherwise the id belongs to another server." };
    }
    if (!response.ok) return { label, ok: false, detail: `Discord answered ${response.status}.` };
    const channels = (await response.json()) as Array<{ name?: string; type?: number }>;
    // 2 is a voice channel, 13 is a stage channel.
    const voice = channels.filter((channel) => channel.type === 2 || channel.type === 13);
    if (voice.length === 0) {
      return { label, ok: false, detail: "the bot is in the server but sees no voice channel. Check its channel permissions." };
    }
    const names = voice.map((channel) => channel.name ?? "?").join(", ");
    return { label, ok: true, detail: `bot is in it, and sees ${voice.length} voice channel(s): ${names}.` };
  } catch (error) {
    return { label, ok: false, detail: `could not reach Discord: ${describe(error)}` };
  }
}

const results = await Promise.all([checkDiscord(), checkOpenAi(), checkGuild()]);
console.log("");
for (const result of results) {
  console.log(`  ${result.ok ? "ok  " : "FAIL"}  ${result.label}: ${result.detail}`);
}
console.log("");
// `process.exitCode` rather than `process.exit()`: tearing the process down
// while fetch's sockets are still closing trips a libuv assertion on Windows.
process.exitCode = results.every((result) => result.ok) ? 0 : 1;
