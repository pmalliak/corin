import { describe, expect, it } from "vitest";
import { carryGameThroughBlink } from "../src/game-continuity";
import type { AgentGame, AgentStatusPayload } from "../src/agent-contract";

const game = {
  matchKey: "0123456789abcdef",
  mode: "CLASSIC",
  timeSeconds: 1142,
  player: { champion: "Lissandra", team: "ORDER" as const, level: 11, kills: 4, deaths: 1, assists: 3, creepScore: 142, gold: 2140, isDead: false },
  participants: [],
} satisfies AgentGame;

const inGame: AgentStatusPayload = { league: "Running", liveApi: "Available", currentGame: "Active" };
const outOfGame: AgentStatusPayload = { league: "Running", liveApi: "Unavailable", currentGame: "Inactive" };

const NOW = 1_000_000;

describe("a game that blinks out of Riot's payload", () => {
  it("keeps the last match when a heartbeat says Active but carries nothing", () => {
    // Observed live: Riot omits activePlayer from the occasional response, and
    // the agent honestly reports the flags with no game attached.
    const carried = carryGameThroughBlink(null, { ...inGame, game, gameSeenAt: NOW - 5_000, lastHeartbeatAt: NOW - 5_000 }, inGame, NOW);

    expect(carried.game).toBe(game);
    // The clock does not restart, or a long blink would look fresh forever.
    expect(carried.gameSeenAt).toBe(NOW - 5_000);
  });

  it("prefers what the agent actually saw, and marks it freshly seen", () => {
    const newer = { ...game, timeSeconds: 1200 };
    const carried = carryGameThroughBlink(newer, { ...inGame, game, gameSeenAt: NOW - 5_000, lastHeartbeatAt: NOW - 5_000 }, inGame, NOW);

    expect(carried.game).toBe(newer);
    expect(carried.gameSeenAt).toBe(NOW);
  });

  it("drops the match the moment the game really ends", () => {
    const carried = carryGameThroughBlink(null, { ...inGame, game, gameSeenAt: NOW - 1_000, lastHeartbeatAt: NOW - 1_000 }, outOfGame, NOW);

    expect(carried.game).toBeNull();
  });

  it("stops carrying a match that has not been seen for longer than a heartbeat lives", () => {
    const carried = carryGameThroughBlink(null, { ...inGame, game, gameSeenAt: NOW - 76_000, lastHeartbeatAt: NOW - 1_000 }, inGame, NOW);

    expect(carried.game).toBeNull();
  });

  it("has nothing to carry on the first heartbeat", () => {
    expect(carryGameThroughBlink(null, undefined, inGame, NOW).game).toBeNull();
  });
});
