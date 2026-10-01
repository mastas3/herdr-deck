"use strict";
// How attachments look: their chips in the message box (beside the pasted blocks, composer.js), and your messages in
// the chat, where "[Attached: <path>]" lines show as the pictures and files they name.
const attachG = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ATTACH_DOC = '<path d="M4.2 1.8h4.9l3.1 3.1v8.4a.9.9 0 0 1-.9.9H4.2a.9.9 0 0 1-.9-.9V2.7a.9.9 0 0 1 .9-.9z"/><path d="M9 1.9v3.1h3.1"/>';
const ATTACH_GLYPH = {
  file: attachG(ATTACH_DOC),
  text: attachG(`${ATTACH_DOC}<path d="M5.6 8.3h4.8M5.6 10.5h4.8M5.6 12.7h2.8"/>`),
  code: attachG(`${ATTACH_DOC}<path d="m6.6 8.6-1.5 1.7 1.5 1.7M9.4 8.6l1.5 1.7-1.5 1.7"/>`),
  pdf: attachG(`${ATTACH_DOC}<rect x="5.3" y="9.2" width="5.4" height="3.2" rx=".6" fill="currentColor" stroke="none"/>`),
  archive: attachG('<rect x="2.3" y="2.8" width="11.4" height="10.6" rx="1.6"/><path d="M2.3 6h11.4M6.6 8.5h2.8"/>'),
  image: attachG('<rect x="2" y="2.6" width="12" height="10.8" rx="1.8"/><circle cx="5.7" cy="6.1" r="1.2"/><path d="m2.4 11.8 3.6-3.4 2.6 2.3 1.9-1.7 3.1 2.8"/>'),
};
const ATTACH_RETRY = attachG('<path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.8M13.2 2.6v2.8h-2.8"/>');
const ATTACH_WORD = { image: "Image", pdf: "PDF", code: "Code", text: "Text", archive: "Archive", file: "File" };
/** A file on the session's machine, for an <img>: the hub forwards it when the session runs elsewhere. */
const attachRaw = (key, path) => `/api/file-raw?key=${encodeURIComponent(key)}&path=${encodeURIComponent(path)}&t=${encodeURIComponent(S.token)}`;

// ── in the message box ───────────────────────────────────────────────────
/** What changes a chip's markup (not its progress, which attachProgress moves in place). */
const attachSig = (l) => l.map((a) => `${a.id}:${a.state}:${a.xhr ? 1 : 0}:${a.url ?? ""}:${a.error ?? ""}`).join("|") + "#";
function attachChipHTML(a) {
  const pct = Math.round(a.p * 100), up = a.state === "up", err = a.state === "err", n = esc(a.name), size = attachSize(a.size);
  const state = up ? (a.xhr ? `uploading, ${pct}%` : "waiting to upload") : err ? `didn’t upload: ${a.error}` : "attached";
  const ring = up ? `<span class="a-ring" role="progressbar" aria-label="Uploading ${n}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><svg viewBox="0 0 36 36" aria-hidden="true"><circle cx="18" cy="18" r="15" pathLength="100"/><circle class="fg" cx="18" cy="18" r="15" pathLength="100"/></svg></span>` : "";
  const x = `<button type="button" class="a-x" data-aact="remove" title="Remove" aria-label="Remove ${n}">${ICON.x}</button>`;
  const img = a.kind === "image" && a.url;
  const head = `<div class="achip ${img ? "img" : "file"} s-${a.state}${up && !a.xhr ? " waiting" : ""}" data-pid="${a.id}" data-aid="${a.id}" role="listitem" style="--p:${a.p.toFixed(3)}">`;
  if (img) return `${head}<button type="button" class="a-main" data-aact="open" data-name="${n}" aria-label="Image ${n}, ${size}, ${esc(state)}"><img src="${esc(a.url)}" alt="" draggable="false"></button>${ring}${err ? `<button type="button" class="a-retry" data-aact="retry" title="${esc(a.error)}. Retry" aria-label="Retry ${n}">${ATTACH_RETRY}</button>` : ""}${x}</div>`;
  const meta = up ? attachUpText(a) : err ? "Didn’t upload" : [attachExt(a.name) || ATTACH_WORD[a.kind], size].filter(Boolean).join(" · ");
  return `${head}<button type="button" class="a-main" data-aact="open" title="${n}${err ? ` · ${esc(a.error)}` : ""}" aria-label="${ATTACH_WORD[a.kind]} ${n}, ${size}, ${esc(state)}"><span class="a-ic">${ATTACH_GLYPH[a.kind] ?? ATTACH_GLYPH.file}</span><span class="a-tx"><span class="a-nm">${n}</span><span class="a-mt">${esc(meta)}</span></span></button>${ring}${err ? `<button type="button" class="a-retry txt" data-aact="retry" aria-label="Retry ${n}">Retry</button>` : ""}${x}</div>`;
}
/** A chip in the box goes: a file, or a pasted block. */
function trayRemove(pid) { attachList().some((a) => a.id === pid) ? attachRemove(S.sel, pid) : pasteRemove(pid); }
const trayMains = () => [...$("cAtt").querySelectorAll("[data-pid]:not(.ghost) > .a-main")];
$("cAtt").addEventListener("click", (e) => {
  const b = e.target.closest("[data-aact]");
  if (!b) return;
  const key = S.sel, id = b.closest("[data-aid]")?.dataset.aid, a = attachList(key).find((x) => x.id === id);
  if (!a) return;
  const act = b.dataset.aact;
  if (act === "remove") return attachRemove(key, id);
  if (act === "retry" || a.state === "err") return attachRetry(a);
  if (a.kind === "image" && a.url) {
    const imgs = attachList(key).filter((x) => x.kind === "image" && x.url);
    S.gallery = imgs.map((x) => ({ src: x.url, name: x.name }));
    return openLightbox(imgs.indexOf(a));
  }
  if (a.state !== "done") return toast(`${a.name} is still uploading`);
  openFile(a.path, key);
});
// Like a token input: arrows walk the chips, Backspace or Delete removes the one you're on.
$("cAtt").addEventListener("keydown", (e) => {
  const chip = e.target.closest("[data-pid]");
  if (!chip || e.altKey || e.metaKey || e.ctrlKey) return;
  const mains = trayMains(), i = mains.indexOf(chip.querySelector(".a-main"));
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); mains[i + (e.key === "ArrowLeft" ? -1 : 1)]?.focus(); return; }
  if (e.key !== "Backspace" && e.key !== "Delete") return;
  e.preventDefault();
  trayRemove(chip.dataset.pid);
  const left = trayMains();
  (left[e.key === "Backspace" ? Math.max(0, i - 1) : Math.min(i, left.length - 1)] ?? $("cText")).focus();
});
// Backspace in an empty box takes the last chip.
$("cText").addEventListener("keydown", (e) => {
  if (e.key !== "Backspace" || e.isComposing || e.target.value || e.altKey || e.metaKey || e.ctrlKey) return;
  const last = [...$("cAtt").querySelectorAll("[data-pid]:not(.ghost)")].pop();
  if (!last) return;
  e.preventDefault();
  trayRemove(last.dataset.pid);
});

// ── in the chat ──────────────────────────────────────────────────────────
/** Your message's files: pictures as thumbnails (the lightbox opens them), the rest as chips (the file viewer). */
function attachMsgHTML(files, key) {
  if (!files?.length) return "";
  const imgs = files.filter((f) => f.kind === "image"), rest = files.filter((f) => f.kind !== "image");
  const im = imgs.map((f) => {
    const local = attachPreview.get(f.path)?.url, src = local ?? attachRaw(key, f.path), n = esc(f.name);
    return `<button type="button" class="aimg" data-aimg="${esc(src)}" data-apath="${esc(f.path)}" data-aname="${n}" title="${n}" aria-label="Image ${n}"><img ${local ? "" : 'loading="lazy" '}decoding="async" alt="" src="${esc(src)}" onerror="this.parentElement.classList.add('broken')"><span class="a-bk">${ATTACH_GLYPH.image}<span>${n}</span></span></button>`;
  }).join("");
  const fl = rest.map((f) => `<button type="button" class="afile" data-path="${esc(f.path)}" title="${esc(home(f.path))}" aria-label="${ATTACH_WORD[f.kind]} ${esc(f.name)}"><span class="a-ic">${ATTACH_GLYPH[f.kind] ?? ATTACH_GLYPH.file}</span><span class="a-tx"><span class="a-nm">${esc(f.name)}</span><span class="a-mt">${esc(attachExt(f.name) || ATTACH_WORD[f.kind])}</span></span></button>`).join("");
  return `<div class="atts${imgs.length === 1 ? " one" : ""}">${im ? `<div class="aims">${im}</div>` : ""}${fl ? `<div class="afls">${fl}</div>` : ""}</div>`;
}
