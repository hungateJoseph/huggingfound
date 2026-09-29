import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MODELS, startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-server-"));
const { createServer } = await import("../src/server.js");
const { MODELS_DIR } = await import("../src/runners.js");

let stub;
let server;
let base;
let envFile;
let scanFile;

before(async () => {
  stub = await startStubHub();
  envFile = path.join(process.env.HUGGINGFOUND_HOME, ".env");
  scanFile = path.join(process.env.HUGGINGFOUND_HOME, "scan.json");
  server = createServer({ envFile, scanFile, hubBase: stub.base });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
});

const get = (p) => fetch(base + p);
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("serves the page and the starting state", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /HuggingFound/);
  const s = await (await get("/api/state")).json();
  assert.ok(s.machine.ramGb > 0);
  assert.equal(s.categories.length, 9);
  assert.ok(s.picks.every((p) => typeof p.speed === "string" && p.speed.length > 0));
  assert.equal(s.scan, null);
  assert.equal(s.token, "");
  assert.ok(s.picks.length >= 6);
  assert.ok(!s.envFile.startsWith(os.homedir()) || s.envFile.startsWith("~"));
});

test("static files stay inside the public folder", async () => {
  assert.equal((await get("/style.css")).status, 200);
  assert.equal((await get("/../package.json")).status, 404);
  assert.equal((await get("/%2e%2e/package.json")).status, 404);
});

test("api calls from another origin are refused", async () => {
  const res = await fetch(base + "/api/state", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("a scan is saved, and the next scan marks what is new", async () => {
  const first = await (await post("/api/scan", {})).json();
  assert.equal(first.models.length, MODELS.length);
  assert.ok(first.models.every((m) => m.isNew === false));
  assert.ok(fs.existsSync(scanFile));

  const later = await startStubHub({ extraModels: [{ id: "new/Thing-GGUF", pipeline_tag: "text-generation", tags: ["gguf"], downloads: 1, likes: 1, createdAt: "2026-09-29T00:00:00.000Z" }] });
  const s2 = createServer({ envFile, scanFile, hubBase: later.base });
  await new Promise((resolve) => s2.listen(0, "127.0.0.1", resolve));
  try {
    const second = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/scan`, { method: "POST" })).json();
    assert.equal(second.models.filter((m) => m.isNew).map((m) => m.id).join(), "new/Thing-GGUF");
    const meta = (await (await get("/api/state")).json()).scan;
    assert.equal(meta.count, MODELS.length + 1);
    assert.equal(meta.newCount, 1);
    const saved = await (await get("/api/models")).json();
    assert.equal(saved.models.length, MODELS.length + 1);
  } finally {
    s2.close();
    later.server.close();
  }
});

test("scan results carry a rough speed line and an adult flag", async () => {
  const { models } = await (await get("/api/models")).json();
  const llama = models.find((m) => m.id === "bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.match(llama.speed, /words a second/);
  assert.equal(llama.adult, false);
  const cydonia = models.find((m) => m.id === "TheDrummer/Cydonia-24B-v2-GGUF");
  assert.equal(cydonia.adult, true);
  assert.ok(cydonia.categories.includes("nsfw-writing"));
  const python = models.find((m) => m.id === "meta-llama/Llama-3.1-8B-Instruct");
  assert.equal(python.speed, "");
});

test("the trait search asks the hub and returns summarized, speed-tagged models", async () => {
  const found = await (await get("/api/search?q=coder")).json();
  assert.equal(found.q, "coder");
  assert.deepEqual(found.models.map((m) => m.id), ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"]);
  assert.ok(found.models[0].categories.includes("coding"));
  assert.match(found.models[0].speed, /words a second/);
  assert.equal((await get("/api/search?q=%20")).status, 400);
});

test("a measured time replaces the guess after a real run", async () => {
  const { recordTiming } = await import("../src/runners.js");
  recordTiming("second-state/stable-diffusion-v1-5-GGUF/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf", { kind: "image", seconds: 139 });
  const { plan } = await (await get("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).json();
  assert.match(plan.speed.text, /per 512 by 512 image/);
  assert.equal(plan.measured, "Measured here: 2.3 minutes per image");
});

test("model details come with a plan for this machine", async () => {
  const { model, plan } = await (await get("/api/model?id=bartowski/Llama-3.2-3B-Instruct-GGUF")).json();
  assert.equal(model.files.length, 4);
  assert.equal(plan.runnable, true);
  assert.equal(plan.steps.at(-1).kind, "pull-model");
  assert.equal(plan.file.name, "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.equal((await get("/api/model?id=nope")).status, 400);
});

test("a curated pick keeps its named file and runner", async () => {
  const { plan } = await (await get("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).json();
  assert.equal(plan.runner, "sd");
  assert.equal(plan.file.name, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf");
});

test("a gated model is blocked without a token and opens with one", async () => {
  const blocked = await (await get("/api/model?id=meta-llama/Llama-3.1-8B-Instruct")).json();
  assert.equal(blocked.plan.gated, true);
  assert.equal(blocked.plan.runnable, false);

  assert.equal((await post("/api/settings", { HF_TOKEN: "hf_abcdefghijklmnopqrstuvwxyz" })).status, 200);
  assert.equal((await (await get("/api/state")).json()).token, "hf_a************wxyz");
  assert.match(fs.readFileSync(envFile, "utf8"), /^HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz$/m);

  const s3 = createServer({ envFile, scanFile, hubBase: stub.base });
  await new Promise((resolve) => s3.listen(0, "127.0.0.1", resolve));
  try {
    const open = await (await fetch(`http://127.0.0.1:${s3.address().port}/api/model?id=meta-llama/Llama-3.1-8B-Instruct`)).json();
    assert.equal(open.model.gated, true);
    assert.equal(open.plan.gated, undefined);
    assert.match(open.plan.reason, /Python/);
  } finally {
    s3.close();
  }
  assert.equal((await post("/api/settings", { HF_TOKEN: 5 })).status, 400);
  assert.equal((await post("/api/settings", { HF_TOKEN: "" })).status, 200);
  assert.equal((await (await get("/api/state")).json()).token, "");
});

test("a download step streams progress and lands in the models folder", async () => {
  const { id } = await (await post("/api/run", { kind: "download-file", args: { repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" } })).json();
  const events = await readEvents(`${base}/api/runs/${id}`);
  assert.equal(events.at(-1).status, "done");
  assert.ok(events.some((e) => /Downloading/.test(e.line ?? "")));
  assert.ok(events.some((e) => /100% of/.test(e.line ?? "")));
  const dest = path.join(MODELS_DIR, "bartowski", "Llama-3.2-3B-Instruct-GGUF", "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.equal(fs.statSync(dest).size, 64 * 1024);
  assert.ok(!fs.existsSync(`${dest}.part`));

  const { plan } = await (await get("/api/model?id=bartowski/Llama-3.2-3B-Instruct-GGUF")).json();
  assert.ok(plan.steps.some((s) => s.kind === "pull-model"));
});

test("storage lists the download and remove deletes it", async () => {
  const before = await (await get("/api/storage")).json();
  const row = before.files.find((f) => f.file === "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.ok(row);
  assert.ok(before.totalGb > 0);

  const res = await post("/api/remove", { kind: "file", repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" });
  assert.equal(res.status, 200);
  const after = await res.json();
  assert.ok(!after.files.some((f) => f.file === "Llama-3.2-3B-Instruct-Q4_K_M.gguf"));
  assert.ok(!fs.existsSync(path.join(MODELS_DIR, "bartowski")));

  assert.equal((await post("/api/remove", { kind: "file", repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" })).status, 400);
  assert.equal((await post("/api/remove", { kind: "file", repo: "../x", file: "y" })).status, 400);
  assert.equal((await post("/api/remove", { kind: "nonsense" })).status, 400);
});

test("a run that fails says so on the stream", async () => {
  const { id } = await (await post("/api/run", { kind: "download-file", args: { repo: "nobody/missing", file: "x.gguf" } })).json();
  const events = await readEvents(`${base}/api/runs/${id}`);
  assert.equal(events.at(-1).status, "failed");
  assert.ok(events.some((e) => /HTTP 404/.test(e.line ?? "")));
});

test("bad or unknown steps are refused before anything runs", async () => {
  assert.equal((await post("/api/run", { kind: "pull-model", args: { name: "x && echo hi" } })).status, 400);
  assert.equal((await post("/api/run", { kind: "nonsense" })).status, 400);
  assert.equal((await get("/api/runs/999")).status, 404);
});

test("uploads land in the upload folder and results are read back", async () => {
  const res = await fetch(base + "/api/upload", { method: "POST", headers: { "x-filename": "my clip.wav" }, body: Buffer.from("RIFF") });
  const { path: saved } = await res.json();
  assert.match(saved, /my_clip\.wav$/);
  assert.ok(fs.existsSync(saved));
  assert.equal((await get("/api/result?file=missing.txt")).status, 404);
  assert.equal((await get("/output/../package.json")).status, 404);
});

async function readEvents(url) {
  const text = await (await fetch(url)).text();
  return text.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
}
