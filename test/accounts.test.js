import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { startStubOllama } from "./stub-ollama.js";
import { KEY, startStubRunpod } from "./stub-runpod.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-accounts-"));
const { createServer } = await import("../src/server.js");
const { createAccounts, SESSION_COOKIE } = await import("../src/accounts.js");

// Accounts on the hosted site: Google sign-in checked against Google's
// keys (a stand-in here), settings encrypted at rest, one rented machine
// per account that the browser talks to directly, and runs that only their
// owner can follow.

const CLIENT = "test-client-id.apps.googleusercontent.com";
const SECRET = "test-accounts-secret-0123456789";
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
const b64url = (s) => Buffer.from(s).toString("base64url");
function idToken(overrides = {}, { kid = "k1", key = privateKey } = {}) {
  const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({ iss: "https://accounts.google.com", aud: CLIENT, exp: Math.floor(Date.now() / 1000) + 3600, email: "ana@example.com", email_verified: true, name: "Ana", picture: "https://img.example/ana.png", ...overrides }));
  const sig = crypto.sign("sha256", Buffer.from(`${header}.${payload}`), key).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

let jwks;
let stub;
let runpod;
let ollama;
let server;
let base;
const home = process.env.HUGGINGFOUND_HOME;
const dead = "http://127.0.0.1:1";
const QWEN = "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF";
const PULLED = `hf.co/${QWEN}:Q4_K_M`;

before(async () => {
  jwks = http.createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise((r) => jwks.listen(0, "127.0.0.1", r));
  stub = await startStubHub();
  runpod = await startStubRunpod();
  ollama = await startStubOllama();
  server = createServer({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, hosted: true, refreshHours: 0, accountsDir: path.join(home, "accounts"), accountsSecret: SECRET, googleClientId: CLIENT, googleJwks: `http://127.0.0.1:${jwks.address().port}/certs`, runpodBase: runpod.base, runpodProxy: () => ollama.url, idleWatch: false, siteOrigin: "https://huggingfound.test" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
  runpod.server.close();
  ollama.server.close();
  jwks.close();
});

const get = (p, cookie = "") => fetch(base + p, { headers: cookie ? { Cookie: cookie } : {} });
const post = (p, body, cookie = "") => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const json = async (p, cookie = "") => (await get(p, cookie)).json();
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

test("the account store encrypts settings at rest and signs sessions", () => {
  const dir = path.join(home, "unit-accounts");
  const accounts = createAccounts({ dir, secret: SECRET, googleClientId: CLIENT, production: true });
  const user = accounts.findOrCreate({ email: "Bo@Example.com", name: "Bo" });
  assert.equal(user.email, "bo@example.com");
  assert.deepEqual(accounts.findOrCreate({ email: "bo@example.com" }), user, "the same person again");
  accounts.saveSettings(user.id, { RUNPOD_API_KEY: KEY, RUNPOD_IDLE_MINUTES: "20" });
  const raw = fs.readFileSync(path.join(dir, `${user.id}.json`), "utf8");
  assert.doesNotMatch(raw, new RegExp(KEY), "the key is not readable in the file");
  assert.equal(accounts.settings(user.id).RUNPOD_API_KEY, KEY);
  accounts.saveSettings(user.id, { RUNPOD_IDLE_MINUTES: "" });
  assert.equal(accounts.settings(user.id).RUNPOD_IDLE_MINUTES, undefined, "an empty value removes the setting");
  assert.deepEqual(accounts.withPods(), []);
  accounts.saveSettings(user.id, { RUNPOD_POD_ID: "podx" });
  assert.deepEqual(accounts.withPods(), [user.id]);
  const token = accounts.issue(user.id);
  assert.equal(accounts.verify(token), user.id);
  assert.equal(accounts.verify(token.slice(0, -2) + "xx"), null, "a tampered token is nobody");
  assert.equal(accounts.verify(""), null);
  assert.match(accounts.cookie(token), new RegExp(`^${SESSION_COOKIE}=.*HttpOnly.*SameSite=Lax.*Secure`));
  assert.equal(accounts.userFromRequest({ headers: { cookie: `other=1; ${SESSION_COOKIE}=${token}` } }).id, user.id);
  // A different secret cannot read the settings, and does not crash.
  const other = createAccounts({ dir, secret: "another-secret-0123456789", googleClientId: CLIENT });
  assert.deepEqual(other.settings(user.id), {});
  assert.equal(accounts.remove(user.id), true);
  assert.equal(accounts.get(user.id), null);
  assert.throws(() => createAccounts({ dir, secret: "short" }), /at least 16/);
});

test("a visitor who is not signed in sees how to sign in and cannot touch keys or machines", async () => {
  const s = await json("/api/state");
  assert.equal(s.user, null);
  assert.deepEqual(s.auth, { google: CLIENT, ready: true, guestHours: 12 });
  assert.equal(s.rental, null);
  assert.equal(s.chatServer, null);
  for (const p of ["/api/settings", "/api/rent", "/api/run"]) assert.equal((await post(p, {})).status, 401, p);
  assert.equal((await get("/api/rent")).status, 401);
});

test("Google sign-in checks the token against Google's keys and this site's client id", async () => {
  for (const [bad, why] of [
    [idToken({ aud: "someone-else" }), /different site/],
    [idToken({ iss: "https://evil.example" }), /not issued by Google/],
    [idToken({ exp: Math.floor(Date.now() / 1000) - 10 }), /expired/],
    [idToken({ email_verified: false }), /verified email/],
    [idToken({}, { key: crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey }), /not valid/],
    [idToken({}, { kid: "unknown" }), /signing key was not found/],
    ["not.a.token.at.all", /not a Google sign-in token/],
  ]) {
    const res = await post("/api/auth/google", { credential: bad });
    assert.ok([400, 401].includes(res.status), why);
    assert.match((await res.json()).error, why);
  }
  const res = await post("/api/auth/google", { credential: idToken() });
  assert.equal(res.status, 200);
  const cookie = cookieOf(res);
  assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(res.headers.get("set-cookie"), /HttpOnly/);
  const s = await json("/api/state", cookie);
  assert.deepEqual(s.user, { email: "ana@example.com", name: "Ana", picture: "https://img.example/ana.png", guest: false, expiresAt: null });
  assert.deepEqual(s.rental, { rented: false });
  assert.equal(s.runpodKey, "");
  assert.equal(s.claudeReady, false);
  const out = await post("/api/auth/logout", {}, cookie);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
});

let ana;
let ben;

test("a signed-in person keeps only their own keys, and the hosted settings refuse the app's", async () => {
  ana = cookieOf(await post("/api/auth/google", { credential: idToken() }));
  ben = cookieOf(await post("/api/auth/google", { credential: idToken({ email: "ben@example.com", name: "Ben", picture: null }) }));
  assert.notEqual(ana, ben);
  assert.equal((await post("/api/settings", { HF_TOKEN: "hf_abc" }, ana)).status, 400);
  assert.equal((await post("/api/settings", { OLLAMA_SERVER: "http://x", OLLAMA_SERVER_GB: "24" }, ana)).status, 400, "no hand-set servers on the site");
  assert.equal((await post("/api/settings", { RUNPOD_API_KEY: KEY, ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" }, ana)).status, 200);
  const s = await json("/api/state", ana);
  assert.match(s.runpodKey, /^rpa_\*+cdef$/);
  assert.match(s.claudeKey, /^sk-a\*+wxyz$/);
  assert.equal(s.claudeReady, true);
  assert.equal(s.claudeHosted.saved, true);
  const b = await json("/api/state", ben);
  assert.equal(b.runpodKey, "", "Ben sees nothing of Ana's");
  assert.equal((await json("/api/rent/options", ben)).configured, false);
  assert.equal((await json("/api/rent/options", ana)).configured, true);
});

test("renting from the site makes a machine the browser may talk to directly, and only its owner sees it", async () => {
  const res = await post("/api/rent", { gb: 24, diskGb: 50 }, ana);
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.status, "PROVISIONING");
  const made = runpod.state.created.at(-1);
  assert.equal(made.env.OLLAMA_ORIGINS, "https://huggingfound.test", "Ollama on the machine accepts this site's pages");
  const s = await json("/api/state", ana);
  assert.deepEqual(s.chatServer, { url: ollama.url, gpuGb: 24, comfortableGb: 21, rented: true, direct: true });
  assert.equal(s.rental.id, r.id);
  assert.equal(s.runners.ollama.remote, ollama.url);
  const b = await json("/api/state", ben);
  assert.equal(b.chatServer, null);
  assert.deepEqual(b.rental, { rented: false });
  assert.equal((await post("/api/rent/stop", {}, ben)).status, 404, "Ben has nothing to stop");
  assert.equal((await post("/api/rent", { gb: 24 }, ben)).status, 400, "Ben has no key");
  assert.equal(server.rentals.size, 2);
});

test("a chat model's plan can be for the rented machine or for the visitor's own computer", async () => {
  await json("/api/rent", ana);
  await json("/api/rent", ana);
  const rented = await json(`/api/model?id=${QWEN}`, ana);
  assert.equal(rented.choice.where, "rented");
  assert.equal(rented.choice.rented, true);
  assert.equal(rented.choice.tier, 24);
  assert.equal(rented.choice.hasRunpodKey, true);
  assert.equal(rented.plan.steps.length, 1);
  assert.equal(rented.plan.remote, ollama.url);
  assert.match(rented.plan.fit.text, /server's 24 GB GPU/);
  const local = await json(`/api/model?id=${QWEN}&where=local`, ana);
  assert.equal(local.choice.where, "local");
  assert.ok(local.plan.steps.length >= 3);
  assert.equal(local.plan.remote, undefined);
  assert.match(local.plan.fit.text, /laptop/);
  const nobody = await json(`/api/model?id=${QWEN}`);
  assert.deepEqual(nobody.choice, { where: "local", rented: false, tier: 24, hasRunpodKey: false });
  const bens = await json(`/api/model?id=${QWEN}&where=rented`, ben);
  assert.equal(bens.choice.where, "local", "asking for a machine he has not rented gives the local plan");
  const image = await json("/api/model?id=second-state/stable-diffusion-v1-5-GGUF", ana);
  assert.equal(image.choice, null, "only chat models have the choice");
});

test("the download onto the rented machine is the one run the site does, and its log is its owner's", async () => {
  assert.equal((await post("/api/run", { kind: "install-ollama" }, ana)).status, 403);
  assert.equal((await post("/api/run", { kind: "pull-model", args: { name: PULLED } }, ben)).status, 403, "no machine, no download");
  const res = await post("/api/run", { kind: "pull-model", args: { name: PULLED } }, ana);
  assert.equal(res.status, 200);
  const { id } = await res.json();
  assert.match(id, /^[a-f0-9]{16}$/, "ids cannot be guessed by counting");
  assert.equal((await get(`/api/runs/${id}`, ben)).status, 404, "Ben cannot follow Ana's run");
  assert.equal((await get(`/api/runs/${id}`)).status, 401);
  assert.equal((await post(`/api/runs/${id}/cancel`, {}, ben)).status, 404);
  const log = await (await get(`/api/runs/${id}`, ana)).text();
  assert.match(log, /Done\./);
  assert.deepEqual(ollama.state.pulls, [PULLED]);
  const { plan } = await json(`/api/model?id=${QWEN}`, ana);
  assert.equal(plan.steps[0].done, true);
  assert.equal((await post("/api/remove", { kind: "ollama", name: PULLED }, ana)).status, 200);
  assert.deepEqual(ollama.state.deleted, [PULLED]);
  assert.equal((await post("/api/remove", { kind: "file", repo: "a/b", file: "c" }, ana)).status, 403);
  assert.equal((await post("/api/chat", { model: PULLED, messages: [] }, ana)).status, 403, "the site never relays a conversation; the page talks to the machine");
});

test("the idle watch covers every account's machine, including after a restart", async () => {
  assert.deepEqual(await server.checkIdle(), [false, false], "nobody idle long enough");
  // A fresh server process finds Ana's machine from her account alone.
  const again = createServer({ envFile: path.join(home, ".env2"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, hosted: true, refreshHours: 0, accountsDir: path.join(home, "accounts"), accountsSecret: SECRET, googleClientId: CLIENT, runpodBase: runpod.base, runpodProxy: () => ollama.url, idleWatch: false });
  assert.equal(again.rentals.size, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal([...again.rentals.values()][0].cached().id, (await json("/api/rent", ana)).id);
});

test("deleting the account deletes the machine and every key", async () => {
  const podId = (await json("/api/rent", ana)).id;
  assert.equal((await post("/api/account/delete", {}, ana)).status, 200);
  assert.equal(runpod.state.pods[podId].status, "TERMINATED");
  assert.equal((await json("/api/state", ana)).user, null, "signed out");
  assert.equal(fs.readdirSync(path.join(home, "accounts")).filter((f) => f.endsWith(".json") && f !== "index.json").length, 1, "only Ben is left");
  assert.equal(server.rentals.size, 1);
  // Signing in again starts from nothing.
  const fresh = cookieOf(await post("/api/auth/google", { credential: idToken() }));
  const s = await json("/api/state", fresh);
  assert.equal(s.runpodKey, "");
  assert.deepEqual(s.rental, { rented: false });
});

test("a guest enters a key without signing in and gets a session that expires after a quiet while", async () => {
  assert.equal((await post("/api/guest", { RUNPOD_API_KEY: "short" })).status, 400);
  assert.equal((await post("/api/guest", {})).status, 400);
  const res = await post("/api/guest", { RUNPOD_API_KEY: KEY });
  assert.equal(res.status, 200);
  const made = await res.json();
  assert.equal(made.guest, true);
  assert.ok(made.expiresAt > Date.now() + 11 * 3600e3);
  const guest = cookieOf(res);
  assert.match(guest, new RegExp(`^${SESSION_COOKIE}=`));
  const s = await json("/api/state", guest);
  assert.equal(s.user.guest, true);
  assert.equal(s.user.name, "Guest");
  assert.equal(s.user.expiresAt, made.expiresAt);
  assert.match(s.runpodKey, /^rpa_/);
  assert.equal((await json("/api/rent/options", guest)).configured, true);
  // The guest rents like anyone else.
  const r = await (await post("/api/rent", { gb: 24, diskGb: 50 }, guest)).json();
  assert.equal(r.rented, true);
  assert.equal((await json("/api/state", guest)).chatServer.url, ollama.url);
  // Each use pushes the expiry back.
  const later = (await json("/api/state", guest)).user.expiresAt;
  assert.ok(later >= made.expiresAt);
  // Expiry: the file says the time is up, the sweep stops the machine and forgets the guest.
  const dir = path.join(home, "accounts");
  const file = fs.readdirSync(dir).find((f) => f.startsWith("g") && f.endsWith(".json"));
  const record = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
  assert.equal(record.guest, true);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, file), "utf8"), new RegExp(KEY), "the guest's key is encrypted too");
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ ...record, expiresAt: Date.now() - 1000 }));
  assert.equal((await json("/api/state", guest)).user, null, "an expired guest is nobody");
  assert.equal((await get("/api/rent", guest)).status, 401);
  const swept = await server.sweepGuests();
  assert.equal(swept.length, 1);
  assert.equal(runpod.state.pods[r.id].status, "EXITED", "the machine was stopped while the key still worked");
  assert.ok(!fs.existsSync(path.join(dir, file)));
  assert.equal(server.rentals.has(swept[0]), false);
  assert.deepEqual(await server.sweepGuests(), []);
});

test("a guest who signs in keeps the keys and the machine on the account", async () => {
  const res = await post("/api/guest", { RUNPOD_API_KEY: KEY, ANTHROPIC_API_KEY: "sk-ant-api03-guestkey0123456789abcdef" });
  const guest = cookieOf(res);
  const r = await (await post("/api/rent", { gb: 48, diskGb: 50 }, guest)).json();
  const signedIn = await fetch(base + "/api/auth/google", { method: "POST", headers: { "Content-Type": "application/json", Cookie: guest }, body: JSON.stringify({ credential: idToken({ email: "cy@example.com", name: "Cy" }) }) });
  assert.equal(signedIn.status, 200);
  const cy = cookieOf(signedIn);
  const s = await json("/api/state", cy);
  assert.equal(s.user.guest, false);
  assert.equal(s.user.email, "cy@example.com");
  assert.match(s.runpodKey, /^rpa_/);
  assert.match(s.claudeKey, /^sk-a/);
  assert.equal(s.rental.id, r.id, "the machine came along");
  assert.equal(s.chatServer.url, ollama.url);
  assert.equal((await json("/api/state", guest)).user, null, "the guest is gone");
  assert.equal(fs.readdirSync(path.join(home, "accounts")).filter((f) => f.startsWith("g")).length, 0);
  // Keeping the machine on an account means the guest's key no longer works when the cookie is reused.
  assert.equal((await post("/api/rent/stop", {}, guest)).status, 401);
  await post("/api/rent/delete", {}, cy);
  await post("/api/account/delete", {}, cy);
});
