// Gallery: Play. A confirm dialog says exactly what will happen; nothing is built, written or started before you press
// Play. Then: the starter kit (built if needed), the project folder with the kit's files (the server refuses without
// confirm: true), a run on the quest board via startRun (it asks about the main quest; skipped while the quests plugin
// is off), and the New session dialog with task 1 in that folder, which starts nothing until you press Start there.
async function galPlayFlow(id) {
  const x = galIdea(id);
  if (!x) return;
  const playing = galPlaying(id);
  if (playing) return galPlayingMenu(x, playing);
  let pv;
  try { pv = await api("/api/ideas/play", { id }, 20_000); } catch (e) { return toast(e.message, true); }
  const home = (p) => p.replace(/^\/(?:Users|home)\/[^/]+/, "~");
  const kit = galHasKit(id);
  const task = S.gal.kits.get(id)?.buildPlan?.[0];
  const quests = typeof startRun === "function";
  const d = document.createElement("dialog");
  d.className = "galplay";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><p class="galkick">Play this idea</p><h3>${esc(x.name)}</h3>
      <ol class="galsteps">
        ${kit ? "" : "<li><b>Build the starter kit.</b> One Claude call, usually a minute or two.</li>"}
        <li><b>Create <code class="galpath">${esc(home(pv.dir))}</code></b> with the kit's ${pv.files.length} files: ${pv.files.slice(0, 7).map((f) => `<code>${esc(f)}</code>`).join(" ")} and the rest. Key names only, never values.</li>
        ${quests ? `<li><b>Start a run on your quest board</b> with a milestone ladder: offer page live, first user, first paying customer, 10 paying, $100 and $1k a month.</li>
        <li><b>Ask whether it becomes your main quest.</b></li>` : ""}
        <li><b>Open the New session dialog</b> in that folder with ${task ? `task 1, “${esc(task.title)}”` : "task 1 of the kit"}. It starts only when you press Start.</li>
      </ol>
      <p class="hint">Nothing is written, posted or started until you press Play.</p>
      <div class="galplayrun" hidden role="status"><span class="spin"></span><span></span></div></div>
    <div class="dlg-f"><button class="btn" value="cancel">Cancel</button><button class="btn primary" value="ok" data-galgo>Play</button></div></form>`;
  document.body.append(d);
  const run = d.querySelector(".galplayrun");
  const say = (t) => { run.hidden = false; run.lastElementChild.textContent = t; };
  let busy = false;
  d.addEventListener("cancel", (e) => { if (busy) e.preventDefault(); });
  d.querySelector("form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault();
    if (busy) return;
    busy = true;
    d.querySelectorAll("button").forEach((b) => (b.disabled = true));
    try {
      if (!galHasKit(id)) { say("Building the starter kit… one Claude call"); await galKitBuild(id); if (!galHasKit(id)) throw new Error(S.gal.kitJobs.get(id)?.error ?? "The kit couldn't be built"); }
      say("Writing the project folder…");
      const r = await api("/api/ideas/play", { id, confirm: true }, 360_000);
      S.gal.data.playing = { ...(S.gal.data.playing ?? {}), [id]: { dir: r.dir, slug: r.slug, name: r.name, at: Date.now() } };
      d.close(); d.remove();
      S.gal.sheet?.dlg.close();
      galPaint();
      toast(`Wrote ${r.files.length} files to ${home(r.dir)}`);
      const c = S.gal.full.get(id) ?? x;
      if (quests) await startRun({ name: c.name, slug: r.slug, buyer: c.buyer, offer: c.offer, price: c.price, pitch: c.hook, kit: home(r.dir), source: "gallery", firstTask: r.firstTask });
      else openNew({ machine: S.self, cwd: r.dir, project: r.slug, prompt: r.firstTask?.prompt, label: c.name.slice(0, 40), title: `Task 1: ${c.name}` });
    } catch (err) {
      busy = false;
      say(err.message);
      run.querySelector(".spin")?.remove();
      d.querySelectorAll("button").forEach((b) => (b.disabled = false));
    }
  });
  d.addEventListener("close", () => { if (!busy) d.remove(); });
  d.showModal();
  d.querySelector("[data-galgo]").focus();
}
/** Already playing: go to its project page (when project pages are on). */
function galPlayingMenu(x, p) {
  if (!projectLink()) return toast(`“${x.name}” is being played in ${p.dir.replace(/^\/(?:Users|home)\/[^/]+/, "~")}`);
  askDialog({ title: `“${x.name}” is being played`, text: `Its folder is ${p.dir.replace(/^\/(?:Users|home)\/[^/]+/, "~")}. Open its project page?`, ok: "Project page" }).then((yes) => { if (yes) { S.gal.sheet?.dlg.close(); projectLink().open(p.slug); } });
}
// Every gallery file is in: draw For you with the gallery if Discover is already open.
if (S.mode === "discover") renderDiscover();
