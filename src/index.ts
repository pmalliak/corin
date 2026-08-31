import { createApp } from "./app";
export { DeviceSession } from "./device-session";
import type { Env } from "./types";

export default {
  fetch(request, env): Promise<Response> {
    return createApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
