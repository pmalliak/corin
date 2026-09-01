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
        redeem: async (code, deviceName) => code === "A1B2C3D4E5F6" && deviceName === "Panos PC" ? { deviceId: "device-1", credential: "a".repeat(64) } : null,
      },
    });
    const response = await app.fetch(new Request("https://coach.example/agent/pair", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "A1B2C3D4E5F6", deviceName: "Panos PC" }),
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ version: 1, deviceId: "device-1", credential: "a".repeat(64), sessionUrl: "https://coach.example/agent/session" });
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
    member: { user: { id: "discord-user-1" } },
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

function testEnv(releases: Env["RELEASES"] = emptyReleases()): Env {
  return {
    DISCORD_PUBLIC_KEY: publicKeyHex,
    COACH_DB: {} as D1Database,
    DEVICE_SESSIONS: {} as Env["DEVICE_SESSIONS"],
    RELEASES: releases,
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
