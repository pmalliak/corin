import { createApp } from "./app";
import type { Env } from "./types";

export default {
  fetch(request, env): Promise<Response> {
    return createApp(env).fetch(request);
  },
} satisfies ExportedHandler<Env>;
