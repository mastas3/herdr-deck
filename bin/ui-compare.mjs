#!/usr/bin/env node
// Compares two bin/ui-snapshot.mjs runs, view by view: pixels (with a tolerance), DOM text, the set of requests the
// page made, and page errors. Writes <name>.diff.png (changed pixels in red) into the second run's folder for every
// screenshot that differs, prints one line per difference and a summary, and exits 1 when anything differs.
// Usage: bin/ui-compare.mjs <before-dir> <after-dir> [--tolerance 0.001] [--threshold 24] [--ignore-requests <regex>]
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const PLAYWRIGHT = process.env.PLAYWRIGHT_PATH || "/Users/stas-2/.nvm/versions/node/v20.16.0/lib/node_modules/playwright/index.mjs";

function args(argv) {
  const o = { tolerance: 0.001, threshold: 24, dirs: [], ignore: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tolerance") o.tolerance = Number(argv[++i]);
    else if (a === "--threshold") o.threshold = Number(argv[++i]);
    else if (a === "--ignore-requests") o.ignore = new RegExp(argv[++i]);
    else if (a === "--help" || a === "-h") { console.log("usage: bin/ui-compare.mjs <before-dir> <after-dir> [--tolerance 0.001] [--threshold 24] [--ignore-requests <regex>]"); process.exit(0); }
    else o.dirs.push(resolve(a));
  }
  if (o.dirs.length !== 2) throw new Error("give two snapshot folders (see --help)");
  return o;
}

/** Pixel diff in the browser's canvas: no image library needed. A pixel differs when any channel moves by more than
 *  `threshold`; returns the share of differing pixels and a PNG (data URL) marking them. */
async function pixelDiff(page, a, b, threshold) {
  return page.evaluate(async ({ a, b, threshold }) => {
    const load = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = src; });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { ratio: 1, size: `${ia.width}×${ia.height} vs ${ib.width}×${ib.height}` };
    const px = (img) => { const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const g = c.getContext("2d"); g.drawImage(img, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
    const da = px(ia), db = px(ib);
    const c = document.createElement("canvas"); c.width = ia.width; c.height = ia.height;
    const g = c.getContext("2d"), out = g.createImageData(c.width, c.height);
    let n = 0;
    for (let i = 0; i < da.data.length; i += 4) {
      const d = Math.max(Math.abs(da.data[i] - db.data[i]), Math.abs(da.data[i + 1] - db.data[i + 1]), Math.abs(da.data[i + 2] - db.data[i + 2]));
      if (d > threshold) { n++; out.data[i] = 255; out.data[i + 3] = 255; }
      else { const v = (db.data[i] + db.data[i + 1] + db.data[i + 2]) / 12; out.data[i] = out.data[i + 1] = out.data[i + 2] = v; out.data[i + 3] = 255; }
    }
    g.putImageData(out, 0, 0);
    return { ratio: n / (da.data.length / 4), pixels: n, png: n ? c.toDataURL("image/png") : undefined };
  }, { a, b, threshold });
}

const diffSets = (x, y) => ({ gone: x.filter((v) => !y.includes(v)), added: y.filter((v) => !x.includes(v)) });
function textDiff(a, b) {
  const la = a.split("\n"), lb = b.split("\n");
  const d = diffSets(la, lb);
  return [...d.gone.slice(0, 6).map((l) => `- ${l.slice(0, 120)}`), ...d.added.slice(0, 6).map((l) => `+ ${l.slice(0, 120)}`)];
}

async function main() {
  const o = args(process.argv.slice(2));
  const [A, B] = o.dirs;
  const names = readdirSync(A).filter((f) => f.endsWith(".json") && /-(desktop|phone)\.json$/.test(f)).map((f) => f.slice(0, -5)).sort();
  const { chromium } = await import(PLAYWRIGHT);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let bad = 0;
  const lines = [];
  for (const name of names) {
    if (!existsSync(join(B, `${name}.json`))) { bad++; lines.push(`${name}: missing in ${B}`); continue; }
    const ja = JSON.parse(readFileSync(join(A, `${name}.json`), "utf8")), jb = JSON.parse(readFileSync(join(B, `${name}.json`), "utf8"));
    const issues = [];
    const url = (d) => `data:image/png;base64,${readFileSync(join(d, `${name}.png`)).toString("base64")}`;
    const px = await pixelDiff(page, url(A), url(B), o.threshold);
    if (px.ratio > o.tolerance) {
      issues.push(`pixels: ${(px.ratio * 100).toFixed(3)}% differ${px.size ? ` (${px.size})` : ""}`);
      if (px.png) writeFileSync(join(B, `${name}.diff.png`), Buffer.from(px.png.split(",")[1], "base64"));
    }
    // Clock times the deck's server prints (the digest's "01:53 PM") follow its real clock, not the page's frozen one.
    const clock = (t) => t.replace(/\b\d{1,2}:\d{2}(?: ?[AP]M)?\b/g, "hh:mm");
    ja.text = clock(ja.text); jb.text = clock(jb.text);
    if (ja.text !== jb.text) issues.push(`text:\n      ${textDiff(ja.text, jb.text).join("\n      ")}`);
    const keep = (r) => !o.ignore || !o.ignore.test(r);
    const rq = diffSets(ja.requests.filter(keep), jb.requests.filter(keep));
    if (rq.gone.length || rq.added.length) issues.push(`requests:${rq.gone.map((r) => `\n      - ${r}`).join("")}${rq.added.map((r) => `\n      + ${r}`).join("")}`);
    const er = diffSets([...ja.errors, ...ja.console], [...jb.errors, ...jb.console]);
    if (er.added.length) issues.push(`new errors:${er.added.map((r) => `\n      + ${r}`).join("")}`);
    if (jb.errors.length) issues.push(`page errors in ${B}: ${jb.errors.length}`);
    if (issues.length) { bad++; lines.push(`${name}:\n  ${issues.join("\n  ")}`); }
  }
  await browser.close();
  console.log(lines.join("\n"));
  console.log(`\n${names.length} snapshots compared: ${names.length - bad} identical, ${bad} different (tolerance ${o.tolerance * 100}% of pixels, channel threshold ${o.threshold})`);
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error(`ui-compare: ${e.message ?? e}`); process.exit(2); });
