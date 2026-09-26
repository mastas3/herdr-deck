"""Founder Library bridge: the one process that owns the library's Chroma store.

The deck (src/library-bridge.ts) starts it on demand and talks to it over HTTP on 127.0.0.1 with a per-run token.
It reuses the user's yt-transcriber project for everything YouTube: channel enumeration, caption fetching, the
channel orchestrator (resume state + transcript.json) and the per-channel Chroma corpus (nomic-embed-text).

Why one process: a second Chroma client in another process sees new rows in count() but keeps querying its old
in-memory vector index, so searches would miss freshly ingested videos. Ingest and search both go through here.

The library's store is its own directory (<library>/chroma), never yt-transcriber's rag_store: the Vikram corpus
there is never opened by this bridge.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

IDLE_EXIT_S = 45 * 60
WEB_COLLECTION = "web-pages"
WEB_CHUNK_CHARS = 1200

ap = argparse.ArgumentParser()
ap.add_argument("--dir", required=True, help="library directory (~/.config/herdr-deck/library)")
ap.add_argument("--yt", required=True, help="yt-transcriber project directory")
args = ap.parse_args()

LIB = Path(args.dir).expanduser().resolve()
YT = Path(args.yt).expanduser().resolve()
LIB.mkdir(parents=True, exist_ok=True)
# A newer yt-dlp installed only for the library (pip --target <library>/pydeps) wins over the project's own:
# YouTube changes often, and an old yt-dlp enumerates fewer videos and no view counts.
if (LIB / "pydeps").is_dir():
    sys.path.insert(0, str(LIB / "pydeps"))
sys.path.insert(1, str(YT))

from rag_corpus import ChannelCorpus, OllamaEmbedding, chunk_transcript  # noqa: E402

CHROMA = LIB / "chroma"
state = {"last": time.time(), "transcriber": None}
ingest_lock = threading.Lock()
corpora: dict[str, ChannelCorpus] = {}
corpora_lock = threading.Lock()
embedder = OllamaEmbedding()


def corpus(channel_id: str) -> ChannelCorpus:
    with corpora_lock:
        c = corpora.get(channel_id)
        if c is None:
            c = ChannelCorpus(channel_id=channel_id, persist_root=CHROMA)
            corpora[channel_id] = c
        return c


def transcriber():
    """yt-transcriber's YouTubeTranscriber, with Whisper loaded only if a video really has no captions.

    Its constructor loads Whisper large-v3-turbo (about 40 s and 1.5 GB) even when every video has captions.
    """
    if state["transcriber"] is None:
        import transcribe as T

        real = T.WhisperModel

        class LazyWhisper:
            def __init__(self, *a, **k):
                self._a, self._k, self._m = a, k, None

            def __getattr__(self, name):
                if self._m is None:
                    self._m = real(*self._a, **self._k)
                return getattr(self._m, name)

        T.WhisperModel = LazyWhisper
        remember_meta(T.yt_dlp.YoutubeDL)
        state["transcriber"] = T.YouTubeTranscriber(cache_dir=str(LIB / "cache"), skip_speakers=True, use_local_llm=True)
    return state["transcriber"]


seen_meta: dict[str, dict] = {}


def remember_meta(cls) -> None:
    """Keep the publish date, length and views yt-transcriber's caption lookup already fetched (no extra request)."""
    real = cls.extract_info
    if getattr(real, "_remembers", False):
        return

    def extract_info(self, url, *a, **k):
        info = real(self, url, *a, **k)
        if isinstance(info, dict) and info.get("id") and (info.get("upload_date") or info.get("release_timestamp")):
            ts = info.get("release_timestamp") or info.get("timestamp")
            up = str(info.get("upload_date") or "")
            date = f"{up[:4]}-{up[4:6]}-{up[6:8]}" if len(up) == 8 else time.strftime("%Y-%m-%d", time.gmtime(ts)) if ts else None
            seen_meta[info["id"]] = {"date": date, "duration": info.get("duration"), "views": info.get("view_count")}
        return info

    extract_info._remembers = True
    cls.extract_info = extract_info


# ── YouTube: enumerate ────────────────────────────────────────────────────────────


def flat_entry(e: dict) -> dict | None:
    if not e or not e.get("id"):
        return None
    return {
        "video_id": e["id"], "url": f"https://www.youtube.com/watch?v={e['id']}", "title": e.get("title") or "(untitled)",
        "duration_s": int(e["duration"]) if e.get("duration") else None, "view_count": e.get("view_count"),
        "upload_date": e.get("upload_date"), "channel": e.get("channel") or e.get("uploader"),
    }


def enumerate_source(body: dict) -> dict:
    kind, url = body.get("kind"), str(body.get("url") or "")
    if kind == "channel":
        from channel_enumerator import enumerate_channel

        r = enumerate_channel(url, limit=body.get("limit"), include_shorts=bool(body.get("shorts")))
        for i, v in enumerate(r["videos"]):
            v["order"] = i  # the channel tab lists newest first
        return r
    from yt_dlp import YoutubeDL

    opts = {"extract_flat": "in_playlist", "skip_download": True, "quiet": True, "no_warnings": True, "ignoreerrors": True}
    videos = []
    title = None
    urls = body.get("urls") or [url]
    for u in urls:
        with YoutubeDL(opts) as ydl:
            info = ydl.extract_info(u, download=False) or {}
        entries = info.get("entries") if info.get("entries") is not None else [info]
        title = title or info.get("title")
        for e in entries:
            v = flat_entry(e or {})
            if v:
                v["order"] = len(videos)
                videos.append(v)
    return {"channel_title": title, "videos": videos}


# ── YouTube: ingest one video ────────────────────────────────────────────────────


def ingest_video(body: dict) -> dict:
    """Captions first (seconds), Whisper only when allowed. Then yt-transcriber's orchestrator chunks and embeds."""
    from channel_orchestrator import ChannelOrchestrator

    cid = body["channel_id"]
    v = body["video"]
    vid = v["video_id"]
    out = LIB / "channels" / cid
    vdir = out / f"video_{vid}"
    tjson = vdir / f"{vid}_transcript.json"
    with ingest_lock:
        t = transcriber()
        segments = None
        if not tjson.exists():
            vdir.mkdir(parents=True, exist_ok=True)
            old = t.cache_dir
            t.cache_dir = vdir
            try:
                segments = t.fetch_youtube_subtitles(v["url"])
            finally:
                t.cache_dir = old
            for f in vdir.glob("*.vtt"):
                f.unlink(missing_ok=True)
            if segments:
                ChannelOrchestrator._save_transcript_json(tjson, vid, v["url"], v.get("title") or "", segments)
            elif not body.get("whisper"):
                return {"status": "no_captions"}
        orch = ChannelOrchestrator(t, corpus(cid), {"channel_id": cid}, out)
        # With transcript.json on disk the orchestrator re-ingests from it; without (Whisper allowed) it downloads.
        s = orch.run([{"video_id": vid, "url": v["url"], "title": v.get("title")}], {"transcript_only": True})
        st = orch._state.get("videos", {}).get(vid, {})
        if s["failed"]:
            return {"status": "failed", "error": st.get("error") or "ingest failed"}
        n = st.get("chunks") or corpus(cid).count_video(vid)
        segs = len(segments) if segments else None
        return {"status": "ingested", "chunks": n, "segments": segs, "transcript": str(tjson), "skipped": bool(s["skipped"]), "meta": seen_meta.pop(vid, None)}


# ── web pages (fetched politely by the deck; only their text arrives here) ───────


def ingest_text(body: dict) -> dict:
    text = re.sub(r"\s+", " ", str(body.get("text") or "")).strip()
    url, title = str(body["url"]), str(body.get("title") or body["url"])
    doc_id = re.sub(r"[^A-Za-z0-9_-]", "-", str(body["id"]))[:60]
    # Paragraph-ish pieces as pseudo-segments: chunk_transcript then sizes them like transcripts (no timestamps).
    pieces = [text[i:i + WEB_CHUNK_CHARS] for i in range(0, len(text), WEB_CHUNK_CHARS)]
    c = corpus(WEB_COLLECTION)
    c.delete_video(doc_id)
    ids, docs, metas = [], [], []
    for i, p in enumerate(pieces[:200]):
        ids.append(f"{doc_id}:web:{i}")
        docs.append(p)
        metas.append({"channel_id": WEB_COLLECTION, "video_id": doc_id, "video_title": title, "video_url": url, "start_time_s": 0,
                      "end_time_s": 0, "chunk_type": "web", "chunk_seq": i, "is_synthesis": False,
                      "source_url_with_timestamp": url, "ingested_at": int(time.time())})
    if ids:
        c._collection.upsert(ids=ids, documents=docs, metadatas=metas)
    return {"status": "ingested", "chunks": len(ids)}


# ── search ─────────────────────────────────────────────────────────────────────


def collections() -> list[str]:
    import chromadb

    client = chromadb.PersistentClient(path=str(CHROMA))
    return [c.name if hasattr(c, "name") else str(c) for c in client.list_collections()]


def search(body: dict) -> dict:
    q = str(body.get("q") or "").strip()
    k = max(1, min(50, int(body.get("k") or 8)))
    if not q:
        return {"hits": []}
    only = set(body.get("channels") or [])
    t0 = time.time()
    # nomic-embed-text wants a task prefix; the corpus was embedded without one, so the query goes without too.
    emb = embedder([q])[0]
    hits = []
    import chromadb

    client = chromadb.PersistentClient(path=str(CHROMA))
    for col in client.list_collections():
        name = col.name if hasattr(col, "name") else str(col)
        cid = name[len("channel_"):] if name.startswith("channel_") else name
        if only and cid not in only:
            continue
        coll = client.get_collection(name)
        if coll.count() == 0:
            continue
        r = coll.query(query_embeddings=[emb], n_results=min(k, coll.count()))
        for i, doc in enumerate((r.get("documents") or [[]])[0]):
            md = (r.get("metadatas") or [[]])[0][i] or {}
            d = (r.get("distances") or [[]])[0][i]
            hits.append({"id": (r.get("ids") or [[]])[0][i], "score": None if d is None else round(1.0 - d, 4), "text": doc, **md})
    hits.sort(key=lambda h: -(h["score"] or 0))
    return {"hits": hits[:k], "ms": int((time.time() - t0) * 1000)}


def counts(_body: dict) -> dict:
    import chromadb

    client = chromadb.PersistentClient(path=str(CHROMA))
    out = {}
    for col in client.list_collections():
        name = col.name if hasattr(col, "name") else str(col)
        out[name[len("channel_"):] if name.startswith("channel_") else name] = client.get_collection(name).count()
    return {"counts": out}


ROUTES = {"/enumerate": enumerate_source, "/ingest": ingest_video, "/ingest-text": ingest_text, "/search": search, "/counts": counts,
          "/health": lambda b: {"ok": True, "pid": os.getpid()}}
TOKEN = secrets.token_hex(16)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        state["last"] = time.time()
        if self.headers.get("x-token") != TOKEN or self.path not in ROUTES:
            self.send_response(403)
            self.end_headers()
            return
        try:
            n = int(self.headers.get("content-length") or 0)
            body = json.loads(self.rfile.read(n) or b"{}")
            res, code = ROUTES[self.path](body), 200
        except Exception as e:  # the deck shows the message; the bridge keeps running
            res, code = {"error": f"{type(e).__name__}: {e}"[:500]}, 500
        data = json.dumps(res, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def idle_watch(server):
    while True:
        time.sleep(30)
        if time.time() - state["last"] > IDLE_EXIT_S and not ingest_lock.locked():
            server.shutdown()
            return


if __name__ == "__main__":
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    info = {"pid": os.getpid(), "port": srv.server_address[1], "token": TOKEN, "started": int(time.time())}
    tmp = LIB / f"bridge.json.{os.getpid()}"
    tmp.write_text(json.dumps(info))
    os.chmod(tmp, 0o600)
    os.replace(tmp, LIB / "bridge.json")
    threading.Thread(target=idle_watch, args=(srv,), daemon=True).start()
    print(json.dumps({"ready": True, **{k: v for k, v in info.items() if k != "token"}}), flush=True)
    try:
        srv.serve_forever()
    finally:
        try:
            if json.loads((LIB / "bridge.json").read_text()).get("pid") == os.getpid():
                (LIB / "bridge.json").unlink()
        except Exception:
            pass
