import type { Env } from "./types";

const encoder = new TextEncoder();

export const DiscordInteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
} as const;

export async function verifyDiscordRequest(request: Request, publicKeyHex: string): Promise<string | null> {
  const signatureHex = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  if (!signatureHex || !timestamp || !/^[0-9a-f]{64}$/i.test(publicKeyHex) || !/^[0-9a-f]{128}$/i.test(signatureHex)) {
    return null;
  }

  const body = await request.text();
  const publicKey = hexToBytes(publicKeyHex).buffer as ArrayBuffer;
  const signature = hexToBytes(signatureHex).buffer as ArrayBuffer;
  const algorithm = { name: "Ed25519" } as const;
  const importedKey = await crypto.subtle.importKey("raw", publicKey, algorithm, false, ["verify"]);
  const isValid = await crypto.subtle.verify(algorithm, importedKey, signature, encoder.encode(timestamp + body));
  return isValid ? body : null;
}

function hexToBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{1,2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
}

export function interactionResponse(content: string): Response {
  return Response.json({ type: 4, data: { content, flags: 64 } });
}

export function discordUserId(interaction: { member?: { user?: { id?: string } }; user?: { id?: string } }): string | null {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

export type DiscordEnv = Pick<Env, "DISCORD_PUBLIC_KEY">;
