import { createApp } from "./app";
export { DeviceSession } from "./device-session";
import type { Env } from "./types";

export default {
  fetch(request, env, ctx): Promise<Response> {
    return createApp(env, ctx).fetch(request);
  },
} satisfies ExportedHandler<Env>;
