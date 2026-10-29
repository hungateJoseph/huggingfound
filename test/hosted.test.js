import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-hosted-"));
const { createServer } = await import("../src/server.js");
const { ReviewError } = await import("../src/review.js");

// The public copy of the site: it may search, browse and show what people
// say, and it refreshes its own catalogue; it must not run or download
// anything for a visitor.
const checks = [];
let stub;
let server;
let base;
const dead = "http://127.0.0.1:1";

before(async () => {
  stub = await startStubHub();
  const home = process.env.HUGGINGFOUND_HOME;
  server = createServer({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, hosted: true, refreshHours: 0, devCode: "open-sesame-123", reviewLimit: 3, reviewer: {
    async review(input, onText, use) {
      checks.push({ input, use });
      // Anthropic refusing the key, as the real reviewer reports it.
      if (input.answer === "refuse the key") throw new ReviewError("Anthropic refused the API key. Check that it is entered correctly and still active.", 401);
      onText("Looks right.");
      return { declined: false, model: "claude-opus-5", note: "" };
    },
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
});

const get = (p, headers = {}) => fetch(base + p, { headers });
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("the state says it is hosted and describes a typical laptop, not this machine", async () => {
  const s = await (await get("/api/state")).json();
  assert.equal(s.hosted, true);
  assert.equal(s.machine.hosted, true);
  assert.equal(s.machine.ramGb, 16);
  assert.equal(s.runners.ollama.installed, false);
  assert.equal(s.summarizer, null);
  assert.equal(s.refresh.hours, 0);
});

test("the about page is served, links the developer's GitHub, and names this site's repository", async () => {
  const res = await get("/about.html");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const page = await res.text();
  assert.match(page, /github\.com\/hungateJoseph"/);
  assert.match(page, /href="https:\/\/www\.linkedin\.com\/in\/joseph-hungate\/"/);
  assert.doesNotMatch(page, /mailto:|REPLACE-WITH|huggingfound\.git|oopsiblinked/, "one sentence and two links, nothing else");
  assert.match(page, /Amazon Web Services[\s\S]*Cyber Officer[\s\S]*AI models can be put to work most efficiently/);
  // The front page and the privacy page both point at it.
  for (const p of ["/", "/privacy.html"]) assert.match(await (await get(p)).text(), /href="\/about\.html"/, p);
});

test("nothing that runs, downloads, chats or changes settings is reachable", async () => {
  // What never happens on the server itself, signed in or not.
  for (const p of ["/api/chat", "/api/scan", "/api/voices/gather", "/api/unload", "/api/upload"]) {
    const res = await post(p, {});
    assert.equal(res.status, 403, p);
    assert.match((await res.json()).error, /your own computer/);
  }
  // What a signed-in person may do (keys, renting, downloads onto the rented machine) asks for sign-in first.
  for (const p of ["/api/run", "/api/settings", "/api/remove", "/api/runs/1/cancel", "/api/rent", "/api/rent/stop"]) {
    const res = await post(p, {});
    assert.equal(res.status, 401, p);
    assert.match((await res.json()).error, /Enter a RunPod key.*or sign in/);
  }
  for (const p of ["/api/storage", "/api/result?file=x.png", "/api/image-server"]) {
    assert.equal((await get(p)).status, 403, p);
  }
});

test("the page's own host may call the API; other sites may not", async () => {
  const host = base.replace("http://", "");
  assert.equal((await get("/api/state", { Origin: `https://${host}` })).status, 200);
  assert.equal((await get("/api/state", { Origin: "https://evil.example" })).status, 403);
});

test("the server refreshes its own catalogue: a scan, then what people say", async () => {
  assert.equal((await (await get("/api/models")).json()).models.length, 0);
  await server.refresh();
  const saved = await (await get("/api/models")).json();
  assert.ok(saved.models.length > 5);
  assert.ok(saved.models.some((m) => m.summary?.long?.length), "summaries were gathered after the scan");
  const s = await (await get("/api/state")).json();
  assert.ok(s.scan.at);
  assert.ok(s.voices.count > 5);
  assert.ok(s.refresh.last);
});

test("a visitor the site does not know sees no adult or video models and no LoRAs; a guest's Anthropic key or signing in opens the video models, and adult models only the owner", async () => {
  const CYDONIA = "TheDrummer/Cydonia-24B-v2-GGUF";
  const WAN = "Wan-AI/Wan2.2-TI2V-5B-Diffusers";
  const state = await (await get("/api/state")).json();
  assert.deepEqual(state.access, { full: false, adult: false });
  assert.ok(state.categories.every((c) => !c.id.startsWith("nsfw")), "no adult category is named to a visitor");
  const found = await (await get("/api/find?q=porn+roleplay+writing")).json();
  assert.ok(found.models.length > 0, "the search still answers");
  assert.ok(found.models.every((m) => !m.adult), "with no adult model in it");
  assert.equal((await (await get("/api/search?q=cydonia")).json()).models.length, 0, "an adult model asked for by name is not there");
  assert.equal((await (await get("/api/search?q=wan2.2")).json()).models.length, 0, "nor a video model");
  const browse = (await (await get("/api/models")).json()).models;
  assert.ok(browse.length > 5);
  assert.ok(browse.every((m) => !m.adult && !/video/.test(m.pipeline ?? "")), "Browse has neither");
  for (const [id, why] of [[CYDONIA, /^This model is not available here\.$/], [WAN, /Video models and LoRAs open once you sign in, or enter an Anthropic API key as a guest/]]) {
    const res = await get(`/api/model?id=${id}`);
    assert.equal(res.status, 403, id);
    assert.match((await res.json()).error, why);
  }
  for (const p of [`/api/loras?id=${WAN}`, `/api/loras/recipe?base=${WAN}&id=x/y`, `/api/loras/files?id=x/y`, "/api/loras/link?url=https://civitai.com/models/1"]) assert.equal((await get(p)).status, 403, p);
  // A guest with only a RunPod key is still a visitor here; with an Anthropic key the video models open, the adult ones stay shut.
  const runpodOnly = await post("/api/guest", { RUNPOD_API_KEY: "runpodkey0123456789abcdef" });
  const cookie1 = runpodOnly.headers.get("set-cookie").split(";")[0];
  assert.deepEqual((await (await get("/api/state", { Cookie: cookie1 })).json()).access, { full: false, adult: false });
  const withClaude = await post("/api/guest", { ANTHROPIC_API_KEY: "sk-ant-api03-guestkey0123456789abcdef" });
  const cookie2 = withClaude.headers.get("set-cookie").split(";")[0];
  assert.deepEqual((await (await get("/api/state", { Cookie: cookie2 })).json()).access, { full: true, adult: false });
  assert.equal((await (await get("/api/search?q=cydonia", { Cookie: cookie2 })).json()).models.length, 0, "the adult model stays shut for a guest");
  assert.equal((await (await get("/api/search?q=wan2.2", { Cookie: cookie2 })).json()).models.length, 2);
  assert.equal((await get(`/api/model?id=${WAN}`, { Cookie: cookie2 })).status, 200);
  assert.equal((await get(`/api/model?id=${CYDONIA}`, { Cookie: cookie2 })).status, 403);
  assert.ok((await (await get("/api/models", { Cookie: cookie2 })).json()).models.every((m) => !m.adult));
  // Signed in: the video models, not the adult ones.
  const user = server.accounts.findOrCreate({ email: "vis@example.com", name: "Vis" });
  const signed = `hf_session=${server.accounts.issue(user.id)}`;
  assert.deepEqual((await (await get("/api/state", { Cookie: signed })).json()).access, { full: true, adult: false });
  assert.equal((await get(`/api/model?id=${CYDONIA}`, { Cookie: signed })).status, 403);
  assert.notEqual((await get(`/api/loras?id=${WAN}`, { Cookie: signed })).status, 403);
  // The owner, signed in with Google on the admin address: everything.
  const owner = server.accounts.findOrCreate({ email: "jbabyjbaby1@gmail.com", name: "Joseph" });
  const ownerCookie = `hf_session=${server.accounts.issue(owner.id)}`;
  const ownerState = await (await get("/api/state", { Cookie: ownerCookie })).json();
  assert.deepEqual(ownerState.access, { full: true, adult: true });
  assert.equal(ownerState.user.admin, true);
  assert.equal((await (await get("/api/search?q=cydonia", { Cookie: ownerCookie })).json()).models.length, 1);
  assert.equal((await get(`/api/model?id=${CYDONIA}`, { Cookie: ownerCookie })).status, 200);
  assert.ok(ownerState.categories.some((c) => c.id.startsWith("nsfw")));
  // The admin address registered with a password, unverified, is not the owner.
  const squat = await post("/api/auth/register", { email: "squat@example.com", password: "longenough1", name: "S" });
  assert.equal(squat.status, 200);
  const squatCookie = squat.headers.get("set-cookie").split(";")[0];
  assert.deepEqual((await (await get("/api/state", { Cookie: squatCookie })).json()).access, { full: true, adult: false });
});

test("an account with an email address and a password: made once, signed into with the right password only, and Google takes it over", async () => {
  const made = await post("/api/auth/register", { email: "Mia@Example.com", password: "a-good-password", name: "Mia" });
  assert.equal(made.status, 200);
  assert.deepEqual((await made.json()).user, { email: "mia@example.com", name: "Mia", picture: null });
  const cookie = made.headers.get("set-cookie").split(";")[0];
  const me = (await (await get("/api/state", { Cookie: cookie })).json()).user;
  assert.equal(me.email, "mia@example.com");
  assert.equal(me.guest, false);
  assert.equal((await post("/api/auth/register", { email: "mia@example.com", password: "another-one-1" })).status, 409, "the address is taken");
  assert.equal((await post("/api/auth/register", { email: "short@example.com", password: "short" })).status, 400, "eight characters at least");
  assert.equal((await post("/api/auth/register", { email: "not an address", password: "longenough1" })).status, 400);
  assert.equal((await post("/api/auth/login", { email: "mia@example.com", password: "wrong-password" })).status, 401);
  const back = await post("/api/auth/login", { email: "mia@example.com", password: "a-good-password" });
  assert.equal(back.status, 200);
  assert.ok(back.headers.get("set-cookie"));
  // A Google account without a password is not opened by a password.
  server.accounts.findOrCreate({ email: "g@example.com", name: "G" });
  const viaGoogle = await post("/api/auth/login", { email: "g@example.com", password: "whatever-this-is" });
  assert.equal(viaGoogle.status, 401);
  assert.match((await viaGoogle.json()).error, /signs in with Google/);
  // Whoever proves the address with Google owns it: the password is dropped.
  const owner = server.accounts.findOrCreate({ email: "mia@example.com", name: "Mia Real" });
  assert.equal(owner.verified, true);
  assert.equal(owner.password, false);
  assert.equal((await post("/api/auth/login", { email: "mia@example.com", password: "a-good-password" })).status, 401);
});

test("a person changes their name freely, and their email only with their password, to a free address; a Google address stays as it is", async () => {
  const made = await post("/api/auth/register", { email: "ned@example.com", password: "ned-password-1", name: "Ned" });
  const cookie = made.headers.get("set-cookie").split(";")[0];
  assert.equal((await post("/api/account/update", { name: "Edward" }, { Cookie: cookie })).status, 200);
  let me = (await (await get("/api/state", { Cookie: cookie })).json()).user;
  assert.deepEqual([me.name, me.email, me.password], ["Edward", "ned@example.com", true]);
  assert.equal((await post("/api/account/update", { email: "new@example.com" }, { Cookie: cookie })).status, 401, "no password, no change of address");
  assert.equal((await post("/api/account/update", { email: "new@example.com", password: "wrong" }, { Cookie: cookie })).status, 401);
  server.accounts.findOrCreate({ email: "taken@example.com", name: "T" });
  assert.equal((await post("/api/account/update", { email: "taken@example.com", password: "ned-password-1" }, { Cookie: cookie })).status, 409, "an address with an account already is refused");
  assert.equal((await post("/api/account/update", { email: "jbabyjbaby1@gmail.com", password: "ned-password-1" }, { Cookie: cookie })).status, 409, "the owner's address is taken too");
  assert.equal((await post("/api/account/update", { email: "new@example.com", password: "ned-password-1" }, { Cookie: cookie })).status, 200);
  me = (await (await get("/api/state", { Cookie: cookie })).json()).user;
  assert.equal(me.email, "new@example.com");
  assert.equal((await post("/api/auth/login", { email: "new@example.com", password: "ned-password-1" })).status, 200, "signs in under the new address");
  assert.equal((await post("/api/auth/login", { email: "ned@example.com", password: "ned-password-1" })).status, 401, "and no longer under the old");
  // Renamed to an address on the admin list before it was taken, an account is still not the owner: the new address is unverified.
  const g = server.accounts.findOrCreate({ email: "gina@example.com", name: "Gina" });
  const gCookie = `hf_session=${server.accounts.issue(g.id)}`;
  assert.equal((await post("/api/account/update", { name: "Georgina" }, { Cookie: gCookie })).status, 200);
  const changed = await post("/api/account/update", { email: "other@example.com" }, { Cookie: gCookie });
  assert.equal(changed.status, 400);
  assert.match((await changed.json()).error, /comes from Google/);
  assert.equal((await post("/api/account/update", { name: "X" })).status, 401, "signed out, nothing changes");
});

test("a model's plan lists the steps with commands, for a typical laptop, with nothing marked done", async () => {
  const { plan } = await (await get("/api/model?id=bartowski/Qwen2.5-Coder-7B-Instruct-GGUF")).json();
  assert.equal(plan.runnable, true);
  assert.ok(plan.steps.length >= 3);
  assert.ok(plan.steps.every((s) => !s.done));
  assert.ok(plan.steps.every((s) => s.command));
  assert.match(plan.fit.text, /16 GB laptop|16 GB of memory|32 GB/);
  assert.equal(plan.measured, "");
});

test("a server token reaches the Hub but never unlocks a visitor's plan", async () => {
  process.env.HF_TOKEN = "hf_servertoken";
  try {
    const { model, plan } = await (await get("/api/model?id=meta-llama/Llama-3.1-8B-Instruct")).json();
    assert.equal(model.gated, true, "the Hub answered with the token");
    assert.equal(plan.runnable, false);
    assert.match(plan.reason, /Python/);
  } finally {
    delete process.env.HF_TOKEN;
  }
});

// ---- Claude's check on the hosted site ---------------------------------------

const OWN_KEY = "sk-ant-api03-visitorvisitorvisitorvisitor";
const check = (headers, body = { kind: "text", question: "q", answer: "a" }) => post("/api/review", body, headers);

test("a refused key is named: the one typed into the page is used ahead of a saved one, and the message says so", async () => {
  const res = await check({ "X-Forwarded-For": "10.0.0.9", "X-Anthropic-Key": OWN_KEY }, { kind: "text", question: "q", answer: "refuse the key" });
  assert.equal(res.status, 401);
  assert.match((await res.json()).error, /Anthropic refused the API key\.[\s\S]*The key used was the one typed into the Check an answer panel, not the one saved in Settings; clear that field to use the saved key\./);
  assert.equal(checks.at(-1).use.from, "typed");
  checks.pop();
});

test("a check needs the visitor's own key or the owner's dev code", async () => {
  assert.equal((await (await get("/api/state")).json()).claudeHosted.devCode, true);
  const none = await check({ "X-Forwarded-For": "10.0.0.1" });
  assert.equal(none.status, 401);
  assert.match((await none.json()).error, /your own Anthropic API key \(sign in to save one\), or the site owner's dev code/);
  const bad = await check({ "X-Forwarded-For": "10.0.0.1", "X-Anthropic-Key": "hello" });
  assert.equal(bad.status, 400);
  assert.equal(checks.length, 0, "nothing reached Claude");
});

test("a visitor's key is used for that one check and nothing else", async () => {
  const res = await check({ "X-Forwarded-For": "10.0.0.2", "X-Anthropic-Key": OWN_KEY }, { kind: "text", question: "q", answer: "a", file: "pic.png" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Looks right\./);
  const last = checks.at(-1);
  assert.equal(last.use.apiKey, OWN_KEY);
  assert.equal("file" in last.input, false, "the hosted site has no files to name");
  const state = JSON.stringify(await (await get("/api/state")).json());
  assert.ok(!state.includes("visitorvisitor"), "the key is not kept or echoed");
});

test("the dev code uses the site's key; a wrong code is refused and guessing is cut off", async () => {
  const right = await check({ "X-Forwarded-For": "10.0.0.3", "X-Dev-Code": "open-sesame-123" });
  assert.equal(right.status, 200);
  assert.equal(checks.at(-1).use.apiKey, "", "falls through to the key on the server");
  const before = checks.length;
  for (let i = 0; i < 8; i++) assert.equal((await check({ "X-Forwarded-For": "10.0.0.4", "X-Dev-Code": `guess-${i}` })).status, 401);
  const locked = await check({ "X-Forwarded-For": "10.0.0.4", "X-Dev-Code": "guess-again" });
  assert.equal(locked.status, 429);
  assert.equal(checks.length, before, "no guess reached Claude");
  assert.equal((await check({ "X-Forwarded-For": "10.0.0.5", "X-Dev-Code": "open-sesame-123" })).status, 200, "other addresses are unaffected");
});

test("one address gets a limited number of checks an hour", async () => {
  const from = { "X-Forwarded-For": "10.0.0.6", "X-Anthropic-Key": OWN_KEY };
  for (let i = 0; i < 3; i++) assert.equal((await check(from)).status, 200);
  const over = await check(from);
  assert.equal(over.status, 429);
  assert.match((await over.json()).error, /a lot of checks/);
});

test("a picked picture travels in the request and is checked as an image", async () => {
  const { buildRequest } = await import("../src/review.js");
  const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const req = buildRequest({ kind: "image", image: { media_type: "image/png", data }, prompt: "a cat" });
  assert.deepEqual(req.messages[0].content[0], { type: "image", source: { type: "base64", media_type: "image/png", data } });
  assert.throws(() => buildRequest({ kind: "image", image: { media_type: "image/gif", data } }), /PNG, JPEG or WebP/);
  assert.throws(() => buildRequest({ kind: "image", image: { media_type: "image/png", data: "<script>" } }), /did not arrive intact/);
  const res = await check({ "X-Forwarded-For": "10.0.0.7", "X-Anthropic-Key": OWN_KEY }, { kind: "image", image: { media_type: "image/png", data }, prompt: "a cat" });
  assert.equal(res.status, 200);
  assert.equal(checks.at(-1).input.image.media_type, "image/png");
});
