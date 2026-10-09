import type { Host } from "../../src/plugin-api";
import { createTerminalRunner, terminalMachines, terminalSocket, TerminalError, type TerminalMachine } from "./transport";
import { createShells } from "./shells";

export function activate(host: Host) {
  const socket = terminalSocket(host.dataDir), shells = createShells(createTerminalRunner(socket), socket);
  const used = new Map<string, TerminalMachine>();
  let stopped = false;
  host.onStop(async () => { stopped = true; await Promise.allSettled([...used.values()].map(m => shells.cleanup(m))); });
  host.routes("terminals", async ({ path, body }) => {
    if (path !== "/api/terminals") return;
    try {
      if (stopped) throw new TerminalError("Terminals are switched off.", 503);
      const machines = terminalMachines(host);
      if (body?.op === "machines") return { machines: machines.map(({ ssh, ...m }) => m) };
      const m = machines.find(m => m.id === body?.machine);
      if (!m) throw new TerminalError("Choose a connected machine.");
      used.set(m.id, m);
      return await shells.action(m, body);
    } catch (e: any) { return Response.json({ error: e?.message || "Terminal unavailable." }, { status: e?.status || 500 }); }
  });
}
