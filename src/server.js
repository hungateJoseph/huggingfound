import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categorize.js";
import { mask, readEnv, writeEnv } from "./envfile.js";
import { createHub } from "./hf.js";
import { describeMachine } from "./machine.js";
import { PICKS } from "./picks.js";
import { buildPlan } from "./plans.js";
import { DATA_DIR, OLLAMA_URL, OUTPUT_DIR, UPLOAD_DIR, detect, getRun, startRun, which } from "./runners.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const RUNNER_NAMES = { ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };

export function createServer({ envFile, hubBase, fetchImpl = fetch, scanFile = path.join(DATA_DIR, "scan.json") } = {}) {
  const machine = describeMachine();
  const env = () => readEnv(envFile);
  const hub = () => createHub({ fetchImpl, base: hubBase, token: env().HF_TOKEN });
  const details = new Map();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
          return send(res, 403, { error: "Forbidden" });
        }
        return await api(req, res, url);
      }
      if (url.pathname.startsWith("/output/")) return serveFile(res, path.join(OUTPUT_DIR, path.basename(url.pathname)));
      return serveFile(res, path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname), PUBLIC);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  async function api(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/state") {
      const saved = env();
      return send(res, 200, {
        machine,
        categories: CATEGORIES,
        runners: await detect(fetchImpl),
        token: saved.HF_TOKEN ? mask(saved.HF_TOKEN) : "",
        envFile: tildify(envFile),
        scan: readScan(scanFile, { meta: true }),
        picks: PICKS,
      });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await json(req);
      if (typeof body.HF_TOKEN !== "string") return send(res, 400, { error: "HF_TOKEN must be a string" });
      writeEnv(envFile, { HF_TOKEN: body.HF_TOKEN.trim() });
      // A new token can change what the Hub is willing to show.
      details.clear();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/scan") {
      const previous = readScan(scanFile);
      const known = new Set((previous?.models ?? []).map((m) => m.id));
      const models = await hub().scan();
      const scan = { at: new Date().toISOString(), models: models.map((m) => ({ ...m, isNew: previous ? !known.has(m.id) : false })) };
      fs.mkdirSync(path.dirname(scanFile), { recursive: true });
      fs.writeFileSync(scanFile, JSON.stringify(scan));
      return send(res, 200, scan);
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      return send(res, 200, readScan(scanFile) ?? { at: null, models: [] });
    }
    if (req.method === "GET" && url.pathname === "/api/model") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      // Gated refusals are not cached: a token added later should get a fresh answer.
      const model = details.get(id) ?? (await hub().model(id));
      if (!model.gatedBlocked) details.set(id, model);
      // Curated picks name their runner and file outright, so a repository
      // the tag rules cannot place still gets a plan.
      const pick = PICKS.find((p) => p.id === id);
      if (pick && !model.gatedBlocked) model.runner = { id: pick.runner, name: RUNNER_NAMES[pick.runner], easy: true };
      const plan = model.gatedBlocked
        ? { runnable: false, gated: true, reason: "This model is gated and the request was refused. Accept the licence on Hugging Face and add a token in Settings.", steps: [], link: `https://huggingface.co/${id}` }
        : buildPlan({ model, files: model.files, machine, detected: await detect(fetchImpl), hasToken: Boolean(env().HF_TOKEN), preferredFile: pick?.file });
      return send(res, 200, { model, plan });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await json(req);
      try {
        const run = startRun(String(body.kind ?? ""), body.args ?? {}, machine, { token: env().HF_TOKEN, fetchImpl, hubBase });
        return send(res, 200, { id: run.id });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const run = getRun(url.pathname.slice("/api/runs/".length));
      if (!run) return send(res, 404, { error: "No such run" });
      return stream(res, run);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await json(req);
      const upstream = await fetchImpl(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: String(body.model ?? ""), messages: Array.isArray(body.messages) ? body.messages.slice(-40) : [], stream: true }),
      });
      res.writeHead(upstream.ok ? 200 : upstream.status, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const reader = upstream.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const name = String(req.headers["x-filename"] ?? "audio").replace(/[^\w.+-]/g, "_");
      const dest = path.join(UPLOAD_DIR, `${Date.now()}-${name}`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        req.pipe(out).on("finish", resolve).on("error", reject);
      });
      const wav = await ensureWav(dest);
      return send(res, 200, { path: wav });
    }
    if (req.method === "GET" && url.pathname === "/api/result") {
      const file = path.basename(url.searchParams.get("file") ?? "");
      const full = path.join(OUTPUT_DIR, file);
      if (!file || !fs.existsSync(full)) return send(res, 404, { error: "Not found" });
      return send(res, 200, { text: file.endsWith(".txt") ? fs.readFileSync(full, "utf8") : null, url: `/output/${file}` });
    }
    send(res, 404, { error: "Not found" });
  }

  // whisper.cpp is happiest with 16 kHz wav. Other formats go through
  // ffmpeg when it is installed; otherwise whisper.cpp's own decoder gets
  // a go at the original file.
  async function ensureWav(file) {
    if (file.toLowerCase().endsWith(".wav") || !which("ffmpeg")) return file;
    const wav = `${file}.wav`;
    await new Promise((resolve, reject) => {
      execFile("ffmpeg", ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], (err) => (err ? reject(new Error("ffmpeg could not read this recording")) : resolve()));
    });
    return wav;
  }
}

function readScan(file, { meta = false } = {}) {
  if (!fs.existsSync(file)) return null;
  try {
    const scan = JSON.parse(fs.readFileSync(file, "utf8"));
    return meta ? { at: scan.at, count: scan.models.length, newCount: scan.models.filter((m) => m.isNew).length } : scan;
  } catch {
    return null;
  }
}

function stream(res, run) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const write = (line) => res.write(`data: ${JSON.stringify(line === null ? { done: true, status: run.status, result: run.result ? path.basename(run.result) : null } : { line })}\n\n`);
  for (const line of run.lines) write(line);
  if (run.status !== "running") {
    write(null);
    return res.end();
  }
  const listener = (line) => {
    write(line);
    if (line === null) {
      run.listeners.delete(listener);
      res.end();
    }
  };
  run.listeners.add(listener);
  res.on("close", () => run.listeners.delete(listener));
}

function serveFile(res, file, root) {
  if ((root && !file.startsWith(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function json(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Bad JSON"));
      }
    });
    req.on("error", reject);
  });
}

function tildify(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
