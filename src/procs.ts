// Process table: one `ps` call gives memory, CPU and start time for every pane's process tree.

export type Proc = { pid: number; ppid: number; rssKB: number; cpu: number; startedAt: number; comm: string };

/** macOS `etime`: [[dd-]hh:]mm:ss → seconds. */
export function parseEtime(s: string): number {
  let days = 0;
  let rest = s.trim();
  const dash = rest.indexOf("-");
  if (dash >= 0) {
    days = Number(rest.slice(0, dash));
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(":").map(Number);
  while (parts.length < 3) parts.unshift(0);
  const [h, m, sec] = parts;
  return days * 86400 + h * 3600 + m * 60 + sec;
}

export function parsePs(out: string, now = Date.now()): Map<number, Proc> {
  const procs = new Map<number, Proc>();
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    procs.set(pid, {
      pid,
      ppid: Number(m[2]),
      rssKB: Number(m[3]),
      cpu: Number(m[4]),
      startedAt: now - parseEtime(m[5]) * 1000,
      comm: m[6].split("/").pop() ?? m[6],
    });
  }
  return procs;
}

export async function readProcs(): Promise<Map<number, Proc>> {
  const p = Bun.spawn(["ps", "-axo", "pid=,ppid=,rss=,pcpu=,etime=,comm="], { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(p.stdout).text();
  return parsePs(out);
}

export function childrenIndex(procs: Map<number, Proc>): Map<number, number[]> {
  const kids = new Map<number, number[]>();
  for (const p of procs.values()) {
    const list = kids.get(p.ppid);
    if (list) list.push(p.pid);
    else kids.set(p.ppid, [p.pid]);
  }
  return kids;
}

/** Total memory and CPU of a process and all its descendants (a pane's shell drags in agents, MCP servers, dev servers). */
export function treeUsage(root: number, procs: Map<number, Proc>, kids: Map<number, number[]>) {
  let rssKB = 0, cpu = 0, count = 0;
  const stack = [root];
  const seen = new Set<number>();
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    const p = procs.get(pid);
    if (!p) continue;
    rssKB += p.rssKB;
    cpu += p.cpu;
    count++;
    for (const k of kids.get(pid) ?? []) stack.push(k);
  }
  return { rssKB, cpu, count };
}
