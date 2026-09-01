import type { DeviceSnapshot } from "./types";

/**
 * The live snapshot as plain text, for a reader that can only fetch a URL.
 *
 * ChatGPT Projects cannot hold a bearer token or speak MCP, so the one thing a
 * project guideline can do is read a page. A page is what this returns: the same
 * state the MCP tool exposes, written so a language model can quote it without
 * parsing a nested JSON blob, and worded so that anything missing reads as
 * unknown rather than as an invitation to guess.
 *
 * Champions only, exactly as everywhere else. Nobody else's summoner name exists
 * in the snapshot to begin with, and the owner's own Riot ID is left out because
 * advice never needs it and this URL carries its secret in the open.
 */
export function liveGameReport(snapshot: DeviceSnapshot, now: Date): string {
  const { status, game } = snapshot;
  const lines: string[] = [
    "CORIN LIVE GAME, read-only snapshot",
    `Fetched: ${now.toISOString()}`,
    "Source: League's local Live Client API on the player's own PC, relayed by the Corin agent.",
    "Every player other than the owner is identified by champion only. Treat anything absent below as unknown; do not infer it.",
    "",
    "CONNECTION",
    `Agent: ${status.agent}`,
    `League client: ${status.league}`,
    `Live client API: ${status.liveApi}`,
    `Current game: ${status.currentGame}`,
  ];

  if (!game) {
    lines.push("", "MATCH", noGameExplanation(status));
    return lines.join("\n");
  }

  const detail = record(game.detail);
  const player = game.player;
  const playerDetail = record(player.detail);
  const allies = player.team;
  const enemies = allies === "ORDER" ? "CHAOS" : "ORDER";

  lines.push(
    "",
    "MATCH",
    `Mode: ${game.mode}${mapSuffix(detail)}`,
    `Game time: ${clock(game.timeSeconds)}`,
    `Match id: ${game.matchKey}`,
    "",
    "THE PLAYER ASKING",
    `Champion: ${player.champion}, level ${round(player.level)}, ${positionOf(player.position)}, ${allies} side`,
    `Score: ${round(player.kills)}/${round(player.deaths)}/${round(player.assists)}, CS ${round(player.creepScore)} (${csPerMinute(player.creepScore, game.timeSeconds)}/min), gold ${round(player.gold)}, ${aliveness(player.isDead, playerDetail)}`,
  );

  const own = [
    optional("Wards", wardScore(playerDetail)),
    optional("Abilities", abilities(playerDetail)),
    optional("Summoner spells", list(playerDetail.summonerSpells)),
    optional("Runes", runes(playerDetail)),
    optional("Items", items(playerDetail)),
    optional("Champion stats", championStats(playerDetail)),
  ];
  lines.push(...own.filter((line): line is string => line !== null));

  lines.push("", `ALLIES (${allies}, the player excluded)`, ...roster(game, allies));
  lines.push("", `ENEMIES (${enemies})`, ...roster(game, enemies));

  const events = recentEvents(detail);
  if (events.length > 0) lines.push("", "RECENT EVENTS (oldest first, champions only)", ...events);

  return lines.join("\n");
}

function noGameExplanation(status: DeviceSnapshot["status"]): string {
  if (status.agent === "Not paired") return "No PC is paired with this account, so there is no game state to read at all.";
  if (status.agent === "Disconnected") return "The agent on the player's PC is not running, so nothing is reporting. Whether a game is under way cannot be told from here.";
  if (status.currentGame === "Active") return "A game is under way but its details have not arrived yet. Ask again in a moment.";
  return "The player is not in a game right now. Say so rather than describing a match.";
}

/** Champions only. The agent never sends anyone else's name, and none is needed here. */
function roster(game: NonNullable<DeviceSnapshot["game"]>, team: "ORDER" | "CHAOS"): string[] {
  const rows: string[] = [];
  for (const participant of game.participants) {
    if (participant.team !== team) continue;
    const detail = record(participant.detail);
    const facts = [
      `level ${round(participant.level)}`,
      `${round(participant.kills)}/${round(participant.deaths)}/${round(participant.assists)}`,
      `CS ${round(participant.creepScore)}`,
      aliveness(participant.isDead, detail),
    ];
    const extras = [
      optional("spells", list(detail.summonerSpells)),
      optional("runes", runes(detail)),
      optional("items", items(detail)),
    ].filter((entry): entry is string => entry !== null);
    rows.push(`- ${participant.champion}, ${positionOf(participant.position)}, ${facts.join(", ")}${extras.length > 0 ? `; ${extras.join("; ")}` : ""}`);
  }
  return rows.length > 0 ? rows : ["- none reported"];
}

/** The tail of the log, because a coach is asked about what just happened. */
function recentEvents(detail: Record<string, unknown>): string[] {
  const raw = Array.isArray(detail.events) ? detail.events : [];
  return raw
    .slice(-15)
    .map((entry) => eventLine(record(entry)))
    .filter((line): line is string => line !== null);
}

function eventLine(event: Record<string, unknown>): string | null {
  const name = text(event.name, 64);
  if (!name) return null;

  const killer = text(event.killer, 64);
  const victim = text(event.victim, 64);
  const parts: string[] = [];
  if (killer && victim) parts.push(`${killer} killed ${victim}`);
  else if (killer) parts.push(`by ${killer}`);
  else if (victim) parts.push(`on ${victim}`);

  const assisters = list(event.assisters);
  if (assisters) parts.push(`assists: ${assisters}`);
  const recipient = text(event.recipient, 64);
  if (recipient) parts.push(recipient);
  const dragon = text(event.dragonType, 32);
  if (dragon) parts.push(`${dragon} dragon`);
  if (event.stolen === true) parts.push("stolen");
  const structure = text(event.turret, 64) ?? text(event.inhibitor, 64);
  if (structure) parts.push(structure);
  const streak = number(event.killStreak);
  if (streak !== null && streak > 1) parts.push(`${round(streak)} kill streak`);

  return `${clock(number(event.timeSeconds) ?? 0)} ${name}${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
}

function mapSuffix(detail: Record<string, unknown>): string {
  const map = text(detail.map, 48);
  const terrain = text(detail.mapTerrain, 48);
  if (!map) return "";
  return terrain && terrain !== "Default" ? ` on ${map} (${terrain})` : ` on ${map}`;
}

function aliveness(isDead: boolean, detail: Record<string, unknown>): string {
  if (!isDead) return "alive";
  const respawn = number(detail.respawnSeconds);
  return respawn !== null && respawn > 0 ? `dead, respawns in ${round(respawn)}s` : "dead";
}

function wardScore(detail: Record<string, unknown>): string | null {
  const score = number(detail.wardScore);
  return score === null ? null : score.toFixed(1);
}

/** Q, W, E, R and the passive with the ranks put into them so far. */
function abilities(detail: Record<string, unknown>): string | null {
  const raw = Array.isArray(detail.abilities) ? detail.abilities : [];
  const ranked = raw
    .map((entry) => record(entry))
    .map((ability) => {
      const slot = text(ability.slot, 8);
      if (!slot) return null;
      const rank = number(ability.rank);
      const name = text(ability.name, 48);
      return { slot, line: `${slot}${rank !== null ? round(rank) : ""}${name ? ` ${name}` : ""}` };
    })
    .filter((entry): entry is { slot: string; line: string } => entry !== null)
    .sort((left, right) => slotOrder(left.slot) - slotOrder(right.slot));
  return ranked.length > 0 ? ranked.map((entry) => entry.line).join(", ") : null;
}

/**
 * The agent keys abilities by slot, so they arrive alphabetical: E, Passive, Q,
 * R, W. Q, W, E, R is the order a skill order is talked about in, and reading a
 * skill order out of the alphabet is how a coach gets it wrong.
 */
const slots = ["Q", "W", "E", "R", "PASSIVE"];

function slotOrder(slot: string): number {
  const index = slots.indexOf(slot.toUpperCase());
  return index === -1 ? slots.length : index;
}

/** Keystone first, then the trees, since that is the shape advice is given in. */
function runes(detail: Record<string, unknown>): string | null {
  const chosen = record(detail.runes);
  const keystone = displayName(chosen.keystone);
  const trees = [displayName(chosen.primaryRuneTree), displayName(chosen.secondaryRuneTree)].filter((tree): tree is string => tree !== null);
  if (!keystone && trees.length === 0) return null;
  return `${keystone ?? "unknown keystone"}${trees.length > 0 ? ` (${trees.join(" + ")})` : ""}`;
}

function items(detail: Record<string, unknown>): string | null {
  const raw = Array.isArray(detail.items) ? detail.items : [];
  const names = raw
    .map((entry) => record(entry))
    .map((item) => {
      const name = text(item.name, 64);
      if (!name) return null;
      const count = number(item.count);
      return count !== null && count > 1 ? `${name} x${round(count)}` : name;
    })
    .filter((entry): entry is string => entry !== null);
  return names.length > 0 ? names.join(", ") : null;
}

/**
 * Riot's whole stat block travels through, and most of it is noise in a sentence.
 * These are the ones that change what a coach would say next.
 */
function championStats(detail: Record<string, unknown>): string | null {
  const stats = record(detail.stats);
  const bits: string[] = [];

  const health = pair(stats.currentHealth, stats.maxHealth);
  if (health) bits.push(`hp ${health}`);
  const resource = pair(stats.resourceValue, stats.resourceMax);
  if (resource) bits.push(`${(text(stats.resourceType, 24) ?? "resource").toLowerCase()} ${resource}`);

  const amounts: Array<[string, unknown]> = [
    ["AD", stats.attackDamage],
    ["AP", stats.abilityPower],
    ["armor", stats.armor],
    ["MR", stats.magicResist],
    ["ability haste", stats.abilityHaste],
    ["move speed", stats.moveSpeed],
    ["attack range", stats.attackRange],
  ];
  for (const [label, value] of amounts) {
    const amount = number(value);
    if (amount !== null) bits.push(`${label} ${round(amount)}`);
  }

  const attackSpeed = number(stats.attackSpeed);
  if (attackSpeed !== null) bits.push(`attack speed ${attackSpeed.toFixed(2)}`);

  const shares: Array<[string, unknown]> = [
    ["crit", stats.critChance],
    ["life steal", stats.lifeSteal],
    ["omnivamp", stats.omnivamp],
  ];
  for (const [label, value] of shares) {
    const share = number(value);
    if (share !== null && share > 0) bits.push(`${label} ${round(share * 100)}%`);
  }

  // Riot sends crit and life steal as a fraction of one, and tenacity as the
  // percentage itself. A live game showed tenacity 5, which as a fraction would
  // have read 500%.
  const tenacity = number(stats.tenacity);
  if (tenacity !== null && tenacity > 0) bits.push(`tenacity ${round(tenacity)}%`);

  return bits.length > 0 ? bits.join(", ") : null;
}

function pair(current: unknown, max: unknown): string | null {
  const value = number(current);
  const limit = number(max);
  if (value === null || limit === null || limit <= 0) return null;
  return `${round(value)}/${round(limit)}`;
}

function displayName(value: unknown): string | null {
  return text(record(value).displayName, 64);
}

function list(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => text(entry, 64)).filter((entry): entry is string => entry !== null);
  return entries.length > 0 ? entries.join(", ") : null;
}

function optional(label: string, value: string | null): string | null {
  return value === null ? null : `${label}: ${value}`;
}

function positionOf(position: string | undefined): string {
  return position && position !== "NONE" ? position : "position unknown";
}

function csPerMinute(creepScore: number, timeSeconds: number): string {
  return timeSeconds > 0 ? (creepScore / (timeSeconds / 60)).toFixed(1) : "0.0";
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Live values arrive as floats. Whole numbers are what a sentence about them would use. */
function round(value: number): number {
  return Math.round(value);
}

/** The detail blob is whatever the agent sent, so nothing out of it is trusted on sight. */
function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
