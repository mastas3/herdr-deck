// The only server surface is a fixed set of local artwork. Session data and actions stay with the deck.
import type { Host } from "../../src/plugin-api";

export function activate(host: Host) {
  host.routes("/aether-art/", async ({ url }) => {
    const name = url.pathname.slice("/aether-art/".length);
    if (!["world.webp", "aether.webp"].includes(name)) return new Response("Not found", { status: 404 });
    const file = Bun.file(`${host.dir}/art/${name}`);
    return await file.exists() ? new Response(file, { headers: { "cache-control": "private, max-age=3600" } }) : new Response("Not found", { status: 404 });
  });
}
