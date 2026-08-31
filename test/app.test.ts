import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { DeviceStatusRepository, Env, PairingCode, PairingCodeRepository } from "../src/types";

const encoder = new TextEncoder();
let privateKey: CryptoKey;
let publicKeyHex: string;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  privateKey = keyPair.privateKey;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  publicKeyHex = [...raw].map((byte) => byte.toString(16).padStart(2, "0")).join("");
});

describe("Discord interactions", () => {
  it("answers the Discord verification ping", async () => {
    const response = await signedRequest({ type: 1 });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ type: 1 });
  });

  it("creates an ephemeral pairing code for /coach connect", async () => {
    const response = await signedRequest(command("connect"));
    const body = (await response.json()) as { type: number; data: { content: string; flags: number } };
    expect(body.type).toBe(4);
    expect(body.data.flags).toBe(64);
    expect(body.data.content).toContain("PAIR-ME");
  });

  it("returns only the requesting user's status for /coach status", async () => {
    const response = await signedRequest(command("status"));
    const body = (await response.json()) as { data: { content: string } };
    expect(body.data.content).toContain("Agent: Connected");
    expect(body.data.content).toContain("Current game: Active");
  });
});

function command(subcommand: string) {
  return { type: 2, data: { name: "coach", options: [{ name: subcommand }] }, member: { user: { id: "discord-user-1" } } };
}

async function signedRequest(payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const timestamp = "1725094800";
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(timestamp + body)));
  const app = createApp(
    { DISCORD_PUBLIC_KEY: publicKeyHex, COACH_DB: {} as D1Database } satisfies Env,
    {
      pairingCodes: fakePairingCodes,
      deviceStatus: fakeDeviceStatus,
      now: () => new Date("2026-08-31T12:00:00.000Z"),
    },
  );
  return app.fetch(
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
}

const fakePairingCodes: PairingCodeRepository = {
  create: async (): Promise<PairingCode> => ({ value: "PAIR-ME", expiresAt: new Date("2026-08-31T12:10:00.000Z") }),
  redeem: async () => null,
};

const fakeDeviceStatus: DeviceStatusRepository = {
  getForDiscordUser: async () => ({ agent: "Connected", league: "Running", liveApi: "Available", currentGame: "Active" }),
};
