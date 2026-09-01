import type { DeviceStatus } from "./types";

export type AgentStatusPayload = {
  league: Exclude<DeviceStatus["league"], "Unknown">;
  liveApi: Exclude<DeviceStatus["liveApi"], "Unknown">;
  currentGame: Exclude<DeviceStatus["currentGame"], "Unknown">;
};

export type Team = "ORDER" | "CHAOS";

/** Whatever the agent sent that is not modelled above: items, runes, stats, abilities. */
type WithDetail = { detail?: Record<string, unknown> };

export type AgentPlayer = WithDetail & {
  champion: string;
  team: Team;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  gold: number;
  isDead: boolean;
  position?: string;
  riotId?: string;
};

export type AgentParticipant = WithDetail & {
  champion: string;
  team: Team;
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  isDead: boolean;
  position?: string;
};

export type AgentGame = {
  /** Identifies the match, not the people in it. Two devices reporting the same key are in one game. */
  matchKey: string;
  mode: string;
  timeSeconds: number;
  player: AgentPlayer;
  participants: AgentParticipant[];
  /** Stats, runes, items, abilities and events. Carried through without being re-modelled here. */
  detail?: Record<string, unknown>;
};

export type AgentMessage = {
  version: 1 | 2;
  type: "hello" | "heartbeat";
  requestId: string;
  payload: AgentStatusPayload;
  game: AgentGame | null;
};

/**
 * Accepts v1 and v2. v2 adds the game alongside the same three flags, so a v1
 * agent stays valid for as long as anyone is still running one.
 *
 * The flags are checked strictly because `/coach status` renders them. The game
 * is checked down to the fields that get displayed, and the rest travels as
 * opaque detail: re-modelling every League stat here would only add drift.
 */
export function parseAgentMessage(value: unknown): AgentMessage | null {
  if (!isRecord(value) || (value.version !== 1 && value.version !== 2)) return null;
  if (value.type !== "hello" && value.type !== "heartbeat") return null;
  if (!isRequestId(value.requestId)) return null;

  const payload = value.payload;
  if (!isRecord(payload)) return null;
  if (!isOneOf(payload.league, ["Running", "Not detected"])) return null;
  if (!isOneOf(payload.liveApi, ["Available", "Unavailable"])) return null;
  if (!isOneOf(payload.currentGame, ["Active", "Inactive"])) return null;

  const game = payload.game === undefined || payload.game === null ? null : parseGame(payload.game);
  if (payload.game !== undefined && payload.game !== null && game === null) return null;

  return {
    version: value.version,
    type: value.type,
    requestId: value.requestId,
    payload: { league: payload.league, liveApi: payload.liveApi, currentGame: payload.currentGame },
    game,
  };
}

function parseGame(value: unknown): AgentGame | null {
  if (!isRecord(value)) return null;
  if (!isShortString(value.matchKey, 64) || !isShortString(value.mode, 32)) return null;
  if (!isCount(value.timeSeconds)) return null;

  const player = parsePlayer(value.player);
  if (!player) return null;

  const rawParticipants = value.participants;
  if (!Array.isArray(rawParticipants) || rawParticipants.length > 10) return null;
  const participants: AgentParticipant[] = [];
  for (const entry of rawParticipants) {
    const participant = parseParticipant(entry);
    if (!participant) return null;
    participants.push(participant);
  }

  const { matchKey, mode, timeSeconds, player: _player, participants: _participants, ...detail } = value;
  return {
    matchKey: matchKey as string,
    mode: mode as string,
    timeSeconds: timeSeconds as number,
    player,
    participants,
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
}

function parsePlayer(value: unknown): AgentPlayer | null {
  const base = parseParticipant(value);
  if (!base || !isRecord(value) || !isCount(value.gold)) return null;
  return {
    // `base` already carries the unmodelled fields as detail.
    ...base,
    gold: value.gold,
    ...(isShortString(value.riotId, 128) ? { riotId: value.riotId } : {}),
  };
}

function parseParticipant(value: unknown): AgentParticipant | null {
  if (!isRecord(value)) return null;
  if (!isShortString(value.champion, 32)) return null;
  if (!isOneOf(value.team, ["ORDER", "CHAOS"])) return null;
  if (!isCount(value.level) || !isCount(value.kills) || !isCount(value.deaths) || !isCount(value.assists) || !isCount(value.creepScore)) return null;
  if (typeof value.isDead !== "boolean") return null;

  return {
    champion: value.champion,
    team: value.team,
    level: value.level,
    kills: value.kills,
    deaths: value.deaths,
    assists: value.assists,
    creepScore: value.creepScore,
    isDead: value.isDead,
    ...(isShortString(value.position, 16) ? { position: value.position } : {}),
    ...detailOf(value, PARTICIPANT_KEYS),
  };
}

const PARTICIPANT_KEYS = [
  "champion", "team", "level", "kills", "deaths", "assists", "creepScore", "isDead", "position", "gold", "riotId",
] as const;

/**
 * Keeps the fields nobody here models: items, runes, ability ranks, the full
 * stat block. The coach needs to answer "what have I built", and re-declaring
 * every League stat in this file would only guarantee it drifts from the agent.
 */
function detailOf(value: Record<string, unknown>, modelled: readonly string[]): WithDetail {
  const detail: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!modelled.includes(key)) detail[key] = entry;
  }
  return Object.keys(detail).length > 0 ? { detail } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isShortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}
