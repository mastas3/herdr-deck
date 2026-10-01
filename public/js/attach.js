"use strict";
// Files you attach to a message: chips in the message box while they upload (paperclip, drop or paste), sent as
// "[Attached: <path>]" lines after what you typed. The agent still gets those lines (Codex app threads turn deck
// uploads into native images from them, src/http/codex.ts); only the page shows them as chips (attach-view.js).
/* @pure:attach-begin: no globals in here; test/attach.test.ts evaluates this block on its own. */
const ATTACH_MAX = 20, ATTACH_MAX_BYTES = 100 * 1024 * 1024;
const ATTACH_LINE = /^\[Attached: ([^\]\n]+)\]$/;
const ATTACH_IMG = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;
const ATTACH_CODE = /\.(m?js|cjs|tsx?|jsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|html?|css|scss|vue|svelte|lua|r|pl|exs?|zig|dart)$/i;
const ATTACH_TEXT = /\.(txt|md|markdown|mdx|csv|tsv|log|jsonl?|ya?ml|toml|ini|xml|conf|cfg|rtf|diff|patch)$/i;
const ATTACH_ZIP = /\.(zip|tar|tgz|gz|bz2|tbz2?|xz|7z|rar|zst)$/i;
/** What a file is, for its icon and how it opens: image (a thumbnail), pdf, code, text, archive or file. */
function attachKind(name, type = "") {
  const n = String(name ?? ""), t = String(type ?? "");
  if (ATTACH_IMG.test(n) || /^image\/(png|jpeg|gif|webp|avif|bmp|svg\+xml)$/.test(t)) return "image";
  if (/\.pdf$/i.test(n) || t === "application/pdf") return "pdf";
  if (ATTACH_CODE.test(n)) return "code";
  if (ATTACH_TEXT.test(n) || /^text\//.test(t) || t === "application/json") return "text";
  if (ATTACH_ZIP.test(n) || /zip|x-tar|gzip|compressed/.test(t)) return "archive";
  return "file";
}
/** "PDF", "TS", "ZIP": the extension in capitals, or nothing. */
const attachExt = (name) => /\.([a-z0-9]{1,6})$/i.exec(String(name ?? ""))?.[1].toUpperCase() ?? "";
const attachSize = (n) => (n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
/** A path's file name, without the id the deck puts in front of what you upload (src/http/files.ts saveUpload). */
function attachName(path) {
  const p = String(path ?? ""), base = p.split("/").pop() || p;
  return p.includes("/.cache/herdr-deck/uploads/") ? base.replace(/^[0-9a-z]{6,12}-(?=.)/, "") : base;
}
/** The message the agent gets: what you typed, then one "[Attached: <path>]" line per file, in the order added. */
function withAttachments(text, paths) {
  const lines = (paths ?? []).filter(Boolean).map((p) => `[Attached: ${p}]`).join("\n");
  const t = String(text ?? "").trimEnd();
  return !lines ? t : t ? `${t}\n${lines}` : lines;
}
/** A message's own words, and the files its "[Attached: <path>]" lines carry (whole lines only). */
function splitAttachments(text) {
  const src = String(text ?? ""), files = [], keep = [];
  if (!src.includes("[Attached: ")) return { text: src, files };
  for (const line of src.split("\n")) {
    const m = ATTACH_LINE.exec(line.trim());
    if (m) { const path = m[1].trim(); files.push({ path, name: attachName(path), kind: attachKind(path) }); }
    else keep.push(line);
  }
  return files.length ? { text: keep.join("\n").replace(/\n{3,}/g, "\n\n").trim(), files } : { text: src, files };
}
/** A queued message on one line: its words, and how many files go with it. */
function attachSummary(text) {
  const a = splitAttachments(text), n = a.files.length, t = a.text.replace(/\s+/g, " ").trim();
  return n ? `${t}${t ? " · " : ""}${n} file${n > 1 ? "s" : ""}` : t;
}
/** How a set of attachments stands: still uploading, and failed. */
function attachCount(list) {
  let up = 0, err = 0;
  for (const a of list ?? []) { if (a.state === "up") up++; else if (a.state === "err") err++; }
  return { up, err };
}
/** Each session keeps its own attachments, like its draft: a send takes them, a failed send puts them back first. */
function attachTakeFrom(map, key) { const l = map.get(key) ?? []; map.delete(key); return l; }
function attachRestoreTo(map, key, list) { if (list?.length) map.set(key, [...list, ...(map.get(key) ?? []).filter((a) => !list.includes(a))].slice(0, ATTACH_MAX)); }
/* @pure:attach-end */

S.attach = new Map(); // session key → [{ id, key, file, name, size, type, kind, url, state: "up" | "done" | "err", p, path, error, xhr }]
const attachList = (key = S.sel) => S.attach.get(key) ?? [];
const attachTake = (key) => { const l = attachTakeFrom(S.attach, key); renderPastes(); return l; };
function attachRestore(key, list) {
  for (const a of list) attachPreviewDrop(a.path);
  attachRestoreTo(S.attach, key, list);
  renderPastes();
}
let attachSeq = 0, attachActive = 0;

/** Files from the paperclip, a drop or a paste: a chip each at once (an image shows its picture straight from your
 *  machine), then they upload to the session's machine, three at a time. */
function attachFiles(files) {
  const r = rowOf(S.sel);
  if (!r || r.hist) return toast("Open a live session to attach files", true);
  const key = r.key, l = [...attachList(key)], all = [...files];
  const big = all.filter((f) => f.size > ATTACH_MAX_BYTES), fit = all.filter((f) => f.size <= ATTACH_MAX_BYTES);
  const take = fit.slice(0, Math.max(0, ATTACH_MAX - l.length));
  if (big.length) toast(`${big.length > 1 ? `${big.length} files are` : `${big[0].name} is`} over 100 MB. Not attached.`, true);
  else if (fit.length > take.length) toast(`Up to ${ATTACH_MAX} files in one message. ${fit.length - take.length} left out.`, true);
  if (!take.length) return;
  for (const f of take) {
    const name = f.name || "pasted.png", kind = attachKind(name, f.type);
    l.push({ id: `a${++attachSeq}`, key, file: f, name, size: f.size, type: f.type, kind, url: kind === "image" ? URL.createObjectURL(f) : null, state: "up", p: 0 });
  }
  S.attach.set(key, l);
  renderPastes();
  attachPump();
  if (!isPhone()) $("cText").focus();
}
function attachPump() {
  for (const l of S.attach.values()) for (const a of l) {
    if (attachActive >= 3) return;
    if (a.state === "up" && !a.xhr) attachUpload(a);
  }
}
/** XHR, not fetch: it reports how far the upload is. */
function attachUpload(a) {
  attachActive++;
  const x = new XMLHttpRequest();
  a.xhr = x; a.p = 0; a.error = null;
  x.open("POST", `/api/upload?key=${encodeURIComponent(a.key)}&name=${encodeURIComponent(a.name)}`);
  x.setRequestHeader("x-deck-token", S.token);
  x.setRequestHeader("content-type", "application/octet-stream");
  x.upload.onprogress = (e) => { if (e.lengthComputable && e.total) attachProgress(a, e.loaded / e.total); };
  const end = (error, path) => {
    if (a.xhr !== x) return; // removed meanwhile
    a.xhr = null; attachActive--;
    if (error) {
      Object.assign(a, { state: "err", error, p: 0 });
      attachSay(`${a.name} didn’t upload`);
      toast(`${a.name} didn’t upload: ${error}`, true, { label: "Retry", run: () => attachRetry(a) });
    } else { Object.assign(a, { state: "done", path, p: 1 }); attachSay(`${a.name} attached`); }
    if (a.key === S.sel) renderPastes();
    attachPump();
  };
  x.onload = () => {
    let j = null;
    try { j = JSON.parse(x.responseText); } catch {}
    if (x.status >= 200 && x.status < 300 && j?.path) end(null, j.path);
    else end(j?.error ?? (x.status === 413 ? "it’s too big" : `the deck answered ${x.status}`));
  };
  x.onerror = () => end("the connection dropped");
  x.send(a.file);
}
/** Progress moves the ring in place: re-drawing the tray on every tick would reload the thumbnails. */
function attachProgress(a, p) {
  a.p = p;
  if (a.key !== S.sel) return;
  const el = $("cAtt").querySelector(`[data-aid="${a.id}"]`);
  if (!el) return;
  el.style.setProperty("--p", p.toFixed(3));
  el.querySelector("[role=progressbar]")?.setAttribute("aria-valuenow", String(Math.round(p * 100)));
  const mt = el.querySelector(".a-mt");
  if (mt) mt.textContent = attachUpText(a);
}
/** All its bytes are out: the deck is saving it (or passing it on to the session's machine). */
const attachUpText = (a) => (!a.xhr ? "Waiting…" : a.p >= 1 ? "Saving…" : `Uploading ${Math.round(a.p * 100)}%`);
function attachRetry(a) {
  if (!attachList(a.key).includes(a) || a.state !== "err") return;
  Object.assign(a, { state: "up", p: 0, error: null });
  if (a.key === S.sel) renderPastes();
  attachPump();
}
/** A chip goes (its × or Backspace); Undo brings it back where it was, uploading again if it hadn't finished. */
function attachRemove(key, id) {
  const l = [...attachList(key)], i = l.findIndex((a) => a.id === id);
  if (i < 0) return;
  const [a] = l.splice(i, 1);
  l.length ? S.attach.set(key, l) : S.attach.delete(key);
  if (a.xhr) { const x = a.xhr; a.xhr = null; attachActive--; x.abort(); if (a.state === "up") a.p = 0; }
  if (a.url) { URL.revokeObjectURL(a.url); a.url = null; }
  renderPastes();
  attachPump();
  toast(`Removed ${a.name}`, false, { label: "Undo", run: () => {
    const now = [...attachList(key)];
    if (a.kind === "image" && a.file) a.url = URL.createObjectURL(a.file);
    now.splice(Math.min(i, now.length), 0, a);
    S.attach.set(key, now.slice(0, ATTACH_MAX));
    renderPastes();
    attachPump();
  } });
}
/** Sending: the pictures stay on hand a few minutes, so your message in the chat shows them at once (a failed send
 *  puts them back in the box, and then they're the box's again). */
const attachPreview = new Map(); // uploaded path → { url, timer }
function attachKeep(list) {
  for (const a of list) {
    if (!a.url || !a.path) continue;
    const url = a.url;
    attachPreviewDrop(a.path);
    attachPreview.set(a.path, { url, timer: setTimeout(() => {
      attachPreview.delete(a.path);
      if (![...S.attach.values()].some((l) => l.includes(a))) { URL.revokeObjectURL(url); a.url = null; }
    }, 180_000) });
  }
}
function attachPreviewDrop(path) { const p = attachPreview.get(path); if (p) { clearTimeout(p.timer); attachPreview.delete(path); } }
/** Screen readers hear when an upload lands or fails. */
function attachSay(msg) { const el = $("cAttLive"); if (el) el.textContent = msg; }
