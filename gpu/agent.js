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
//   HF_TOKEN        a Hugging Face token for gated downloads (optional)

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.env.HF_AGENT_PORT || 7860);
const HOST = process.env.HF_AGENT_HOST || "0.0.0.0";
const MODELS_DIR = process.env.HF_MODELS_DIR || "/root/.ollama/huggingfound/models";
const SD_SERVER = process.env.SD_SERVER || "/opt/huggingfound/bin/sd-server";
const SD_PORT = Number(process.env.SD_PORT || 7861);
const SD_URL = `http://127.0.0.1:${SD_PORT}`;
const HUB = process.env.HF_HUB || "https://huggingface.co";
const ORIGINS = (process.env.HF_ORIGINS || process.env.OLLAMA_ORIGINS || "").split(",").map((o) => o.trim()).filter(Boolean);
const VERSION = "1";

const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/;
const FILE_RE = /^(?!\.+$)[\w.+-]+$/;
const MAX_BODY = 12 * 1024 * 1024;
const JOB_TTL = 30 * 60e3;

fs.mkdirSync(MODELS_DIR, { recursive: true });

// ---- the image server --------------------------------------------------------

const sd = { proc: null, file: null, ready: false, loading: null, errors: [], tail: "" };

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
  sd.file = file;
  sd.errors = [];
  sd.tail = "";
  const argv = ["-m", file, "--listen-ip", "127.0.0.1", "--listen-port", String(SD_PORT), "--vae-tiling"];
  const proc = spawn(SD_SERVER, argv, { stdio: ["ignore", "pipe", "pipe"] });
  sd.proc = proc;
  const onData = (chunk) => {
    sd.tail = (sd.tail + chunk.toString()).slice(-4000);
    for (const line of chunk.toString().split(/\r?\n/)) if (/\[ERROR/.test(line)) sd.errors.push({ at: Date.now(), line: line.trim() });
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
    for (let i = 0; i < 300; i++) {
      if (sd.proc !== proc) throw new Error(`the image server stopped: ${lastLine()}`);
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

// ---- jobs ------------------------------------------------------------------------
// One picture per job. The browser submits and polls; the agent loads the
// model if needed, hands the job to sd-server and follows it.

const jobs = new Map();

function startJob(input) {
  const id = crypto.randomBytes(8).toString("hex");
  const job = { id, status: "loading", createdAt: Date.now(), image: null, error: null, note: "" };
  jobs.set(id, job);
  (async () => {
    try {
      const file = modelFile(input.repo, input.file);
      if (!fs.existsSync(file)) throw new Error("that model is not on this machine yet");
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

function modelFile(repo, file) {
  if (!REPO_RE.test(repo) || !FILE_RE.test(file)) throw new Error("Bad model name");
  return path.join(MODELS_DIR, ...repo.split("/"), file);
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
      for (const file of fs.readdirSync(repoDir)) {
        if (file.endsWith(".part")) continue;
        out.push({ repo: `${owner}/${repo}`, file, gb: fs.statSync(path.join(repoDir, file)).size / 1024 ** 3 });
      }
    }
  }
  return out;
}

const downloading = new Set();

// Streams a file from Hugging Face onto the disk, reporting progress as
// lines of JSON in Ollama's style: status, total, completed.
async function download(repo, file, token, write) {
  const dest = modelFile(repo, file);
  const key = `${repo}/${file}`;
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
    for await (const chunk of res.body) {
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once("drain", r));
      const pct = total ? Math.floor((received / total) * 100) : -1;
      if (pct !== lastPct) {
        lastPct = pct;
        write({ status: `downloading ${file}`, total, completed: received });
      }
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    fs.renameSync(tmp, dest);
    write({ status: "success" });
  } finally {
    downloading.delete(key);
  }
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
      return send(res, 200, { ok: true, version: VERSION, loaded: sd.file ? path.relative(MODELS_DIR, sd.file).split(path.sep).join("/") : null, ready: sd.ready, loading: Boolean(sd.loading), models: listModels().length });
    }
    if (req.method === "GET" && url.pathname === "/models") return send(res, 200, { models: listModels() });
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
    if (req.method === "DELETE" && url.pathname === "/models") {
      const body = await readJson(req, 64 * 1024);
      let file;
      try {
        file = modelFile(String(body.repo ?? ""), String(body.file ?? ""));
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      if (sd.file === file) stopServer();
      if (!fs.existsSync(file)) return send(res, 404, { error: "Not on this machine" });
      fs.rmSync(file, { force: true });
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
      const size = (n, fallback) => (Number.isInteger(n) && n >= 256 && n <= 2048 && n % 64 === 0 ? n : fallback);
      const steps = Number.isInteger(body.steps) && body.steps >= 1 && body.steps <= 150 ? body.steps : 20;
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
      const job = startJob({ repo, file, prompt, negative: String(body.negative ?? "").slice(0, 2000), width: size(body.width, 512), height: size(body.height, 512), steps, cfg, sampler, scheduler, init, strength });
      return send(res, 202, { id: job.id, status: job.status });
    }
    const m = url.pathname.match(/^\/jobs\/([a-f0-9]{16})$/);
    if (req.method === "GET" && m) {
      const job = jobs.get(m[1]);
      if (!job) return send(res, 404, { error: "No such job" });
      return send(res, 200, { id: job.id, status: job.status, error: job.error, image: job.status === "completed" ? job.image : null });
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
    process.exit(0);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`HuggingFound GPU agent listening on ${HOST}:${server.address().port}; models in ${MODELS_DIR}; origins: ${ORIGINS.join(", ") || "none (same-machine only)"}`);
});
