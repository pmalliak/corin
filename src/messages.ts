import type { DiscordMessage } from "./discord";
import type { DeviceStatus, PairingCode } from "./types";

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

export function statusMessage(status: DeviceStatus): DiscordMessage {
  const paired = status.agent !== "Not paired";
  const connected = status.agent === "Connected";
  return {
    embeds: [
      {
        title: "📊  Coach status",
        color: connected ? good : paired ? caution : neutral,
        description: connected
          ? undefined
          : paired
            ? "Your PC is paired but nothing is reporting. Start the agent and run this again."
            : "No PC is paired with your account yet. Run **`/coach setup`** for the walkthrough.",
        fields: [
          { name: "🖥️  Agent", value: indicator(status.agent), inline: false },
          { name: "🎮  League", value: indicator(status.league), inline: true },
          { name: "📡  Live API", value: indicator(status.liveApi), inline: true },
          { name: "🕹️  Current game", value: indicator(status.currentGame), inline: true },
        ],
        footer,
      },
    ],
  };
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
