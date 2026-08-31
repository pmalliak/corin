import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
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
    expect(followUps[0]?.content).toContain("PAIR-ME");
  });

  it("returns only the requesting user's status for /coach status", async () => {
    const { followUps } = await signedRequest(command("status"));
    expect(followUps[0]?.content).toContain("Agent: Connected");
    expect(followUps[0]?.content).toContain("Current game: Active");
  });

  it("tells the user when a coach command fails instead of leaving it pending", async () => {
    const { followUps } = await signedRequest(command("status"), {
      deviceStatus: {
        getForDiscordUser: async () => {
          throw new Error("D1 unavailable");
        },
      },
    });
    expect(followUps[0]?.content).toContain("Something went wrong");
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

  it("rejects malformed pairing exchanges before redemption", async () => {
    const response = await createApp(testEnv(), testContext(), fakeDependencies())
      .fetch(new Request("https://coach.example/agent/pair", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
    expect(response.status).toBe(400);
  });
});

function command(subcommand: string) {
  return {
    type: 2,
    application_id: "application-1",
    token: "interaction-token-1",
    data: { name: "coach", options: [{ name: subcommand }] },
    member: { user: { id: "discord-user-1" } },
  };
}

interface FollowUp {
  interaction: { applicationId: string; token: string };
  content: string;
}

async function signedRequest(payload: unknown, overrides: Partial<ReturnType<typeof fakeDependencies>> = {}): Promise<{ response: Response; followUps: FollowUp[] }> {
  const body = JSON.stringify(payload);
  const timestamp = "1725094800";
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(timestamp + body)));

  const followUps: FollowUp[] = [];
  const pending: Array<Promise<unknown>> = [];
  const app = createApp(
    testEnv(),
    { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    {
      ...fakeDependencies(),
      ...overrides,
      followUp: async (interaction, content) => void followUps.push({ interaction, content }),
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

function testEnv(): Env {
  return { DISCORD_PUBLIC_KEY: publicKeyHex, COACH_DB: {} as D1Database, DEVICE_SESSIONS: {} as Env["DEVICE_SESSIONS"] };
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
  getForDiscordUser: async () => ({ agent: "Connected", league: "Running", liveApi: "Available", currentGame: "Active" }),
};

const fakeDeviceAuthentication: DeviceAuthenticationRepository = {
  authenticate: async () => null,
};
