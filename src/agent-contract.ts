import type { DeviceStatus } from "./types";

export type AgentStatusPayload = {
  league: Exclude<DeviceStatus["league"], "Unknown">;
  liveApi: Exclude<DeviceStatus["liveApi"], "Unknown">;
  currentGame: Exclude<DeviceStatus["currentGame"], "Unknown">;
};

export type AgentMessage = {
  version: 1;
  type: "hello" | "heartbeat";
  requestId: string;
  payload: AgentStatusPayload;
};

export function parseAgentMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value) || value.version !== 1 || (value.type !== "hello" && value.type !== "heartbeat") || !isRequestId(value.requestId)) {
    return null;
  }
  const payload = value.payload;
  if (!isRecord(payload) || !isOneOf(payload.league, ["Running", "Not detected"]) || !isOneOf(payload.liveApi, ["Available", "Unavailable"]) || !isOneOf(payload.currentGame, ["Active", "Inactive"])) {
    return null;
  }
  return { version: 1, type: value.type, requestId: value.requestId, payload: { league: payload.league, liveApi: payload.liveApi, currentGame: payload.currentGame } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
