import type { DiscordMessage } from "./discord";
import type { DeviceSnapshot, PairingCode } from "./types";

const brand = 0xc8aa6e;
const good = 0x3ba55d;
const caution = 0xe67e22;
const bad = 0xed4245;
const neutral = 0x99aab5;

const footer = { text: "Corin • one pairing per PC • your game data stays yours" };

export function setupMessage(downloadUrl: string): DiscordMessage {
  return {
    embeds: [
      {
        title: "🎮  Set up your LoL Coach",
        url: downloadUrl,
        color: brand,
        description:
          "The coach answers questions about **your own live game**, so it needs a small agent running on your PC. Once per machine, about five minutes.",
        fields: [
          {
            name: "1️⃣  Download the agent",
            value: `**[corin-agent.exe](${downloadUrl})** for Windows. One file, no installer, nothing to install alongside it.`,
          },
          {
            name: "2️⃣  Run it",
            value:
              "Double click it. If Windows SmartScreen warns you, choose **More info → Run anyway**. A small console window opens and asks for a pairing code.",
          },
          {
            name: "3️⃣  Get a pairing code",
            value: "Run **`/coach connect`** here. You get a 12 character code, good for 10 minutes, usable once.",
          },
          {
            name: "4️⃣  Paste it into the agent",
            value:
              "Paste the code in the agent window and press **Enter**. It stores a device credential in Windows Credential Manager, so this is the only time you do it.",
          },
          {
            name: "5️⃣  Leave it running while you play",
            value:
              "The window holds one outbound connection to the coach and reconnects on its own. Closing it only means the coach reports you as disconnected.",
          },
          {
            name: "6️⃣  Check it",
            value: "Run **`/coach status`**. **Agent: Connected** means you are done. Start a game and League flips to **Running**.",
          },
          {
            name: "🔐  What it can and cannot see",
            value:
              "It reads League's local game API on your own machine and sends a small normalized summary: champion, level, KDA, CS, gold, items, game time. It never opens a port, never touches anything else on your PC, and holds no Discord, OpenAI or Riot key.",
          },
          {
            name: "🧰  If something looks wrong",
            value: [
              "• **Agent: Disconnected**, the agent window is closed. Reopen it.",
              "• **Code expired**, run `/coach connect` again for a fresh one.",
              "• **New PC**, pair that one too. Every machine gets its own code.",
              "• **Starting over**: `corin-agent reset` forgets the stored credential.",
            ].join("\n"),
          },
        ],
        footer,
      },
    ],
    components: [
      {
        type: 1,
        components: [{ type: 2, style: 5, label: "Download the agent", url: downloadUrl, emoji: { name: "⬇️" } }],
      },
    ],
  };
}

export function pairingMessage(pairing: PairingCode): DiscordMessage {
  return {
    embeds: [
      {
        title: "🔗  Pair this PC",
        color: brand,
        description: [
          "Paste this code into the LoL Coach Agent running on your PC:",
          "```",
          pairing.value,
          "```",
          `It expires <t:${Math.floor(pairing.expiresAt.getTime() / 1_000)}:R> and works exactly once.`,
          "",
          "No agent on that PC yet? Run **`/coach setup`** first.",
        ].join("\n"),
        footer,
      },
    ],
  };
}

export function statusMessage(snapshot: DeviceSnapshot): DiscordMessage {
  const { status, game } = snapshot;
  const paired = status.agent !== "Not paired";
  const connected = status.agent === "Connected";

  const fields = [
    { name: "🖥️  Agent", value: indicator(status.agent), inline: false },
    { name: "🎮  League", value: indicator(status.league), inline: true },
    { name: "📡  Live API", value: indicator(status.liveApi), inline: true },
    { name: "🕹️  Current game", value: indicator(status.currentGame), inline: true },
  ];

  if (game) fields.push(...gameFields(game));

  return {
    embeds: [
      {
        title: "📊  Coach status",
        color: connected ? good : paired ? caution : neutral,
        description: connected
          ? game
            ? `**${game.player.champion}** · ${game.mode} · ${clock(game.timeSeconds)}`
            : undefined
          : paired
            ? "Your PC is paired but nothing is reporting. Start the agent and run this again."
            : "No PC is paired with your account yet. Run **`/coach setup`** for the walkthrough.",
        fields,
        footer,
      },
    ],
  };
}

function gameFields(game: NonNullable<DeviceSnapshot["game"]>): Array<{ name: string; value: string; inline: boolean }> {
  const player = game.player;
  const perMinute = game.timeSeconds > 0 ? (player.creepScore / (game.timeSeconds / 60)).toFixed(1) : "0.0";

  return [
    { name: "⚔️  Score", value: `${player.kills} / ${player.deaths} / ${player.assists}`, inline: true },
    { name: "🌾  CS", value: `${player.creepScore}  (${perMinute}/min)`, inline: true },
    { name: "💰  Gold", value: Math.round(player.gold).toLocaleString("en-US"), inline: true },
    { name: "🧭  Level", value: `${player.level}${player.position && player.position !== "NONE" ? `  ·  ${titleCase(player.position)}` : ""}`, inline: true },
    { name: "🟦  Your team", value: roster(game, player.team), inline: true },
    { name: "🟥  Enemy team", value: roster(game, player.team === "ORDER" ? "CHAOS" : "ORDER"), inline: true },
  ];
}

/** Champions only. The agent never sends anyone else's name, and none is needed here. */
function roster(game: NonNullable<DeviceSnapshot["game"]>, team: "ORDER" | "CHAOS"): string {
  const line = (champion: string, kills: number, deaths: number, assists: number, isDead: boolean) =>
    `${isDead ? "💀" : "•"} ${champion}  ${kills}/${deaths}/${assists}`;

  const rows: string[] = [];
  if (game.player.team === team) {
    rows.push(`**${line(game.player.champion, game.player.kills, game.player.deaths, game.player.assists, game.player.isDead)}**`);
  }
  for (const participant of game.participants) {
    if (participant.team !== team) continue;
    rows.push(line(participant.champion, participant.kills, participant.deaths, participant.assists, participant.isDead));
  }
  return rows.length > 0 ? rows.join("\n") : "—";
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function titleCase(value: string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function unknownCommandMessage(): DiscordMessage {
  return {
    embeds: [
      {
        title: "❓  I don't know that one",
        color: neutral,
        description: "Try **`/coach setup`**, **`/coach connect`** or **`/coach status`**.",
      },
    ],
  };
}

export function failureMessage(): DiscordMessage {
  return {
    embeds: [
      {
        title: "⚠️  Something went wrong",
        color: bad,
        description: "That failed on my side, not yours. Try again in a moment.",
      },
    ],
  };
}

export function plainMessage(text: string): DiscordMessage {
  return { embeds: [{ color: neutral, description: text }] };
}

const indicators: Record<string, string> = {
  Connected: "🟢",
  Disconnected: "🔴",
  "Not paired": "⚪",
  Running: "🟢",
  "Not detected": "⚪",
  Available: "🟢",
  Unavailable: "🔴",
  Active: "🟢",
  Inactive: "⚪",
  Unknown: "❔",
};

function indicator(value: string): string {
  return `${indicators[value] ?? "❔"}  ${value}`;
}
