#!/usr/bin/env node
// Stands in for gpu/worker.py in tests: speaks the same line protocol,
// "loads" any folder that has a model_index.json, and answers a generate
// with a tiny PNG, or a tiny "clip" when the model's class name says
// Video. Each generate request is appended to FAKE_WORKER_LOG.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const MP4 = Buffer.from("fake mp4 bytes").toString("base64");
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

if (process.argv.includes("--check")) {
  say(process.env.FAKE_WORKER_BROKEN ? { ok: false, error: "ImportError: no torch" } : { ok: true, torch: "2.5.0", diffusers: "0.33.0", cuda: true, gpu: "Fake A40", vramGb: 48 });
  process.exit(0);
}

let loaded = null;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.op === "check") return say({ ok: true, cuda: true });
  if (req.op === "load") {
    const index = path.join(req.dir, "model_index.json");
    if (!fs.existsSync(index)) return say({ ok: false, error: "ValueError: that folder has no model_index.json; it is not a diffusers model" });
    const cls = JSON.parse(fs.readFileSync(index, "utf8"))._class_name ?? "";
    loaded = { dir: req.dir, kind: /Video|Wan|LTX|Mochi|CogVideoX|Hunyuan/.test(cls) ? "video" : "image" };
    return say({ ok: true, kind: loaded.kind, offloaded: false, weightsGb: 0.1, vramGb: 48 });
  }
  if (req.op === "generate") {
    if (!loaded) return say({ ok: false, error: "ValueError: no model is loaded" });
    if (process.env.FAKE_WORKER_LOG) fs.appendFileSync(process.env.FAKE_WORKER_LOG, JSON.stringify({ ...req, init: req.init ? `${req.init.length} chars` : null }) + "\n");
    if (/fail please/.test(req.prompt)) return say({ ok: false, error: "RuntimeError: the model choked" });
    say({ progress: 0.5 });
    if (loaded.kind === "video") return say({ ok: true, video: MP4, frames: req.frames ?? 33, fps: 16 });
    return say({ ok: true, image: PNG, width: req.width ?? 1024, height: req.height ?? 1024 });
  }
  if (req.op === "unload") {
    loaded = null;
    return say({ ok: true });
  }
  say({ ok: false, error: `unknown op ${req.op}` });
});
