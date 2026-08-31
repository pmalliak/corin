import { DiscordInteractionType, discordUserId, interactionResponse, verifyDiscordRequest } from "./discord";
import { D1CoachRepository } from "./repositories";
import type { DeviceStatusRepository, Env, PairingCodeRepository } from "./types";

interface Dependencies {
  pairingCodes: PairingCodeRepository;
  deviceStatus: DeviceStatusRepository;
  now(): Date;
}

interface DiscordInteraction {
  type: number;
  data?: { name?: string; options?: Array<{ name?: string }> };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

export function createApp(env: Env, dependencies: Dependencies = defaultDependencies(env)) {
  return {
    fetch: async (request: Request): Promise<Response> => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
      if (request.method === "POST" && url.pathname === "/interactions") return handleInteraction(request, env, dependencies);
      return new Response("Not Found", { status: 404 });
    },
  };
}

function defaultDependencies(env: Env): Dependencies {
  const repository = new D1CoachRepository(env.COACH_DB);
  return { pairingCodes: repository, deviceStatus: repository, now: () => new Date() };
}

async function handleInteraction(request: Request, env: Env, dependencies: Dependencies): Promise<Response> {
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
  if (subcommand === "connect") {
    const pairing = await dependencies.pairingCodes.create(userId, dependencies.now());
    return interactionResponse(`Enter this pairing code in the LoL Coach Agent: \`${pairing.value}\`\nIt expires at <t:${Math.floor(pairing.expiresAt.getTime() / 1_000)}:R>.`);
  }
  if (subcommand === "status") {
    const status = await dependencies.deviceStatus.getForDiscordUser(userId, dependencies.now());
    return interactionResponse(`Agent: ${status.agent}\nLeague: ${status.league}\nLive API: ${status.liveApi}\nCurrent game: ${status.currentGame}`);
  }
  return interactionResponse("Try `/coach connect` or `/coach status`.");
}
