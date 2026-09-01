import {
  DiscordInteractionType,
  deferredInteractionResponse,
  discordAccount,
  editOriginalInteractionResponse,
  interactionResponse,
  verifyDiscordRequest,
  type DeferredInteraction,
  type DiscordMessage,
} from "./discord";
import { failureMessage, pairingMessage, plainMessage, setupMessage, statusMessage, unknownCommandMessage } from "./messages";
import { liveGameReport } from "./live-game-report";
import { sha256 } from "./crypto";
import { mobileAppHtml } from "./mobile-app";
import { D1CoachRepository } from "./repositories";
import type { DeviceAuthenticationRepository, DeviceSnapshot, DeviceStatus, DeviceStatusRepository, DiscordAccount, Env, PairingCodeRepository } from "./types";

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
  member?: { user?: { id?: string; username?: string; global_name?: string | null } };
  user?: { id?: string; username?: string; global_name?: string | null };
}

export function createApp(env: Env, ctx: Waiter, dependencies: Dependencies = defaultDependencies(env)) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
      if (request.method === "GET" && url.pathname === "/robots.txt") return robotsResponse();
      if (request.method === "GET" && url.pathname === "/mobile") return new Response(mobileAppHtml, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      if (request.method === "POST" && url.pathname === "/mobile/api/chat") return handleMobileChat(request, env, dependencies);
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/download") return handleAgentDownload(request, env);
      if (request.method === "POST" && url.pathname === "/interactions") return handleInteraction(request, env, ctx, dependencies);
      if (request.method === "POST" && url.pathname === "/agent/pair") return handlePairingExchange(request, dependencies);
      if (request.method === "GET" && url.pathname === "/agent/session") return handleDeviceSession(request, env, dependencies);
      if (request.method === "GET" && url.pathname === "/coach/state") return handleCoachState(request, url, env, dependencies);
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/chatgpt/live-game") return handleChatgptLiveGame(request, url, env, dependencies);
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
  const account = discordAccount(interaction);
  if (!account) return interactionResponse(plainMessage("I couldn't identify your Discord account."));

  const subcommand = interaction.data.options?.[0]?.name;
  if (subcommand === "setup") return interactionResponse(setupMessage(agentDownloadUrl(request)));
  if (subcommand !== "connect" && subcommand !== "status") return interactionResponse(unknownCommandMessage());

  const deferred = deferralTarget(interaction);
  if (!deferred) return interactionResponse(plainMessage("I couldn't reply to that interaction."));

  // Discord abandons an interaction after three seconds, which D1 and the session
  // Durable Object can exceed together, so acknowledge first and edit the reply after.
  ctx.waitUntil(completeCoachCommand(subcommand, account, deferred, dependencies));
  return deferredInteractionResponse();
}

function agentDownloadUrl(request: Request): string {
  return new URL("/download", request.url).toString();
}

async function completeCoachCommand(subcommand: "connect" | "status", account: DiscordAccount, deferred: DeferredInteraction, dependencies: Dependencies): Promise<void> {
  let message: DiscordMessage;
  try {
    message = subcommand === "connect" ? await connectMessage(account, dependencies) : await currentStatusMessage(account.id, dependencies);
  } catch (error) {
    console.error(`/coach ${subcommand} failed`, error);
    message = failureMessage();
  }
  await dependencies.followUp(deferred, message);
}

async function connectMessage(account: DiscordAccount, dependencies: Dependencies): Promise<DiscordMessage> {
  return pairingMessage(await dependencies.pairingCodes.create(account, dependencies.now()));
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
  // The account is what the agent puts on screen, so a friend can see which
  // Discord identity this PC now answers for. Absent when we never learned a handle.
  return Response.json({
    version: 1,
    deviceId: result.deviceId,
    credential: result.credential,
    sessionUrl: new URL("/agent/session", request.url).toString(),
    ...(result.discordUsername ? { account: { username: result.discordUsername } } : {}),
  });
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

/**
 * Explicitly permissive, and served because the fetchers this Worker exists to
 * be read by look for one. A 404 is only usually taken as permission, and none
 * of these routes is reachable without a secret, so a crawler that asks has
 * nothing here to find.
 */
function robotsResponse(): Response {
  return new Response("User-agent: *\nAllow: /\n", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
  });
}

/**
 * The same live state as a plain page, for a reader that can only open a URL.
 *
 * A ChatGPT Project can be told to read a link before it answers, but it cannot
 * send an Authorization header and it cannot speak MCP, so the secret has to
 * travel in the URL. That is exactly why this is its own route with its own
 * token: it is rotated or removed on its own, without touching the MCP endpoint
 * or the coach service token, and even in the wrong hands it reads one account,
 * the one named by MCP_DISCORD_USER_ID, and can change nothing.
 *
 * A URL-borne secret is weaker than a header: it lands in browser history, in
 * whatever fetches the page, and in request logs. It is a deliberate trade for
 * a client that has nowhere else to put a credential.
 */
async function handleChatgptLiveGame(request: Request, url: URL, env: Env, dependencies: Dependencies): Promise<Response> {
  const expected = env.CHATGPT_LIVE_TOKEN;
  if (!expected) return new Response("Not Found", { status: 404 });

  const presented = urlSecret(url);
  if (!presented || !(await secretsMatch(presented, expected))) return new Response("Unauthorized", { status: 401 });
  if (request.method === "HEAD") return reportResponse("");

  const discordUserId = env.MCP_DISCORD_USER_ID;
  if (!discordUserId || !/^\d{17,20}$/.test(discordUserId)) {
    return reportResponse("Corin is not configured yet: no Discord account has been selected on the Worker.", 503);
  }

  const snapshot = await dependencies.deviceStatus.getForDiscordUser(discordUserId, dependencies.now());
  return reportResponse(liveGameReport(snapshot, dependencies.now()));
}

/**
 * The secret as the guideline writes it, `?<secret>`, and as a person naturally
 * writes it by hand, `?token=<secret>`.
 *
 * Only the first parameter is read, and a bare one at that. A fetcher that
 * appends a parameter of its own, or a cache-buster added by hand, must not turn
 * the secret into a miss.
 */
function urlSecret(url: URL): string | null {
  const named = url.searchParams.get("token");
  if (named) return named;

  const first = url.search.slice(1).split("&")[0] ?? "";
  if (first.length === 0 || first.includes("=")) return null;
  try {
    return decodeURIComponent(first);
  } catch {
    return null;
  }
}

/**
 * Plain text, because the reader is a language model and never a browser.
 *
 * Deliberately no `x-robots-tag`. A URL nobody can reach without the secret is
 * not something a crawler can index anyway, and the header is read by the very
 * fetchers this page exists for, which can refuse a page that carries it.
 */
function reportResponse(body: string, status = 200): Response {
  return new Response(status === 200 && body.length === 0 ? null : body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // A player's live position is not something a cache should keep.
      "cache-control": "no-store, max-age=0",
    },
  });
}

async function handleMobileChat(request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
  const expected = env.APP_ACCESS_TOKEN;
  const presented = request.headers.get("x-corin-access-token");
  if (!expected || !presented || !(await secretsMatch(presented, expected))) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const payload = await requestJson(request);
  const message = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).message : null;
  if (typeof message !== "string" || message.trim().length === 0 || message.length > 800) return Response.json({ error: "Ask a short question." }, { status: 400 });
  if (!env.OPENAI_API_KEY || !env.MCP_DISCORD_USER_ID) return Response.json({ error: "The assistant is not configured yet." }, { status: 503 });

  const snapshot = await dependencies.deviceStatus.getForDiscordUser(env.MCP_DISCORD_USER_ID, dependencies.now());
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5-mini",
      store: false,
      max_output_tokens: 500,
      instructions: "You are Corin, a concise League of Legends coach. Use only the supplied live-game state. If the player is not in a game, say so. Do not invent facts, names, or game events. Reply in the user's language.",
      input: `Live-game state:\n${JSON.stringify(snapshot).slice(0, 30_000)}\n\nPlayer question: ${message.trim()}`,
    }),
  });
  if (!response.ok) {
    console.error("OpenAI response failed", response.status);
    return Response.json({ error: "The AI service is unavailable right now." }, { status: 502 });
  }
  const result = (await response.json()) as { output_text?: string };
  return Response.json({ answer: result.output_text || "I couldn't produce an answer." }, { headers: { "cache-control": "no-store" } });
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
