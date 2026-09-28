"use strict";
// Report back in the New session dialog: "Report when done", off until you tick it. When ticked, this exact text is
// added to the end of your first message (you see it before you start): the agent writes REPORT.md and a DONE marker
// when it finishes, and its report card picks REPORT.md up.
const RB_WHEN_DONE = "When you're done, write REPORT.md in the project root: a one-line heading that says what you did, then what changed, what you ran to check it and the result, what's left, and what you need from me. Then create an empty file named DONE next to it.";

rbReg.extend("new.fields", {
  render(el, { kind }) {
    if (!el.firstChild) {
      el.className = "rbnew field";
      el.innerHTML = `<label class="rbnew-l"><input type="checkbox" data-rbnew> Report when done</label>
        <p class="hint rbnew-t" hidden>Adds this to the end of your first message:<br><q>${esc(RB_WHEN_DONE)}</q></p>`;
      const box = el.querySelector("[data-rbnew]");
      box.addEventListener("change", () => { store("rbWhenDone", box.checked); el.querySelector(".rbnew-t").hidden = !box.checked; });
    }
    const box = el.querySelector("[data-rbnew]");
    box.checked = !!load("rbWhenDone", false);
    el.querySelector(".rbnew-t").hidden = !box.checked;
    el.hidden = kind === "shell";
  },
  apply(body) {
    if (body.kind === "shell" || !load("rbWhenDone", false) || !String(body.prompt ?? "").trim()) return;
    body.prompt = `${String(body.prompt).trimEnd()}\n\n${RB_WHEN_DONE}`;
  },
});
