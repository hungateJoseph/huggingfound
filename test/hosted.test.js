import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-hosted-"));
const { createServer } = await import("../src/server.js");

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
    assert.match((await res.json()).error, /Sign in|not set up/);
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
