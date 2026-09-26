// The deck's own API, part 2: Connections (what each machine can reach), recipes, and "suggest mega projects".
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { inventory, inventoryText, loadConnConf, saveConnConf, type Item as ConnItem } from "../connections";
import { CATEGORIES, enrich } from "../store";
import { allRecipes, deleteCustom, fillPrompt, rankRecipes, recipeIds, saveCustom } from "../recipes";
import { upsertAccount } from "../accounts";
import { json } from "./page";
import type { Hub } from "./hub";

export async function connectionsApi(hub: Hub, path: string, body: any): Promise<Response | undefined> {
  const { SELF } = hub;
  const { remotes, allRows } = hub.hosts;
  const { startSession } = hub.sessions;
  switch (path) {
    case "/api/connections": {
      if (body.machine && body.machine !== SELF.id) {
        const remote = remotes.get(body.machine);
        if (!remote) return json({ error: "unknown machine" }, 404);
        const r = await remote.post("/api/connections", { refresh: body.refresh });
        return json(r.data?.sections ? enrich(r.data) : r.data, r.status);
      }
      return json(enrich(await inventory(!!body.refresh)));
    }
    case "/api/recipes": {
      // The store's recipes, ranked by what the chosen machine has. Yours live on the hub.
      const m = body.machine && body.machine !== SELF.id ? String(body.machine) : SELF.id;
      const inv = await (async () => {
        if (m === SELF.id) return inventory();
        const remote = remotes.get(m);
        if (!remote?.online) return undefined;
        try { const r = await remote.post("/api/connections", {}); return r.data?.sections ? r.data : undefined; } catch { return undefined; }
      })();
      try {
        if (body.op === "save") saveCustom(body.recipe);
        else if (body.op === "delete") deleteCustom(String(body.id ?? ""));
        else if (body.op === "prompt") {
          const r = allRecipes().find((x) => x.id === body.id);
          if (!r) return json({ error: "No such recipe" }, 404);
          const picked = (Array.isArray(body.picked) ? body.picked : []).map(String).slice(0, 200);
          const own = recipeIds(r, inv);
          const extra = picked.filter((x: string) => !own.includes(x));
          const connections = inv ? inventoryText(inv, new Set(own)) : "";
          const selected = inv && extra.length ? inventoryText(inv, new Set(extra)).split("\n").slice(3).join("\n").trim() : "";
          return json({ prompt: fillPrompt(r, { connections, machine: inv?.machine ?? m, selected }), folder: r.folder ?? "", agent: r.agent ?? "claude", machine: r.machine ?? "hub", title: r.title });
        }
      } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); }
      return json({ machine: m, reachable: !!inv, recipes: rankRecipes(allRecipes(), inv) });
    }
    case "/api/connections-conf": {
      if (body.machine && body.machine !== SELF.id) {
        const remote = remotes.get(body.machine);
        if (!remote) return json({ error: "unknown machine" }, 404);
        const r = await remote.post("/api/connections-conf", { ...body, machine: undefined });
        return json(r.data?.sections ? enrich(r.data) : r.data, r.status);
      }
      const c = loadConnConf();
      const id = String(body.id ?? "");
      if (body.op === "hide") c.hidden = [...new Set([...c.hidden, id])];
      else if (body.op === "unhide") c.hidden = c.hidden.filter((x) => x !== id);
      else if (body.op === "note") { const t = String(body.text ?? "").trim().slice(0, 1000); if (t) c.notes[id] = t; else delete c.notes[id]; }
      else if (body.op === "add") {
        const it = body.item ?? {};
        const name = String(it.name ?? "").trim().slice(0, 80);
        if (!name) return json({ error: "A name is required" }, 400);
        const item: ConnItem = { id: `custom:${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, name, kind: "custom", status: "ready", detail: String(it.detail ?? "").slice(0, 200), use: String(it.use ?? "").slice(0, 1000), via: String(it.via ?? "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6), ...(CATEGORIES.some((x) => x.id === it.cat) ? { cat: it.cat } : {}) };
        c.custom = [...c.custom.filter((x) => x.id !== item.id), item];
      } else if (body.op === "remove") c.custom = c.custom.filter((x) => x.id !== id);
      else if (body.op === "account") { try { c.accounts = upsertAccount(c.accounts, body.account); } catch (e: any) { return json({ error: e?.message ?? String(e) }, 400); } }
      else if (body.op === "unaccount") c.accounts = c.accounts.filter((x) => x.id !== id);
      else return json({ error: "unknown op" }, 400);
      saveConnConf(c);
      return json(enrich(await inventory(true)));
    }
    case "/api/connections-text": {
      const inv = body.machine && body.machine !== SELF.id
        ? (await (remotes.get(body.machine) ?? { post: async () => ({ data: null }) } as any).post("/api/connections", {})).data
        : await inventory();
      if (!inv?.sections) return json({ error: "That machine isn’t reachable" }, 502);
      const ids = Array.isArray(body.ids) && body.ids.length ? new Set<string>(body.ids.map(String)) : undefined;
      const text = inventoryText(inv, ids);
      return json({ text, file: inv.file });
    }
    case "/api/suggest-projects": {
      // A fresh Claude session gets the map of everything reachable and proposes ambitious projects.
      const maps = [inventoryText(await inventory())];
      for (const h of remotes.values()) if (h.online) { try { const r = await h.post("/api/connections", {}); if (r.data?.sections) maps.push(inventoryText(r.data)); } catch {} }
      const recent = [...new Set(allRows().filter((r) => !r.empty).map((r) => r.project))].slice(0, 25).join(", ");
      const prompt = `You are helping me plan ambitious work. Below is everything my machines can reach (agents, subscriptions, MCP servers, signed-in CLIs, API key names, skills). My active projects: ${recent}.\n\nPropose 6 "mega projects" that are only possible because of this combination: for each, the outcome, which of my connections it uses, the first 3 concrete steps an agent could start today, rough effort, and the main risk. Rank them by value to me. Also list any connection I'm missing that would unlock something big. Don't start building; wait for me to pick.\n\n${maps.join("\n\n---\n\n")}`;
      return json(await startSession({ kind: "claude", cwd: body.cwd || process.env.DECK_HUB_DIR || (existsSync(`${homedir()}/wiki`) ? `${homedir()}/wiki` : homedir()), prompt, label: "Mega project ideas", focus: false }));
    }
  }
}
