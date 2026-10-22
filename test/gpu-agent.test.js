import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
const workerLog = path.join(home, "worker-requests.log");
let stub;
let agent;
let base;
// Civitai's download address, played locally: it answers only its own key.
let civitai;
const civitaiAsked = [];
const REPO = "second-state/stable-diffusion-v1-5-GGUF";
const fakeOllama = path.join(home, "fake-ollama");
const ollamaPort = 20000 + Math.floor(Math.random() * 20000);
const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf";

before(async () => {
  stub = await startStubHub();
  civitai = http.createServer((req, res) => {
    civitaiAsked.push({ url: req.url, auth: req.headers.authorization ?? null });
    if (req.headers.authorization !== "Bearer civitai-key") {
      res.writeHead(401);
      return res.end("{}");
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": "11" });
    res.end("lora-weight");
  });
  await new Promise((r) => civitai.listen(0, "127.0.0.1", r));
  // sd-server is played by a script that takes the same flags.
  const fake = path.join(home, "sd-server");
  fs.writeFileSync(fake, `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, "fake-sd-server.js")}" "$@"\n`);
  fs.chmodSync(fake, 0o755);
  // Ollama is played by a script answering its version on a port of its own.
  // Answers its version, and echoes a chat's body back as two lines, as Ollama streams.
  fs.writeFileSync(fakeOllama, `#!${process.execPath}\nrequire("node:http").createServer((q, s) => { if (q.method !== "POST") return s.end(JSON.stringify({ version: "fake" })); let b = ""; q.on("data", (c) => (b += c)); q.on("end", () => { if (/make-it-fail/.test(b)) { s.statusCode = 500; return s.end(JSON.stringify({ error: "model requires more system memory (40.0 GiB) than is available (20.0 GiB)" })); } if (/cut-me-off/.test(b)) { s.setHeader("Content-Type", "application/x-ndjson"); s.write(JSON.stringify({ message: { role: "assistant", content: "", thinking: "hmm" } }) + "\\n"); return setTimeout(() => s.destroy(), 50); } s.setHeader("Content-Type", "application/x-ndjson"); s.write(JSON.stringify({ message: { role: "assistant", content: "echo" }, got: JSON.parse(b) }) + "\\n"); s.end(JSON.stringify({ done: true }) + "\\n"); }); }).listen(${ollamaPort}, "127.0.0.1");\n`);
  fs.chmodSync(fakeOllama, 0o755);
  // A half-written part from a download cut off before the restart.
  fs.mkdirSync(path.join(modelsDir, "x", "y", "unet"), { recursive: true });
  fs.writeFileSync(path.join(modelsDir, "x", "y", "unet", "stale.safetensors.part"), "half");
  agent = spawn(process.execPath, [path.join(here, "..", "gpu", "agent.js")], {
    // The Python side is played by a Node script that speaks the same protocol.
    env: { ...process.env, HF_OLLAMA_BIN: fakeOllama, OLLAMA_HOST: `127.0.0.1:${ollamaPort}`, HF_AGENT_PORT: "0", HF_AGENT_HOST: "127.0.0.1", HF_MODELS_DIR: modelsDir, SD_SERVER: fake, SD_PORT: String(sdPort), HF_HUB: stub.base, HF_ORIGINS: `${ORIGIN},http://localhost:*`, HF_AGENT_TOKEN: SECRET, FAKE_SD_LOG: sdLog, HF_CHUNK_BYTES: "16384", HF_CHUNK_STREAMS: "3", HF_PYTHON: process.execPath, HF_WORKER: path.join(here, "fake-worker.js"), FAKE_WORKER_LOG: workerLog, HF_FFMPEG: path.join(here, "fake-ffmpeg.js"), HF_DISK_GB: "50", HF_TUNNEL_DIR: path.join(home, "tunnels"), HF_CIVITAI_ORIGIN: `http://127.0.0.1:${civitai.address().port}` },
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
  civitai?.close();
  agent.kill();
  stub.server.close();
});

// The secret the agent was started with goes with every request, as the site's and the page's do.
const SECRET = "test-agent-secret-0123456789";
const AUTH = { Authorization: `Bearer ${SECRET}` };
const get = (p, headers = {}) => fetch(base + p, { headers: { ...AUTH, ...headers } });
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...AUTH, ...headers }, body: JSON.stringify(body) });
const del = (p, body) => fetch(base + p, { method: "DELETE", headers: { "Content-Type": "application/json", ...AUTH }, body: JSON.stringify(body) });
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
  // Both startup checks spawn a process; on a busy machine they take a while.
  for (let i = 0; i < 200; i++) {
    const h = await (await get("/health")).json();
    if (h.sdOk !== null && h.pyOk !== null) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const h = await (await get("/health")).json();
  assert.ok(h.diskFreeGb > 0 && h.diskTotalGb >= h.diskFreeGb, "the room on the models disk");
  // The disk is a 50 GB quota on this computer's far larger disk: the room is the quota less what the agent's folders hold.
  assert.equal(h.diskTotalGb, 50, "the size the site gave, not the pool's");
  assert.ok(typeof h.diskUsedGb === "number" && h.diskUsedGb >= 0 && h.diskUsedGb < 1, "what is on it so far");
  assert.ok(h.diskFreeGb <= 50 && h.diskFreeGb > 49, "the quota less that");
  // Grown since: the site says the new size with its health call, and the agent goes by it.
  const grownH = await (await get("/health?diskGb=70")).json();
  assert.deepEqual([grownH.diskTotalGb, grownH.diskFreeGb > 69], [70, true]);
  assert.equal((await (await get("/health")).json()).diskTotalGb, 70, "and keeps it");
  assert.ok(!fs.existsSync(path.join(modelsDir, "x", "y", "unet", "stale.safetensors.part")), "a half-written part from before the restart is swept at startup");
  delete h.diskFreeGb;
  delete h.diskTotalGb;
  delete h.diskUsedGb;
  assert.deepEqual({ ...h, idleSeconds: 0 }, { ok: true, version: "29", sdOk: true, sdProblem: "", pyOk: true, pyProblem: "", gpu: "Fake A40", vramGb: 48, fp8: null, loaded: null, ready: false, loading: false, models: 0, busy: false, idleSeconds: 0, idleMinutes: 30, leaseUntil: null }, "both engines' startup checks passed; nothing is being worked on");
  // On Vast.ai the Cloudflare tunnels' addresses are read from their logs
  // and said on /health: the latest each, since a dropped tunnel comes back
  // with a new one.
  fs.mkdirSync(path.join(home, "tunnels"), { recursive: true });
  fs.writeFileSync(path.join(home, "tunnels", "hf-tunnel-ollama.log"), "INF Requesting new quick Tunnel on trycloudflare.com...\nINF |  https://old-words-here.trycloudflare.com  |\nERR lost connection\nINF |  https://brave-new-words.trycloudflare.com  |\n");
  fs.writeFileSync(path.join(home, "tunnels", "hf-tunnel-agent.log"), "INF |  https://agent-side-words.trycloudflare.com  |\n");
  assert.deepEqual((await (await get("/health")).json()).tunnels, { ollama: "https://brave-new-words.trycloudflare.com", agent: "https://agent-side-words.trycloudflare.com" });
  fs.rmSync(path.join(home, "tunnels"), { recursive: true, force: true });
  const pre = await fetch(`${base}/jobs`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal((await get("/health", { Origin: "http://localhost:4188" })).status, 200, "a pattern with a wildcard port");
  assert.equal((await get("/health", { Origin: "https://evil.example" })).status, 403);
  assert.equal((await get("/health", { Origin: "https://evil.example" })).headers.get("access-control-allow-origin"), null);
  // Started with a secret, it answers nobody without it, whatever the
  // route; the preflight passes, as a browser sends that before any header.
  assert.equal((await fetch(`${base}/health`)).status, 401, "no secret");
  assert.equal((await fetch(`${base}/health`, { headers: { Authorization: "Bearer wrong" } })).status, 401, "the wrong one");
  assert.equal((await fetch(`${base}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: REPO, file: FILE, prompt: "a cat" }) })).status, 401);
  assert.equal((await fetch(`${base}/models`)).status, 401);
  assert.match((await (await fetch(`${base}/health`)).json()).error, /did not carry its secret/);
  assert.equal(pre.headers.get("access-control-allow-headers"), "Content-Type, Authorization, X-Agent-Token", "a page may send the secret either way");
  const asked = await fetch(`${base}/jobs`, { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type, x-future-header" } });
  assert.equal(asked.headers.get("access-control-allow-headers"), "content-type, x-future-header", "whatever a newer page asks to send is allowed; the secret check decides");
  assert.equal((await fetch(`${base}/health`, { headers: { "X-Agent-Token": SECRET } })).status, 200, "the secret in a header of its own, for a proxy that drops the standard one");
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
  // A big file comes in pieces over several connections at once, and lands whole and in order.
  const pieces = stub.requests.filter((r) => r.path.endsWith(`/${FILE}`) && r.range).map((r) => r.range);
  assert.deepEqual(pieces.sort(), ["bytes=0-16383", "bytes=16384-32767", "bytes=32768-49151", "bytes=49152-65535"], "four pieces of sixteen kilobytes");
  assert.ok(fs.readFileSync(path.join(modelsDir, "second-state", "stable-diffusion-v1-5-GGUF", FILE)).equals(Buffer.alloc(64 * 1024, FILE)), "the pieces in their places");
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

test("a folder-layout model is fetched in parts and merged into one checkpoint; the parts are removed", async () => {
  const PONY = "John6666/pony-realism-v23-sdxl";
  const files = [
    { from: "unet/diffusion_pytorch_model.fp16.safetensors", to: "unet/diffusion_pytorch_model.safetensors" },
    { from: "vae/diffusion_pytorch_model.fp16.safetensors", to: "vae/diffusion_pytorch_model.safetensors" },
    { from: "text_encoder/model.fp16.safetensors", to: "text_encoder/model.safetensors" },
    { from: "text_encoder_2/model.fp16.safetensors", to: "text_encoder_2/model.safetensors" },
  ];
  assert.equal((await post("/download-folder", { repo: PONY, files: [{ from: "../etc/passwd" }], into: "x.safetensors" })).status, 400);
  assert.equal((await post("/download-folder", { repo: PONY, files, into: "x.gguf" })).status, 400, "the merge is a safetensors checkpoint");
  const res = await post("/download-folder", { repo: PONY, files, into: "pony-realism-v23-sdxl.safetensors" });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].status, "file 1 of 4: unet/diffusion_pytorch_model.fp16.safetensors");
  assert.ok(lines.some((l) => /^Merging unet/.test(l.status)), "the converter reports what it merges");
  assert.equal(lines.at(-1).status, "success", JSON.stringify(lines.at(-1)));
  const dir = path.join(modelsDir, "John6666", "pony-realism-v23-sdxl");
  assert.ok(fs.existsSync(path.join(dir, "pony-realism-v23-sdxl.safetensors")));
  assert.ok(!fs.existsSync(path.join(dir, "unet")), "the parts are gone once merged");
  const { models } = await (await get("/models")).json();
  assert.ok(models.some((m) => m.repo === PONY && m.file === "pony-realism-v23-sdxl.safetensors"));
  const again = (await (await post("/download-folder", { repo: PONY, files, into: "pony-realism-v23-sdxl.safetensors" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(again[0].status, "already here");
  assert.equal((await del("/models", { repo: PONY, file: "pony-realism-v23-sdxl.safetensors" })).status, 200);
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

test("a diffusers-family model is fetched as a folder, loaded by the Python worker, and makes a picture or a clip", async () => {
  const QWEN = "Qwen/Qwen-Image";
  const files = ["model_index.json", "transformer/config.json", "transformer/diffusion_pytorch_model-00001-of-00002.safetensors", "vae/diffusion_pytorch_model.safetensors"];
  assert.equal((await post("/download-repo", { repo: QWEN, files: ["transformer/config.json"] })).status, 400, "without the index nothing loads");
  assert.equal((await post("/download-repo", { repo: QWEN, files: ["model_index.json", "a/b/c/d.safetensors"] })).status, 400, "too deep");
  // The machine weighs the model against its disk before the first byte, and says what it has.
  const health = await (await get("/health")).json();
  assert.ok(health.diskFreeGb > 0 && health.diskTotalGb >= health.diskFreeGb, JSON.stringify(health));
  const noRoom = (await (await post("/download-repo", { repo: QWEN, files, gb: 1e6 })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(noRoom.at(-1).error, /the machine has [\d.]+ GB free of its \d+ GB disk, and the model's 4 files needs 1000000\.0 GB\. Grow the disk from the model's window/);
  assert.ok(!fs.existsSync(path.join(modelsDir, "Qwen", "Qwen-Image")), "nothing was fetched");
  const res = await post("/download-repo", { repo: QWEN, files });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].status, "file 1 of 4: model_index.json");
  assert.equal(lines.at(-1).status, "success", JSON.stringify(lines.at(-1)));
  const dir = path.join(modelsDir, "Qwen", "Qwen-Image");
  assert.ok(fs.existsSync(path.join(dir, "transformer", "diffusion_pytorch_model-00001-of-00002.safetensors")));
  const { models } = await (await get("/models")).json();
  const entry = models.find((m) => m.repo === QWEN);
  assert.equal(entry.file, "model_index.json", "a folder model is listed by its index");
  assert.equal(entry.engine, "diffusers");
  assert.deepEqual(entry.files.sort(), [...files].sort(), "with the files it holds, so a download that stopped partway is told from a whole one");
  assert.ok(entry.gb > 0);
  // Fetching again only fills gaps.
  const again = (await (await post("/download-repo", { repo: QWEN, files })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(again[0].status, "already here");
  // A picture through the worker, with the diffusers-style settings.
  const job = await (await post("/jobs", { repo: QWEN, file: "model_index.json", prompt: "a lighthouse", negative: "blurry", steps: 28, width: 1024, height: 768, cfg: 4, cache: 0.1 })).json();
  const done = await finish(job.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.kind, "image");
  assert.match(done.image, /^iVBOR/);
  const asked = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([asked.op, asked.prompt, asked.negative, asked.steps, asked.width, asked.height, asked.cfg, asked.cache], ["generate", "a lighthouse", "blurry", 28, 1024, 768, 4, 0.1], "the pass-skipping threshold goes to the worker");
  const plainLoad = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.op === "load").at(-1);
  assert.equal(plainLoad.fp8, undefined, "nothing asked, nothing sent");
  assert.equal(plainLoad.compile, undefined);
  // The same model asked for with fp8 weights and compiled blocks is loaded again that way.
  const quick = await (await post("/jobs", { repo: QWEN, file: "model_index.json", prompt: "a lighthouse", steps: 28, width: 1024, height: 768, cfg: 4, fp8: true, compile: true })).json();
  assert.equal((await finish(quick.id)).status, "completed");
  const quickLoad = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.op === "load").at(-1);
  assert.deepEqual([quickLoad.fp8, quickLoad.compile], [true, true], "fp8 weights and compiled blocks go with the load");
  assert.ok(quickLoad !== plainLoad && fs.readFileSync(workerLog, "utf8").trim().split("\n").filter((l) => JSON.parse(l).op === "load").length >= 2, "loaded again for the change");
  const h = await (await get("/health")).json();
  assert.equal(h.loaded, `${QWEN}/model_index.json`);
  assert.equal(h.ready, true);
  // A seed goes to the worker and comes back with the job, so a reply can
  // keep to it; a seed out of range is dropped rather than refused.
  const seeded = await (await post("/jobs", { repo: QWEN, file: "model_index.json", prompt: "a lighthouse", seed: 42 })).json();
  assert.equal((await finish(seeded.id)).seed, 42);
  assert.equal(fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1).seed, 42);
  const unseeded = await (await post("/jobs", { repo: QWEN, file: "model_index.json", prompt: "a lighthouse", seed: -5 })).json();
  assert.equal((await finish(unseeded.id)).seed, null);
  assert.equal(fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1).seed, undefined);
  // A failed generation is explained; the worker stays up for the next one.
  const bad = await (await post("/jobs", { repo: QWEN, file: "model_index.json", prompt: "fail please" })).json();
  assert.match((await finish(bad.id)).error, /the model choked/);
  // A video family answers with a clip.
  const WAN = "Wan-AI/Wan2.2-TI2V-5B-Diffusers";
  await post("/download-repo", { repo: WAN, files: ["model_index.json", "transformer/diffusion_pytorch_model.safetensors"] }).then((r) => r.text());
  const clip = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves at dusk", frames: 33, width: 832, height: 480, steps: 20 })).json();
  const made = await finish(clip.id);
  assert.equal(made.status, "completed", made.error);
  assert.equal(made.kind, "video");
  assert.equal(Buffer.from(made.video, "base64").toString(), "fake mp4 bytes");
  const askedClip = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([askedClip.frames, askedClip.width, askedClip.height], [33, 832, 480]);
  // A picture the clip ends on travels with the job, beside the one it starts from.
  const png = `data:image/png;base64,${"A".repeat(400)}`;
  const ending = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves, back to the start", frames: 33, init: png, lastInit: png })).json();
  assert.equal((await finish(ending.id)).status, "completed");
  const askedEnding = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([askedEnding.init, askedEnding.lastInit], ["400 chars", "400 chars"]);
  assert.equal((await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "x", frames: 33, lastInit: "not a picture!" })).status, 400, "a last picture has to arrive intact");
  // Reference pictures travel too, and ask for the model's reference workflow.
  const refs = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "the three of them holding hands", frames: 33, references: [png, png, png] })).json();
  assert.equal((await finish(refs.id)).status, "completed");
  const logged = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(logged.at(-1).references, ["400 chars", "400 chars", "400 chars"]);
  assert.equal(logged.filter((l) => l.op === "load").at(-1).workflow, "ref2va", "loaded for the reference workflow");
  assert.equal((await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "x", frames: 33, references: Array(10).fill(png) })).status, 400, "nine at most");
  // A lean poll leaves the clip out and says it waits; the bytes come apart from the status.
  const lean = await (await get(`/jobs/${clip.id}?lean=1`)).json();
  assert.deepEqual([lean.status, lean.video, lean.image, lean.result, lean.bytes], ["completed", null, null, true, 14]);
  const raw = await get(`/jobs/${clip.id}/result`);
  assert.equal(raw.headers.get("content-type"), "video/mp4");
  assert.equal(Buffer.from(await raw.arrayBuffer()).toString(), "fake mp4 bytes");
  assert.equal((await get(`/jobs/${bad.id}/result`)).status, 409, "a job that made nothing has no result");
  // The clip's last frame is kept apart, for whatever starts from it.
  assert.equal(lean.last, true);
  const lastFrame = await get(`/jobs/${clip.id}/last`);
  assert.equal(lastFrame.headers.get("content-type"), "image/png");
  assert.match(Buffer.from(await lastFrame.arrayBuffer()).toString("base64"), /^iVBOR/);
  assert.equal((await get(`/jobs/${bad.id}/last`)).status, 404, "a failed job has none");
  // Pieces of a long clip are joined into one on the machine, in order.
  const second = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves, later", frames: 33 })).json();
  assert.equal((await finish(second.id)).status, "completed");
  assert.equal((await post("/jobs/join", { ids: [clip.id] })).status, 400, "one clip is nothing to join");
  assert.equal((await post("/jobs/join", { ids: [clip.id, "0000000000000000"] })).status, 404);
  assert.equal((await post("/jobs/join", { ids: [clip.id, bad.id] })).status, 409, "every piece has to be a finished clip");
  const joinRes = await post("/jobs/join", { ids: [clip.id, second.id] });
  assert.equal(joinRes.status, 202);
  const joined = await finish((await joinRes.json()).id);
  assert.equal(joined.status, "completed", joined.error);
  assert.equal(joined.kind, "video");
  assert.equal(joined.last, true, "the joined clip's last frame is the last piece's");
  assert.equal(Buffer.from(await (await get(`/jobs/${joined.id}/result`)).arrayBuffer()).toString(), "fake mp4 bytesfake mp4 bytes", "the pieces, in order, as one file");
  // A piece the machine no longer has (one shot of a clip made again, the
  // rest kept in the browser) is sent up as the clip itself and joined in its place.
  const mixed = await post("/jobs/join", { pieces: [{ video: Buffer.from("kept shot 1").toString("base64") }, { id: second.id }, { video: Buffer.from("kept shot 3").toString("base64") }] });
  assert.equal(mixed.status, 202);
  const rejoined = await finish((await mixed.json()).id);
  assert.equal(rejoined.status, "completed", rejoined.error);
  assert.equal(Buffer.from(await (await get(`/jobs/${rejoined.id}/result`)).arrayBuffer()).toString(), "kept shot 1fake mp4 byteskept shot 3", "the sent pieces and the one on the machine, in order");
  assert.equal((await post("/jobs/join", { pieces: [{ video: "not base64!" }, { id: second.id }] })).status, 400, "a clip sent up has to arrive intact");
  assert.equal((await post("/jobs/join", { pieces: [{}, { id: second.id }] })).status, 400, "a piece is a job here or a clip sent up");
  // A reset from the page while a job is in flight stops the worker on it:
  // the job fails with the reason instead of being waited for, and the next
  // job starts a fresh worker and loads the model again.
  const slow = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves, slowly", frames: 33 })).json();
  for (let i = 0; i < 100 && (await (await get(`/jobs/${slow.id}?lean=1`)).json()).progress == null; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((await (await get(`/jobs/${slow.id}?lean=1`)).json()).status, "generating");
  const reset = await (await post("/unload", {})).json();
  assert.deepEqual(reset, { ok: true, stopped: true });
  const stopped = await finish(slow.id);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error, /reset from the page while working on this/);
  assert.equal((await (await get("/health")).json()).loaded, null);
  const countLoads = () => fs.readFileSync(workerLog, "utf8").trim().split("\n").filter((l) => JSON.parse(l).op === "load").length;
  const beforeReset = countLoads();
  const after = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves after the reset", frames: 33 })).json();
  assert.equal((await finish(after.id)).status, "completed");
  assert.equal(countLoads() - beforeReset, 1, "a fresh worker loaded the model again");
  // A ten-second clip at 24 fps, as MiniMax-H3 makes, is within the frame limit.
  const long = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "a long walk", frames: 243, fps: 24, width: 1344, height: 768, steps: 30 })).json();
  assert.equal((await finish(long.id)).status, "completed");
  const askedLong = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([askedLong.frames, askedLong.fps, askedLong.width, askedLong.height], [243, 24, 1344, 768]);
  // Running out of memory drops the worker's model and says so: the agent
  // forgets it too and loads it again for the next job.
  const loads = () => fs.readFileSync(workerLog, "utf8").trim().split("\n").filter((l) => JSON.parse(l).op === "load").length;
  const oom = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "out of memory please", frames: 33 })).json();
  assert.match((await finish(oom.id)).error, /ran out of memory/);
  assert.equal((await (await get("/health")).json()).loaded, null, "nothing is loaded after it");
  let before = loads();
  const next = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves again", frames: 33 })).json();
  assert.equal((await finish(next.id)).status, "completed");
  assert.equal(loads() - before, 1, "loaded again first");
  // An older worker drops it without a word: the agent's stale record sends
  // the next job to an empty worker, and the answer "no model is loaded"
  // has it load the model again and ask once more, with no failure shown.
  const quiet = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "out of memory quietly", frames: 33 })).json();
  assert.match((await finish(quiet.id)).error, /ran out of memory/);
  assert.equal((await (await get("/health")).json()).loaded, `${WAN}/model_index.json`, "the agent still believes it loaded");
  before = loads();
  const healed = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "waves once more", frames: 33 })).json();
  assert.equal((await finish(healed.id)).status, "completed");
  assert.equal(loads() - before, 1, "loaded again, then made");
  // The site can drop the worker's model outright.
  assert.equal((await post("/unload", {})).status, 200);
  assert.equal((await (await get("/health")).json()).loaded, null);
  before = loads();
  const fresh = await (await post("/jobs", { repo: WAN, file: "model_index.json", prompt: "after the reset", frames: 33 })).json();
  assert.equal((await finish(fresh.id)).status, "completed");
  assert.equal(loads() - before, 1);
  // Going back to sd-server hands the card over: the worker's model is unloaded first.
  const sd = await (await post("/jobs", { repo: REPO, file: FILE, prompt: "a boat" })).json();
  assert.equal((await finish(sd.id)).status, "completed");
  assert.equal((await (await get("/health")).json()).loaded, `${REPO}/${FILE}`);
  // Removing a folder model removes the whole folder.
  assert.equal((await del("/models", { repo: QWEN, file: "model_index.json" })).status, 200);
  assert.ok(!fs.existsSync(dir));
  assert.equal((await del("/models", { repo: WAN, file: "model_index.json" })).status, 200);
});

test("an add-on is kept apart from the models and applied by the worker to a base checkpoint with a reference picture", async () => {
  const ADDON = "h94/IP-Adapter-FaceID";
  const files = ["ip-adapter-faceid_sd15.bin", "ip-adapter-faceid_sd15_lora.safetensors"];
  assert.equal((await post("/download-addon", { repo: ADDON, files: ["../x"] })).status, 400);
  const res = await post("/download-addon", { repo: ADDON, files });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).status, "success", JSON.stringify(lines.at(-1)));
  const listed = await (await get("/models")).json();
  assert.deepEqual(listed.addons.map((a) => [a.repo, a.file]), files.map((f) => [ADDON, f]));
  assert.ok(!listed.models.some((m) => m.repo === ADDON), "an add-on is not a model");
  // A base checkpoint to apply it to, as a single file the worker loads.
  const BASE = "someone/sd-base";
  const basePath = path.join(modelsDir, "someone", "sd-base", "sd-v1-5.safetensors");
  fs.mkdirSync(path.dirname(basePath), { recursive: true });
  fs.writeFileSync(basePath, "fake checkpoint");
  assert.equal((await post("/jobs", { repo: REPO, file: FILE, prompt: "x", addon: { repo: ADDON, file: files[0] } })).status, 400, "not onto a GGUF");
  const ref = `data:image/png;base64,${"B".repeat(200)}`;
  const job = await (await post("/jobs", { repo: BASE, file: "sd-v1-5.safetensors", prompt: "a portrait", addon: { kind: "ip-adapter", repo: ADDON, file: files[0], lora: files[1], scale: 0.7 }, ipImage: ref, width: 512, height: 512, steps: 25 })).json();
  const done = await finish(job.id);
  assert.equal(done.status, "completed", done.error);
  const asked = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const load = asked.filter((r) => r.op === "load").at(-1);
  assert.equal(load.file, basePath, "the base is loaded from its single file");
  assert.deepEqual(load.adapters.map((a) => [a.kind, path.basename(a.path), path.basename(a.lora), a.scale, a.faceid, a.plus, a.xl]), [["ip-adapter", files[0], files[1], 0.7, true, false, false]]);
  const gen = asked.at(-1);
  assert.equal(gen.ipImage, "200 chars");
  assert.equal((await (await get("/health")).json()).loaded, `${BASE}/sd-v1-5.safetensors`);
  // Without the reference picture the worker says so.
  const bare = await (await post("/jobs", { repo: BASE, file: "sd-v1-5.safetensors", prompt: "a portrait", addon: { repo: ADDON, file: files[0] } })).json();
  assert.match((await finish(bare.id)).error, /needs a reference picture/);
  assert.equal((await del("/models", { repo: ADDON, file: files[0], addon: true })).status, 200);
  assert.equal((await del("/models", { repo: ADDON, file: files[0], addon: true })).status, 404);
  assert.equal((await (await get("/models")).json()).addons.length, 1);
  assert.equal((await del("/models", { repo: BASE, file: "sd-v1-5.safetensors" })).status, 200, "removing the base the worker holds");
  assert.equal((await (await get("/health")).json()).loaded, null);
});

test("a model the image server cannot load is explained with the server's own words, and a download that ends short is not kept", async () => {
  const BAD = "someone/broken-model";
  const file = path.join(modelsDir, "someone", "broken-model", "broken.safetensors");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not a model");
  const job = await (await post("/jobs", { repo: BAD, file: "broken.safetensors", prompt: "a cat" })).json();
  const done = await finish(job.id);
  assert.equal(done.status, "failed");
  assert.match(done.error, /stopped while loading the model\. The server said: .*unknown tensor.*new_sd_ctx_t failed/);
  const log = await (await get("/log")).json();
  assert.equal(log.lastFailure.file, `${BAD}/broken.safetensors`);
  assert.match(log.lastFailure.report, /new_sd_ctx_t failed/);
  assert.match(log.sd, /new_sd_ctx_t failed/);
  fs.rmSync(path.dirname(file), { recursive: true, force: true });
  const short = (await (await post("/download", { repo: REPO, file: "short.bin" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(short.at(-1).error, /ended early \(0\.00 of 0\.00 GB\); try again/);
  assert.ok(!fs.existsSync(path.join(modelsDir, "second-state", "stable-diffusion-v1-5-GGUF", "short.bin")), "nothing half-written is kept");
});

test("the machine stops itself when nothing has used it and the site has not renewed its lease; a lease or a download keeps it up", async () => {
  const spawnAgent = (env) => {
    const child = spawn(process.execPath, [path.join(here, "..", "gpu", "agent.js")], { env: { ...process.env, HF_AGENT_PORT: "0", HF_AGENT_HOST: "127.0.0.1", HF_MODELS_DIR: path.join(home, "idle-models"), SD_SERVER: path.join(home, "sd-server"), HF_PYTHON: process.execPath, HF_WORKER: path.join(here, "fake-worker.js"), HF_IDLE_CHECK_MS: "100", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const url = new Promise((resolve) => child.stdout.on("data", () => {
      const m = /listening on 127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve(`http://127.0.0.1:${m[1]}`);
    }));
    const exit = new Promise((resolve) => child.on("exit", (code) => resolve({ code, out })));
    return { child, url, exit };
  };
  // Half a second of idle time: it exits on its own, saying why.
  const a = spawnAgent({ HF_IDLE_MINUTES: "0.01" });
  await a.url;
  const ended = await Promise.race([a.exit, new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(ended, "the agent stopped itself");
  assert.equal(ended.code, 0);
  assert.match(ended.out, /No activity .* stopping the machine to end the bill/);
  // With a lease from the site it stays up past its idle time (a lease is at most the idle time, renewed by the site while there is activity).
  const b = spawnAgent({ HF_IDLE_MINUTES: "0.05" });
  const burl = await b.url;
  const lease = await (await fetch(`${burl}/lease`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: 1 }) })).json();
  assert.ok(lease.leaseUntil > Date.now());
  const h = await (await fetch(`${burl}/health`)).json();
  assert.equal(h.idleMinutes, 0.05);
  const early = await Promise.race([b.exit, new Promise((r) => setTimeout(() => r(null), 1500))]);
  assert.equal(early, null, "still up under the lease");
  const later = await Promise.race([b.exit, new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(later && later.code === 0, "and gone once the lease has run out without renewal");
  // On Vast.ai the machine asks Vast.ai to stop it, with the key Vast.ai gives every machine, then exits.
  const asked = [];
  const vastApi = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      asked.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      res.end(JSON.stringify({ success: true }));
    });
  });
  await new Promise((r) => vastApi.listen(0, "127.0.0.1", r));
  const v = spawnAgent({ HF_IDLE_MINUTES: "0.01", CONTAINER_ID: "5123", CONTAINER_API_KEY: "machine-key", HF_VAST_API: `http://127.0.0.1:${vastApi.address().port}/api/v0` });
  await v.url;
  const vended = await Promise.race([v.exit, new Promise((r) => setTimeout(() => r(null), 5000))]);
  vastApi.close();
  assert.ok(vended && vended.code === 0, "it stopped itself");
  assert.deepEqual(asked, [{ method: "PUT", url: "/api/v0/instances/5123/", auth: "Bearer machine-key", body: { state: "stopped" } }]);
  assert.match(vended.out, /Asked Vast\.ai to stop this machine: HTTP 200/);
  // Idle time 0 means the day-long ceiling, not for ever.
  const c = spawnAgent({ HF_IDLE_MINUTES: "0", HF_IDLE_CEILING_MINUTES: "0.01" });
  await c.url;
  const ceiling = await Promise.race([c.exit, new Promise((r) => setTimeout(() => r(null), 5000))]);
  assert.ok(ceiling && ceiling.code === 0, "the ceiling ends it");
});

test("a download can run detached: the site gets an id and polls for the lines, so a dropped connection loses nothing", async () => {
  assert.equal((await get("/downloads/0123456789abcdef")).status, 404);
  const started = await post("/download", { repo: REPO, file: "ggml-tiny.bin", detach: true });
  assert.equal(started.status, 202);
  const { id, status } = await started.json();
  assert.equal(status, "running");
  let cursor = 0;
  const seen = [];
  let final;
  for (let i = 0; i < 100; i++) {
    const state = await (await get(`/downloads/${id}?after=${cursor}`)).json();
    seen.push(...state.lines);
    cursor = state.cursor;
    if (state.status !== "running") {
      final = state;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(final.status, "done", final.error);
  assert.equal(seen[0].status, "starting");
  assert.equal(seen.at(-1).status, "success");
  assert.ok(seen.some((l) => l.total && l.completed === l.total), "the progress lines were kept for the poll");
  const again = await (await get(`/downloads/${id}?after=${cursor}`)).json();
  assert.deepEqual(again.lines, [], "nothing new after the end");
  assert.equal((await del("/models", { repo: REPO, file: "ggml-tiny.bin" })).status, 200);
});

test("a download asked for twice is one task: the second request joins it, the list shows it, and a file in flight is waited for", async () => {
  const first = await (await post("/download", { repo: REPO, file: "slow.bin", detach: true })).json();
  const second = await (await post("/download", { repo: REPO, file: "slow.bin", detach: true })).json();
  assert.equal(second.id, first.id, "the same task");
  assert.equal(second.attached, true);
  const { tasks: listed } = await (await get("/downloads")).json();
  const mine = listed.find((t) => t.id === first.id);
  assert.deepEqual([mine.key, mine.status], [`/download|${REPO}|slow.bin`, "running"]);
  // A streamed request for the file meanwhile waits for the task's copy rather than failing.
  const streamed = (await (await post("/download", { repo: REPO, file: "slow.bin" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(streamed[0].status, /^waiting for slow\.bin, already being fetched/);
  assert.equal(streamed.at(-1).status, "success");
  assert.ok(streamed.some((l) => l.status === "already here"));
  for (let i = 0; i < 100; i++) {
    const state = await (await get(`/downloads/${first.id}`)).json();
    if (state.status !== "running") {
      assert.equal(state.status, "done", state.error);
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal((await del("/models", { repo: REPO, file: "slow.bin" })).status, 200);
});

test("removing a model unloads it and frees the disk", async () => {
  assert.equal((await del("/models", { repo: REPO, file: FILE })).status, 200);
  assert.equal((await del("/models", { repo: REPO, file: FILE })).status, 404);
  const h = await (await get("/health")).json();
  assert.equal(h.loaded, null);
  assert.equal(h.models, 0);
  assert.ok(!fs.existsSync(path.join(modelsDir, "second-state")));
});

test("the machine reports on itself: what it runs, holds, has loaded and how its failures went, with a journal on its disk", async () => {
  const d = await (await get("/diagnostics")).json();
  assert.equal(d.version, "29");
  assert.ok(d.agentUptimeSeconds >= 0);
  assert.deepEqual([d.env.HF_DISK_GB, typeof d.disk.totalGb, Array.isArray(d.models), Array.isArray(d.failures), typeof d.journal], ["50", "number", true, true, "string"]);
  assert.match(d.journal, /agent 29 started: disk 50 GB/);
  assert.match(d.journal, /job .* done|failed/, "jobs from the tests before are in it");
  assert.ok(d.failures.length > 0, "the failed jobs of the tests before are remembered");
  for (const k of ["at", "error", "jobId", "kind", "trace", "what"]) assert.ok(k in d.failures[0], `a failure carries ${k}`);
  assert.equal(typeof d.ollamaLog, "string", "Ollama's log is in the report");
  const text = await (await get("/journal?lines=50")).text();
  assert.match(text, /agent 29 started/);
  assert.ok(fs.existsSync(path.join(modelsDir, "..", "journal.log")), "the journal lives on the disk beside the models");
});

test("a chat model held up by an earlier reply is freed: Ollama is started afresh and answers again", async () => {
  const res = await fetch(`${base}/ollama/restart`, { method: "POST", headers: { Authorization: `Bearer ${SECRET}`, Origin: ORIGIN } });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.equal(body.ok, true);
  assert.equal((await (await fetch(`http://127.0.0.1:${ollamaPort}/api/version`)).json()).version, "fake");
  // A chat carried to Ollama: base64-wrapped in, decoded, streamed back line by line.
  const carried = await post("/chat", { b64: Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi <script>alert(1)</script>" }] })).toString("base64") });
  assert.equal(carried.status, 200);
  // The first line is the agent's own, at once, so the proxy in front of the machine sees a byte before Ollama's first word.
  const lines = (await carried.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], {}, "a heartbeat first");
  assert.deepEqual([lines[1].got.model, lines[1].got.messages[0].content, lines[1].got.stream, lines[2].done], ["m", "hi <script>alert(1)</script>", true, true], "the chat reached Ollama as sent, streaming");
  // Ollama's refusal comes as a line of its own, the headers being gone.
  const refused = await post("/chat", { b64: Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "make-it-fail" }] })).toString("base64") });
  assert.equal(refused.status, 200);
  assert.deepEqual((await refused.text()).trim().split("\n").map((l) => JSON.parse(l)).at(-1), { error: "model requires more system memory (40.0 GiB) than is available (20.0 GiB)" });
  // A reply that breaks off before its last line is said so, not left looking like an empty answer.
  const cut = (await (await post("/chat", { b64: Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "cut-me-off" }] })).toString("base64") })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(cut.at(-2).message.thinking, "hmm");
  assert.match(cut.at(-1).error, /^Ollama's reply ended early \(/);
  assert.equal((await post("/chat", { b64: "not base64 json" })).status, 400);
  assert.match(await (await get("/journal?lines=20")).text(), /ollama restarted from the page \(answering after \d+ s\)/);
  // Without the site's secret, nothing is restarted.
  assert.equal((await fetch(`${base}/ollama/restart`, { method: "POST" })).status, 401);
  spawnSync("pkill", ["-f", `${fakeOllama} serve`]);
});

test("an add-on from Civitai is fetched from its download address with the Civitai key, never the Hugging Face token; a job's LoRAs and fine-tune reach the worker", async () => {
  const civ = `http://127.0.0.1:${civitai.address().port}`;
  const file = "v101_f1001.safetensors";
  // Only Civitai's download address, and only for the files asked for.
  assert.equal((await post("/download-addon", { repo: "civitai/11", files: [file], sources: { [file]: "https://evil.example/x" }, civitaiToken: "civitai-key" })).status, 400);
  assert.equal((await post("/download-addon", { repo: "civitai/11", files: [file], sources: { "other.safetensors": `${civ}/api/download/models/101?fileId=1001` }, civitaiToken: "civitai-key" })).status, 400);
  // Without the key, Civitai's refusal is said plainly.
  let lines = (await (await post("/download-addon", { repo: "civitai/11", files: [file], token: "hf-token-never-for-civitai", sources: { [file]: `${civ}/api/download/models/101?fileId=1001` } })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.match(lines.at(-1).error, /Civitai refused the download: it needs your Civitai API token/);
  assert.equal(civitaiAsked.at(-1).auth, null, "the Hugging Face token never goes to Civitai");
  lines = (await (await post("/download-addon", { repo: "civitai/11", files: [file], sources: { [file]: `${civ}/api/download/models/101?fileId=1001` }, civitaiToken: "civitai-key" })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).status, "success", JSON.stringify(lines.at(-1)));
  assert.equal(civitaiAsked.at(-1).url, "/api/download/models/101?fileId=1001");
  const kept = path.join(home, "addons", "civitai", "11", file);
  assert.equal(fs.readFileSync(kept, "utf8"), "lora-weight");
  // A fine-tune already on the machine, and a video model to use them with.
  const ft = path.join(home, "addons", "civitai", "2877206", "v3391862_f3281578.safetensors");
  fs.mkdirSync(path.dirname(ft), { recursive: true });
  fs.writeFileSync(ft, "finetune");
  const dir = path.join(modelsDir, "test", "Video-Model");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "model_index.json"), JSON.stringify({ _class_name: "MiniMaxH3ModularPipeline" }));
  assert.equal((await post("/jobs", { repo: "test/Video-Model", file: "model_index.json", prompt: "a dancer", loras: [{ repo: "civitai/11", file: "../../etc/passwd" }] })).status, 400, "names are checked");
  assert.equal((await post("/jobs", { repo: "test/Video-Model", file: "model_index.json", prompt: "a dancer", loras: Array.from({ length: 5 }, () => ({ repo: "civitai/11", file })) })).status, 400, "four LoRAs at most");
  const res = await post("/jobs", { repo: "test/Video-Model", file: "model_index.json", prompt: "a dancer", frames: 33, fps: 16, loras: [{ repo: "civitai/11", file, scale: 0.7 }], finetune: { repo: "civitai/2877206", file: "v3391862_f3281578.safetensors" } });
  assert.equal(res.status, 202, await res.clone().text());
  await finish((await res.json()).id);
  const load = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.op === "load").at(-1);
  assert.deepEqual(load.adapters, [{ kind: "transformer", path: ft }, { kind: "lora", path: kept, scale: 0.7 }]);
});

