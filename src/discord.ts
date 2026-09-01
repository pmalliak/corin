import type { DiscordAccount, Env } from "./types";

const encoder = new TextEncoder();

export const DiscordInteractionType = {
  Ping: 1,
  ApplicationCommand: 2,
} as const;

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

export interface DiscordMessage {
  content?: string;
  embeds?: DiscordEmbed[];
  components?: unknown[];
}

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

export function interactionResponse(message: DiscordMessage): Response {
  return Response.json({ type: 4, data: { ...message, flags: 64 } });
}

type InteractionUser = { id?: string; username?: string; global_name?: string | null };

/**
 * Who ran the command. The id is what everything keys on; the handle exists so
 * the agent can say "paired with panos" instead of showing a snowflake, and is
 * optional because Discord is free to leave it out.
 */
export function discordAccount(interaction: { member?: { user?: InteractionUser }; user?: InteractionUser }): DiscordAccount | null {
  const user = interaction.member?.user ?? interaction.user;
  if (!user?.id) return null;
  const handle = user.global_name?.trim() || user.username?.trim();
  return { id: user.id, username: handle ? handle.slice(0, 64) : null };
}

export type DiscordEnv = Pick<Env, "DISCORD_PUBLIC_KEY">;

export function deferredInteractionResponse(): Response {
  return Response.json({ type: 5, data: { flags: 64 } });
}

export interface DeferredInteraction {
  applicationId: string;
  token: string;
}

export async function editOriginalInteractionResponse(interaction: DeferredInteraction, message: DiscordMessage): Promise<void> {
  const response = await fetch(`https://discord.com/api/v10/webhooks/${interaction.applicationId}/${interaction.token}/messages/@original`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "", embeds: [], components: [], ...message }),
  });
  if (!response.ok) console.error("Discord follow-up failed", response.status, await response.text());
}
