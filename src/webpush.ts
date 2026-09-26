// Web Push with nothing but WebCrypto: VAPID (RFC 8292) and aes128gcm payload encryption (RFC 8291, RFC 8188).
// The payload is encrypted for the device, so the push service (Apple, Google, Mozilla) only relays ciphertext.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const te = new TextEncoder();
export const b64u = (b: Uint8Array | ArrayBuffer) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
export const unb64u = (s: string) => new Uint8Array(Buffer.from(String(s).replace(/=+$/, ""), "base64url"));
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

export type Vapid = { publicKey: string; privateJwk: JsonWebKey; createdAt?: number };

export async function generateVapid(): Promise<Vapid> {
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { publicKey: b64u(raw), privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey), createdAt: Date.now() };
}

/** The deck's VAPID key pair: made once, kept in a mode-600 file. Changing it would orphan every subscription. */
export async function loadVapid(file: string): Promise<Vapid> {
  if (existsSync(file)) {
    try {
      const v = JSON.parse(readFileSync(file, "utf8"));
      if (v?.publicKey && v?.privateJwk?.d) { chmodSync(file, 0o600); return v; }
    } catch {}
  }
  const v = await generateVapid();
  writeFileSync(file, JSON.stringify(v, null, 1), { mode: 0o600 });
  chmodSync(file, 0o600);
  return v;
}

/** ES256 JWT for the push service at `aud` (its origin). WebCrypto's ECDSA signature is already JOSE's r||s form. */
export async function vapidJwt(aud: string, sub: string, privateJwk: JsonWebKey, expSec = Math.floor(Date.now() / 1000) + 12 * 3600) {
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(te.encode(JSON.stringify({ aud, exp: expSec, sub })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${head}.${body}`));
  return `${head}.${body}.${b64u(sig)}`;
}

async function hmac(key: Uint8Array, data: Uint8Array) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
/** HKDF with a single output block (every length here is ≤ 32 bytes). */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, len: number) {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
}

/** A P-256 ECDH private key from its raw parts (public point 0x04||x||y and scalar d). */
export async function ecdhPrivateKey(publicRaw: Uint8Array, d: Uint8Array) {
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", x: b64u(publicRaw.slice(1, 33)), y: b64u(publicRaw.slice(33, 65)), d: b64u(d), ext: true };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
const ecdhPublicKey = (raw: Uint8Array) => crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);

/** Content keys shared by encrypt and decrypt (RFC 8291 §3.3–3.4, RFC 8188 §2.2–2.3). */
async function contentKeys(ecdhSecret: Uint8Array, auth: Uint8Array, uaPublic: Uint8Array, asPublic: Uint8Array, salt: Uint8Array) {
  const ikm = await hkdf(auth, ecdhSecret, cat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  return { cek, nonce };
}

export type EncryptOpts = { salt?: Uint8Array; asPublic?: Uint8Array; asPrivate?: Uint8Array; rs?: number; pad?: number };

/**
 * One aes128gcm record for a subscription's p256dh / auth keys:
 * salt(16) | rs(4) | idlen(1)=65 | as_public(65) | AES-128-GCM(payload | 0x02 | padding).
 */
export async function encryptPayload(payload: Uint8Array | string, p256dh: string, auth: string, o: EncryptOpts = {}) {
  const plain = typeof payload === "string" ? te.encode(payload) : payload;
  const uaPublic = unb64u(p256dh);
  const authSecret = unb64u(auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("bad p256dh key");
  if (authSecret.length < 16) throw new Error("bad auth secret");
  let asPublic: Uint8Array, asKey: CryptoKey;
  if (o.asPublic && o.asPrivate) { asPublic = o.asPublic; asKey = await ecdhPrivateKey(o.asPublic, o.asPrivate); }
  else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    asKey = kp.privateKey;
  }
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await ecdhPublicKey(uaPublic) }, asKey, 256));
  const salt = o.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const rs = o.rs ?? 4096;
  const pad = o.pad ?? 0;
  if (plain.length + 1 + pad + 16 > rs) throw new Error(`payload too large (${plain.length} bytes)`);
  const { cek, nonce } = await contentKeys(secret, authSecret, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = cat(plain, new Uint8Array([2]), new Uint8Array(pad));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, record));
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = 65;
  return cat(header, asPublic, ct);
}

/** The device side, for tests and the local mock push service: undo encryptPayload with the subscription's private key. */
export async function decryptPayload(body: Uint8Array, uaPublic: Uint8Array, uaPrivate: Uint8Array, auth: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const uaKey = await ecdhPrivateKey(uaPublic, uaPrivate);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: await ecdhPublicKey(asPublic) }, uaKey, 256));
  const { cek, nonce } = await contentKeys(secret, auth, uaPublic, asPublic, salt);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const rec = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, key, ct));
  let end = rec.length - 1;
  while (end >= 0 && rec[end] === 0) end--;
  if (rec[end] !== 2) throw new Error("bad padding delimiter");
  return rec.slice(0, end);
}

export type PushSub = { endpoint: string; keys: { p256dh: string; auth: string } };
export type SendOpts = { ttl?: number; urgency?: "very-low" | "low" | "normal" | "high"; topic?: string; subject: string; fetch?: typeof fetch };
export type SendResult = { status: number; ok: boolean; gone: boolean; error?: string };

/** Encrypt and POST one message. `gone` means the subscription is dead (404/410) and should be dropped. */
export async function sendWebPush(sub: PushSub, payload: string, vapid: Vapid, o: SendOpts): Promise<SendResult> {
  const aud = new URL(sub.endpoint).origin;
  const jwt = await vapidJwt(aud, o.subject, vapid.privateJwk);
  const body = await encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  const headers: Record<string, string> = {
    authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(o.ttl ?? 6 * 3600),
    urgency: o.urgency ?? "normal",
  };
  if (o.topic) headers.topic = o.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
  try {
    const res = await (o.fetch ?? fetch)(sub.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(15_000) });
    const ok = res.status >= 200 && res.status < 300;
    const text = ok ? "" : (await res.text().catch(() => "")).slice(0, 300);
    return { status: res.status, ok, gone: res.status === 404 || res.status === 410, error: ok ? undefined : `${res.status} ${text}`.trim() };
  } catch (e: any) {
    return { status: 0, ok: false, gone: false, error: e?.message ?? String(e) };
  }
}
