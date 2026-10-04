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
let stub;
let server;
let base;
const dead = "http://127.0.0.1:1";

before(async () => {
  stub = await startStubHub();
  const home = process.env.HUGGINGFOUND_HOME;
  server = createServer({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, hosted: true, refreshHours: 0 });
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
  for (const p of ["/api/run", "/api/chat", "/api/settings", "/api/scan", "/api/voices/gather", "/api/remove", "/api/unload", "/api/upload", "/api/review", "/api/runs/1/cancel"]) {
    const res = await post(p, {});
    assert.equal(res.status, 403, p);
    assert.match((await res.json()).error, /your own computer/);
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
