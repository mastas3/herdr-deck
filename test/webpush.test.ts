import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { b64u, decryptPayload, encryptPayload, generateVapid, loadVapid, sendWebPush, unb64u, vapidJwt } from "../src/webpush";

// RFC 8291 Appendix A.
const V = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  message: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

/** A browser-like subscription: an ECDH key pair and an auth secret. */
async function fakeDevice() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const d = unb64u((await crypto.subtle.exportKey("jwk", kp.privateKey)).d!);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { pub, d, auth, keys: { p256dh: b64u(pub), auth: b64u(auth) } };
}

describe("RFC 8291 aes128gcm", () => {
  test("encrypting the RFC's inputs gives the RFC's message byte for byte", async () => {
    const out = await encryptPayload(unb64u(V.plaintext), V.uaPublic, V.auth, { salt: unb64u(V.salt), asPublic: unb64u(V.asPublic), asPrivate: unb64u(V.asPrivate) });
    expect(out.length).toBe(86 + 41 + 1 + 16); // header, payload, delimiter, tag
    expect(b64u(out)).toBe(V.message);
  });
  test("the RFC's message decrypts with the user agent's key", async () => {
    const plain = await decryptPayload(unb64u(V.message), unb64u(V.uaPublic), unb64u(V.uaPrivate), unb64u(V.auth));
    expect(new TextDecoder().decode(plain)).toBe("When I grow up, I want to be a watermelon");
  });
  test("round trip with fresh keys, padding and unicode", async () => {
    const dev = await fakeDevice();
    const msg = JSON.stringify({ title: "Needs you: “deck” ✓", body: "x".repeat(2000) });
    const body = await encryptPayload(msg, dev.keys.p256dh, dev.keys.auth, { pad: 37 });
    expect(body.subarray(16, 20)).toEqual(new Uint8Array([0, 0, 16, 0])); // rs = 4096
    expect(body[20]).toBe(65);
    expect(new TextDecoder().decode(await decryptPayload(body, dev.pub, dev.d, dev.auth))).toBe(msg);
  });
  test("a different device can't read it", async () => {
    const a = await fakeDevice(), b = await fakeDevice();
    const body = await encryptPayload("secret", a.keys.p256dh, a.keys.auth);
    await expect(decryptPayload(body, b.pub, b.d, b.auth)).rejects.toThrow();
  });
  test("oversized payloads are refused", async () => {
    const dev = await fakeDevice();
    await expect(encryptPayload("x".repeat(5000), dev.keys.p256dh, dev.keys.auth)).rejects.toThrow(/too large/);
  });
});

async function verifyJwt(jwt: string, publicKey: string) {
  const [h, p, s] = jwt.split(".");
  const key = await crypto.subtle.importKey("raw", unb64u(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, unb64u(s), new TextEncoder().encode(`${h}.${p}`));
  return { ok, header: JSON.parse(new TextDecoder().decode(unb64u(h))), claims: JSON.parse(new TextDecoder().decode(unb64u(p))) };
}

describe("VAPID", () => {
  test("the JWT verifies with the public key and carries aud, sub and a short exp", async () => {
    const v = await generateVapid();
    expect(unb64u(v.publicKey).length).toBe(65);
    const jwt = await vapidJwt("https://web.push.apple.com", "mailto:someone@example.com", v.privateJwk);
    const r = await verifyJwt(jwt, v.publicKey);
    expect(r.ok).toBe(true);
    expect(r.header).toEqual({ typ: "JWT", alg: "ES256" });
    expect(r.claims.aud).toBe("https://web.push.apple.com");
    expect(r.claims.sub).toBe("mailto:someone@example.com");
    const left = r.claims.exp - Date.now() / 1000;
    expect(left).toBeGreaterThan(11 * 3600);
    expect(left).toBeLessThanOrEqual(12 * 3600);
  });
  test("a tampered JWT doesn't verify", async () => {
    const v = await generateVapid();
    const jwt = await vapidJwt("https://fcm.googleapis.com", "mailto:a@b.c", v.privateJwk);
    const [h, , s] = jwt.split(".");
    const forged = `${h}.${b64u(new TextEncoder().encode(JSON.stringify({ aud: "https://evil.example", exp: 1, sub: "x" })))}.${s}`;
    expect((await verifyJwt(forged, v.publicKey)).ok).toBe(false);
  });
  test("the key file is made once, mode 600, and reused", async () => {
    const dir = mkdtempSync(`${tmpdir()}/vapid-`);
    const a = await loadVapid(`${dir}/push.json`);
    const b = await loadVapid(`${dir}/push.json`);
    expect(b.publicKey).toBe(a.publicKey);
    expect(statSync(`${dir}/push.json`).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(`${dir}/push.json`, "utf8")).privateJwk.d).toBeTruthy();
  });
});

describe("sending to a push service", () => {
  test("a local mock push service gets a verifiable JWT and a payload it can decrypt", async () => {
    const v = await generateVapid();
    const dev = await fakeDevice();
    let seen: any;
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      const m = auth.match(/^vapid t=([^,]+), k=(.+)$/);
      const jwt = m ? await verifyJwt(m[1], m[2]) : undefined;
      const plain = await decryptPayload(new Uint8Array(await req.arrayBuffer()), dev.pub, dev.d, dev.auth);
      seen = { jwt, k: m?.[2], text: new TextDecoder().decode(plain), enc: req.headers.get("content-encoding"), ttl: req.headers.get("ttl"), urgency: req.headers.get("urgency"), topic: req.headers.get("topic") };
      return new Response(null, { status: 201 });
    } });
    const port = srv.port;
    const endpoint = `http://127.0.0.1:${port}/push/abc`;
    const r = await sendWebPush({ endpoint, keys: dev.keys }, JSON.stringify({ title: "hi" }), v, { subject: "mailto:a@b.c", ttl: 60, urgency: "high", topic: "s:mac/p1!" });
    srv.stop(true);
    expect(r).toEqual({ status: 201, ok: true, gone: false, error: undefined });
    expect(seen.jwt.ok).toBe(true);
    expect(seen.jwt.claims.aud).toBe(`http://127.0.0.1:${port}`);
    expect(seen.k).toBe(v.publicKey);
    expect(JSON.parse(seen.text)).toEqual({ title: "hi" });
    expect(seen.enc).toBe("aes128gcm");
    expect(seen.ttl).toBe("60");
    expect(seen.urgency).toBe("high");
    expect(seen.topic).toBe("smacp1");
  });
  test("404 and 410 mean the subscription is gone; 500 doesn't", async () => {
    const v = await generateVapid();
    const dev = await fakeDevice();
    for (const [status, gone] of [[410, true], [404, true], [500, false]] as const) {
      const r = await sendWebPush({ endpoint: "https://push.example/x", keys: dev.keys }, "{}", v, { subject: "mailto:a@b.c", fetch: (async () => new Response("nope", { status })) as any });
      expect(r.gone).toBe(gone);
      expect(r.ok).toBe(false);
    }
  });
});
