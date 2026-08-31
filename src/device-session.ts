import { DurableObject } from "cloudflare:workers";
import { parseAgentMessage, type AgentStatusPayload } from "./agent-contract";
import type { DeviceStatus, Env } from "./types";

const heartbeatTtlMs = 75_000;

type StoredStatus = AgentStatusPayload & { lastHeartbeatAt: number };

export class DeviceSession extends DurableObject<Env> {
  public async fetch(request: Request): Promise<Response> {
    if (request.headers.get("x-coach-internal-status") === "1") return Response.json(await this.getStatus(Date.now()));
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

  public async getStatus(now: number): Promise<DeviceStatus> {
    const stored = await this.ctx.storage.get<StoredStatus>("status");
    const connected = this.ctx.getWebSockets().length > 0;
    if (!stored || !connected || now - stored.lastHeartbeatAt > heartbeatTtlMs) {
      return { agent: "Disconnected", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" };
    }
    return { agent: "Connected", league: stored.league, liveApi: stored.liveApi, currentGame: stored.currentGame };
  }

  public async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string" || message.length > 2_048) return this.closeInvalid(socket);
    let raw: unknown;
    try {
      raw = JSON.parse(message);
    } catch {
      return this.closeInvalid(socket);
    }
    const agentMessage = parseAgentMessage(raw);
    if (!agentMessage) return this.closeInvalid(socket);

    const status: StoredStatus = { ...agentMessage.payload, lastHeartbeatAt: Date.now() };
    await this.ctx.storage.put("status", status);
    socket.send(JSON.stringify({ version: 1, type: "ack", requestId: agentMessage.requestId, payload: { receivedAt: status.lastHeartbeatAt } }));
  }

  public webSocketClose(socket: WebSocket, code: number, reason: string): void {
    socket.close(code, reason);
  }

  private closeInvalid(socket: WebSocket): void {
    socket.close(1008, "Invalid agent message");
  }
}
