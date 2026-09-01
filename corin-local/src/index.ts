import { ChannelType, Client, Events, GatewayIntentBits, PermissionsBitField } from "discord.js";
import { spawn, type ChildProcess } from "node:child_process";
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
import { JitterBuffer } from "./playback.ts";
import { VbanEndpoint } from "./vban.ts";

const config = loadConfig();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const needed = [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak];

let vban: VbanEndpoint | undefined;
let mixer: PcmMixer | undefined;
let receiverStop: (() => void) | undefined;
let discordOutput: JitterBuffer | undefined;
let chatGptCapture: ChildProcess | undefined;

function referenceTone(): Buffer {
  const samples = 48_000 * 2;
  const pcm = Buffer.alloc(samples * 2 * 2);
  for (let sample = 0; sample < samples; sample += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * sample) / 48_000) * 8_000);
    pcm.writeInt16LE(value, sample * 4);
    pcm.writeInt16LE(value, sample * 4 + 2);
  }
  return pcm;
}

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
  discordOutput?.close();
  discordOutput = undefined;
}

/** Captures the B2 bus directly, avoiding the noisy VBAN output hop. */
function startChatGptCapture(): void {
  if (chatGptCapture) return;
  const executable = process.env.FFMPEG_PATH ??
    "C:\\Users\\panos\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg.Essentials_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-essentials_build\\bin\\ffmpeg.exe";
  const capture = spawn(executable, [
    "-hide_banner", "-loglevel", "warning", "-thread_queue_size", "512",
    "-f", "dshow", "-audio_buffer_size", "50",
    "-i", "audio=Voicemeeter Out B2 (VB-Audio Voicemeeter VAIO)",
    "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1",
  ], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  capture.stdout?.on("data", (pcm: Buffer) => discordOutput?.write(pcm));
  capture.stderr?.on("data", (message: Buffer) => console.error("[B2 capture]", message.toString().trim()));
  capture.once("error", (error) => console.error("[B2 capture]", error.message));
  capture.once("exit", (code, signal) => {
    chatGptCapture = undefined;
    console.warn(`[B2 capture] stopped (code ${code}, signal ${signal})`);
  });
  chatGptCapture = capture;
}

function receiveDiscord(connection: VoiceConnection): () => void {
  const active = new Set<string>();
  const onStart = (userId: string) => {
    if (userId === client.user?.id || active.has(userId)) return;
    active.add(userId);
    console.log(`[discord receive] speaker started: ${userId}`);
    const opus = connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    let receivedAudio = false;
    decoder.on("data", (pcm: Buffer) => {
      if (!receivedAudio) {
        receivedAudio = true;
        console.log(`[discord receive] first PCM frame: ${pcm.length} bytes`);
      }
      mixer?.push(userId, pcm);
    });
    let stopped = false;
    const done = () => {
      if (stopped) return;
      stopped = true;
      active.delete(userId);
      mixer?.forget(userId);
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

  const output = new JitterBuffer();
  const player = createAudioPlayer();
  player.on("error", (error) => console.error("[discord playback]", error.message));
  const resource = createAudioResource(output, { inputType: StreamType.Raw });
  // The server's voice channels are capped at 64 kbps.  Sending a higher-rate
  // Opus stream than the channel accepts makes the receiver discard or mangle
  // packets, which sounds like digital static.
  resource.encoder?.setBitrate(64_000);
  resource.encoder?.setFEC(true);
  resource.encoder?.setPLP(0.05);
  player.play(resource);
  connection.subscribe(player);
  discordOutput = output;
  if (process.argv.includes("--test-tone")) {
    output.write(referenceTone());
    console.log("[audio test] playing a 2-second 440 Hz reference tone");
  }
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
  vban.on("gap", ({ expected, received }) => console.warn(`[vban] packet gap: expected ${expected}, received ${received}`));
  await vban.start();
  mixer = new PcmMixer((pcm) => vban?.sendPcm(pcm));
  mixer.start();
  console.log(`[corin-local] ${ready.user.tag} online`);
  console.log(`[vban] Discord -> ${config.toGptStream}; ChatGPT -> ${config.fromGptStream}`);
  await settle(guild);
  startChatGptCapture();
});

client.on(Events.VoiceStateUpdate, (before, after) => {
  const guild = after.guild ?? before.guild;
  void settle(guild).catch((error: unknown) => console.error("[corin-local] could not settle:", error));
});
client.on(Events.Error, (error) => console.error("[discord]", error.message));

const close = () => {
  stopListening();
  mixer?.stop();
  chatGptCapture?.kill();
  chatGptCapture = undefined;
  vban?.close();
  leave(config.guildId, "shutting down");
  client.destroy();
};
process.once("SIGINT", close);
process.once("SIGTERM", close);

await client.login(config.botToken);
