"use strict";
// Files: what the Files and Changes tabs share. They ask /api/files about one session (the hub passes a question about
// another machine's session on to that machine's deck), open files in the deck's own file viewer (openFile), and act
// on a file from its ⋯ menu: copy the path, mention it in the message box, or open it / show it in Finder on the Mac.
const filesReg = deckPlugins.register("files", {
  palette: (q, cur) => {
    const r = cur && rowOf(cur);
    if (!r || !filesStub || filesStub.real()) return [];
    return [
      { t: "Files: this session’s folder and the files it touched", run: () => filesStub.open("files"), slot: "more" },
      { t: "Changes: what this session’s folder has changed (git diff)", run: () => filesStub.open("changes"), slot: "more" },
    ];
  },
});

const filesApi = (row, body) => api("/api/files", { ...body, key: row.key }, 20_000);
const FILES_BADGE = { M: "Changed", A: "Added", D: "Deleted", R: "Renamed", "?": "New, not in git yet", U: "Conflict" };
/** A git status badge: one letter, its meaning on hover. */
const filesBadge = (st) => (st ? `<span class="fx-b" data-st="${esc(st)}" title="${esc(FILES_BADGE[st] ?? st)}">${st === "?" ? "N" : esc(st)}</span>` : "");
const filesIcon = (d) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const FILES_ICONS = {
  files: filesIcon('<path d="M2.5 4.5v8a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1H8L6.5 3h-3a1 1 0 0 0-1 1z"/>'),
  changes: filesIcon('<path d="M5 2.5v7M2 6h6M3 12.5h10M11 3v5M9 5.5h4" stroke-linecap="round"/>'),
};
/** The Mac can open files for a session that runs on it (the deck's own machine, or the Codex app on it). */
const filesOnMac = (row) => !!row && (row.machine === S.self || row.machine === "codex-app");

/** A path to type into the message box: relative to the session's folder when it's inside, else absolute. */
function filesMentionPath(info, abs) {
  const base = info.cwd ? `${info.root}/${info.cwd}` : info.root;
  const p = abs.startsWith(base + "/") ? abs.slice(base.length + 1) : abs;
  return /\s/.test(p) ? `"${p}"` : p;
}
/** Puts "@path " into the message box where the cursor is, and goes there. */
function filesMention(row, text) {
  if (S.sel !== row.key || $("composer").hidden) return toast("This session has no message box", true);
  const ta = $("cText");
  const at = ta.selectionStart ?? ta.value.length, end = ta.selectionEnd ?? at;
  const pre = ta.value.slice(0, at), gap = pre && !/\s$/.test(pre) ? " " : "";
  ta.value = pre + gap + text + " " + ta.value.slice(end);
  const pos = (pre + gap + text + " ").length;
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  autosize(ta);
  if (isPhone() && filesStub?.isOpen()) filesStub.close();
  focusReply();
  ta.setSelectionRange(pos, pos);
}

/** The ⋯ menu of one file (or folder). `abs` is its absolute path on the session's machine. */
function filesMenu(anchor, row, info, abs, dir) {
  const mac = filesOnMac(row);
  const items = [
    ...(dir ? [] : [{ html: "<span>View</span>", run: () => openFile(abs, row.key) }]),
    { html: "<span>Copy path</span>", run: () => copy(abs, "path") },
    { html: "<span>Mention in message</span><small>adds @path to the message box</small>", run: () => filesMention(row, "@" + filesMentionPath(info, abs)) },
  ];
  if (mac) items.push("-",
    { html: "<span>Open on Mac</span><small>in its default app</small>", run: () => api("/api/file-open", { key: row.key, path: abs }).then(() => toast("Opened on the Mac")).catch((x) => toast(x.message, true)) },
    { html: "<span>Show in Finder</span>", run: () => api("/api/file-open", { key: row.key, path: abs, reveal: true }).then(() => toast("Shown in Finder")).catch((x) => toast(x.message, true)) });
  openMenu(anchor, items, home(abs).split("/").pop() || home(abs));
}

/** Light syntax colour for a line of code: comments, strings, numbers and common keywords. Escapes everything. */
const FILES_KW = /^(?:const|let|var|function|return|if|else|for|while|import|export|from|class|new|async|await|def|self|None|True|False|true|false|null|undefined|type|interface|fn|pub|use|struct|impl|match|package|func|try|catch|throw|in|of|as|with|yield)$/;
const FILES_TOK = /(\/\/.*$|#(?![\w{[]).*$|--\s.*$|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d[\d_.]*\b)|([A-Za-z_]\w*)/g;
function filesHi(text) {
  let out = "", last = 0;
  for (const m of text.matchAll(FILES_TOK)) {
    out += esc(text.slice(last, m.index));
    const [t, c, s, n, w] = m;
    out += c ? `<i class="hc">${esc(t)}</i>` : s ? `<i class="hs">${esc(t)}</i>` : n ? `<i class="hn">${esc(t)}</i>` : w && FILES_KW.test(w) ? `<i class="hk">${esc(t)}</i>` : esc(t);
    last = m.index + t.length;
  }
  return out + esc(text.slice(last));
}

/** What in a row means "the agent may have changed files": the inspector calls patch() far more often than that. */
const filesSig = (r) => `${r?.status}|${r?.lastActiveAt ?? ""}|${r?.now ?? ""}|${r?.dirty ?? ""}`;
/** Refreshes a tab while it's open and its session is working: at most every `ms`, never while you're typing in it. */
function filesPacer(ms, run) {
  let timer = 0, last = 0;
  return {
    poke() {
      clearTimeout(timer);
      const wait = Math.max(0, ms - (Date.now() - last));
      timer = setTimeout(() => { last = Date.now(); run(); }, wait);
    },
    stop() { clearTimeout(timer); },
    mark() { last = Date.now(); },
  };
}
