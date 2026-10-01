// Copy and Run on code blocks. Run sends a "!" command to the session it was written in:
// Claude Code runs a message that starts with "!" as a shell command. You confirm (and can edit) it first; the
// chat then shows the run as a card (run-card.js).
const canRunCode = (r) => !!r && r.agent === "claude" && !r.app && !r.hist && r.status !== "empty" && !S.mode;
const renderDetailBeforeCode = renderDetail;
renderDetail = function (...a) {
  const out = renderDetailBeforeCode.apply(this, a);
  $("detail").classList.toggle("can-run", canRunCode(rowOf(S.sel)));
  return out;
};
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-cbcopy], [data-cbrun]");
  if (!btn) return;
  e.preventDefault(); e.stopPropagation();
  const code = btn.closest(".cb")?.querySelector("code")?.textContent ?? "";
  if (btn.matches("[data-cbcopy]")) return copy(code, "command");
  const r = rowOf(S.sel);
  if (!canRunCode(r)) return toast("Run works in a live Claude Code session", true);
  const cmd = await askDialog({ title: "Run this command?", text: `It runs in “${r.title}” on ${machineLabel(r.machine)}, as if you typed it there.`, input: code.trim(), multiline: true, ok: "Run", selectInput: false });
  if (!cmd || !cmd.trim()) return;
  runCommand(r, cmd, code); // the run's card in the chat shows it from here on (run-card.js)
}, true);
