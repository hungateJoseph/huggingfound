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
const workerLog = path.join(home, "worker-requests.log");
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
    // The Python side is played by a Node script that speaks the same protocol.
    env: { ...process.env, HF_AGENT_PORT: "0", HF_AGENT_HOST: "127.0.0.1", HF_MODELS_DIR: modelsDir, SD_SERVER: fake, SD_PORT: String(sdPort), HF_HUB: stub.base, HF_ORIGINS: `${ORIGIN},http://localhost:*`, FAKE_SD_LOG: sdLog, HF_PYTHON: process.execPath, HF_WORKER: path.join(here, "fake-worker.js"), FAKE_WORKER_LOG: workerLog },
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
  for (let i = 0; i < 40 && ((await (await get("/health")).json()).sdOk === null || (await (await get("/health")).json()).pyOk === null); i++) await new Promise((r) => setTimeout(r, 50));
  const h = await (await get("/health")).json();
  assert.deepEqual(h, { ok: true, version: "4", sdOk: true, sdProblem: "", pyOk: true, pyProblem: "", gpu: "Fake A40", vramGb: 48, loaded: null, ready: false, loading: false, models: 0 }, "both engines' startup checks passed");
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
  assert.ok(entry.gb > 0);
  // Fetching again only fills gaps.
  const again = (await (await post("/download-repo", { repo: QWEN, files })).text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(again[0].status, "already here");
  // A picture through the worker, with the diffusers-style settings.
  const job = await (await post("/jobs", { repo: QWEN, file: "model_index.json", prompt: "a lighthouse", negative: "blurry", steps: 28, width: 1024, height: 768, cfg: 4 })).json();
  const done = await finish(job.id);
  assert.equal(done.status, "completed", done.error);
  assert.equal(done.kind, "image");
  assert.match(done.image, /^iVBOR/);
  const asked = fs.readFileSync(workerLog, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([asked.op, asked.prompt, asked.negative, asked.steps, asked.width, asked.height, asked.cfg], ["generate", "a lighthouse", "blurry", 28, 1024, 768, 4]);
  const h = await (await get("/health")).json();
  assert.equal(h.loaded, `${QWEN}/model_index.json`);
  assert.equal(h.ready, true);
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

test("removing a model unloads it and frees the disk", async () => {
  assert.equal((await del("/models", { repo: REPO, file: FILE })).status, 200);
  assert.equal((await del("/models", { repo: REPO, file: FILE })).status, 404);
  const h = await (await get("/health")).json();
  assert.equal(h.loaded, null);
  assert.equal(h.models, 0);
  assert.ok(!fs.existsSync(path.join(modelsDir, "second-state")));
});
