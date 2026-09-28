// The Files plugin: the inspector's Files and Changes tabs ask POST /api/files { op, key, … } about one session.
// A session on another machine ("<machine>|<key>") is answered by that machine's deck, where this plugin runs too
// (machine "any"): the hub passes the question on through the core's `remotes`, the way the core forwards its own
// per-session requests (src/http/forward.ts). Read-only throughout; nothing here writes a file or runs a timer.
import type { Host } from "../../src/plugin-api";
import { createFiles, FilesError } from "./service";

type Remote = { conf: { id: string; label: string }; online: boolean; post(path: string, body: unknown): Promise<{ status: number; data: any }> };
type Remotes = { get(id: string): Remote | undefined };

const err = (msg: string, status = 400) => Response.json({ error: msg }, { status });

export function activate(host: Host) {
  const files = createFiles({ rows: () => host.rows() });
  host.onStop(() => files.clear());

  host.routes("files", async ({ path, body }) => {
    if (path !== "/api/files") return undefined;
    const key = String(body?.key ?? "");
    const i = key.indexOf("|");
    const remote = i > 0 ? host.use<Remotes>("remotes")?.get(key.slice(0, i)) : undefined;
    if (remote) return forward(remote, { ...body, key: key.slice(i + 1) });
    try { return await files.handle(body); }
    catch (e: any) { return err(e instanceof FilesError ? e.message : `Files: ${e?.message ?? e}`, e instanceof FilesError ? e.status : 500); }
  });

  async function forward(remote: Remote, body: unknown) {
    try {
      const r = await remote.post("/api/files", body);
      // The node's deck answers 404 without a JSON error when Files is off there.
      if (r.status === 404 && !r.data?.error) return err(`Turn on Files in Plugins on ${remote.conf.label} to see its files here.`, 409);
      return Response.json(r.data ?? {}, { status: r.status });
    } catch (e: any) { return err(e?.message ?? `${remote.conf.label} didn’t answer`, 502); }
  }
}
