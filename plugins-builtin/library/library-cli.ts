// Founder Library from the terminal, for when the deck service isn't the one running the worker.
//   bun plugins-builtin/library/library-cli.ts run          ingest + extract cards in the foreground (Ctrl-C to stop; it resumes later)
//   bun plugins-builtin/library/library-cli.ts status       per-source counts
//   bun plugins-builtin/library/library-cli.ts search "q"   what the Library tab would answer
//   bun plugins-builtin/library/library-cli.ts playbooks    write the playbooks from the cards
//   bun plugins-builtin/library/library-cli.ts spotcheck N  compare N local cards with Claude's reading of the same transcript
//   bun plugins-builtin/library/library-cli.ts dates        fill in publish dates and lengths with yt-dlp (resumable; never touches Chroma)
import { createLibrary } from "./library";

const lib = createLibrary();
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "run") {
  lib.setRunning(true, false);
  process.on("SIGINT", () => { lib.runner.stop(); console.log("stopping after the current video…"); });
  const r = await lib.runner.run();
  if (!r.ok) console.log(`another process (pid ${r.owner}) is already running the library worker`);
  process.exit(0);
} else if (cmd === "status") {
  const s = await lib.status();
  for (const x of s.sources) console.log(`${x.enabled ? "on " : "off"} ${x.id.padEnd(24)} ${String(x.counts.ingested).padStart(4)}/${String(x.counts.total - x.counts.skipped).padEnd(4)} ingested · ${x.counts.queued} queued · ${x.counts.failed} failed · ${x.counts.no_captions} no captions · ${x.cards} cards`);
  console.log(JSON.stringify({ runner: s.runner, cards: s.cards }, null, 1));
} else if (cmd === "search") {
  const r = await lib.search(rest.join(" "), 8);
  console.log(JSON.stringify(r, null, 1));
} else if (cmd === "playbooks") {
  const r = await lib.writePlaybooks();
  console.log(r.map((p) => `${p.file} (${p.cards} cards)`).join("\n"));
} else if (cmd === "spotcheck") {
  const { spotCheck } = await import("./library-spotcheck");
  await spotCheck(lib, Number(rest[0]) || 3, rest.slice(1));
} else if (cmd === "dates") {
  console.log("before:", JSON.stringify(lib.dateCoverage()));
  const r = await lib.backfill({ parallel: Math.min(3, Number(rest[0]) || 2), log: (s) => console.log(s) });
  console.log(`asked ${r.asked}: ${r.found} dated, ${r.failed} without; ${r.cards} cards dated now`);
  console.log("after:", JSON.stringify(lib.dateCoverage()));
} else if (cmd === "recheck") {
  console.log(`${lib.recheck()} cards re-checked`);
} else if (cmd === "reextract") {
  await lib.reextract(rest);
  for (const id of rest) console.log(JSON.stringify(lib.cards().get(id)));
} else {
  console.log("usage: bun plugins-builtin/library/library-cli.ts run | status | search <q> | playbooks | spotcheck <n> | dates [parallel]");
}
