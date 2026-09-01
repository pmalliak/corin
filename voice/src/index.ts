/**
 * The voice host. Logs in to the gateway, sits in whichever voice channel the
 * players are using, and hands every utterance to a sink.
 *
 * There is deliberately no command surface. The Worker owns `/coach`, and
 * teaching it to reach this process would mean a control channel before there
 * is anything worth controlling. Watching voice states instead means the coach
 * is simply there when you are, and the Worker needs no change at all.
 */

import { fileURLToPath } from "node:url";

import { ChannelType, Client, Events, GatewayIntentBits, PermissionsBitField } from "discord.js";
import type { Guild, VoiceBasedChannel } from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import { isMissingConfig, loadConfig, requireOpenAiKey, type Config } from "./config.ts";
import { listen, type Listener, type Sink } from "./listener.ts";
import { createEchoSink } from "./echo.ts";
import { createCoach, type Coach } from "./coach.ts";
import { createWakeGate, defaultTranscribePrompt } from "./wake.ts";
import { createGameStateReader } from "./state.ts";
import { installCrashGuard } from "./resilience.ts";
import { AlreadyRunning, claimSingleInstance } from "./lock.ts";

// Before anything opens a socket. The gateway library leaves its own socket's
// error events unhandled outside worker mode, and one reset would otherwise be
// the end of an all night process.
installCrashGuard();

// Two hosts on one bot token steal the voice connection from each other, and
// the symptom is wrong behaviour rather than an error. An abandoned instance
// once answered a question by playing the asker their own voice back.
let releaseLock: () => void;
try {
  releaseLock = claimSingleInstance(fileURLToPath(new URL("../.corin.lock", import.meta.url)));
} catch (error) {
  if (error instanceof AlreadyRunning) {
    console.error(`
  ${error.message}
`);
    process.exit(1);
  }
  throw error;
}

let config: Config;
try {
  config = loadConfig();
  if (config.sink === "coach") requireOpenAiKey(config);
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
let coach: Coach | undefined;

/** The channel with the most humans in it, or nothing if the server is empty. */
/**
 * Where the coach is allowed to go is a Discord permission, not a setting in
 * this repository. Take Connect away from a channel and the coach stops
 * entering it; give it only to one channel and that is the only place it can
 * ever appear. No restart, no deploy, and it is managed in the same place as
 * every other permission on the server, which is where the Worker already
 * leaves the question of who may use `/coach`.
 *
 * `COACH_CHANNEL_ID` pins it harder still, for when a permission is too blunt.
 */
const NEEDED = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak];

function mayEnter(channel: VoiceBasedChannel, guild: Guild): boolean {
  if (config.channelId && channel.id !== config.channelId) return false;
  if (channel.id === guild.afkChannelId) return false; // where people go to not be talked to
  const me = guild.members.me;
  return me === null || channel.permissionsFor(me).has(NEEDED);
}

/** The channel with the most humans in it that the coach is allowed to join. */
function busiestChannel(guild: Guild): VoiceBasedChannel | undefined {
  let best: VoiceBasedChannel | undefined;
  let bestCount = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildVoice) continue;
    if (!mayEnter(channel, guild)) continue;
    const humans = channel.members.filter((member) => !member.user.bot).size;
    if (humans > bestCount) {
      best = channel;
      bestCount = humans;
    }
  }
  return best;
}

function buildSink(connection: VoiceConnection): Sink {
  if (config.sink === "echo") {
    console.log("[voice] echo sink: you will hear yourself, and OpenAI is never called");
    return createEchoSink(connection);
  }
  console.log(
    `[voice] coach sink: ${config.coachModel}, voice "${config.coachVoice}", ` +
      `answering to ${config.wakeWords.join(", ")}`,
  );
  // Both halves are needed: where the Worker is, and permission to ask it. With
  // either missing the coach still talks, it just cannot see anybody's game.
  const eyes =
    config.workerUrl && config.serviceToken
      ? createGameStateReader(config.workerUrl, config.serviceToken)
      : undefined;
  if (!eyes) console.warn("[voice] no game link: set CORIN_WORKER_URL and COACH_SERVICE_TOKEN to give the coach eyes");

  coach = createCoach({
    readGameState: eyes,
    connection,
    apiKey: config.openAiApiKey,
    model: config.coachModel,
    voice: config.coachVoice,
    followUpMs: config.followUpMs,
    followUpMinWords: config.followUpMinWords,
    gate: createWakeGate({
      apiKey: config.openAiApiKey,
      model: config.transcribeModel,
      wakeWords: config.wakeWords,
      prompt: config.transcribePrompt || defaultTranscribePrompt(config.wakeWords),
      language: config.transcribeLanguage,
      minLoudness: config.minLoudness,
    }),
  });
  return coach.sink;
}

function leave(guildId: string, reason: string): void {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  console.log(`[voice] leaving: ${reason}`);
  listener?.stop();
  listener = undefined;
  coach?.close();
  coach = undefined;
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
    buildSink(connection),
  );
  console.log(`[voice] ready in "${channel.name}"`);
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

// discord.js surfaces these rather than throwing, and an EventEmitter with no
// listener on "error" throws by definition.
client.on(Events.Error, (error) => console.error("[gateway] error:", error.message));
client.on(Events.ShardError, (error) => console.error("[gateway] shard error:", error.message));

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
    releaseLock();
    void client.destroy();
  });
}

await client.login(config.discordBotToken);
