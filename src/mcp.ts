import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { D1CoachRepository } from "./repositories";
import type { DeviceSnapshot, Env } from "./types";

const unpaired: DeviceSnapshot = {
  status: { agent: "Not paired", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" },
  game: null,
};

const disconnected: DeviceSnapshot = {
  status: { agent: "Disconnected", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" },
  game: null,
};

/** A read-only MCP server protected by a personal bearer token. */
export class CorinMcp extends McpAgent<Env> {
  server = new McpServer({ name: "corin-live-coach", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.tool(
      "get_my_live_game",
      "Get the configured player's current League of Legends coach state. Read-only; returns connection status and, while in a game, anonymized champion and match information.",
      {},
      async () => {
        const discordUserId = this.env.MCP_DISCORD_USER_ID;
        if (!discordUserId || !/^\d{17,20}$/.test(discordUserId)) {
          return {
            content: [{ type: "text", text: "MCP is not configured yet. Set the MCP_DISCORD_USER_ID Worker secret before connecting a client." }],
            isError: true,
          };
        }

        const snapshot = await getConfiguredPlayerState(this.env, discordUserId);
        return { content: [{ type: "text", text: JSON.stringify(snapshot) }] };
      },
    );
  }
}

async function getConfiguredPlayerState(env: Env, discordUserId: string): Promise<DeviceSnapshot> {
  const repository = new D1CoachRepository(env.COACH_DB);
  const deviceId = await repository.getLatestDeviceIdForDiscordUser(discordUserId);
  if (!deviceId) return unpaired;

  try {
    const response = await env.DEVICE_SESSIONS
      .getByName(deviceId)
      .fetch("https://device-session/status", { headers: { "x-coach-internal-status": "1" } });
    const snapshot = await response.json();
    return isDeviceSnapshot(snapshot) ? snapshot : disconnected;
  } catch (error) {
    console.error("MCP state lookup failed", error);
    return disconnected;
  }
}

function isDeviceSnapshot(value: unknown): value is DeviceSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return typeof snapshot.status === "object" && snapshot.status !== null && (snapshot.game === null || typeof snapshot.game === "object");
}
