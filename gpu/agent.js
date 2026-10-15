#!/usr/bin/env node
// The agent that runs on a rented GPU next to Ollama. It makes image models
// usable there the way Ollama makes chat models usable: it downloads a model
// file from Hugging Face onto the machine's disk, loads one into
// stable-diffusion.cpp's server, and takes picture requests from the
// person's browser directly, so nothing they ask for passes through the
// HuggingFound site. Plain Node, no dependencies, one file.
//
// Environment:
//   HF_AGENT_PORT   the port to listen on (7860)
//   HF_ORIGINS      browser origins allowed to call it, comma-separated,
//                   like OLLAMA_ORIGINS; falls back to OLLAMA_ORIGINS
//   HF_AGENT_TOKEN  a secret the site makes when it rents the machine; set,
//                   every request has to carry it (Authorization: Bearer),
//                   so nobody who learns the machine's address can use it
//   HF_MODELS_DIR   where model files live (/root/.ollama/huggingfound/models,
//                   on the persistent disk next to Ollama's models)
//   SD_SERVER       path to sd-server; SD_PORT the local port it listens on
//   HF_PYTHON       the Python that has torch and diffusers; HF_WORKER the
//                   worker script it runs (worker.py next to this file)
//   HF_TOKEN        a Hugging Face token for gated downloads (optional)
//   HF_IDLE_MINUTES minutes without activity before the machine stops
//                   itself (30); the site renews a lease while there is
//                   activity, so a site that cannot reach RunPod, a lost
//                   key or a closed laptop still ends the bill
//
// Two engines: stable-diffusion.cpp for single-file checkpoints (fast,
// small), and the diffusers library through worker.py for the families
// that only it loads (FLUX, Qwen-Image, Wan, Hunyuan and the rest of the
// folder layouts), which also make video. A folder model is handled by
// its model_index.json, so the rest of the app can treat it as a file.

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { convertDiffusersFolder } from "./convert.js";

const PORT = Number(process.env.HF_AGENT_PORT || 7860);
const HOST = process.env.HF_AGENT_HOST || "0.0.0.0";
const MODELS_DIR = process.env.HF_MODELS_DIR || "/root/.ollama/huggingfound/models";
const SD_SERVER = process.env.SD_SERVER || "/opt/huggingfound/bin/sd-server";
const SD_PORT = Number(process.env.SD_PORT || 7861);
const SD_URL = `http://127.0.0.1:${SD_PORT}`;
const HUB = process.env.HF_HUB || "https://huggingface.co";
const PYTHON = process.env.HF_PYTHON || "/opt/huggingfound/py/bin/python3";
const WORKER = process.env.HF_WORKER || path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.py");
const INDEX = "model_index.json";
// The machine's own idle watch. It counts picture jobs, downloads and
// lease renewals from the site as activity; when none has come for the
// idle time it exits, which stops the pod and its billing, with the disk
// kept. A hard ceiling applies even when the idle time is turned off.
const IDLE_MINUTES = Math.max(0, Number(process.env.HF_IDLE_MINUTES ?? 30)) || 0;
const IDLE_CEILING_MINUTES = Number(process.env.HF_IDLE_CEILING_MINUTES ?? 24 * 60);
const IDLE_CHECK_MS = Number(process.env.HF_IDLE_CHECK_MS ?? 30e3);
let lastActivity = Date.now();
let leaseUntil = 0;
function touchActivity() {
  lastActivity = Date.now();
}
function idleLimitMs() {
  return (IDLE_MINUTES > 0 ? IDLE_MINUTES : IDLE_CEILING_MINUTES) * 60e3;
}
function busy() {
  return downloading.size > 0 || [...tasks.values()].some((t) => t.status === "running") || [...jobs.values()].some((j) => ["loading", "queued", "generating"].includes(j.status));
}
function idleWatch() {
  if (busy()) {
    touchActivity();
    return;
  }
  const since = Date.now() - Math.max(lastActivity, leaseUntil - idleLimitMs());
  if (since < idleLimitMs() || Date.now() < leaseUntil) return;
  console.log(`No activity for ${Math.round(since / 60e3)} minutes and no lease from the site: stopping the machine to end the bill.`);
  stopServer();
  stopWorker();
  process.exit(0);
}
// Add-ons (IP-Adapters, LoRAs) live apart from models; they are applied to one.
const ADDONS_DIR = process.env.HF_ADDONS_DIR || path.join(MODELS_DIR, "..", "addons");
const ORIGINS = (process.env.HF_ORIGINS || process.env.OLLAMA_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const TOKEN = process.env.HF_AGENT_TOKEN || "";
const VERSION = "9";

const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/;
const FILE_RE = /^(?!\.+$)[\w.+-]+$/;
// A file up to two folders deep inside a repository (a diffusers layout's
// unet/diffusion_pytorch_model.safetensors), no dot-segments.
const SUBPATH_RE = /^(?!\.)[\w.+-]+(?:\/(?!\.)[\w.+-]+){0,2}$/;
const PART_DIRS = ["unet", "vae", "text_encoder", "text_encoder_2"];
const MAX_BODY = 12 * 1024 * 1024;
const JOB_TTL = 30 * 60e3;

fs.mkdirSync(MODELS_DIR, { recursive: true });
fs.mkdirSync(ADDONS_DIR, { recursive: true });

// A download cut off by a stop or a crash leaves a half-written .part on
// the disk. Nothing is downloading when the agent starts, so they go, and
// the room they took is back before the next download is weighed.
function sweepParts(dir) {
  let gone = 0;
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".part")) {
        fs.rmSync(full, { force: true });
        gone++;
      }
    }
  };
  try {
    walk(dir);
  } catch {
    // a disk that cannot be read is reported when it is used
  }
  if (gone) console.log(`Removed ${gone} half-written download part${gone === 1 ? "" : "s"} from ${dir}`);
}
sweepParts(MODELS_DIR);
sweepParts(ADDONS_DIR);

// Whether the image server can start at all on this machine, checked once
// at startup so a broken binary shows in the machine's status rather than
// at the first picture.
const sdCheck = { ok: null, problem: "" };
function checkServer() {
  const child = spawn(SD_SERVER, ["--help"], { stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  child.stderr.on("data", (c) => (err += c));
  child.on("error", (e) => {
    sdCheck.ok = false;
    sdCheck.problem = e.message;
  });
  child.on("exit", (code) => {
    if (sdCheck.ok === false) return;
    sdCheck.ok = code === 0;
    sdCheck.problem = code === 0 ? "" : err.trim().split("\n").pop() || `exit code ${code}`;
  });
}
checkServer();

// Whether the Python side (torch, diffusers, the GPU) works, checked once
// at startup the same way.
const pyCheck = { ok: null, problem: "", gpu: null, vramGb: null };
function checkWorker() {
  const child = spawn(PYTHON, [WORKER, "--check"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  child.on("error", (e) => {
    pyCheck.ok = false;
    pyCheck.problem = e.message;
  });
  child.on("exit", (code) => {
    if (pyCheck.ok === false) return;
    try {
      const info = JSON.parse(out.trim().split("\n").pop());
      pyCheck.ok = Boolean(info.ok && info.cuda !== false);
      pyCheck.problem = info.ok ? (info.cuda === false ? "torch sees no GPU" : "") : info.error;
      pyCheck.gpu = info.gpu ?? null;
      pyCheck.vramGb = info.vramGb ?? null;
    } catch {
      pyCheck.ok = false;
      pyCheck.problem = (err.trim().split("\n").pop() || `exit code ${code}`).slice(0, 300);
    }
  });
}
checkWorker();

// ---- the Python worker --------------------------------------------------------
// One long-lived process; requests go one at a time, each a line in and a
// line out, with progress lines in between.

const py = { proc: null, dir: null, key: null, kind: null, pending: null, chain: Promise.resolve(), tail: "" };

function stopWorker() {
  if (py.proc) {
    try {
      py.proc.kill();
    } catch {
      // already gone
    }
  }
  py.proc = null;
  py.dir = null;
  py.kind = null;
}

function startWorker() {
  if (py.proc) return;
  // The allocator grows its segments instead of leaving gaps between them,
  // which is the difference between fitting and not for a clip near the
  // card's limit.
  const proc = spawn(PYTHON, [WORKER], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTORCH_CUDA_ALLOC_CONF: process.env.PYTORCH_CUDA_ALLOC_CONF || "expandable_segments:True" } });
  py.proc = proc;
  py.tail = "";
  proc.stderr.on("data", (c) => (py.tail = (py.tail + c.toString()).slice(-4000)));
  const rl = readline.createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (!py.pending) return;
    if (msg.progress != null && msg.ok === undefined) {
      py.pending.touch?.();
      py.pending.onProgress?.(msg.progress);
      return;
    }
    const { resolve } = py.pending;
    py.pending = null;
    resolve(msg);
  });
  const gone = () => {
    if (py.proc !== proc) return;
    const pending = py.pending;
    py.pending = null;
    stopWorker();
    pending?.resolve({ ok: false, error: `the Python worker stopped: ${py.tail.trim().split("\n").pop() || "no output"}` });
  };
  proc.on("exit", gone);
  proc.on("error", (err) => {
    py.tail += `\n${err.message}`;
    gone();
  });
}

// Sends one request and waits for its answer; requests queue behind each other.
// `timeoutMs` is a silence: a long clip takes as long as it takes, and the
// worker is given up on only when nothing has come from it, not even a
// step of progress, for that long.
function askWorker(req, onProgress = null, timeoutMs = 60 * 60e3, onStart = null) {
  const run = () => new Promise((resolve) => {
    startWorker();
    if (!py.proc) return resolve({ ok: false, error: "the Python worker could not start" });
    onStart?.();
    let settled = false;
    let timer = null;
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (py.pending?.resolve === finish) py.pending = null;
      resolve(msg);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (settled) return;
        stopWorker();
        finish({ ok: false, error: `the Python worker gave no sign of life for ${Math.round(timeoutMs / 60e3)} minutes and was stopped; ask again` });
      }, timeoutMs);
    };
    arm();
    py.pending = { resolve: finish, onProgress, touch: arm };
    py.proc.stdin.write(`${JSON.stringify(req)}\n`, (err) => {
      if (err) finish({ ok: false, error: err.message });
    });
  });
  const next = py.chain.then(run, run);
  py.chain = next.catch(() => {});
  return next;
}

// Loads a folder model into the worker, replacing whatever either engine
// had: the two cannot share the card.
async function ensureWorkerLoaded(target, adapters = []) {
  const key = JSON.stringify([target, adapters]);
  if (py.proc && py.dir && py.key === key) return;
  stopServer();
  const req = { op: "load", adapters };
  if (target.endsWith(`/${INDEX}`)) req.dir = path.dirname(target);
  else req.file = target;
  const answer = await askWorker(req, null, 30 * 60e3);
  if (!answer.ok) throw new Error(answer.error || "the model did not load");
  py.dir = req.dir ?? req.file;
  py.key = key;
  py.kind = answer.kind ?? "image";
  py.note = answer.note || "";
  py.mode = answer.mode || "";
}

async function unloadWorker() {
  if (!py.proc) return;
  if (py.dir) await askWorker({ op: "unload" });
  forgetWorkerModel();
}

// The worker holds no model (it said so, or dropped it): the next job loads one.
function forgetWorkerModel() {
  py.dir = null;
  py.key = null;
  py.kind = null;
  py.note = "";
  py.mode = "";
}

// ---- the image server --------------------------------------------------------

const sd = { proc: null, file: null, ready: false, loading: null, errors: [], tail: "", lastFailure: null };

function stopServer() {
  if (sd.proc) {
    try {
      sd.proc.kill();
    } catch {
      // already gone
    }
  }
  sd.proc = null;
  sd.file = null;
  sd.ready = false;
  sd.loading = null;
}

// Loads a model into sd-server, replacing whatever was loaded. Waiting
// callers share one load.
function ensureLoaded(file) {
  if (sd.proc && sd.file === file && sd.ready) return Promise.resolve();
  if (sd.loading && sd.file === file) return sd.loading;
  stopServer();
  // The Python side gives the card back before sd-server takes it.
  const freed = unloadWorker().catch(() => {});
  sd.file = file;
  sd.errors = [];
  sd.tail = "";
  const argv = ["-m", file, "--listen-ip", "127.0.0.1", "--listen-port", String(SD_PORT), "--vae-tiling", "-v"];
  const proc = spawn(SD_SERVER, argv, { stdio: ["ignore", "pipe", "pipe"] });
  sd.proc = proc;
  const onData = (chunk) => {
    sd.tail = (sd.tail + chunk.toString()).slice(-6000);
    for (const line of chunk.toString().split(/\r?\n/)) if (/\[(ERROR|E)\]/.test(line)) sd.errors.push({ at: Date.now(), line: line.trim() });
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", () => {
    if (sd.proc === proc) stopServer();
  });
  proc.on("error", (err) => {
    sd.tail += `\n${err.message}`;
    if (sd.proc === proc) stopServer();
  });
  sd.loading = (async () => {
    await freed;
    for (let i = 0; i < 300; i++) {
      if (sd.proc !== proc) {
        sd.lastFailure = { file: path.relative(MODELS_DIR, file).split(path.sep).join("/"), at: Date.now(), report: failureReport() };
        throw new Error(`the image server stopped while loading the model. ${failureReport()}`);
      }
      try {
        const res = await fetch(`${SD_URL}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          sd.ready = true;
          sd.loading = null;
          return;
        }
      } catch {
        // still loading
      }
      await sleep(1000);
    }
    stopServer();
    throw new Error("the image server did not answer in five minutes");
  })();
  return sd.loading;
}

const lastLine = () => sd.tail.split("\n").filter(Boolean).pop() ?? "no output";

// Why the server died: its error and warning lines, then its last lines,
// so the person sees the cause (a truncated file, an unknown model format,
// a CUDA problem) rather than only "failed".
function failureReport() {
  const lines = sd.tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const notable = lines.filter((l) => /\[(ERROR|E|WARN|W)\]|error|failed|unknown|cannot|unsupported|out of memory|CUDA/i.test(l));
  const picked = [...new Set([...notable.slice(-6), ...lines.slice(-4)])];
  return picked.length ? `The server said: ${picked.join(" | ")}` : "The server printed nothing.";
}

// ---- jobs ------------------------------------------------------------------------
// One picture per job. The browser submits and polls; the agent loads the
// model if needed, hands the job to sd-server and follows it.

const jobs = new Map();

function startJob(input) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, status: "loading", createdAt: Date.now(), image: null, video: null, kind: "image", progress: null, error: null, note: "", seed: input.seed ?? null };
  jobs.set(id, job);
  (async () => {
    try {
      const file = modelFile(input.repo, input.file);
      if (!fs.existsSync(file)) throw new Error("that model is not on this machine yet");
      if (input.file === INDEX || input.addon) {
        // An add-on is applied by the Python side to a base it loads itself,
        // a folder or a single checkpoint.
        const adapters = [];
        if (input.addon) {
          const main = addonFile(input.addon.repo, input.addon.file);
          if (!fs.existsSync(main)) throw new Error("that add-on is not on this machine yet");
          const lora = input.addon.lora ? addonFile(input.addon.repo, input.addon.lora) : null;
          if (lora && !fs.existsSync(lora)) throw new Error("the add-on's LoRA is not on this machine yet");
          adapters.push({ kind: input.addon.kind, path: main, lora, scale: input.addon.scale, faceid: /faceid/i.test(input.addon.file), plus: /plus/i.test(input.addon.file), xl: /sdxl/i.test(input.addon.file) });
        }
        const req = { op: "generate", prompt: input.prompt, negative: input.negative, steps: input.steps, width: input.width, height: input.height, cfg: input.cfg, frames: input.frames, fps: input.fps, init: input.init, strength: input.init ? input.strength : undefined, ipImage: input.ipImage ?? undefined, seed: input.seed ?? undefined };
        let answer;
        for (let attempt = 0; ; attempt++) {
          await ensureWorkerLoaded(file, adapters);
          job.kind = py.kind;
          job.note = py.note;
          // Jobs take the worker one at a time: this one waits its turn.
          job.status = "queued";
          answer = await askWorker(req, (p) => (job.progress = p), 60 * 60e3, () => (job.status = "generating"));
          if (answer.ok) break;
          // The worker drops its model after running out of memory; a
          // record here that says otherwise would send the next job to an
          // empty worker, which answers "no model is loaded". Either way
          // the record is cleared, and a stale one is corrected by loading
          // the model again and asking once more.
          const stale = /no model is loaded/i.test(answer.error || "");
          if (answer.unloaded || stale) forgetWorkerModel();
          if (!stale || attempt > 0) throw new Error(answer.error || "the worker made nothing");
          job.status = "loading";
          job.progress = null;
        }
        if (answer.video) {
          job.video = answer.video;
          job.last = answer.last || null;
          job.kind = "video";
        } else if (answer.image) {
          job.image = answer.image;
          job.kind = "image";
        } else throw new Error("the worker returned no picture");
        job.status = "completed";
        return;
      }
      await ensureLoaded(file);
      job.status = "queued";
      const body = {
        prompt: input.prompt,
        negative_prompt: input.negative || "",
        width: input.width,
        height: input.height,
        seed: input.seed ?? -1,
        sample_params: { sample_steps: input.steps, sample_method: input.sampler, scheduler: input.scheduler, guidance: { txt_cfg: input.cfg } },
        vae_tiling_params: { enabled: true },
        output_format: "png",
      };
      if (input.init) {
        body.init_image = input.init;
        body.strength = input.strength;
      }
      const submitted = await fetch(`${SD_URL}/sdcpp/v1/img_gen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
      if (!submitted.ok) throw new Error(`the image server refused the request (HTTP ${submitted.status})`);
      const remote = await submitted.json();
      const started = Date.now();
      for (;;) {
        await sleep(1000);
        const err = sd.errors.find((e) => e.at >= started);
        if (err || !sd.proc) {
          stopServer();
          throw new Error(err ? err.line : "the image server stopped");
        }
        if (Date.now() - started > 30 * 60e3) throw new Error("no picture after 30 minutes");
        const res = await fetch(`${SD_URL}/sdcpp/v1/jobs/${encodeURIComponent(remote.id)}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error(`lost the image server while waiting (HTTP ${res.status})`);
        const state = await res.json();
        if (state.status === "generating") job.status = "generating";
        if (state.status === "completed") {
          const b64 = state.result?.images?.[0]?.b64_json;
          if (!b64) throw new Error("the image server returned no image");
          job.image = b64;
          job.status = "completed";
          return;
        }
        if (state.status === "failed" || state.status === "cancelled") throw new Error(state.error?.message ?? state.error?.error ?? JSON.stringify(state.error ?? state.status));
      }
    } catch (err) {
      job.status = "failed";
      job.error = err.message;
    }
  })();
  return job;
}

// Several clips joined into one, in order: the pieces of a long clip, each
// made from the last frame of the one before. ffmpeg copies the streams
// when they match (one model, one setting) and encodes afresh otherwise.
let ffmpegPath = process.env.HF_FFMPEG || "";
function ffmpeg() {
  if (ffmpegPath) return ffmpegPath;
  const probe = spawnSync(PYTHON, ["-c", "import imageio_ffmpeg,sys;sys.stdout.write(imageio_ffmpeg.get_ffmpeg_exe())"], { encoding: "utf8", timeout: 30000 });
  ffmpegPath = probe.status === 0 ? probe.stdout.trim() : "";
  if (!ffmpegPath) throw new Error("ffmpeg is not on this machine, so clips cannot be joined here");
  return ffmpegPath;
}
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpeg(), ["-y", "-loglevel", "error", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    proc.stderr.on("data", (c) => (err += c.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `ffmpeg exited ${code}`))));
  });
}
function startJoin(pieces) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, status: "generating", createdAt: Date.now(), image: null, video: null, kind: "video", progress: null, error: null, note: "", seed: null, joined: pieces.map((p) => p.id) };
  jobs.set(id, job);
  (async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hf-join-"));
    try {
      const files = pieces.map((p, i) => {
        const file = path.join(dir, `piece-${i + 1}.mp4`);
        fs.writeFileSync(file, Buffer.from(p.video, "base64"));
        return file;
      });
      const list = path.join(dir, "list.txt");
      fs.writeFileSync(list, files.map((f) => `file '${f}'`).join("\n") + "\n");
      const out = path.join(dir, "joined.mp4");
      try {
        await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
      } catch {
        await runFfmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", out]);
      }
      job.video = fs.readFileSync(out).toString("base64");
      job.last = pieces.at(-1).last || null;
      job.status = "completed";
    } catch (err) {
      job.status = "failed";
      job.error = `the pieces could not be joined: ${err.message}`;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  })();
  return job;
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL;
  for (const [id, job] of jobs) if (job.createdAt < cutoff) jobs.delete(id);
}, 60e3).unref();

// ---- model files ---------------------------------------------------------------------

function modelFile(repo, file, deep = false) {
  if (!REPO_RE.test(repo) || !(deep ? SUBPATH_RE : FILE_RE).test(file)) throw new Error("Bad model name");
  return path.join(MODELS_DIR, ...repo.split("/"), ...file.split("/"));
}

function addonFile(repo, file) {
  if (!REPO_RE.test(repo) || !SUBPATH_RE.test(file)) throw new Error("Bad add-on name");
  return path.join(ADDONS_DIR, ...repo.split("/"), ...file.split("/"));
}

// Every add-on file on the machine, by repository and path within it.
function listAddons() {
  const out = [];
  const walk = (dir, repo, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const sub = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(full, repo, sub);
      else if (entry.isFile() && !entry.name.endsWith(".part")) out.push({ repo, file: sub, gb: fs.statSync(full).size / 1024 ** 3 });
    }
  };
  if (!fs.existsSync(ADDONS_DIR)) return out;
  for (const owner of fs.readdirSync(ADDONS_DIR)) {
    const ownerDir = path.join(ADDONS_DIR, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (fs.statSync(repoDir).isDirectory()) walk(repoDir, `${owner}/${repo}`, "");
    }
  }
  return out;
}

function listModels() {
  const out = [];
  if (!fs.existsSync(MODELS_DIR)) return out;
  for (const owner of fs.readdirSync(MODELS_DIR)) {
    const ownerDir = path.join(MODELS_DIR, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      // A diffusers folder is one model, listed by its index file.
      if (fs.existsSync(path.join(repoDir, INDEX))) {
        // With the files it holds: a download that died midway has the
        // index and not the weights, and the site must not take it for whole.
        out.push({ repo: `${owner}/${repo}`, file: INDEX, gb: folderSize(repoDir), engine: "diffusers", files: folderFiles(repoDir) });
        continue;
      }
      for (const file of fs.readdirSync(repoDir)) {
        if (file.endsWith(".part")) continue;
        const full = path.join(repoDir, file);
        // The parts of a folder-layout model are not models until merged.
        if (!fs.statSync(full).isFile()) continue;
        out.push({ repo: `${owner}/${repo}`, file, gb: fs.statSync(full).size / 1024 ** 3 });
      }
    }
  }
  return out;
}

function folderFiles(dir, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const sub = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...folderFiles(path.join(dir, entry.name), sub));
    else if (entry.isFile() && !entry.name.endsWith(".part")) out.push(sub);
  }
  return out;
}

function folderSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderSize(full);
    else if (entry.isFile() && !entry.name.endsWith(".part")) total += fs.statSync(full).size / 1024 ** 3;
  }
  return total;
}

const downloading = new Set();
setInterval(idleWatch, IDLE_CHECK_MS).unref();

// Room on the models disk, in GB; null where the system cannot say.
function diskSpace() {
  try {
    const s = fs.statfsSync(MODELS_DIR);
    return { freeGb: (s.bavail * s.bsize) / 1024 ** 3, totalGb: (s.blocks * s.bsize) / 1024 ** 3 };
  } catch {
    return null;
  }
}

// A download that will not fit, said before it dies midway: a full disk
// once killed the agent with a half-written file, and the site saw only
// a machine that stopped answering.
function diskFull(needGb, what) {
  const d = diskSpace();
  const room = d ? `${d.freeGb.toFixed(1)} GB free of its ${d.totalGb.toFixed(0)} GB disk` : "no room left on its disk";
  return new Error(`the machine has ${room}, and ${what} needs ${needGb.toFixed(1)} GB. Grow the disk from the model's window (or delete models from the machine) and run the step again; it goes on from the files already there`);
}

// ---- download tasks ---------------------------------------------------------------
// A download runs on the machine whether or not anyone is connected: the
// site starts it, gets an id, and polls for progress. A connection that
// drops (the proxy caps long requests) costs nothing; the lines wait here.
const tasks = new Map();
const TASK_LINES = 400;
function startTask(work, key = "") {
  const id = crypto.randomBytes(8).toString("hex");
  const task = { id, key, status: "running", error: null, lines: [], first: 0, startedAt: Date.now(), finishedAt: null };
  tasks.set(id, task);
  const write = (line) => {
    task.lines.push(line);
    if (task.lines.length > TASK_LINES) {
      task.lines.shift();
      task.first++;
    }
  };
  work(write)
    .then(() => (task.status = "done"))
    .catch((err) => {
      task.status = "failed";
      task.error = err.message;
    })
    .finally(() => (task.finishedAt = Date.now()));
  return task;
}
setInterval(() => {
  const cutoff = Date.now() - 2 * 3600e3;
  for (const [id, t] of tasks) if (t.finishedAt && t.finishedAt < cutoff) tasks.delete(id);
}, 10 * 60e3).unref();

// Answers a download route either way: streamed, or detached with an id.
// A detached request for a download already running joins it rather than
// starting it twice: a step tried again, or opened from another tab, never
// trips over its own first attempt.
function answerDownload(req, res, body, work, key = "") {
  if (body.detach) {
    const running = key ? [...tasks.values()].find((t) => t.key === key && t.status === "running") : null;
    if (running) return send(res, 202, { id: running.id, status: running.status, attached: true });
    const task = startTask(work, key);
    return send(res, 202, { id: task.id, status: task.status });
  }
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
  const write = (line) => res.write(`${JSON.stringify(line)}\n`);
  return work(write)
    .catch((err) => write({ error: err.message }))
    .then(() => res.end());
}

// Streams a file from Hugging Face onto the disk, reporting progress as
// lines of JSON in Ollama's style: status, total, completed. `saveAs` is
// the path to keep it under when it differs (a half-precision variant
// loses its .fp16 suffix so the merge finds it).
// The big files come in several pieces at once: Hugging Face serves byte
// ranges, and one connection rarely fills a data-centre link. Each piece
// is fetched whole and written at its place in a file made the right size
// first; a server that will not serve ranges is told by its answer.
const CHUNK_BYTES = Number(process.env.HF_CHUNK_BYTES) || 32 * 1024 * 1024;
const CHUNK_STREAMS = Number(process.env.HF_CHUNK_STREAMS) || 8;

async function fetchRanges(src, headers, total, tmp, onBytes) {
  const fh = await fs.promises.open(tmp, "w");
  const stop = new AbortController();
  try {
    await fh.truncate(total);
    const ranges = [];
    for (let a = 0; a < total; a += CHUNK_BYTES) ranges.push([a, Math.min(total, a + CHUNK_BYTES) - 1]);
    let next = 0;
    const worker = async () => {
      while (next < ranges.length) {
        const [a, b] = ranges[next++];
        const res = await fetch(src, { headers: { ...headers, Range: `bytes=${a}-${b}` }, redirect: "follow", signal: stop.signal });
        if (res.status !== 206) {
          await res.body?.cancel?.().catch(() => {});
          throw Object.assign(new Error("ranges not served"), { code: "NO_RANGES" });
        }
        const parts = [];
        let got = 0;
        for await (const c of res.body) {
          parts.push(c);
          got += c.length;
          onBytes(c.length);
        }
        if (got !== b - a + 1) throw Object.assign(new Error("a piece ended early"), { code: "SHORT" });
        await fh.write(Buffer.concat(parts, got), 0, got, a);
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(CHUNK_STREAMS, ranges.length) }, worker));
    } catch (err) {
      stop.abort();
      throw err;
    }
  } finally {
    await fh.close();
  }
}

async function download(repo, file, token, write, saveAs = file, dest = modelFile(repo, saveAs, true)) {
  const key = dest;
  // Another task has this very file in hand: wait for it rather than fail.
  if (downloading.has(key)) {
    write({ status: `waiting for ${file}, already being fetched` });
    while (downloading.has(key)) await sleep(1000);
  }
  if (fs.existsSync(dest)) {
    write({ status: "already here" });
    write({ status: "success" });
    return;
  }
  downloading.add(key);
  try {
    const headers = { "User-Agent": "huggingfound-gpu" };
    const auth = token || process.env.HF_TOKEN || "";
    if (auth) headers.Authorization = `Bearer ${auth}`;
    write({ status: "starting" });
    const url = `${HUB}/${repo}/resolve/main/${file}`;
    const res = await fetch(url, { headers, redirect: "follow" });
    if (res.status === 401 || res.status === 403) throw new Error("this file is gated; it needs a Hugging Face token with the licence accepted");
    if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    const room = diskSpace();
    if (total && room && room.freeGb < total / 1024 ** 3 + 0.5) {
      await res.body?.cancel?.().catch(() => {});
      throw diskFull(total / 1024 ** 3, file);
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    let received = 0;
    let lastPct = -1;
    const progress = (n) => {
      received += n;
      const pct = total ? Math.floor((received / total) * 100) : -1;
      if (pct !== lastPct) {
        lastPct = pct;
        write({ status: `downloading ${file}`, total, completed: received, file });
      }
    };
    const early = () => new Error(`the download of ${file} ended early (${(received / 1024 ** 3).toFixed(2)} of ${(total / 1024 ** 3).toFixed(2)} GB); try again`);
    // One stream into the file, for small files and servers without ranges.
    const single = async (body) => {
      const out = fs.createWriteStream(tmp);
      // A fault in the writer (the disk filling up) ends the download as an
      // error of its own; left unheard it would end the whole agent.
      let failWrite;
      const writeFailed = new Promise((_, reject) => (failWrite = reject));
      writeFailed.catch(() => {});
      out.on("error", failWrite);
      try {
        try {
          for await (const chunk of body) {
            if (!out.write(chunk)) await Promise.race([new Promise((r) => out.once("drain", r)), writeFailed]);
            progress(chunk.length);
          }
        } catch (err) {
          // A connection that drops before the announced size is the usual cause.
          throw err?.code === "ENOSPC" ? err : total && received < total ? early() : err;
        }
        await Promise.race([new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve()))), writeFailed]);
      } catch (err) {
        out.destroy();
        throw err;
      }
    };
    try {
      if (total > CHUNK_BYTES * 2) {
        await res.body?.cancel?.().catch(() => {});
        // The file's own address once redirected (a content network): the
        // token stays with the hub, where it belongs.
        const src = res.url || url;
        const plain = new URL(src).origin === new URL(HUB).origin ? headers : { "User-Agent": headers["User-Agent"] };
        try {
          await fetchRanges(src, plain, total, tmp, progress);
        } catch (err) {
          if (err?.code === "SHORT") throw early();
          if (err?.code !== "NO_RANGES") throw err;
          received = 0;
          lastPct = -1;
          const whole = await fetch(url, { headers, redirect: "follow" });
          if (!whole.ok) throw new Error(`Hugging Face answered HTTP ${whole.status}`);
          await single(whole.body);
        }
      } else {
        await single(res.body);
      }
      if (total && received !== total) throw early();
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err?.code === "ENOSPC" ? diskFull(total / 1024 ** 3, file) : err;
    }
    fs.renameSync(tmp, dest);
    write({ status: "success" });
  } finally {
    downloading.delete(key);
  }
}

// A model only the diffusers library loads: every file it needs is fetched
// into the repository's folder, kept as published. Files already there are
// skipped, so an interrupted download picks up where it stopped.
async function downloadRepo(repo, files, token, write, gb = 0) {
  const have = files.filter((f) => fs.existsSync(modelFile(repo, f, true)));
  if (have.length === files.length) {
    write({ status: "already here" });
    write({ status: "success" });
    return;
  }
  // The whole model is weighed against the disk before the first byte;
  // a model partly here is checked file by file as it goes on.
  const room = diskSpace();
  if (gb && room && !have.length && room.freeGb < gb + 1) throw diskFull(gb, `the model's ${files.length} files`);
  for (const [i, f] of files.entries()) {
    if (fs.existsSync(modelFile(repo, f, true))) continue;
    write({ status: `file ${i + 1} of ${files.length}: ${f}` });
    await download(repo, f, token, (line) => (line.status === "success" ? null : write(line)));
  }
  if (!fs.existsSync(modelFile(repo, INDEX))) throw new Error("the download has no model_index.json, so the model cannot be loaded");
  write({ status: "success" });
}

// An add-on's files, kept apart from the models.
async function downloadAddon(repo, files, token, write) {
  const missing = files.filter((f) => !fs.existsSync(addonFile(repo, f)));
  if (!missing.length) {
    write({ status: "already here" });
    write({ status: "success" });
    return;
  }
  for (const [i, f] of files.entries()) {
    if (fs.existsSync(addonFile(repo, f))) continue;
    write({ status: `file ${i + 1} of ${files.length}: ${f}` });
    await download(repo, f, token, (line) => (line.status === "success" ? null : write(line)), f, addonFile(repo, f));
  }
  write({ status: "success" });
}

// A model published in the diffusers folder layout: its parts are fetched
// one by one and merged into the single checkpoint sd-server loads, named
// `into`; the parts are removed afterwards. The same merge HuggingFound
// does on a person's own computer.
async function downloadFolder(repo, files, into, token, write, gb = 0) {
  const dest = modelFile(repo, into);
  if (fs.existsSync(dest)) {
    write({ status: "already here" });
    write({ status: "success" });
    return;
  }
  // The parts and the merged checkpoint sit on the disk together for a while.
  const room = diskSpace();
  if (gb && room && !files.some((f) => fs.existsSync(modelFile(repo, f.to, true))) && room.freeGb < gb * 2 + 1) throw diskFull(gb * 2, `the model's ${files.length} parts and the checkpoint merged from them`);
  for (const [i, f] of files.entries()) {
    write({ status: `file ${i + 1} of ${files.length}: ${f.from}` });
    await download(repo, f.from, token, (line) => (line.status === "success" ? null : write(line)), f.to);
  }
  const dir = path.dirname(dest);
  write({ status: "merging the parts into one checkpoint" });
  await convertDiffusersFolder(dir, dest, (text) => write({ status: text }));
  for (const f of files) fs.rmSync(modelFile(repo, f.to, true), { force: true });
  for (const sub of PART_DIRS) {
    const d = path.join(dir, sub);
    if (fs.existsSync(d) && fs.readdirSync(d).length === 0) fs.rmdirSync(d);
  }
  write({ status: "success" });
}

// ---- HTTP ------------------------------------------------------------------------

function originAllowed(origin) {
  if (!origin) return true;
  return ORIGINS.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern.endsWith(":*")) return origin.startsWith(pattern.slice(0, -1));
    return origin === pattern;
  });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (!originAllowed(origin)) return false;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  // Whatever headers the page asks about: a page newer than this image
  // may send one this image does not know, and the secret check below
  // decides what counts, not the header list.
  res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "Content-Type, Authorization, X-Agent-Token");
  res.setHeader("Access-Control-Max-Age", "43200");
  return true;
}

// The request carries the machine's secret, as a bearer token or in a
// header of its own, in case a proxy on the way drops the standard one.
// The origin check above stops other sites' pages; this stops anyone else
// who has the address.
function tokenOk(req) {
  if (!TOKEN) return true;
  const given = (/^Bearer\s+(.+)$/i.exec(req.headers.authorization || "")?.[1] || req.headers["x-agent-token"] || "").trim();
  const a = Buffer.from(given);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readJson(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("Bad JSON"));
      }
    });
    req.on("error", reject);
  });
}

const SAMPLERS = new Set(["euler", "euler_a", "heun", "dpm2", "dpm++2s_a", "dpm++2m", "dpm++2mv2", "ipndm", "ipndm_v", "lcm", "ddim_trailing", "tcd"]);
const SCHEDULERS = new Set(["discrete", "karras", "exponential", "ays", "gits", "sgm_uniform", "simple", "smoothstep"]);

const server = http.createServer(async (req, res) => {
  try {
    if (!cors(req, res)) return send(res, 403, { error: "This origin may not use the machine" });
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (!tokenOk(req)) return send(res, 401, { error: "This machine answers only its own site: the request did not carry its secret" });
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/health") {
      const rel = (p) => path.relative(MODELS_DIR, p).split(path.sep).join("/");
      const loaded = sd.file ? rel(sd.file) : py.dir ? (py.dir.endsWith(".safetensors") || py.dir.endsWith(".ckpt") ? rel(py.dir) : `${rel(py.dir)}/${INDEX}`) : null;
      const room = diskSpace();
      return send(res, 200, { ok: true, version: VERSION, sdOk: sdCheck.ok, sdProblem: sdCheck.problem, pyOk: pyCheck.ok, pyProblem: pyCheck.problem, gpu: pyCheck.gpu, vramGb: pyCheck.vramGb, diskFreeGb: room ? Math.round(room.freeGb * 10) / 10 : null, diskTotalGb: room ? Math.round(room.totalGb) : null, loaded, ready: sd.file ? sd.ready : Boolean(py.dir), loading: Boolean(sd.loading), models: listModels().length, busy: busy(), idleSeconds: Math.round((Date.now() - lastActivity) / 1000), idleMinutes: IDLE_MINUTES, leaseUntil: leaseUntil || null });
    }
    if (req.method === "GET" && url.pathname === "/models") return send(res, 200, { models: listModels(), addons: listAddons() });
    // The image server's recent output and the Python side's, for a look
    // when a picture fails.
    if (req.method === "GET" && url.pathname === "/log") return send(res, 200, { sd: sd.tail, lastFailure: sd.lastFailure ?? null, python: py.tail, loaded: sd.file ? path.relative(MODELS_DIR, sd.file).split(path.sep).join("/") : null });
    // The site renews the lease while it sees activity (a chat sent from the
    // browser, a download it is relaying). A lease is at most the idle time.
    // Drops whatever either engine holds, so the next job loads its model
    // afresh: the site's way to reset a worker whose state it doubts.
    if (req.method === "POST" && url.pathname === "/unload") {
      stopServer();
      // A request in flight is not waited for: the worker is stopped, the
      // job fails with the reason, and the next job starts a fresh worker.
      if (py.pending) {
        const pending = py.pending;
        py.pending = null;
        stopWorker();
        pending.resolve({ ok: false, error: "the machine's worker was reset from the page while working on this; ask again" });
        return send(res, 200, { ok: true, stopped: true });
      }
      await unloadWorker().catch(() => forgetWorkerModel());
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/lease") {
      const body = await readJson(req, 4 * 1024);
      const minutes = Math.min(IDLE_MINUTES > 0 ? IDLE_MINUTES : IDLE_CEILING_MINUTES, Math.max(1, Number(body.minutes) || IDLE_MINUTES || 30));
      touchActivity();
      leaseUntil = Date.now() + minutes * 60e3;
      return send(res, 200, { ok: true, leaseUntil, idleMinutes: IDLE_MINUTES, ceilingMinutes: IDLE_CEILING_MINUTES });
    }
    if (req.method === "POST" && url.pathname === "/download") {
      touchActivity();
      const body = await readJson(req, 64 * 1024);
      const repo = String(body.repo ?? "");
      const file = String(body.file ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file)) return send(res, 400, { error: "Bad model name" });
      return answerDownload(req, res, body, (write) => download(repo, file, typeof body.token === "string" ? body.token : "", write), `/download|${repo}|${file}`);
    }
    // Every download task, for a site that has lost track of one.
    if (req.method === "GET" && url.pathname === "/downloads") {
      return send(res, 200, { tasks: [...tasks.values()].map((t) => ({ id: t.id, key: t.key, status: t.status, error: t.error, startedAt: t.startedAt, finishedAt: t.finishedAt, last: t.lines.at(-1) ?? null })) });
    }
    const taskMatch = url.pathname.match(/^\/downloads\/([a-f0-9]{16})$/);
    if (req.method === "GET" && taskMatch) {
      const task = tasks.get(taskMatch[1]);
      if (!task) return send(res, 404, { error: "No such download" });
      const after = Math.max(Number(url.searchParams.get("after")) || 0, task.first);
      return send(res, 200, { id: task.id, status: task.status, error: task.error, lines: task.lines.slice(after - task.first), cursor: task.first + task.lines.length });
    }
    if (req.method === "POST" && url.pathname === "/download-addon") {
      touchActivity();
      const body = await readJson(req, 64 * 1024);
      const repo = String(body.repo ?? "");
      const files = Array.isArray(body.files) ? body.files.map((f) => String(f ?? "")) : [];
      if (!REPO_RE.test(repo) || files.length === 0 || files.length > 40 || !files.every((f) => SUBPATH_RE.test(f))) return send(res, 400, { error: "Bad add-on name" });
      return answerDownload(req, res, body, (write) => downloadAddon(repo, files, typeof body.token === "string" ? body.token : "", write), `/download-addon|${repo}`);
    }
    if (req.method === "POST" && url.pathname === "/download-repo") {
      touchActivity();
      const body = await readJson(req, 256 * 1024);
      const repo = String(body.repo ?? "");
      const files = Array.isArray(body.files) ? body.files.map((f) => String(f ?? "")) : [];
      if (!REPO_RE.test(repo) || files.length === 0 || files.length > 120 || !files.every((f) => SUBPATH_RE.test(f)) || !files.includes(INDEX)) return send(res, 400, { error: "Bad model name" });
      return answerDownload(req, res, body, (write) => downloadRepo(repo, files, typeof body.token === "string" ? body.token : "", write, Number(body.gb) || 0), `/download-repo|${repo}`);
    }
    if (req.method === "POST" && url.pathname === "/download-folder") {
      touchActivity();
      const body = await readJson(req, 64 * 1024);
      const repo = String(body.repo ?? "");
      const into = String(body.into ?? "");
      const files = Array.isArray(body.files) ? body.files.map((f) => ({ from: String(f?.from ?? ""), to: String(f?.to ?? f?.from ?? "") })) : [];
      const partOk = (p) => SUBPATH_RE.test(p) && PART_DIRS.includes(p.split("/")[0]) && p.split("/").length === 2;
      if (!REPO_RE.test(repo) || !FILE_RE.test(into) || !into.endsWith(".safetensors") || files.length === 0 || files.length > 8 || !files.every((f) => partOk(f.from) && partOk(f.to))) return send(res, 400, { error: "Bad model name" });
      return answerDownload(req, res, body, (write) => downloadFolder(repo, files, into, typeof body.token === "string" ? body.token : "", write, Number(body.gb) || 0), `/download-folder|${repo}|${into}`);
    }
    if (req.method === "DELETE" && url.pathname === "/models") {
      const body = await readJson(req, 64 * 1024);
      if (body.addon) {
        let f;
        try {
          f = addonFile(String(body.repo ?? ""), String(body.file ?? ""));
        } catch (err) {
          return send(res, 400, { error: err.message });
        }
        if (!fs.existsSync(f)) return send(res, 404, { error: "Not on this machine" });
        if (py.key?.includes(f)) await unloadWorker().catch(() => {});
        fs.rmSync(f, { force: true });
        let d = path.dirname(f);
        while (d.startsWith(ADDONS_DIR) && d !== ADDONS_DIR && fs.existsSync(d) && fs.readdirSync(d).length === 0) {
          fs.rmdirSync(d);
          d = path.dirname(d);
        }
        return send(res, 200, { ok: true });
      }
      let file;
      try {
        file = modelFile(String(body.repo ?? ""), String(body.file ?? ""));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      if (sd.file === file) stopServer();
      if (py.dir === file) await unloadWorker().catch(() => {});
      if (!fs.existsSync(file)) return send(res, 404, { error: "Not on this machine" });
      if (path.basename(file) === INDEX) {
        // The index stands for the whole folder.
        if (py.dir === path.dirname(file)) await unloadWorker().catch(() => {});
        fs.rmSync(path.dirname(file), { recursive: true, force: true });
      } else fs.rmSync(file, { force: true });
      let dir = path.dirname(file);
      while (dir.startsWith(MODELS_DIR) && dir !== MODELS_DIR && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
        fs.rmdirSync(dir);
        dir = path.dirname(dir);
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/jobs/join") {
      touchActivity();
      const body = await readJson(req);
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      if (ids.length < 2 || ids.length > 24 || !ids.every((id) => /^[a-f0-9]{16}$/.test(id))) return send(res, 400, { error: "Name two to twenty-four clips to join, in order" });
      const pieces = ids.map((id) => jobs.get(id));
      if (pieces.some((p) => !p)) return send(res, 404, { error: "One of those clips is no longer on this machine" });
      if (pieces.some((p) => p.status !== "completed" || !p.video)) return send(res, 409, { error: "Every piece has to be a finished clip" });
      const job = startJoin(pieces);
      return send(res, 202, { id: job.id, status: job.status });
    }
    if (req.method === "POST" && url.pathname === "/jobs") {
      touchActivity();
      const body = await readJson(req);
      const repo = String(body.repo ?? "");
      const file = String(body.file ?? "");
      const prompt = String(body.prompt ?? "").slice(0, 2000);
      if (!REPO_RE.test(repo) || !FILE_RE.test(file)) return send(res, 400, { error: "Bad model name" });
      if (!prompt.trim()) return send(res, 400, { error: "Say what the picture should show" });
      let addon = null;
      if (body.addon && typeof body.addon === "object") {
        const a = body.addon;
        const kind = a.kind === "lora" ? "lora" : "ip-adapter";
        if (!REPO_RE.test(String(a.repo ?? "")) || !SUBPATH_RE.test(String(a.file ?? "")) || (a.lora && !SUBPATH_RE.test(String(a.lora)))) return send(res, 400, { error: "Bad add-on name" });
        if (!/\.(safetensors|ckpt)$/i.test(file) && file !== INDEX) return send(res, 400, { error: "An add-on applies to a checkpoint or a folder model, not to a GGUF file" });
        addon = { kind, repo: String(a.repo), file: String(a.file), lora: a.lora ? String(a.lora) : null, scale: Math.min(2, Math.max(0, Number(a.scale) || (kind === "lora" ? 0.8 : 0.6))) };
      }
      let ipImage = null;
      if (body.ipImage) {
        const data = String(body.ipImage).replace(/^data:image\/\w+;base64,/, "");
        if (!/^[A-Za-z0-9+/]+=*$/.test(data) || data.length > 11 * 1024 * 1024) return send(res, 400, { error: "The reference picture did not arrive intact" });
        ipImage = data;
      }
      const diffusers = file === INDEX || Boolean(addon);
      // sd-server wants multiples of 64; the diffusers families take 16.
      const grain = diffusers ? 16 : 64;
      const size = (n, fallback) => (Number.isInteger(n) && n >= 256 && n <= 2048 && n % grain === 0 ? n : fallback);
      const steps = Number.isInteger(body.steps) && body.steps >= 1 && body.steps <= 150 ? body.steps : diffusers ? 28 : 20;
      // Up to fifteen seconds at 24 fps, the longest clip a family here makes.
      const frames = Number.isInteger(body.frames) && body.frames >= 9 && body.frames <= 361 ? body.frames : 33;
      const fps = Number.isInteger(body.fps) && body.fps >= 8 && body.fps <= 30 ? body.fps : 16;
      const cfg = Number.isFinite(body.cfg) && body.cfg >= 0 && body.cfg <= 30 ? body.cfg : 7;
      const sampler = SAMPLERS.has(body.sampler) ? body.sampler : "euler_a";
      const scheduler = SCHEDULERS.has(body.scheduler) ? body.scheduler : "discrete";
      let init = null;
      let strength = 0.55;
      if (body.init) {
        const data = String(body.init).replace(/^data:image\/\w+;base64,/, "");
        if (!/^[A-Za-z0-9+/]+=*$/.test(data) || data.length > 11 * 1024 * 1024) return send(res, 400, { error: "The starting picture did not arrive intact" });
        init = data;
        strength = Math.min(0.95, Math.max(0.1, Number(body.strength) || 0.55));
      }
      // The same seed with revised words keeps a scene close to the one before.
      const seed = Number.isInteger(body.seed) && body.seed >= 0 && body.seed < 2 ** 31 ? body.seed : null;
      const job = startJob({ repo, file, prompt, negative: String(body.negative ?? "").slice(0, 2000), width: size(body.width, diffusers ? 1024 : 512), height: size(body.height, diffusers ? 1024 : 512), steps, cfg, sampler, scheduler, init, strength, frames, fps, addon, ipImage, seed });
      return send(res, 202, { id: job.id, status: job.status });
    }
    const m = url.pathname.match(/^\/jobs\/([a-f0-9]{16})(\/result|\/last)?$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "No such job" });
      const done = job.status === "completed";
      const b64 = done ? job.video || job.image : null;
      // A clip's last frame, as a picture, for whatever starts from it.
      if (m[2] === "/last") {
        if (!job.last) return send(res, done || job.status === "failed" ? 404 : 409, { error: job.status === "failed" ? "this job made nothing" : done ? "this clip has no last frame kept" : "not finished yet" });
        const bytes = Buffer.from(job.last, "base64");
        res.writeHead(200, { "Content-Type": "image/png", "Content-Length": bytes.length, "Cache-Control": "no-store" });
        return res.end(bytes);
      }
      // The result as bytes, apart from the status: a clip is tens of
      // megabytes, which a poll every second or two should not carry.
      if (m[2]) {
        if (!b64) return send(res, done ? 500 : 409, { error: done ? "the job made nothing" : "not finished yet" });
        const bytes = Buffer.from(b64, "base64");
        res.writeHead(200, { "Content-Type": job.video ? "video/mp4" : "image/png", "Content-Length": bytes.length, "Cache-Control": "no-store" });
        return res.end(bytes);
      }
      // A lean poll leaves the result out and says it is there to fetch;
      // the plain one carries it, for pages from before.
      const lean = url.searchParams.get("lean") === "1";
      return send(res, 200, { id: job.id, status: job.status, kind: job.kind, progress: job.progress, note: job.note || "", error: job.error, seed: job.seed, image: done && !lean ? job.image : null, video: done && !lean ? job.video : null, result: Boolean(b64), bytes: b64 ? Buffer.byteLength(b64, "base64") : 0, last: Boolean(job.last) });
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, err.message === "Body too large" ? 413 : 500, { error: err.message });
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// A fault in one request or download must not take the agent down with
// it: a dead agent leaves the machine billing with nothing to say why.
for (const event of ["uncaughtException", "unhandledRejection"]) {
  process.on(event, (err) => console.error(`agent fault (${event}): ${err?.stack || err}`));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopServer();
    stopWorker();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  touchActivity();
  console.log(`HuggingFound GPU agent listening on ${HOST}:${server.address().port}; models in ${MODELS_DIR}; origins: ${ORIGINS.join(", ") || "none (same-machine only)"}`);
});
