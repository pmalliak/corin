import type { AgentGame, AgentStatusPayload } from "./agent-contract";

/** How long a heartbeat, and the game it carried, stay believable. */
export const heartbeatTtlMs = 75_000;

export type StoredSnapshot = AgentStatusPayload & {
  lastHeartbeatAt: number;
  game?: AgentGame | null;
  /** When the game below was last actually reported, not merely carried over. */
  gameSeenAt?: number;
};

/**
 * Riot omits activePlayer from the occasional response, and the agent honestly
 * reports what it saw: a game is on, but here is nothing about it. Overwriting
 * a good match with that blink makes the coach answer "you are not in a game"
 * mid teamfight, which is worse than being a few seconds stale.
 *
 * So a heartbeat that says the game is Active but carries no game keeps the one
 * already stored, and only for as long as a heartbeat itself stays fresh. When a
 * game really ends the flags say Inactive, and the match is dropped at once.
 *
 * It lives outside the Durable Object so it can be tested without a Worker
 * runtime, which is the only reason this file exists.
 */
export function carryGameThroughBlink(
  incoming: AgentGame | null,
  previous: StoredSnapshot | undefined,
  payload: AgentStatusPayload,
  now: number,
): { game: AgentGame | null; gameSeenAt?: number } {
  if (incoming) return { game: incoming, gameSeenAt: now };
  if (payload.currentGame !== "Active" || !previous?.game) return { game: null };
  if (now - (previous.gameSeenAt ?? 0) > heartbeatTtlMs) return { game: null };
  return { game: previous.game, gameSeenAt: previous.gameSeenAt };
}
