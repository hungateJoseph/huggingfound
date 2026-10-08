import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";

// The agent that runs on a rented GPU: it downloads image models onto the
// machine, loads one into sd-server (a fake here) and makes pictures for
// the browser. Started as the real program, with a fake sd-server and the
// stand-in Hub.

const here = path.dirname(fileURLToPath(import.meta.url));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-agent-"));
const modelsDir = path.join(home, "models");
const sdLog = path.join(home, "sd-requests.log");
const sdPort = 7900 + Math.floor(Math.random() * 1000);
const ORIGIN = "https://huggingfound.test";
let stub;
let agent;
let base;
const REPO = "second-state/stable-diffusion-v1-5-GGUF";
const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf";

before(async () => {
  stub = await startStubHub();
  // sd-server is played by a script that takes the same flags.
  const fake = path.join(home, "sd-server");
  fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "fake-sd-server.js")}" "$@"\n`);
  fs.chmodSync(fake, 0o755);
  agent = spawn(process.execPath, [path.join(here, "..", "gpu", "agent.js")], {
    env: { ...process.env, HF_AGENT_PORT: "0", HF_AGENT_HOST: "127.0.0.1", HF_MODELS_DIR: modelsDir, SD_SERVER: fake, SD_PORT: String(sdPort), HF_HUB: stub.base, HF_ORIGINS: `${ORIGIN},http://localhost:*`, FAKE_SD_LOG: sdLog },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  agent.stderr.on("data", (c) => (errors += c));
  base = await new Promise((resolve, reject) => {
    let out = "";
    agent.stdout.on("data", (c) => {
      out += c;
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    });
    agent.on("exit", (code) => reject(new Error(`the agent exited with ${code}: ${errors}`)));
    setTimeout(() => reject(new Error(`the agent did not start: ${out} ${errors}`)), 8000);
  });
});

after(() => {
  agent.kill();
  stub.server.close();
});

const get = (p, headers = {}) => fetch(base + p, { headers });
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const del = (p, body) => fetch(base + p, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const sdRequests = () => (fs.existsSync(sdLog) ? fs.readFileSync(sdLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

async function finish(id) {
  for (let i = 0; i < 100; i++) {
    const job = await (await get(`/jobs/${id}`)).json();
    if (job.status === "completed" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the job never finished");
}

test("it answers health, and only the allowed origins may call it from a page", async () => {
  const h = await (await get("/health")).json();
  assert.deepEqual(h, { ok: true, version: "1", loaded: null, ready: false, loading: false, models: 0 });
  const pre = await fetch(`${base}/jobs`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal((await get("/health", { Origin: "http://localhost:4188" })).status, 200, "a pattern with a wildcard port");
  assert.equal((await get("/health", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await get("/health", { Origin: "https://evil.example" })).headers.get("access-control-allow-origin"), null);
});

test("it downloads a model file from the Hub onto the disk with progress, and lists it", async () => {
  assert.equal((await post("/download", { repo: "../x", file: FILE })).status, 400);
  const res = await post("/download", { repo: REPO, file: FILE });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].status, "starting");
  assert.ok(lines.some((l) => l.total === 64 * 1024 && l.completed === 64 * 1024));
  assert.equal(lines.at(-1).status, "success");
  assert.ok(fs.existsSync(path.join(modelsDir, "second-state", "stable-diffusion-v1-5-GGUF", FILE)));
  const { models } = await (await get("/models")).json();
  assert.deepEqual(models.map((m) => [m.repo, m.file]), [[REPO, FILE]]);
  assert.ok(models[0].gb > 0);
  const again = (await (await post("/download", { repo: REPO, file: FILE })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(again[0].status, "already here");
  // A gated file without a token is explained, not half-downloaded.
  const gated = (await (await post("/download", { repo: "black-forest-labs/FLUX.1-dev", file: "flux1-dev.safetensors" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(gated.at(-1).error, /gated/);
  assert.ok(!fs.existsSync(path.join(modelsDir, "black-forest-labs")));
});

test("a picture job loads the model, hands the request to sd-server and returns the picture", async () => {
  assert.equal((await post("/jobs", { repo: REPO, file: FILE, prompt: "   " })).status, 400);
  const missing = await (await post("/jobs", { repo: REPO, file: "nope.gguf", prompt: "a cat" })).json();
  assert.match((await finish(missing.id)).error, /not on this machine/);
  const res = await post("/jobs", { repo: REPO, file: FILE, prompt: "a lighthouse at dusk", negative: "blurry", steps: 12, width: 768, height: 768, cfg: 7, sampler: "dpm++2m", scheduler: "karras" }, { Origin: ORIGIN });
  assert.equal(res.status, 202);
  const { id, status } = await res.json();
  assert.equal(status, "loading");
  const job = await finish(id);
  assert.equal(job.status, "completed", job.error);
  assert.match(job.image, /^iVBOR/, "a PNG, base64");
  const sent = sdRequests().at(-1);
  assert.equal(sent.prompt, "a lighthouse at dusk");
  assert.equal(sent.negative_prompt, "blurry");
  assert.deepEqual([sent.width, sent.height], [768, 768]);
  assert.deepEqual(sent.sample_params, { sample_steps: 12, sample_method: "dpm++2m", scheduler: "karras", guidance: { txt_cfg: 7 } });
  assert.equal(sent.init_image, null);
  assert.equal(sent.strength, undefined);
  const h = await (await get("/health")).json();
  assert.equal(h.loaded, `${REPO}/${FILE}`);
  assert.equal(h.ready, true);
});

test("an edit sends the starting picture and how much of it to keep; bad input and a failed job are explained", async () => {
  const res = await post("/jobs", { repo: REPO, file: FILE, prompt: "darker sky", init: `data:image/png;base64,${"A".repeat(400)}`, strength: 0.3, width: 9999, steps: 500, sampler: "nonsense" });
  const { id } = await res.json();
  const job = await finish(id);
  assert.equal(job.status, "completed", job.error);
  const sent = sdRequests().at(-1);
  assert.equal(sent.init_image, "400 chars");
  assert.equal(sent.strength, 0.3);
  assert.deepEqual([sent.width, sent.sample_params.sample_steps, sent.sample_params.sample_method], [512, 20, "euler_a"], "out-of-range values fall back to the defaults");
  assert.equal((await post("/jobs", { repo: REPO, file: FILE, prompt: "x", init: "not base64!!" })).status, 400);
  const bad = await (await post("/jobs", { repo: REPO, file: FILE, prompt: "fail please" })).json();
  assert.match((await finish(bad.id)).error, /the model choked/);
  assert.equal((await get("/jobs/0123456789abcdef")).status, 404);
});

test("removing a model unloads it and frees the disk", async () => {
  assert.equal((await del("/models", { repo: REPO, file: FILE })).status, 200);
  assert.equal((await del("/models", { repo: REPO, file: FILE })).status, 404);
  const h = await (await get("/health")).json();
  assert.equal(h.loaded, null);
  assert.equal(h.models, 0);
  assert.ok(!fs.existsSync(path.join(modelsDir, "second-state")));
});
