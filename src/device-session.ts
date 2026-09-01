import { DurableObject } from "cloudflare:workers";
import { parseAgentMessage, type AgentGame, type AgentStatusPayload } from "./agent-contract";
import type { DeviceSnapshot, DeviceStatus, Env } from "./types";

const heartbeatTtlMs = 75_000;

/**
 * A v2 heartbeat carries the whole match: ten players with items and runes, the
 * owner's full champion stats, and the recent event log. Around 20 KB in a busy
 * game, so the old 2 KB ceiling would have rejected every one of them. Generous
 * enough for a long game, still far short of anything worth worrying about.
 */
const maxMessageBytes = 64 * 1024;

type StoredSnapshot = AgentStatusPayload & {
  lastHeartbeatAt: number;
  game?: AgentGame | null;
};

const disconnected: DeviceStatus = { agent: "Disconnected", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" };

export class DeviceSession extends DurableObject<Env> {
  public async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-coach-internal-status") === "1") return Response.json(await this.getSnapshot(Date.now()));
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
    const deviceId = request.headers.get("x-coach-device-id");
    if (!deviceId) return new Response("Unauthorized", { status: 401 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.serializeAttachment({ deviceId });
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  public async getSnapshot(now: number): Promise<DeviceSnapshot> {
    const stored = await this.ctx.storage.get<StoredSnapshot>("status");
    const connected = this.ctx.getWebSockets().length > 0;
    if (!stored || !connected || now - stored.lastHeartbeatAt > heartbeatTtlMs) {
      return { status: disconnected, game: null };
    }
    return {
      status: { agent: "Connected", league: stored.league, liveApi: stored.liveApi, currentGame: stored.currentGame },
      game: stored.game ?? null,
    };
  }

  public async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > maxMessageBytes) return this.closeInvalid(socket);
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return this.closeInvalid(socket);
    }
    const agentMessage = parseAgentMessage(raw);
    if (!agentMessage) return this.closeInvalid(socket);

    const snapshot: StoredSnapshot = { ...agentMessage.payload, game: agentMessage.game, lastHeartbeatAt: Date.now() };
    await this.ctx.storage.put("status", snapshot);
    socket.send(JSON.stringify({ version: 1, type: "ack", requestId: agentMessage.requestId, payload: { receivedAt: snapshot.lastHeartbeatAt } }));
  }

  public webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private closeInvalid(socket: WebSocket): void {
    socket.close(1008, "Invalid agent message");
  }
}
