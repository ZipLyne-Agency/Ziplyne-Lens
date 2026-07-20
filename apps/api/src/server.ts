import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { startWarmer } from "./warmer.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const hostname = "127.0.0.1";

serve({ fetch: app.fetch, hostname, port }, (info) => {
  console.log(`ZipLyne Lens API listening on http://${hostname}:${info.port}`);
  startWarmer();
});
