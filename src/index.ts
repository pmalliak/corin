export { DeviceSession } from "./device-session";
export { CorinMcp } from "./mcp";
import { CorinMcp } from "./mcp";
import { createApp } from "./app";
import { sha256 } from "./crypto";
import type { Env } from "./types";

const mcpHandler = CorinMcp.serve("/mcp");

export default {
  async fetch(request, env, ctx): Promise<Response> {
    if (new URL(request.url).pathname !== "/mcp") return createApp(env, ctx).fetch(request);

    const expected = env.MCP_BEARER_TOKEN;
    const token = /^Bearer (\S+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!expected || !token || !(await secretsMatch(token, expected))) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }

    return mcpHandler.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

async function secretsMatch(presented: string, expected: string): Promise<boolean> {
  const [presentedDigest, expectedDigest] = await Promise.all([sha256(presented), sha256(expected)]);
  return presentedDigest === expectedDigest;
}
