import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { DiscordMessage } from "../src/discord";
import type { DeviceAuthenticationRepository, DeviceStatusRepository, Env, PairingCode, PairingCodeRepository } from "../src/types";

const encoder = new TextEncoder();
let privateKey: CryptoKey;
let publicKeyHex: string;

beforeAll(async () => {
  const keyPair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  privateKey = keyPair.privateKey;
  const raw = new Uint8Array((await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer);
  publicKeyHex = [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");
});

describe("Discord interactions", () => {
  it("answers the Discord verification ping", async () => {
    const { response } = await signedRequest({ type: 1 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("acknowledges a coach command before Discord's three second deadline", async () => {
    const { response } = await signedRequest(command("status"));
    await expect(response.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
  });

  it("creates an ephemeral pairing code for /coach connect", async () => {
    const { followUps } = await signedRequest(command("connect"));
    expect(followUps).toHaveLength(1);
    expect(followUps[0]?.interaction).toEqual({ applicationId: "application-1", token: "interaction-token-1" });
    expect(textOf(followUps[0]?.message)).toContain("PAIR-ME");
  });

  it("remembers the Discord handle behind a pairing code", async () => {
    const created: Array<{ id: string; username: string | null }> = [];
    await signedRequest(command("connect"), {
      pairingCodes: {
        ...fakePairingCodes,
        create: async (account) => {
          created.push(account);
          return { value: "PAIR-ME", expiresAt: new Date("2026-08-31T12:10:00.000Z") };
        },
      },
    });
    expect(created).toEqual([{ id: "discord-user-1", username: "Panos" }]);
  });

  it("returns only the requesting user's status for /coach status", async () => {
    const { followUps } = await signedRequest(command("status"));
    const fields = followUps[0]?.message.embeds?.[0]?.fields ?? [];
    expect(fields.map((field) => field.value)).toEqual(["🟢  Connected", "🟢  Running", "🟢  Available", "🟢  Active"]);
  });

  it("shows the live game in /coach status once one is under way", async () => {
    const { followUps } = await signedRequest(command("status"), {
      deviceStatus: {
        getForDiscordUser: async () => ({
          status: { agent: "Connected" as const, league: "Running" as const, liveApi: "Available" as const, currentGame: "Active" as const },
          game: fakeGame(),
        }),
      },
    });

    const text = textOf(followUps[0]?.message);
    expect(text).toContain("Jinx");
    expect(text).toContain("4 / 1 / 3");
    expect(text).toContain("142");
    expect(text).toContain("19:02");
    expect(text).toContain("Thresh");
    expect(text).toContain("Ahri");
  });

  it("never puts another player's name in a status reply", async () => {
    const { followUps } = await signedRequest(command("status"), {
      deviceStatus: {
        getForDiscordUser: async () => ({
          status: { agent: "Connected" as const, league: "Running" as const, liveApi: "Available" as const, currentGame: "Active" as const },
          game: fakeGame(),
        }),
      },
    });

    const encoded = JSON.stringify(followUps[0]?.message);
    for (const identity of ["summonerName", "riotIdGameName", "riotIdTagLine"]) {
      expect(encoded).not.toContain(identity);
    }
  });

  it("answers /coach setup immediately with the full install guide", async () => {
    const { response } = await signedRequest(command("setup"));
    const payload = (await response.json()) as { type: number; data: DiscordMessage & { flags: number } };

    expect(payload.type).toBe(4);
    expect(payload.data.flags).toBe(64);
    const guide = textOf(payload.data);
    for (const step of ["Download the agent", "/coach connect", "/coach status", "Credential Manager", "SmartScreen"]) {
      expect(guide).toContain(step);
    }
    expect(JSON.stringify(payload.data)).toContain("https://coach.example/download");
  });

  it("answers in whatever channel the guild allows the command in", async () => {
    const { response } = await signedRequest(command("status", "222222222222222222"));
    await expect(response.json()).resolves.toEqual({ type: 5, data: { flags: 64 } });
  });

  it("tells the user when a coach command fails instead of leaving it pending", async () => {
    const { followUps } = await signedRequest(command("status"), {
      deviceStatus: {
        getForDiscordUser: async () => {
          throw new Error("D1 unavailable");
        },
      },
    });
    expect(textOf(followUps[0]?.message)).toContain("Something went wrong");
  });

  it("exchanges a valid pairing code for a device credential", async () => {
    const app = createApp(testEnv(), testContext(), {
      ...fakeDependencies(),
      pairingCodes: {
        ...fakePairingCodes,
        redeem: async (code, deviceName) =>
          code === "A1B2C3D4E5F6" && deviceName === "Panos PC" ? { deviceId: "device-1", credential: "a".repeat(64), discordUsername: "Panos" } : null,
      },
    });
    const response = await app.fetch(new Request("https://coach.example/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "A1B2C3D4E5F6", deviceName: "Panos PC" }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 1,
      deviceId: "device-1",
      credential: "a".repeat(64),
      sessionUrl: "https://coach.example/agent/session",
      account: { username: "Panos" },
    });
  });

  it("pairs without an account when the backend never learned a handle", async () => {
    const app = createApp(testEnv(), testContext(), {
      ...fakeDependencies(),
      pairingCodes: {
        ...fakePairingCodes,
        redeem: async () => ({ deviceId: "device-1", credential: "a".repeat(64), discordUsername: null }),
      },
    });
    const response = await app.fetch(new Request("https://coach.example/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "A1B2C3D4E5F6", deviceName: "Panos PC" }),
    }));
    await expect(response.json()).resolves.not.toHaveProperty("account");
  });

  it("serves the agent binary as a named download", async () => {
    const response = await createApp(testEnv(releasesHolding("MZ fake binary")), testContext(), fakeDependencies())
      .fetch(new Request("https://coach.example/download"));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="corin-agent.exe"');
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    await expect(response.text()).resolves.toBe("MZ fake binary");
  });

  it("says so when no agent build has been published", async () => {
    const response = await createApp(testEnv(), testContext(), fakeDependencies())
      .fetch(new Request("https://coach.example/download"));

    expect(response.status).toBe(404);
  });

  it("rejects malformed pairing exchanges before redemption", async () => {
    const response = await createApp(testEnv(), testContext(), fakeDependencies())
      .fetch(new Request("https://coach.example/agent/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(400);
  });
});

function command(subcommand: string, channelId = "111111111111111111") {
  return {
    type: 2,
    application_id: "application-1",
    token: "interaction-token-1",
    channel_id: channelId,
    data: { name: "coach", options: [{ name: subcommand }] },
    member: { user: { id: "discord-user-1", username: "panos", global_name: "Panos" } },
  };
}

interface FollowUp {
  interaction: { applicationId: string; token: string };
  message: DiscordMessage;
}

/** Everything a reply says, so an assertion does not care which embed field holds it. */
function textOf(message: DiscordMessage | undefined): string {
  const embeds = message?.embeds ?? [];
  return [
    message?.content ?? "",
    ...embeds.flatMap((embed) => [embed.title ?? "", embed.description ?? "", ...(embed.fields ?? []).flatMap((field) => [field.name, field.value])]),
  ].join("\n");
}

async function signedRequest(payload: unknown, overrides: Partial<ReturnType<typeof fakeDependencies>> = {}, env: Env = testEnv()): Promise<{ response: Response; followUps: FollowUp[] }> {
  const body = JSON.stringify(payload);
  const timestamp = "1725094800";
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(timestamp + body)));

  const followUps: FollowUp[] = [];
  const pending: Array<Promise<unknown>> = [];
  const app = createApp(
    env,
    { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    {
      ...fakeDependencies(),
      ...overrides,
      followUp: async (interaction, message) => void followUps.push({ interaction, message }),
    },
  );

  const response = await app.fetch(
    new Request("https://coach.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": [...signature].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
        "x-signature-timestamp": timestamp,
      },
      body,
    }),
  );

  await Promise.all(pending);
  return { response, followUps };
}

function testContext() {
  return { waitUntil: () => {} };
}

function testEnv(releases: Env["RELEASES"] = emptyReleases(), coachServiceToken?: string, extra: Partial<Env> = {}): Env {
  return {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    COACH_DB: {} as D1Database,
    DEVICE_SESSIONS: {} as Env["DEVICE_SESSIONS"],
    RELEASES: releases,
    ACCESS_CLIENT_ID: "test",
    ACCESS_CLIENT_SECRET: "test",
    ACCESS_TOKEN_URL: "https://access.example/token",
    ACCESS_AUTHORIZATION_URL: "https://access.example/authorization",
    ACCESS_JWKS_URL: "https://access.example/jwks",
    COOKIE_ENCRYPTION_KEY: "test",
    OAUTH_KV: {} as KVNamespace,
    ...(coachServiceToken ? { COACH_SERVICE_TOKEN: coachServiceToken } : {}),
    ...extra,
  };
}

function emptyReleases(): Env["RELEASES"] {
  return { get: async () => null } as unknown as Env["RELEASES"];
}

function releasesHolding(bytes: string): Env["RELEASES"] {
  const object = {
    body: new Blob([bytes]).stream(),
    httpEtag: '"abc123"',
    writeHttpMetadata: (headers: Headers) => headers.set("content-length", String(bytes.length)),
  };
  return { get: async () => object } as unknown as Env["RELEASES"];
}

function fakeDependencies() {
  return {
    pairingCodes: fakePairingCodes,
    deviceStatus: fakeDeviceStatus,
    deviceAuthentication: fakeDeviceAuthentication,
    followUp: async () => {},
    now: () => new Date("2026-08-31T12:00:00.000Z"),
  };
}

const fakePairingCodes: PairingCodeRepository = {
  create: async (): Promise<PairingCode> => ({ value: "PAIR-ME", expiresAt: new Date("2026-08-31T12:10:00.000Z") }),
  redeem: async () => null,
};

const fakeDeviceStatus: DeviceStatusRepository = {
  getForDiscordUser: async () => ({
    status: { agent: "Connected", league: "Running", liveApi: "Available", currentGame: "Active" },
    game: null,
  }),
};

/** A game as the Durable Object would hand it back, champions only. */
export function fakeGame() {
  return {
    matchKey: "0123456789abcdef0123456789abcdef",
    mode: "CLASSIC",
    timeSeconds: 1142,
    player: { champion: "Jinx", team: "ORDER" as const, level: 11, kills: 4, deaths: 1, assists: 3, creepScore: 142, gold: 2140, isDead: false, position: "BOTTOM" },
    participants: [
      { champion: "Thresh", team: "ORDER" as const, level: 10, kills: 1, deaths: 2, assists: 8, creepScore: 24, isDead: false },
      { champion: "Ahri", team: "CHAOS" as const, level: 11, kills: 2, deaths: 3, assists: 4, creepScore: 130, isDead: true },
    ],
  };
}

const fakeDeviceAuthentication: DeviceAuthenticationRepository = {
  authenticate: async () => null,
};

describe("game state for the voice coach", () => {
  const token = "service-token-for-the-coach";
  const url = "https://coach.example/coach/state?discordUserId=86976067461472256";

  // Written out rather than defaulted, because passing undefined to a default
  // parameter selects the default, which quietly made the "no token" case pass.
  const call = (init: RequestInit = {}, configured: string | undefined = token) =>
    createApp(testEnv(emptyReleases(), configured), testContext(), fakeDependencies()).fetch(new Request(url, init));

  it("hands the snapshot to a caller holding the service token", async () => {
    const response = await call({ headers: { authorization: `Bearer ${token}` } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: { agent: "Connected", league: "Running", liveApi: "Available", currentGame: "Active" },
      game: null,
    });
    // A player's live position is not something a cache should keep.
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("refuses a wrong token, and one that is merely absent", async () => {
    expect((await call({ headers: { authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await call()).status).toBe(401);
  });

  it("does not exist at all until a token is configured", async () => {
    // A deployment without the secret cannot be probed for anybody's game.
    const response = await createApp(testEnv(emptyReleases()), testContext(), fakeDependencies())
      .fetch(new Request(url, { headers: { authorization: `Bearer ${token}` } }));
    expect(response.status).toBe(404);
  });

  it("wants a Discord user id that could actually be one", async () => {
    const response = await createApp(testEnv(emptyReleases(), token), testContext(), fakeDependencies())
      .fetch(new Request("https://coach.example/coach/state?discordUserId=../../etc", { headers: { authorization: `Bearer ${token}` } }));

    expect(response.status).toBe(400);
  });
});

describe("the live-game page a ChatGPT Project reads", () => {
  const token = "chatgpt-url-secret";
  const discordUserId = "86976067461472256";
  const configured: Partial<Env> = { CHATGPT_LIVE_TOKEN: token, MCP_DISCORD_USER_ID: discordUserId };

  const call = (query: string, env: Partial<Env> = configured, overrides: Partial<ReturnType<typeof fakeDependencies>> = {}) =>
    createApp(testEnv(emptyReleases(), undefined, env), testContext(), { ...fakeDependencies(), ...overrides })
      .fetch(new Request(`https://coach.example/chatgpt/live-game${query}`));

  it("takes the secret straight out of the query string", async () => {
    const response = await call(`?${token}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    // A player's live position is not something a cache or a search index should keep.
    expect(response.headers.get("cache-control")).toBe("no-store, max-age=0");
    // No x-robots-tag: the fetchers this page exists for read it, and some refuse a page that carries it.
    expect(response.headers.get("x-robots-tag")).toBeNull();
    expect(await response.text()).toContain("Agent: Connected");
  });

  it("takes the secret written as a named parameter too", async () => {
    expect((await call(`?token=${token}`)).status).toBe(200);
  });

  it("survives a parameter appended after the secret", async () => {
    // A fetcher adding its own parameter, or a cache-buster added by hand, must not lock the page.
    expect((await call(`?${token}&t=17`)).status).toBe(200);
    expect((await call(`?token=${token}&t=17`)).status).toBe(200);
  });

  it("refuses a wrong secret, and one that is merely absent", async () => {
    expect((await call("?wrong")).status).toBe(401);
    expect((await call("")).status).toBe(401);
    expect((await call("?other=1")).status).toBe(401);
  });

  it("does not exist at all until a secret is configured", async () => {
    const response = await call(`?${token}`, { MCP_DISCORD_USER_ID: discordUserId });
    expect(response.status).toBe(404);
  });

  it("never lets the caller choose whose game it reads", async () => {
    const asked: string[] = [];
    const response = await call(`?token=${token}&discordUserId=999999999999999999`, configured, {
      deviceStatus: {
        getForDiscordUser: async (id: string) => {
          asked.push(id);
          return { status: { agent: "Connected" as const, league: "Running" as const, liveApi: "Available" as const, currentGame: "Active" as const }, game: null };
        },
      },
    });

    expect(response.status).toBe(200);
    expect(asked).toEqual([discordUserId]);
  });

  it("says plainly that there is no game, rather than leaving room to guess", async () => {
    const text = await (await call(`?${token}`, configured, {
      deviceStatus: {
        getForDiscordUser: async () => ({
          status: { agent: "Connected" as const, league: "Running" as const, liveApi: "Available" as const, currentGame: "Inactive" as const },
          game: null,
        }),
      },
    })).text();

    expect(text).toContain("The player is not in a game right now");
  });

  it("writes the live game as text a coach can quote", async () => {
    const text = await (await call(`?${token}`, configured, {
      deviceStatus: {
        getForDiscordUser: async () => ({
          status: { agent: "Connected" as const, league: "Running" as const, liveApi: "Available" as const, currentGame: "Active" as const },
          game: detailedGame(),
        }),
      },
    })).text();

    expect(text).toContain("Champion: Jinx, level 11, BOTTOM, ORDER side");
    expect(text).toContain("Score: 4/1/3, CS 142 (7.5/min)");
    expect(text).toContain("Game time: 19:02");
    // The agent keys abilities by slot, so they arrive alphabetical. A skill order is read Q, W, E, R.
    expect(text).toContain("Abilities: Q5 Switcheroo!, W3 Zap!, R1 Super Mega Death Rocket!, Passive0 Get Excited!");
    expect(text).toContain("Summoner spells: Flash, Heal");
    // Riot reports tenacity as the percentage itself, unlike crit and life steal.
    expect(text).toContain("tenacity 5%");
    expect(text).toContain("Lethal Tempo (Precision)");
    expect(text).toContain("Runic Compass");
    expect(text).toContain("hp 1240/1560");
    expect(text).toContain("mana 320/620");
    expect(text).toContain("crit 25%");
    expect(text).toContain("- Thresh");
    expect(text).toContain("- Ahri");
    expect(text).toContain("14:32 ChampionKill (Ahri killed Jinx, assists: Thresh)");
  });

  it("keeps the page to champions, including the owner's own Riot ID", async () => {
    const text = await (await call(`?${token}`, configured, {
      deviceStatus: {
        getForDiscordUser: async () => ({
          status: { agent: "Connected" as const, league: "Running" as const, liveApi: "Available" as const, currentGame: "Active" as const },
          game: detailedGame(),
        }),
      },
    })).text();

    // The URL carries its own secret in the open, so the one name in the snapshot stays out of the page.
    expect(text).not.toContain("Panos#EUNE");
  });
});

/** A game with the detail the agent actually sends: items, runes, stats and the event log. */
function detailedGame() {
  const game = fakeGame();
  return {
    ...game,
    detail: {
      map: "Map11",
      events: [{ id: 3, name: "ChampionKill", timeSeconds: 872, killer: "Ahri", victim: "Jinx", assisters: ["Thresh"] }],
    },
    player: {
      ...game.player,
      riotId: "Panos#EUNE",
      detail: {
        wardScore: 3.2,
        abilities: [
          { slot: "R", name: "Super Mega Death Rocket!", rank: 1 },
          { slot: "Passive", name: "Get Excited!", rank: 0 },
          { slot: "Q", name: "Switcheroo!", rank: 5 },
          { slot: "W", name: "Zap!", rank: 3 },
        ],
        summonerSpells: ["Flash", "Heal"],
        runes: { keystone: { displayName: "Lethal Tempo" }, primaryRuneTree: { displayName: "Precision" } },
        items: [{ id: 3866, name: "Runic Compass", slot: 0 }],
        stats: { currentHealth: 1240, maxHealth: 1560, resourceType: "MANA", resourceValue: 320, resourceMax: 620, attackDamage: 214, critChance: 0.25, tenacity: 5 },
      },
    },
  };
}
