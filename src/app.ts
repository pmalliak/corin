import {
  DiscordInteractionType,
  deferredInteractionResponse,
  discordUserId,
  editOriginalInteractionResponse,
  interactionResponse,
  verifyDiscordRequest,
  type DeferredInteraction,
} from "./discord";
import { D1CoachRepository } from "./repositories";
import type { DeviceAuthenticationRepository, DeviceStatus, DeviceStatusRepository, Env, PairingCodeRepository } from "./types";

interface Dependencies {
  pairingCodes: PairingCodeRepository;
  deviceStatus: DeviceStatusRepository;
  deviceAuthentication: DeviceAuthenticationRepository;
  followUp(interaction: DeferredInteraction, content: string): Promise<void>;
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
      if (request.method === "POST" && url.pathname === "/interactions") return handleInteraction(request, env, ctx, dependencies);
      if (request.method === "POST" && url.pathname === "/agent/pair") return handlePairingExchange(request, dependencies);
      if (request.method === "GET" && url.pathname === "/agent/session") return handleDeviceSession(request, env, dependencies);
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
    return interactionResponse("I don't recognize that command yet.");
  }

  const userId = discordUserId(interaction);
  if (!userId) return interactionResponse("I couldn't identify your Discord account.");

  const subcommand = interaction.data.options?.[0]?.name;
  if (subcommand !== "connect" && subcommand !== "status") return interactionResponse("Try `/coach connect` or `/coach status`.");

  const deferred = deferralTarget(interaction);
  if (!deferred) return interactionResponse("I couldn't reply to that interaction.");

  // Discord abandons an interaction after three seconds, which D1 and the session
  // Durable Object can exceed together, so acknowledge first and edit the reply after.
  ctx.waitUntil(completeCoachCommand(subcommand, userId, deferred, dependencies));
  return deferredInteractionResponse();
}

async function completeCoachCommand(subcommand: "connect" | "status", userId: string, deferred: DeferredInteraction, dependencies: Dependencies): Promise<void> {
  let content: string;
  try {
    content = subcommand === "connect" ? await connectContent(userId, dependencies) : await statusContent(userId, dependencies);
  } catch (error) {
    console.error(`/coach ${subcommand} failed`, error);
    content = "Something went wrong on my side. Try again in a moment.";
  }
  await dependencies.followUp(deferred, content);
}

async function connectContent(userId: string, dependencies: Dependencies): Promise<string> {
  const pairing = await dependencies.pairingCodes.create(userId, dependencies.now());
  return `Enter this pairing code in the LoL Coach Agent: \`${pairing.value}\`\nIt expires at <t:${Math.floor(pairing.expiresAt.getTime() / 1_000)}:R>.`;
}

async function statusContent(userId: string, dependencies: Dependencies): Promise<string> {
  const status = await dependencies.deviceStatus.getForDiscordUser(userId, dependencies.now());
  return `Agent: ${status.agent}\nLeague: ${status.league}\nLive API: ${status.liveApi}\nCurrent game: ${status.currentGame}`;
}

function deferralTarget(interaction: DiscordInteraction): DeferredInteraction | null {
  if (!interaction.application_id || !interaction.token) return null;
  return { applicationId: interaction.application_id, token: interaction.token };
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

const unpairedStatus: DeviceStatus = { agent: "Not paired", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" };
const disconnectedStatus: DeviceStatus = { agent: "Disconnected", league: "Unknown", liveApi: "Unknown", currentGame: "Unknown" };

class DurableDeviceStatusRepository implements DeviceStatusRepository {
  public constructor(private readonly repository: D1CoachRepository, private readonly env: Env) {}

  public async getForDiscordUser(discordUserId: string, _now: Date): Promise<DeviceStatus> {
    const deviceId = await this.repository.getLatestDeviceIdForDiscordUser(discordUserId);
    if (!deviceId) return unpairedStatus;
    try {
      const response = await this.env.DEVICE_SESSIONS.getByName(deviceId).fetch("https://device-session/status", { headers: { "x-coach-internal-status": "1" } });
      const status = await response.json();
      return isDeviceStatus(status) ? status : disconnectedStatus;
    } catch (error) {
      console.error("Device session status lookup failed", error);
      return disconnectedStatus;
    }
  }
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

function isDeviceStatus(value: unknown): value is DeviceStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (status.agent === "Connected" || status.agent === "Disconnected" || status.agent === "Not paired")
    && (status.league === "Running" || status.league === "Not detected" || status.league === "Unknown")
    && (status.liveApi === "Available" || status.liveApi === "Unavailable" || status.liveApi === "Unknown")
    && (status.currentGame === "Active" || status.currentGame === "Inactive" || status.currentGame === "Unknown");
}
