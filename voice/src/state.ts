/**
 * What the player's game looks like right now, fetched from the Worker.
 *
 * The Worker holds the live state because the agent talks to it, not to this
 * process, and the coach runs outside the Worker because Discord voice needs
 * UDP. So the coach asks over HTTPS with a service token: it speaks for every
 * paired player at once, which is not something a device credential should
 * ever be able to do.
 *
 * The snapshot is trimmed before it reaches the model. A heartbeat is around
 * 17 KB of runes, stats and event log; handing all of that to a realtime model
 * that is billed by the token, to answer "how much CS do I have", would be
 * expensive and would bury the answer.
 */

export type Participant = {
  champion: string;
  team: "ORDER" | "CHAOS";
  level: number;
  kills: number;
  deaths: number;
  assists: number;
  creepScore: number;
  isDead: boolean;
  position?: string;
  detail?: Record<string, unknown>;
};

export type Player = Participant & { gold: number; riotId?: string };

export type Snapshot = {
  status: {
    agent: "Connected" | "Disconnected" | "Not paired";
    league: string;
    liveApi: string;
    currentGame: string;
  };
  game: {
    matchKey: string;
    mode: string;
    timeSeconds: number;
    player: Player;
    participants: Participant[];
    detail?: Record<string, unknown>;
  } | null;
};

/** What the coach is told. Small enough to read aloud from, complete enough to advise on. */
export function summarise(snapshot: Snapshot): Record<string, unknown> {
  const { status, game } = snapshot;
  if (status.agent !== "Connected") {
    return {
      connected: false,
      why:
        status.agent === "Not paired"
          ? "This player has never paired a PC. They can run /coach connect in Discord."
          : "Their agent is not running. It has to be open on their PC.",
    };
  }
  if (!game) {
    return { connected: true, inGame: false, league: status.league, liveApi: status.liveApi };
  }

  const side = game.player.team;
  return {
    connected: true,
    inGame: true,
    mode: game.mode,
    gameTime: clock(game.timeSeconds),
    you: {
      champion: game.player.champion,
      ...(meaningful(game.player.position) ? { position: game.player.position } : {}),
      level: game.player.level,
      kda: `${game.player.kills}/${game.player.deaths}/${game.player.assists}`,
      cs: game.player.creepScore,
      gold: Math.round(game.player.gold),
      ...(game.player.isDead ? { dead: true } : {}),
      ...items(game.player),
      ...abilities(game.player),
    },
    allies: game.participants.filter((one) => one.team === side).map(brief),
    enemies: game.participants.filter((one) => one.team !== side).map(brief),
  };
}

function brief(one: Participant): Record<string, unknown> {
  return {
    champion: one.champion,
    ...(meaningful(one.position) ? { position: one.position } : {}),
    level: one.level,
    kda: `${one.kills}/${one.deaths}/${one.assists}`,
    cs: one.creepScore,
    ...(one.isDead ? { dead: true } : {}),
    ...items(one),
  };
}

/** Names only. Prices and slots say nothing a coach would say out loud. */
function items(one: Participant): Record<string, unknown> {
  const raw = one.detail?.items;
  if (!Array.isArray(raw)) return {};
  const names = raw
    .filter((item): item is { name: string; consumable?: boolean } => isRecord(item) && typeof item.name === "string")
    .filter((item) => item.consumable !== true)
    .map((item) => item.name);
  return names.length > 0 ? { items: names } : {};
}

/** Ranks, as "Q3 W1 E1 R2", which is how a player would say it. */
function abilities(one: Participant): Record<string, unknown> {
  const raw = one.detail?.abilities;
  if (!Array.isArray(raw)) return {};
  const ranks = raw
    .filter((ability): ability is { slot: string; rank: number } => isRecord(ability) && typeof ability.slot === "string" && typeof ability.rank === "number")
    .filter((ability) => ability.slot !== "Passive" && ability.rank > 0)
    .map((ability) => `${ability.slot}${ability.rank}`);
  return ranks.length > 0 ? { abilityRanks: ranks.join(" ") } : {};
}

export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Riot says NONE outside Summoner's Rift, which is not a lane worth naming. */
function meaningful(position: string | undefined): boolean {
  return position !== undefined && position !== "" && position !== "NONE";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type GameStateReader = (discordUserId: string) => Promise<Record<string, unknown>>;

export function createGameStateReader(workerUrl: string, token: string): GameStateReader {
  return async (discordUserId) => {
    const url = new URL("/coach/state", workerUrl);
    url.searchParams.set("discordUserId", discordUserId);

    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (response.status === 404) {
      return { connected: false, why: "The backend has no coach service token configured." };
    }
    if (!response.ok) {
      return { connected: false, why: `The backend answered ${response.status}.` };
    }
    return summarise((await response.json()) as Snapshot);
  };
}
