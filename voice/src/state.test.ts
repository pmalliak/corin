import { strict as assert } from "node:assert";
import { test } from "node:test";
import { clock, summarise, type Snapshot } from "./state.ts";

const connected = { agent: "Connected", league: "Running", liveApi: "Available", currentGame: "Active" } as const;

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    status: connected,
    game: {
      matchKey: "abc",
      mode: "CLASSIC",
      timeSeconds: 1142,
      player: {
        champion: "Jinx",
        team: "ORDER",
        position: "BOTTOM",
        level: 11,
        kills: 4,
        deaths: 1,
        assists: 3,
        creepScore: 142,
        gold: 2140.7,
        isDead: false,
        riotId: "Panos#EUNE",
        detail: {
          items: [
            { id: 1, name: "Kraken Slayer", slot: 0 },
            { id: 2, name: "Health Potion", slot: 1, consumable: true },
          ],
          abilities: [
            { slot: "Passive", name: "Get Excited!", rank: 0 },
            { slot: "Q", name: "Switcheroo!", rank: 5 },
            { slot: "R", name: "Super Mega Death Rocket!", rank: 0 },
          ],
          runes: { keystone: "Lethal Tempo" },
        },
      },
      participants: [
        { champion: "Lulu", team: "ORDER", level: 10, kills: 0, deaths: 2, assists: 8, creepScore: 20, isDead: false },
        { champion: "Darius", team: "CHAOS", level: 12, kills: 5, deaths: 1, assists: 1, creepScore: 160, isDead: true, detail: { items: [{ id: 9, name: "Stridebreaker", slot: 0 }] } },
      ],
    },
    ...overrides,
  };
}

test("game time is spoken as minutes, not as a count of seconds", () => {
  assert.equal(clock(1142), "19:02");
  assert.equal(clock(0), "0:00");
  assert.equal(clock(-5), "0:00");
});

test("the player's own line carries what a coach would ask about", () => {
  const you = summarise(snapshot()).you as Record<string, unknown>;
  assert.equal(you.champion, "Jinx");
  assert.equal(you.kda, "4/1/3");
  assert.equal(you.cs, 142);
  assert.equal(you.gold, 2141);
  assert.equal(you.position, "BOTTOM");
});

test("teams are split by the player's own side, not by a fixed colour", () => {
  const summary = summarise(snapshot());
  assert.deepEqual((summary.allies as Array<{ champion: string }>).map((one) => one.champion), ["Lulu"]);
  assert.deepEqual((summary.enemies as Array<{ champion: string }>).map((one) => one.champion), ["Darius"]);
});

test("builds travel, consumables do not, because nobody asks about a potion", () => {
  const summary = summarise(snapshot());
  assert.deepEqual((summary.you as { items: string[] }).items, ["Kraken Slayer"]);
  assert.deepEqual((summary.enemies as Array<{ items: string[] }>)[0]?.items, ["Stridebreaker"]);
});

test("ability ranks read the way a player says them, and unlearned ones are silent", () => {
  assert.equal((summarise(snapshot()).you as { abilityRanks: string }).abilityRanks, "Q5");
});

test("nobody else's name is passed on, even though the owner's own is", () => {
  const serialised = JSON.stringify(summarise(snapshot()));
  assert.ok(!serialised.includes("Panos#EUNE"), "the coach does not need a Riot ID to give advice");
  assert.ok(!serialised.includes("riotId"));
});

test("no game means the flags, not an empty match", () => {
  const summary = summarise(snapshot({ game: null }));
  assert.equal(summary.inGame, false);
  assert.equal(summary.connected, true);
});

test("a silent agent explains itself, so the coach can say what to do about it", () => {
  const offline = summarise({ status: { ...connected, agent: "Disconnected" }, game: null });
  assert.equal(offline.connected, false);
  assert.match(String(offline.why), /running/);

  const unpaired = summarise({ status: { ...connected, agent: "Not paired" }, game: null });
  assert.match(String(unpaired.why), /\/coach connect/);
});

test("the summary stays small enough to be worth sending", () => {
  const bytes = JSON.stringify(summarise(snapshot())).length;
  assert.ok(bytes < 1500, `summary is ${bytes} bytes; the raw heartbeat it replaces is around 17000`);
});
