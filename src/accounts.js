import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Accounts for the hosted site. A person signs in with Google, and their
// settings (the RunPod and Anthropic keys, the rented machine) are kept in
// a file of their own, encrypted with a secret the server holds. Nothing a
// person types into a model or gets back from one is stored here; the
// account only remembers keys and the machine, so the next visit is quick.
//
// Sessions are a signed token in an httpOnly cookie that carries only the
// user id. No dependencies: the Google ID token is checked against Google's
// published keys with node:crypto.
//
// A guest is an account without a person: made the moment a visitor enters
// a key without signing in, kept the same way, and swept away GUEST_HOURS
// after its last use. Signing in later adopts a guest's keys and machine.

export const SESSION_COOKIE = "hf_session";
const SESSION_DAYS = 30;
// A guest keeps keys without signing in, for this long after their last
// use; then the machine is stopped and the keys are forgotten.
export const GUEST_HOURS = 12;
const GOOGLE_JWKS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

export function createAccounts({ dir, secret, sessionSecret = secret, googleClientId = "", jwksUrl = GOOGLE_JWKS, fetchImpl = fetch, now = Date.now, production = process.env.NODE_ENV === "production" }) {
  if (!secret || secret.length < 16) throw new Error("Accounts need a secret of at least 16 characters (ACCOUNTS_SECRET).");
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash("sha256").update(secret).digest();
  const indexFile = path.join(dir, "index.json");
  let jwks = { at: 0, keys: [] };

  const readJson = (file, fallback) => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return fallback;
    }
  };
  // Written whole and renamed into place, so a crash never leaves half a file.
  const writeJson = (file, data) => {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  const userFile = (id) => path.join(dir, `${id}.json`);
  const index = () => readJson(indexFile, {});
  const validId = (id) => /^g?[a-f0-9]{24}$/.test(String(id));
  const listIds = () => fs.readdirSync(dir).filter((f) => /^g?[a-f0-9]{24}\.json$/.test(f)).map((f) => f.slice(0, -5));

  function encrypt(obj) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }
  function decrypt(text) {
    if (!text) return {};
    const buf = Buffer.from(text, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8"));
  }

  const b64url = (buf) => Buffer.from(buf).toString("base64url");
  const sign = (text) => crypto.createHmac("sha256", sessionSecret).update(text).digest("base64url");

  return {
    googleConfigured: () => Boolean(googleClientId),
    googleClientId: () => googleClientId,

    // ---- users -------------------------------------------------------------
    findOrCreate({ email, name = null, picture = null }) {
      const lower = String(email).trim().toLowerCase();
      if (!lower) throw new AuthError("No email address.", 400);
      const ids = index();
      let user = ids[lower] ? readJson(userFile(ids[lower]), null) : null;
      if (user) {
        if ((!user.name && name) || (!user.picture && picture)) {
          user = { ...user, name: user.name ?? name, picture: user.picture ?? picture };
          writeJson(userFile(user.id), user);
        }
        return publicUser(user);
      }
      user = { id: crypto.randomBytes(12).toString("hex"), email: lower, name, picture, createdAt: new Date(now()).toISOString(), settings: encrypt({}) };
      writeJson(userFile(user.id), user);
      writeJson(indexFile, { ...ids, [lower]: user.id });
      return publicUser(user);
    },
    get(id) {
      if (!validId(id)) return null;
      const user = readJson(userFile(id), null);
      if (!user) return null;
      if (user.guest && !(user.expiresAt > now())) return null;
      return publicUser(user);
    },
    remove(id) {
      if (!validId(id)) return false;
      const user = readJson(userFile(id), null);
      if (!user) return false;
      fs.rmSync(userFile(id), { force: true });
      if (user.email) {
        const ids = index();
        delete ids[user.email];
        writeJson(indexFile, ids);
      }
      return true;
    },

    // ---- guests ------------------------------------------------------------
    guest() {
      const user = { id: `g${crypto.randomBytes(12).toString("hex")}`, guest: true, createdAt: new Date(now()).toISOString(), expiresAt: now() + GUEST_HOURS * 3600e3, settings: encrypt({}) };
      writeJson(userFile(user.id), user);
      return publicUser(user);
    },
    // Each use pushes a guest's expiry back; a person who keeps coming back keeps their keys.
    extend(id) {
      const user = validId(id) ? readJson(userFile(id), null) : null;
      if (!user?.guest) return null;
      user.expiresAt = now() + GUEST_HOURS * 3600e3;
      writeJson(userFile(id), user);
      return user.expiresAt;
    },
    expiredGuests() {
      return listIds().filter((id) => {
        const user = readJson(userFile(id), null);
        return user?.guest && !(user.expiresAt > now());
      });
    },
    // A guest who signs in keeps what they had: the keys and the machine
    // move to the account wherever the account has none of its own.
    adopt(guestId, userId) {
      const from = this.settings(guestId);
      const user = readJson(userFile(userId), null);
      if (!user) return false;
      const into = this.settings(userId);
      const merged = { ...into };
      for (const [k, v] of Object.entries(from)) if (!(k in merged)) merged[k] = v;
      writeJson(userFile(userId), { ...user, settings: encrypt(merged) });
      this.remove(guestId);
      return true;
    },

    // ---- each user's settings, encrypted at rest ----------------------------
    settings(id) {
      const user = readJson(userFile(id), null);
      if (!user) return {};
      try {
        return decrypt(user.settings);
      } catch {
        // A changed secret makes old settings unreadable; they start over.
        return {};
      }
    },
    saveSettings(id, updates) {
      const user = readJson(userFile(id), null);
      if (!user) throw new AuthError("No such account.", 404);
      const current = this.settings(id);
      for (const [k, v] of Object.entries(updates)) {
        if (v === "" || v === null || v === undefined) delete current[k];
        else current[k] = String(v);
      }
      writeJson(userFile(id), { ...user, settings: encrypt(current) });
      return current;
    },
    // Accounts that have a machine rented, so the idle watch can cover them
    // after a restart.
    withPods() {
      return listIds().filter((id) => this.settings(id).RUNPOD_POD_ID);
    },

    // ---- sessions ----------------------------------------------------------
    issue(userId) {
      const payload = b64url(JSON.stringify({ sub: userId, exp: now() + SESSION_DAYS * 86400e3 }));
      return `${payload}.${sign(payload)}`;
    },
    verify(token) {
      const [payload, sig] = String(token ?? "").split(".");
      if (!payload || !sig) return null;
      const expected = sign(payload);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      try {
        const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
        if (!data.sub || !(data.exp > now())) return null;
        return data.sub;
      } catch {
        return null;
      }
    },
    cookie(token) {
      const attrs = [`${SESSION_COOKIE}=${token}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${SESSION_DAYS * 86400}`];
      if (production) attrs.push("Secure");
      return attrs.join("; ");
    },
    clearCookie() {
      return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${production ? "; Secure" : ""}`;
    },
    userFromRequest(req) {
      const raw = String(req.headers.cookie ?? "");
      const m = raw.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
      if (!m) return null;
      const id = this.verify(m[1]);
      return id ? this.get(id) : null;
    },

    // ---- Sign in with Google ------------------------------------------------
    // The browser's Google widget hands over an ID token: a JWT signed by
    // Google. Its signature is checked against Google's published keys, and
    // its audience must be this site's client id, before the email inside
    // it is believed.
    async verifyGoogle(credential) {
      if (!googleClientId) throw new AuthError("Google sign-in is not set up on this server.", 503);
      const parts = String(credential ?? "").split(".");
      if (parts.length !== 3) throw new AuthError("That is not a Google sign-in token.", 400);
      let header;
      let payload;
      try {
        header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
        payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      } catch {
        throw new AuthError("That is not a Google sign-in token.", 400);
      }
      if (header.alg !== "RS256") throw new AuthError("Unexpected token signature.", 400);
      const jwk = await googleKey(header.kid);
      if (!jwk) throw new AuthError("Google's signing key was not found; try again.", 401);
      const ok = crypto.verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(parts[2], "base64url"));
      if (!ok) throw new AuthError("The Google sign-in token is not valid.", 401);
      if (payload.aud !== googleClientId) throw new AuthError("That token was issued for a different site.", 401);
      if (!GOOGLE_ISSUERS.has(payload.iss)) throw new AuthError("That token was not issued by Google.", 401);
      if (!(Number(payload.exp) * 1000 > now())) throw new AuthError("The Google sign-in token has expired; try again.", 401);
      if (!payload.email || payload.email_verified !== true) throw new AuthError("The Google account has no verified email address.", 401);
      return { email: payload.email, name: payload.name ?? null, picture: payload.picture ?? null };
    },
  };

  async function googleKey(kid) {
    const fresh = now() - jwks.at < 3600e3;
    let hit = fresh ? jwks.keys.find((k) => k.kid === kid) : null;
    if (hit) return hit;
    const res = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new AuthError("Could not reach Google to check the sign-in.", 502);
    jwks = { at: now(), keys: (await res.json()).keys ?? [] };
    hit = jwks.keys.find((k) => k.kid === kid);
    return hit ?? null;
  }
}

function publicUser(user) {
  if (user.guest) return { id: user.id, guest: true, email: null, name: "Guest", picture: null, createdAt: user.createdAt, expiresAt: user.expiresAt };
  return { id: user.id, guest: false, email: user.email, name: user.name ?? null, picture: user.picture ?? null, createdAt: user.createdAt };
}
