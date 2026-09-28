"use strict";
// Release train: adding or editing a project (its repo, who promotes, and each stage's ref, health URL, check and
// deploy commands). Only saved to the deck's data folder; nothing runs from here.
const RT_DEFAULT = [{ name: "QA", ref: "qa" }, { name: "Staging", ref: "staging" }, { name: "Production", ref: "main" }];

function rtStageHTML(s, i) {
  const f = (k, ph, cls = "") => `<input name="${k}" class="${cls}" spellcheck="false" autocomplete="off" placeholder="${esc(ph)}" value="${esc(s[k] ?? "")}">`;
  return `<fieldset class="rtedst" data-i="${i}"><legend>${f("name", "Stage name")}</legend>
    <label><span>Branch or tag <span class="hint">(v* = newest matching tag)</span></span>${f("ref", "e.g. staging", "mono")}</label>
    <label><span>Health URL <span class="hint">(a GET, read-only)</span></span>${f("health", "https://staging.example.com/health", "mono")}</label>
    <label><span>Check command <span class="hint">(optional, runs only when you press Check)</span></span>${f("check", "curl -sf https://…/health", "mono")}</label>
    <label><span>Deploy command <span class="hint">(goes into the agent’s brief; the deck never runs it)</span></span>${f("deploy", "e.g. make deploy-staging", "mono")}</label>
    <button type="button" class="btn ghost" data-rtdel="${i}">Remove stage</button></fieldset>`;
}

function rtEdit(p) {
  const cur = rowOf(S.sel);
  let stages = p?.stages ? p.stages.map((s) => ({ ...s })) : RT_DEFAULT.map((s) => ({ ...s }));
  const d = document.createElement("dialog");
  d.className = "ask wide rtedit";
  d.innerHTML = `<form method="dialog"><div class="dlg-b"><h3>${p ? `Edit ${esc(p.name)}` : "Add a project"}</h3>
    <div class="fields2"><label class="field"><span>Name</span><input name="pname" autocomplete="off" value="${esc(p?.name ?? cur?.project ?? "")}"></label>
      <label class="field"><span>Repo folder</span><input name="repo" spellcheck="false" autocomplete="off" class="mono" value="${esc(p?.repo ?? (cur?.projectRoot ? home(cur.projectRoot) : ""))}" placeholder="~/Documents/Projects/…"></label></div>
    <div class="fields2"><label class="field"><span>Promote with</span><select name="agent">${["codex", "claude", "opencode"].map((a) => `<option ${(p?.agent ?? "codex") === a ? "selected" : ""}>${a}</option>`).join("")}</select></label>
      <label class="field"><span>Model <span class="hint">(optional)</span></span><input name="model" spellcheck="false" value="${esc(p?.model ?? "")}" placeholder="Default"></label></div>
    <div class="field"><span>Stages, first to last</span><div class="rtstages"></div><p><button type="button" class="btn ghost" data-rtaddst>${ICON.plus}Add a stage</button></p></div></div>
    <div class="dlg-f">${p ? `<button type="button" class="btn ghost" data-rtremove>Remove project</button><span class="spacer"></span>` : ""}<button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div></form>`;
  document.body.append(d);
  const box = d.querySelector(".rtstages");
  const read = () => [...box.querySelectorAll(".rtedst")].map((el) => Object.fromEntries(["name", "ref", "health", "check", "deploy"].map((k) => [k, el.querySelector(`[name=${k}]`).value.trim()])));
  const draw = () => { box.innerHTML = stages.map(rtStageHTML).join(""); };
  draw();
  d.addEventListener("click", async (e) => {
    const t = e.target.closest("[data-rtaddst],[data-rtdel],[data-rtremove]");
    if (!t) return;
    if (t.dataset.rtremove != null) {
      if (!await askDialog({ title: `Remove ${p.name} from Releases?`, text: "Only its stages here are forgotten. The repo is untouched.", ok: "Remove", danger: true })) return;
      await api("/api/release-train", { op: "remove", id: p.id }).catch((err) => toast(err.message, true));
      d.close("cancel"); rtS.sel = null; rtLoad(); return;
    }
    stages = read();
    if (t.dataset.rtdel != null) stages.splice(Number(t.dataset.rtdel), 1); else stages.push({ name: "", ref: "" });
    draw();
  });
  d.querySelector("form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "ok") return;
    e.preventDefault(); // keep the dialog open until the server accepts it
    const f = e.target;
    const project = { id: p?.id, name: f.pname.value, repo: f.repo.value, agent: f.agent.value, model: f.model.value, stages: read() };
    try {
      const r = await api("/api/release-train", { op: "save", project, was: p?.id });
      rtS.sel = r.project.id; store("rtSel", r.project.id);
      d.close("ok"); toast(`Saved ${r.project.name}`); rtLoad();
    } catch (err) { toast(err.message, true); }
  });
  d.addEventListener("close", () => motion.drop(d));
  d.showModal();
}
