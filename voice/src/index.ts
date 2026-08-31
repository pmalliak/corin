/**
 * The voice host. Logs in to the gateway, sits in whichever voice channel the
 * players are using, and hands every utterance to a sink.
 *
 * Phase A deliberately has no command surface. The Worker owns `/coach`, and
 * teaching it to reach this process would mean a control channel before there
 * is anything worth controlling. Watching voice states instead means the coach
 * is simply there when you are, and the Worker needs no change at all.
 */

import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import type { Guild, VoiceBasedChannel } from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import { isMissingConfig, loadConfig, type Config } from "./config.ts";
import { listen, type Listener } from "./listener.ts";
import { createEchoSink } from "./echo.ts";

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  if (isMissingConfig(error)) {
    console.error(`\n  ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

const client = new Client({
  // Both are unprivileged. Voice states are what tell us who is where; nothing
  // here reads messages, and nothing here needs the member list.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let listener: Listener | undefined;

/** The channel with the most humans in it, or nothing if the server is empty. */
function busiestChannel(guild: Guild): VoiceBasedChannel | undefined {
  let best: VoiceBasedChannel | undefined;
  let bestCount = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildVoice) continue;
    // Discord's own AFK channel is where people go to not be talked to.
    if (channel.id === guild.afkChannelId) continue;
    const humans = channel.members.filter((member) => !member.user.bot).size;
    if (humans > bestCount) {
      best = channel;
      bestCount = humans;
    }
  }
  return best;
}

function leave(guildId: string, reason: string): void {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  console.log(`[voice] leaving: ${reason}`);
  listener?.stop();
  listener = undefined;
  connection.destroy();
}

async function join(channel: VoiceBasedChannel): Promise<void> {
  console.log(`[voice] joining "${channel.name}"`);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    // Deafened, the bot receives nothing at all. This is the one setting that
    // silently breaks everything downstream.
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch {
    console.error("[voice] the connection never became ready, giving up on this join");
    connection.destroy();
    return;
  }

  watchForDrops(connection, channel.guild.id);
  const guild = channel.guild;
  listener = listen(
    connection,
    (userId) => guild.members.cache.get(userId)?.displayName ?? userId,
    createEchoSink(connection),
  );
  console.log(`[voice] ready in "${channel.name}". Say something and it comes back to you.`);
}

/**
 * A voice connection drops for two very different reasons: Discord moved the
 * websocket, which resolves itself in a moment, or the bot was disconnected for
 * good. Waiting briefly tells them apart without a reconnect storm.
 */
function watchForDrops(connection: VoiceConnection, guildId: string): void {
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
    } catch {
      leave(guildId, "the connection dropped and did not come back");
    }
  });
}

async function reconsider(guild: Guild): Promise<void> {
  if (guild.id !== config.discordGuildId) return;

  const wanted = busiestChannel(guild);
  const connection = getVoiceConnection(guild.id);
  const currentId = connection?.joinConfig.channelId ?? undefined;

  if (!wanted) {
    leave(guild.id, "everyone left");
    return;
  }
  if (currentId === wanted.id) return;
  if (connection) leave(guild.id, `following the players to "${wanted.name}"`);
  await join(wanted);
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`[gateway] logged in as ${ready.user.tag}`);
  const guild = ready.guilds.cache.get(config.discordGuildId);
  if (!guild) {
    console.error(`[gateway] not a member of guild ${config.discordGuildId}. Run "npm run check".`);
    return;
  }
  await reconsider(guild);
  console.log("[voice] waiting for someone to join a voice channel");
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const guild = after.guild ?? before.guild;
  void reconsider(guild).catch((error: unknown) => {
    console.error("[voice] could not settle on a channel:", error instanceof Error ? error.message : error);
  });
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log("\n[shutdown] leaving the channel and logging out");
    leave(config.discordGuildId, "shutting down");
    void client.destroy();
  });
}

await client.login(config.discordBotToken);
