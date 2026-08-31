import { describe, expect, it } from "vitest";
import { parseAgentMessage } from "../src/agent-contract";

describe("agent session contract", () => {
  it("accepts a complete v1 heartbeat", () => {
    expect(parseAgentMessage({ version: 1, type: "heartbeat", requestId: "request-1", payload: { league: "Running", liveApi: "Available", currentGame: "Active" } })).toEqual({ version: 1, type: "heartbeat", requestId: "request-1", payload: { league: "Running", liveApi: "Available", currentGame: "Active" } });
  });

  it("rejects extra or unrecognized status fields", () => {
    expect(parseAgentMessage({ version: 1, type: "heartbeat", requestId: "request-1", payload: { league: "Running", liveApi: "Available", currentGame: "Unknown" } })).toBeNull();
  });
});
