import {
  DiscordInteractionType,
  deferredInteractionResponse,
  discordUserId,
  editOriginalInteractionResponse,
  interactionResponse,
  verifyDiscordRequest,
  type DeferredInteraction,
  type DiscordMessage,
} from "./discord";
import { failureMessage, pairingMessage, plainMessage, setupMessage, statusMessage, unknownCommandMessage } from "./messages";
import { sha256 } from "./crypto";
import { D1CoachRepository } from "./repositories";
import type { DeviceAuthenticationRepository, DeviceSnapshot, DeviceStatus, DeviceStatusRepository, Env, PairingCodeRepository } from "./types";

interface Dependencies {
  pairingCodes: PairingCodeRepository;
  deviceStatus: DeviceStatusRepository;
  deviceAuthentication: DeviceAuthenticationRepository;
  followUp(interaction: DeferredInteraction, message: DiscordMessage): Promise<void>;
  now(): Date;
}

type Waiter = Pick<ExecutionContext, "waitUntil">;

interface DiscordInteraction {
  type: number;
  application_id?: string;
  token?: string;
  data?: { name?: string; options?: Array<{ name?: string }> };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

export function createApp(env: Env, ctx: Waiter, dependencies: Dependencies = defaultDependencies(env)) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/download") return handleAgentDownload(request, env);
      if (request.method === "POST" && url.pathname === "/interactions") return handleInteraction(request, env, ctx, dependencies);
      if (request.method === "POST" && url.pathname === "/agent/pair") return handlePairingExchange(request, dependencies);
      if (request.method === "GET" && url.pathname === "/agent/session") return handleDeviceSession(request, env, dependencies);
      if (request.method === "GET" && url.pathname === "/coach/state") return handleCoachState(request, url, env, dependencies);
      return new Response("Not Found", { status: 404 });
    },
  };
}

function defaultDependencies(env: Env): Dependencies {
  const repository = new D1CoachRepository(env.COACH_DB);
  return {
    pairingCodes: repository,
    deviceStatus: new DurableDeviceStatusRepository(repository, env),
    deviceAuthentication: repository,
    followUp: editOriginalInteractionResponse,
    now: () => new Date(),
  };
}

async function handleInteraction(request: Request, env: Env, ctx: Waiter, dependencies: Dependencies): Promise<Response> {
  const body = await verifyDiscordRequest(request, env.DISCORD_PUBLIC_KEY);
  if (!body) return new Response("Unauthorized", { status: 401 });

  const interaction = JSON.parse(body) as DiscordInteraction;
  if (interaction.type === DiscordInteractionType.Ping) return Response.json({ type: 1 });
  if (interaction.type !== DiscordInteractionType.ApplicationCommand || interaction.data?.name !== "coach") {
    return interactionResponse(unknownCommandMessage());
  }

  // Where the coach may be used is set in the guild's own integration settings,
  // so there is deliberately no channel check here.
  const userId = discordUserId(interaction);
  if (!userId) return interactionResponse(plainMessage("I couldn't identify your Discord account."));

  const subcommand = interaction.data.options?.[0]?.name;
  if (subcommand === "setup") return interactionResponse(setupMessage(agentDownloadUrl(request)));
  if (subcommand !== "connect" && subcommand !== "status") return interactionResponse(unknownCommandMessage());

  const deferred = deferralTarget(interaction);
  if (!deferred) return interactionResponse(plainMessage("I couldn't reply to that interaction."));

  // Discord abandons an interaction after three seconds, which D1 and the session
  // Durable Object can exceed together, so acknowledge first and edit the reply after.
  ctx.waitUntil(completeCoachCommand(subcommand, userId, deferred, dependencies));
  return deferredInteractionResponse();
}

function agentDownloadUrl(request: Request): string {
  return new URL("/download", request.url).toString();
}

async function completeCoachCommand(subcommand: "connect" | "status", userId: string, deferred: DeferredInteraction, dependencies: Dependencies): Promise<void> {
  let message: DiscordMessage;
  try {
    message = subcommand === "connect" ? await connectMessage(userId, dependencies) : await currentStatusMessage(userId, dependencies);
  } catch (error) {
    console.error(`/coach ${subcommand} failed`, error);
    message = failureMessage();
  }
  await dependencies.followUp(deferred, message);
}

async function connectMessage(userId: string, dependencies: Dependencies): Promise<DiscordMessage> {
  return pairingMessage(await dependencies.pairingCodes.create(userId, dependencies.now()));
}

async function currentStatusMessage(userId: string, dependencies: Dependencies): Promise<DiscordMessage> {
  return statusMessage(await dependencies.deviceStatus.getForDiscordUser(userId, dependencies.now()));
}

function deferralTarget(interaction: DiscordInteraction): DeferredInteraction | null {
  if (!interaction.application_id || !interaction.token) return null;
  return { applicationId: interaction.application_id, token: interaction.token };
}

/// The one link a friend needs. Served from the Worker rather than a bucket URL
/// so it stays on this domain and the filename survives the download.
const agentObjectKey = "corin-agent.exe";

async function handleAgentDownload(request: Request, env: Env): Promise<Response> {
  const object = await env.RELEASES.get(agentObjectKey, { onlyIf: request.headers });
  if (!object) return new Response("The agent has not been published yet.", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("content-type", "application/octet-stream");
  headers.set("content-disposition", `attachment; filename="${agentObjectKey}"`);
  headers.set("cache-control", "public, max-age=300");

  if (!("body" in object)) return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  return new Response(object.body, { headers });
}

async function handlePairingExchange(request: Request, dependencies: Dependencies): Promise<Response> {
  const payload = await requestJson(request);
  if (!payload || !isPairingExchange(payload)) return Response.json({ version: 1, error: "invalid_request" }, { status: 400 });
  const result = await dependencies.pairingCodes.redeem(payload.code, payload.deviceName, dependencies.now());
  if (!result) return Response.json({ version: 1, error: "invalid_pairing_code" }, { status: 401 });
  return Response.json({ version: 1, deviceId: result.deviceId, credential: result.credential, sessionUrl: new URL("/agent/session", request.url).toString() });
}

async function handleDeviceSession(request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket upgrade required", { status: 426 });
  const credential = bearerCredential(request.headers.get("authorization"));
  if (!credential) return new Response("Unauthorized", { status: 401 });
  const device = await dependencies.deviceAuthentication.authenticate(credential, dependencies.now());
  if (!device) return new Response("Unauthorized", { status: 401 });

  const upstream = new Request(request, { headers: sessionHeaders(request.headers, device.deviceId) });
  return env.DEVICE_SESSIONS.getByName(device.deviceId).fetch(upstream);
}

const unpaired: DeviceSnapshot = { status: { agent: "Not paired", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" }, game: null };
const disconnected: DeviceSnapshot = { status: { agent: "Disconnected", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" }, game: null };

class DurableDeviceStatusRepository implements DeviceStatusRepository {
  public constructor(private readonly repository: D1CoachRepository, private readonly env: Env) {}

  public async getForDiscordUser(discordUserId: string, _now: Date): Promise<DeviceSnapshot> {
    const deviceId = await this.repository.getLatestDeviceIdForDiscordUser(discordUserId);
    if (!deviceId) return unpaired;
    try {
      const response = await this.env.DEVICE_SESSIONS.getByName(deviceId).fetch("https://device-session/status", { headers: { "x-coach-internal-status": "1" } });
      const snapshot = await response.json();
      return isDeviceSnapshot(snapshot) ? snapshot : disconnected;
    } catch (error) {
      console.error("Device session status lookup failed", error);
      return disconnected;
    }
  }
}

/**
 * The voice coach asking what a player's game looks like right now.
 *
 * Discord voice needs UDP and a Worker has none, so the coach runs as its own
 * process elsewhere and reads game state over HTTPS instead of sharing memory
 * with the session. It presents a service token rather than a device
 * credential, because it is not a device: it speaks for every paired player at
 * once, and no single device credential should carry that.
 *
 * Without the token configured the route does not exist at all, so a
 * deployment that has not been given one cannot be probed for player state.
 */
async function handleCoachState(request: Request, url: URL, env: Env, dependencies: Dependencies): Promise<Response> {
  const expected = env.COACH_SERVICE_TOKEN;
  if (!expected) return new Response("Not Found", { status: 404 });

  const presented = bearerValue(request.headers.get("authorization"));
  if (!presented || !(await secretsMatch(presented, expected))) return new Response("Unauthorized", { status: 401 });

  const discordUserId = url.searchParams.get("discordUserId");
  if (!discordUserId || !/^\d{17,20}$/.test(discordUserId)) return new Response("Bad Request", { status: 400 });

  const snapshot = await dependencies.deviceStatus.getForDiscordUser(discordUserId, dependencies.now());
  return Response.json(snapshot, { headers: { "cache-control": "no-store" } });
}

/** Compares digests rather than the secrets, so the answer takes the same time either way. */
async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(presented), sha256(expected)]);
  return a === b;
}

async function requestJson(request: Request): Promise<unknown | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 1_024)) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 1_024) return null;
      chunks.push(next.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function isPairingExchange(value: unknown): value is { code: string; deviceName: string } {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && /^[A-Za-z0-9]{12}$/.test(record.code) && typeof record.deviceName === "string" && record.deviceName.length > 0 && record.deviceName.length <= 80;
}

/**
 * Any bearer token, for the service token, whose strength is the operator's
 * business. `bearerCredential` stays strict because a device credential has a
 * shape this Worker itself chose.
 */
function bearerValue(header: string | null): string | null {
  const match = /^Bearer (\S+)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

function bearerCredential(header: string | null): string | null {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(header ?? "");
  return match?.[1] ?? null;
}

function sessionHeaders(headers: Headers, deviceId: string): Headers {
  const upstream = new Headers(headers);
  upstream.delete("authorization");
  upstream.delete("x-coach-internal-status");
  upstream.set("x-coach-device-id", deviceId);
  return upstream;
}

function isDeviceSnapshot(value: unknown): value is DeviceSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  return isDeviceStatus(snapshot.status) && (snapshot.game === null || typeof snapshot.game === "object");
}

function isDeviceStatus(value: unknown): value is DeviceStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (status.agent === "Connected" || status.agent === "Disconnected" || status.agent === "Not paired")
    && (status.league === "Running" || status.league === "Not detected" || status.league === "Unknown")
    && (status.liveApi === "Available" || status.liveApi === "Unavailable" || status.liveApi === "Unknown")
    && (status.currentGame === "Active" || status.currentGame === "Inactive" || status.currentGame === "Unknown");
}
