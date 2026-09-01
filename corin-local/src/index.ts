import { PassThrough } from "node:stream";
import { ChannelType, Client, Events, GatewayIntentBits, PermissionsBitField } from "discord.js";
import type { Guild, VoiceBasedChannel } from "discord.js";
import {
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  type VoiceConnection,
} from "@discordjs/voice";
import prism from "prism-media";
import { loadConfig } from "./config.ts";
import { PcmMixer } from "./mixer.ts";
import { VbanEndpoint } from "./vban.ts";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const needed = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak];

let vban: VbanEndpoint | undefined;
let mixer: PcmMixer | undefined;
let receiverStop: (() => void) | undefined;
let discordOutput: PassThrough | undefined;

function mayEnter(channel: VoiceBasedChannel, guild: Guild): boolean {
  if (channel.id === guild.afkChannelId) return false;
  const me = guild.members.me;
  return me === null || channel.permissionsFor(me).has(needed);
}

function wantedChannel(guild: Guild): VoiceBasedChannel | undefined {
  if (config.channelId) {
    const pinned = guild.channels.cache.get(config.channelId);
    return pinned?.type === ChannelType.GuildVoice && mayEnter(pinned, guild) ? pinned : undefined;
  }
  let best: VoiceBasedChannel | undefined;
  let people = 0;
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildVoice || !mayEnter(channel, guild)) continue;
    const humans = [...channel.members.values()].filter((member) => member.id !== client.user?.id).length;
    if (humans > people) {
      best = channel;
      people = humans;
    }
  }
  return best;
}

function stopListening(): void {
  receiverStop?.();
  receiverStop = undefined;
  discordOutput?.end();
  discordOutput = undefined;
}

function receiveDiscord(connection: VoiceConnection): () => void {
  const active = new Set<string>();
  const onStart = (userId: string) => {
    if (userId === client.user?.id || active.has(userId)) return;
    active.add(userId);
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    decoder.on("data", (pcm: Buffer) => mixer?.push(userId, pcm));
    let stopped = false;
    const done = () => {
      if (stopped) return;
      stopped = true;
      active.delete(userId);
      opus.unpipe(decoder);
      opus.destroy();
      decoder.destroy();
    };
    opus.once("end", done);
    opus.once("error", (error) => {
      console.error("[discord receive]", error.message);
      done();
    });
    decoder.once("error", (error: Error) => {
      console.error("[opus decode]", error.message);
      done();
    });
    opus.pipe(decoder);
  };
  connection.receiver.speaking.on("start", onStart);
  return () => connection.receiver.speaking.off("start", onStart);
}

async function join(channel: VoiceBasedChannel): Promise<void> {
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const output = new PassThrough();
  const player = createAudioPlayer();
  player.on("error", (error) => console.error("[discord playback]", error.message));
  player.play(createAudioResource(output, { inputType: StreamType.Raw }));
  connection.subscribe(player);
  discordOutput = output;
  receiverStop = receiveDiscord(connection);
  console.log(`[corin-local] joined #${channel.name}`);
}

function leave(guildId: string, reason: string): void {
  const connection = getVoiceConnection(guildId);
  if (!connection) return;
  console.log(`[corin-local] leaving (${reason})`);
  stopListening();
  connection.destroy();
}

async function settle(guild: Guild): Promise<void> {
  if (guild.id !== config.guildId) return;
  const wanted = wantedChannel(guild);
  const connection = getVoiceConnection(guild.id);
  if (!wanted) {
    leave(guild.id, "no permitted channel has people in it");
    return;
  }
  if (connection?.joinConfig.channelId === wanted.id) return;
  if (connection) leave(guild.id, "following the channel");
  await join(wanted);
}

client.once(Events.ClientReady, async (ready) => {
  const guild = ready.guilds.cache.get(config.guildId);
  if (!guild) throw new Error(`Corin Local has not been invited to guild ${config.guildId}.`);
  vban = new VbanEndpoint(
    { host: config.vmHost, port: config.vmReceivePort, stream: config.toGptStream },
    { port: config.localReceivePort, stream: config.fromGptStream },
  );
  vban.on("error", (error) => console.error("[vban]", error.message));
  vban.on("audio", ({ pcm }) => discordOutput?.write(pcm));
  await vban.start();
  mixer = new PcmMixer((pcm) => vban?.sendPcm(pcm));
  mixer.start();
  console.log(`[corin-local] ${ready.user.tag} online`);
  console.log(`[vban] Discord -> ${config.toGptStream}; ChatGPT -> ${config.fromGptStream}`);
  await settle(guild);
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const guild = after.guild ?? before.guild;
  void settle(guild).catch((error: unknown) => console.error("[corin-local] could not settle:", error));
});
client.on(Events.Error, (error) => console.error("[discord]", error.message));

const close = () => {
  stopListening();
  mixer?.stop();
  vban?.close();
  leave(config.guildId, "shutting down");
  client.destroy();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

await client.login(config.botToken);
