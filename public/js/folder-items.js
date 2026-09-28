"use strict";
// The folder window's listing, apart from the window itself (folder-view.js): what kind each entry is, its icon, size
// and date, which entries show, and each row's HTML. Kept separate so a fuller file manager can reuse it.
/* @pure:folder-begin: no globals in here; test/folder-items.test.ts evaluates this block on its own. */
const FV_EXT = {
  code: "js mjs cjs ts mts cts tsx jsx py rb go rs java kt kts swift c h cc cpp hpp cs php sh bash zsh fish lua sql vue svelte astro html htm css scss sass less ex exs erl hs ml scala dart r pl zig nim",
  md: "md mdx markdown rst adoc org",
  json: "json jsonc json5 jsonl ndjson geojson",
  config: "yml yaml toml ini conf cfg properties env plist xml editorconfig gitignore gitattributes gitmodules dockerignore npmrc nvmrc prettierrc eslintrc babelrc browserslistrc",
  image: "png jpg jpeg gif webp svg avif ico bmp heic tif tiff",
  archive: "zip tar gz tgz bz2 xz 7z rar zst dmg iso",
  media: "mp4 mov webm mkv avi mp3 wav m4a ogg flac aac",
  doc: "pdf txt log csv tsv rtf doc docx xls xlsx ppt pptx",
  font: "woff woff2 ttf otf",
};
const FV_KIND_OF = new Map(Object.entries(FV_EXT).flatMap(([k, list]) => list.split(" ").map((x) => [x, k])));
/** Names that say what they are without an extension (or despite one). */
const FV_NAMES = { dockerfile: "config", makefile: "config", procfile: "config", justfile: "config", license: "doc", readme: "md", "bun.lock": "lock", "bun.lockb": "lock", "package-lock.json": "lock", "yarn.lock": "lock", "pnpm-lock.yaml": "lock", "cargo.lock": "lock", "gemfile.lock": "lock", "poetry.lock": "lock", "composer.lock": "lock", "go.sum": "lock", "flake.lock": "lock" };
/** The icon kind of an entry: dir, link-dir, or a file kind (code, md, json, config, lock, image, …, file). */
function fvKind(e) {
  if (e.kind === "dir" || (e.kind === "link" && e.to === "dir")) return "dir";
  const n = String(e.name).toLowerCase();
  if (FV_NAMES[n]) return FV_NAMES[n];
  if (n.endsWith(".lock")) return "lock";
  const dot = n.lastIndexOf(".");
  // ".gitignore", ".env.local": a dotfile's name is its kind.
  const ext = dot > 0 ? n.slice(dot + 1) : dot === 0 ? n.slice(1).split(".")[0] : "";
  return FV_KIND_OF.get(ext) ?? (n.startsWith(".") ? "config" : "file");
}
/** 0 B, 812 B, 4.2 KB, 18 KB, 3.1 MB… (1024s, like Finder's "KB" in spirit). */
function fvSize(b) {
  if (b == null) return "";
  if (b < 1024) return `${b} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = b / 1024, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 ? v.toFixed(1).replace(/\.0$/, "") : Math.round(v)} ${u[i]}`;
}
/** "just now", "5m ago", "3h ago", "2d ago" for the last week, then the date ("Sep 2", with the year once it's another year). */
function fvWhen(t, now) {
  if (!t) return "";
  const s = (now - t) / 1000;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)}d ago`;
  const d = new Date(t), y = new Date(now).getFullYear() !== d.getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(y ? { year: "numeric" } : {}) });
}
/** What the list shows: hidden entries only when asked, and only names containing the filter (any case). */
function fvShown(entries, q, hidden) {
  const w = String(q ?? "").trim().toLowerCase();
  return entries.filter((e) => (hidden || !e.hidden) && (!w || e.name.toLowerCase().includes(w)));
}
/** The breadcrumb trail for `path` inside the project called `name`: each crumb and the path it opens. */
function fvCrumbs(name, path) {
  const parts = String(path ?? "").split("/").filter(Boolean);
  return [{ label: name, path: "" }, ...parts.map((p, i) => ({ label: p, path: parts.slice(0, i + 1).join("/") }))];
}
/** Keeps the window on screen: at least 320×240, at most the viewport less a margin, and fully inside it. */
function fvClamp(r, vw, vh, m = 8) {
  const width = Math.round(Math.max(Math.min(320, vw - 2 * m), Math.min(r.width, vw - 2 * m)));
  const height = Math.round(Math.max(Math.min(240, vh - 2 * m), Math.min(r.height, vh - 2 * m)));
  return { width, height, left: Math.round(Math.min(Math.max(m, r.left), vw - width - m)), top: Math.round(Math.min(Math.max(m, r.top), vh - height - m)) };
}
/* @pure:folder-end */

const fvSvg = (d, extra = "") => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
const FV_DOC = '<path d="M4.2 1.8h4.9l3.1 3.1v8.3c0 .6-.4 1-1 1H4.2c-.6 0-1-.4-1-1V2.8c0-.6.4-1 1-1z"/><path d="M9 1.9V5h3.1"/>';
const FV_ICON = {
  dir: fvSvg('<path d="M1.6 4.3c0-.8.6-1.3 1.3-1.3h3.2l1.6 1.7h5.5c.8 0 1.3.6 1.3 1.3v6.1c0 .8-.6 1.4-1.3 1.4H2.9c-.8 0-1.3-.6-1.3-1.4z" fill="currentColor" fill-opacity=".2"/>'),
  file: fvSvg(FV_DOC),
  code: fvSvg('<path d="m5.3 4.8-3.1 3.2 3.1 3.2M10.7 4.8l3.1 3.2-3.1 3.2M9.1 3.2 6.9 12.8"/>'),
  md: fvSvg('<rect x="1.5" y="3.5" width="13" height="9" rx="1.6"/><path d="M4.2 10V6l1.7 2 1.7-2v4M11.2 6v4M9.7 8.5 11.2 10l1.5-1.5"/>'),
  json: fvSvg('<path d="M5.8 2.6c-1.4 0-1.9.6-1.9 1.7v1.9c0 .8-.5 1.4-1.4 1.8.9.4 1.4 1 1.4 1.8v1.9c0 1.1.5 1.7 1.9 1.7M10.2 2.6c1.4 0 1.9.6 1.9 1.7v1.9c0 .8.5 1.4 1.4 1.8-.9.4-1.4 1-1.4 1.8v1.9c0 1.1-.5 1.7-1.9 1.7"/>'),
  config: fvSvg('<path d="M2.5 4.5h3M9 4.5h4.5M2.5 11.5h6.5M12.5 11.5h1"/><circle cx="7.2" cy="4.5" r="1.7"/><circle cx="10.8" cy="11.5" r="1.7"/>'),
  lock: fvSvg('<rect x="3.2" y="7" width="9.6" height="6.8" rx="1.5"/><path d="M5.4 7V5.1a2.6 2.6 0 0 1 5.2 0V7M8 9.7v1.4"/>'),
  image: fvSvg('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.6"/><circle cx="5.8" cy="6.3" r="1.2"/><path d="m2.4 12.2 3.7-3.6 2.6 2.5 1.9-1.8 2.9 2.8"/>'),
  archive: fvSvg('<rect x="1.8" y="2.8" width="12.4" height="3.2" rx=".9"/><path d="M2.9 6v6.4c0 .6.4 1 1 1h8.2c.6 0 1-.4 1-1V6M6.5 8.6h3"/>'),
  media: fvSvg('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2"/><path d="m6.6 5.9 3.6 2.1-3.6 2.1z" fill="currentColor"/>'),
  doc: fvSvg(FV_DOC + '<path d="M5.6 8.2h4.8M5.6 10.6h3.6"/>'),
  font: fvSvg('<path d="m3 13 4-10h2l4 10M4.6 9.2h6.8"/>'),
};
const FV_LINK = fvSvg('<path d="M6.2 9.8 11 5M7.4 5H11v3.6"/>', ' class="fv-lk"');
const FV_KIND_NAME = { dir: "Folder", file: "File", code: "Code", md: "Markdown", json: "JSON", config: "Settings", lock: "Lock file", image: "Image", archive: "Archive", media: "Audio or video", doc: "Document", font: "Font" };
/** The entry's name with the filter's match marked. */
function fvMark(name, q) {
  const w = String(q ?? "").trim().toLowerCase(), i = w ? name.toLowerCase().indexOf(w) : -1;
  return i < 0 ? esc(name) : `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, i + w.length))}</mark>${esc(name.slice(i + w.length))}`;
}
/** One row of the listing. `i` is its place in what's shown; `sel` is the highlighted place. */
function fvRowHTML(e, i, sel, q, now) {
  const k = fvKind(e), link = e.kind === "link";
  const what = link ? (e.out ? "Link that leads outside the project" : `Link to a ${e.to === "dir" ? "folder" : "file"}`) : FV_KIND_NAME[k];
  return `<div class="fv-e${e.hidden ? " hid" : ""}${link && e.out ? " out" : ""}" role="option" id="fv-e${i}" data-i="${i}" aria-selected="${i === sel}" title="${esc(`${e.name}\n${what}${e.mtime ? " · changed " + abs(e.mtime) : ""}`)}">`
    + `<span class="fv-ico" data-k="${k}">${FV_ICON[k] ?? FV_ICON.file}${link ? FV_LINK : ""}</span>`
    + `<span class="fv-n">${fvMark(e.name, q)}</span>`
    + `<span class="fv-s">${k === "dir" ? "" : esc(fvSize(e.size))}</span>`
    + `<span class="fv-t">${esc(fvWhen(e.mtime, now))}</span></div>`;
}
