import { describe, expect, it } from "vitest";
import { parseAgentMessage } from "../src/agent-contract";

const flags = { league: "Running", liveApi: "Available", currentGame: "Active" } as const;

function player(overrides: Record<string, unknown> = {}) {
  return { champion: "Jinx", team: "ORDER", level: 11, kills: 4, deaths: 1, assists: 3, creepScore: 142, gold: 2140, isDead: false, ...overrides };
}

function game(overrides: Record<string, unknown> = {}) {
  return {
    matchKey: "0123456789abcdef0123456789abcdef",
    mode: "CLASSIC",
    timeSeconds: 1142,
    player: player(),
    participants: [{ champion: "Ahri", team: "CHAOS", level: 11, kills: 2, deaths: 3, assists: 4, creepScore: 130, isDead: true }],
    ...overrides,
  };
}

describe("agent session contract", () => {
  it("accepts a complete v1 heartbeat", () => {
    const parsed = parseAgentMessage({ version: 1, type: "heartbeat", requestId: "request-1", payload: { ...flags } });
    expect(parsed).toEqual({ version: 1, type: "heartbeat", requestId: "request-1", payload: { ...flags }, game: null });
  });

  it("rejects extra or unrecognized status fields", () => {
    expect(parseAgentMessage({ version: 1, type: "heartbeat", requestId: "request-1", payload: { ...flags, currentGame: "Unknown" } })).toBeNull();
  });

  it("accepts a v2 heartbeat carrying the game", () => {
    const parsed = parseAgentMessage({ version: 2, type: "heartbeat", requestId: "request-1", payload: { ...flags, game: game() } });

    expect(parsed?.version).toBe(2);
    expect(parsed?.payload).toEqual(flags);
    expect(parsed?.game?.player.champion).toBe("Jinx");
    expect(parsed?.game?.participants[0]?.champion).toBe("Ahri");
    expect(parsed?.game?.matchKey).toHaveLength(32);
  });

  it("accepts a v2 heartbeat outside a game", () => {
    const parsed = parseAgentMessage({ version: 2, type: "hello", requestId: "request-1", payload: { league: "Not detected", liveApi: "Unavailable", currentGame: "Inactive" } });
    expect(parsed?.game).toBeNull();
  });

  it("carries stats, items and events through as opaque detail", () => {
    const parsed = parseAgentMessage({
      version: 2,
      type: "heartbeat",
      requestId: "request-1",
      payload: { ...flags, game: game({ events: [{ id: 1, name: "ChampionKill", killer: "Ahri" }] }) },
    });

    expect(parsed?.game?.detail?.events).toEqual([{ id: 1, name: "ChampionKill", killer: "Ahri" }]);
  });

  it("rejects a game whose player is malformed", () => {
    const parsed = parseAgentMessage({
      version: 2,
      type: "heartbeat",
      requestId: "request-1",
      payload: { ...flags, game: game({ player: player({ kills: -1 }) }) },
    });
    expect(parsed).toBeNull();
  });

  it("rejects a game with a roster larger than a match", () => {
    const tooMany = Array.from({ length: 11 }, () => ({ champion: "Ahri", team: "CHAOS", level: 1, kills: 0, deaths: 0, assists: 0, creepScore: 0, isDead: false }));
    expect(parseAgentMessage({ version: 2, type: "heartbeat", requestId: "request-1", payload: { ...flags, game: game({ participants: tooMany }) } })).toBeNull();
  });

  it("rejects an unknown contract version", () => {
    expect(parseAgentMessage({ version: 3, type: "heartbeat", requestId: "request-1", payload: { ...flags } })).toBeNull();
  });
});
