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
//   HF_MODELS_DIR   where model files live (/root/.ollama/huggingfound/models,
//                   on the persistent disk next to Ollama's models)
//   SD_SERVER       path to sd-server; SD_PORT the local port it listens on
//   HF_PYTHON       the Python that has torch and diffusers; HF_WORKER the
//                   worker script it runs (worker.py next to this file)
//   HF_TOKEN        a Hugging Face token for gated downloads (optional)
//
// Two engines: stable-diffusion.cpp for single-file checkpoints (fast,
// small), and the diffusers library through worker.py for the families
// that only it loads (FLUX, Qwen-Image, Wan, Hunyuan and the rest of the
// folder layouts), which also make video. A folder model is handled by
// its model_index.json, so the rest of the app can treat it as a file.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
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
// Add-ons (IP-Adapters, LoRAs) live apart from models; they are applied to one.
const ADDONS_DIR = process.env.HF_ADDONS_DIR || path.join(MODELS_DIR, "..", "addons");
const ORIGINS = (process.env.HF_ORIGINS || process.env.OLLAMA_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const VERSION = "5";

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
  const proc = spawn(PYTHON, [WORKER], { stdio: ["pipe", "pipe", "pipe"] });
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
function askWorker(req, onProgress = null, timeoutMs = 60 * 60e3) {
  const run = () => new Promise((resolve) => {
    startWorker();
    if (!py.proc) return resolve({ ok: false, error: "the Python worker could not start" });
    let settled = false;
    const finish = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (py.pending?.resolve === finish) py.pending = null;
      resolve(msg);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      stopWorker();
      finish({ ok: false, error: "the Python worker did not answer in time" });
    }, timeoutMs);
    py.pending = { resolve: finish, onProgress };
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
}

async function unloadWorker() {
  if (!py.proc) return;
  if (py.dir) await askWorker({ op: "unload" });
  py.dir = null;
  py.key = null;
  py.kind = null;
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
  const job = { id, status: "loading", createdAt: Date.now(), image: null, video: null, kind: "image", progress: null, error: null, note: "" };
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
        await ensureWorkerLoaded(file, adapters);
        job.kind = py.kind;
        job.status = "generating";
        const req = { op: "generate", prompt: input.prompt, negative: input.negative, steps: input.steps, width: input.width, height: input.height, cfg: input.cfg, frames: input.frames, fps: input.fps, init: input.init, strength: input.init ? input.strength : undefined, ipImage: input.ipImage ?? undefined };
        const answer = await askWorker(req, (p) => (job.progress = p));
        if (!answer.ok) throw new Error(answer.error || "the worker made nothing");
        if (answer.video) {
          job.video = answer.video;
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
        seed: -1,
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
        out.push({ repo: `${owner}/${repo}`, file: INDEX, gb: folderSize(repoDir), engine: "diffusers" });
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

// Streams a file from Hugging Face onto the disk, reporting progress as
// lines of JSON in Ollama's style: status, total, completed. `saveAs` is
// the path to keep it under when it differs (a half-precision variant
// loses its .fp16 suffix so the merge finds it).
async function download(repo, file, token, write, saveAs = file, dest = modelFile(repo, saveAs, true)) {
  const key = dest;
  if (downloading.has(key)) throw new Error("that file is already being downloaded");
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
    const res = await fetch(`${HUB}/${repo}/resolve/main/${file}`, { headers, redirect: "follow" });
    if (res.status === 401 || res.status === 403) throw new Error("this file is gated; it needs a Hugging Face token with the licence accepted");
    if (!res.ok) throw new Error(`Hugging Face answered HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    let received = 0;
    let lastPct = -1;
    const early = () => new Error(`the download of ${file} ended early (${(received / 1024 ** 3).toFixed(2)} of ${(total / 1024 ** 3).toFixed(2)} GB); try again`);
    try {
      try {
        for await (const chunk of res.body) {
          received += chunk.length;
          if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
          const pct = total ? Math.floor((received / total) * 100) : -1;
          if (pct !== lastPct) {
            lastPct = pct;
            write({ status: `downloading ${file}`, total, completed: received, file });
          }
        }
      } catch (err) {
        // A connection that drops before the announced size is the usual cause.
        throw total && received < total ? early() : err;
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (total && received !== total) throw early();
    } catch (err) {
      out.destroy();
      fs.rmSync(tmp, { force: true });
      throw err;
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
async function downloadRepo(repo, files, token, write) {
  const have = files.filter((f) => fs.existsSync(modelFile(repo, f, true)));
  if (have.length === files.length) {
    write({ status: "already here" });
    write({ status: "success" });
    return;
  }
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
async function downloadFolder(repo, files, into, token, write) {
  const dest = modelFile(repo, into);
  if (fs.existsSync(dest)) {
    write({ status: "already here" });
    write({ status: "success" });
    return;
  }
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "43200");
  return true;
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
    const url = new URL(req.url, "http://x");
    if (req.method === "GET" && url.pathname === "/health") {
      const rel = (p) => path.relative(MODELS_DIR, p).split(path.sep).join("/");
      const loaded = sd.file ? rel(sd.file) : py.dir ? (py.dir.endsWith(".safetensors") || py.dir.endsWith(".ckpt") ? rel(py.dir) : `${rel(py.dir)}/${INDEX}`) : null;
      return send(res, 200, { ok: true, version: VERSION, sdOk: sdCheck.ok, sdProblem: sdCheck.problem, pyOk: pyCheck.ok, pyProblem: pyCheck.problem, gpu: pyCheck.gpu, vramGb: pyCheck.vramGb, loaded, ready: sd.file ? sd.ready : Boolean(py.dir), loading: Boolean(sd.loading), models: listModels().length });
    }
    if (req.method === "GET" && url.pathname === "/models") return send(res, 200, { models: listModels(), addons: listAddons() });
    // The image server's recent output and the Python side's, for a look
    // when a picture fails.
    if (req.method === "GET" && url.pathname === "/log") return send(res, 200, { sd: sd.tail, lastFailure: sd.lastFailure ?? null, python: py.tail, loaded: sd.file ? path.relative(MODELS_DIR, sd.file).split(path.sep).join("/") : null });
    if (req.method === "POST" && url.pathname === "/download") {
      const body = await readJson(req, 64 * 1024);
      const repo = String(body.repo ?? "");
      const file = String(body.file ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file)) return send(res, 400, { error: "Bad model name" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const write = (line) => res.write(`${JSON.stringify(line)}\n`);
      try {
        await download(repo, file, typeof body.token === "string" ? body.token : "", write);
      } catch (err) {
        write({ error: err.message });
      }
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/download-addon") {
      const body = await readJson(req, 64 * 1024);
      const repo = String(body.repo ?? "");
      const files = Array.isArray(body.files) ? body.files.map((f) => String(f ?? "")) : [];
      if (!REPO_RE.test(repo) || files.length === 0 || files.length > 40 || !files.every((f) => SUBPATH_RE.test(f))) return send(res, 400, { error: "Bad add-on name" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const write = (line) => res.write(`${JSON.stringify(line)}\n`);
      try {
        await downloadAddon(repo, files, typeof body.token === "string" ? body.token : "", write);
      } catch (err) {
        write({ error: err.message });
      }
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/download-repo") {
      const body = await readJson(req, 256 * 1024);
      const repo = String(body.repo ?? "");
      const files = Array.isArray(body.files) ? body.files.map((f) => String(f ?? "")) : [];
      if (!REPO_RE.test(repo) || files.length === 0 || files.length > 120 || !files.every((f) => SUBPATH_RE.test(f)) || !files.includes(INDEX)) return send(res, 400, { error: "Bad model name" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const write = (line) => res.write(`${JSON.stringify(line)}\n`);
      try {
        await downloadRepo(repo, files, typeof body.token === "string" ? body.token : "", write);
      } catch (err) {
        write({ error: err.message });
      }
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/download-folder") {
      const body = await readJson(req, 64 * 1024);
      const repo = String(body.repo ?? "");
      const into = String(body.into ?? "");
      const files = Array.isArray(body.files) ? body.files.map((f) => ({ from: String(f?.from ?? ""), to: String(f?.to ?? f?.from ?? "") })) : [];
      const partOk = (p) => SUBPATH_RE.test(p) && PART_DIRS.includes(p.split("/")[0]) && p.split("/").length === 2;
      if (!REPO_RE.test(repo) || !FILE_RE.test(into) || !into.endsWith(".safetensors") || files.length === 0 || files.length > 8 || !files.every((f) => partOk(f.from) && partOk(f.to))) return send(res, 400, { error: "Bad model name" });
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const write = (line) => res.write(`${JSON.stringify(line)}\n`);
      try {
        await downloadFolder(repo, files, into, typeof body.token === "string" ? body.token : "", write);
      } catch (err) {
        write({ error: err.message });
      }
      return res.end();
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
    if (req.method === "POST" && url.pathname === "/jobs") {
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
      const frames = Number.isInteger(body.frames) && body.frames >= 9 && body.frames <= 161 ? body.frames : 33;
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
      const job = startJob({ repo, file, prompt, negative: String(body.negative ?? "").slice(0, 2000), width: size(body.width, diffusers ? 1024 : 512), height: size(body.height, diffusers ? 1024 : 512), steps, cfg, sampler, scheduler, init, strength, frames, fps, addon, ipImage });
      return send(res, 202, { id: job.id, status: job.status });
    }
    const m = url.pathname.match(/^\/jobs\/([a-f0-9]{16})$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "No such job" });
      return send(res, 200, { id: job.id, status: job.status, kind: job.kind, progress: job.progress, error: job.error, image: job.status === "completed" ? job.image : null, video: job.status === "completed" ? job.video : null });
    }
    send(res, 404, { error: "Not found" });
  } catch (err) {
    send(res, err.message === "Body too large" ? 413 : 500, { error: err.message });
  }
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopServer();
    stopWorker();
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`HuggingFound GPU agent listening on ${HOST}:${server.address().port}; models in ${MODELS_DIR}; origins: ${ORIGINS.join(", ") || "none (same-machine only)"}`);
});
