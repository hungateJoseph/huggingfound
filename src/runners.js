import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { convertDiffusersFolder } from "./convert.js";

// The three local runners and everything the app does on the machine:
// where files live, what is installed, and the commands that install,
// download and run. Every command is built here from checked arguments;
// the page only names a step, it never sends a shell string.

// HUGGINGFOUND_HOME moves everything (models, downloads, settings) elsewhere.
export const DATA_DIR = process.env.HUGGINGFOUND_HOME || path.join(os.homedir(), "HuggingFound");
export const MODELS_DIR = path.join(DATA_DIR, "models");
export const BIN_DIR = path.join(DATA_DIR, "bin");
export const OUTPUT_DIR = path.join(DATA_DIR, "output");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const OLLAMA_URL = "http://127.0.0.1:11434";

// Chat models can run on another machine: a rented GPU reached through
// RunPod's proxy, or a box behind an SSH tunnel. Every Ollama call takes the
// address to use; empty means the Ollama on this computer. The address is
// handed in per request, since on the hosted site each signed-in person
// has a machine of their own.
export function ollamaUrl(remote = "") {
  return remote || OLLAMA_URL;
}

for (const d of [DATA_DIR, MODELS_DIR, BIN_DIR, OUTPUT_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

export function which(cmd) {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    return execFileSync(finder, [cmd], { encoding: "utf8", timeout: 3000 }).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

// Ollama from the PATH when it is installed system-wide, otherwise the
// release build HuggingFound unpacked into its own bin folder.
function ollamaBinary() {
  const onPath = which("ollama");
  if (onPath) return onPath;
  const dist = path.join(BIN_DIR, "ollama");
  if (!fs.existsSync(dist)) return null;
  const name = process.platform === "win32" ? "ollama.exe" : "ollama";
  return walk(dist).find((f) => path.basename(f) === name) ?? null;
}

// Programs HuggingFound installed itself live under bin/<name>/ with their
// libraries; one already on the PATH is used as it is.
function localBinary(dirName, names) {
  const dir = path.join(BIN_DIR, dirName);
  if (fs.existsSync(dir)) {
    const hit = walk(dir).find((f) => names.includes(path.basename(f)));
    if (hit) return hit;
  }
  for (const n of names) {
    const found = which(n);
    if (found) return found;
  }
  return null;
}

const EXE = process.platform === "win32" ? ".exe" : "";
const sdBinary = () => localBinary("sd", [`sd-cli${EXE}`, `sd${EXE}`]);
const whisperBinary = () => localBinary("whisper", [`whisper-cli${EXE}`]);

export async function detect(fetchImpl = fetch, remote = "") {
  // With a chat server there is nothing to install here: it counts as
  // installed, and as running when it answers.
  const ollamaPath = remote ? "remote" : ollamaBinary();
  let ollamaRunning = false;
  let ollamaModels = [];
  if (ollamaPath) {
    try {
      const res = await fetchImpl(`${ollamaUrl(remote)}/api/tags`, { signal: AbortSignal.timeout(remote ? 4000 : 1500) });
      if (res.ok) {
        ollamaRunning = true;
        ollamaModels = ((await res.json()).models ?? []).map((m) => m.name);
      }
    } catch {
      // installed but not running
    }
  }
  return {
    brew: Boolean(which("brew")),
    winget: process.platform === "win32" && Boolean(which("winget")),
    ffmpeg: Boolean(which("ffmpeg")),
    ollama: { installed: Boolean(ollamaPath), running: ollamaRunning, models: ollamaModels, remote },
    whisper: { installed: Boolean(whisperBinary()) },
    sd: { installed: Boolean(sdBinary()), server: Boolean(sdServerBinary()), loaded: imageServerState() },
    models: downloadedFiles(),
  };
}

// Files already in the models folder, keyed by "owner/repo/path", where the
// path may have folders in it (diffusers layouts do).
export function downloadedFiles() {
  const out = [];
  if (!fs.existsSync(MODELS_DIR)) return out;
  for (const owner of fs.readdirSync(MODELS_DIR)) {
    const ownerDir = path.join(MODELS_DIR, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      for (const file of walk(repoDir)) {
        if (!file.endsWith(".part")) out.push(`${owner}/${repo}/${path.relative(repoDir, file).split(path.sep).join("/")}`);
      }
    }
  }
  return out;
}

// Everything taking up space: files in the models folder with their sizes,
// and the models Ollama holds in its own store.
export async function storage(fetchImpl = fetch, remote = "") {
  const files = downloadedFiles().map((key) => {
    const parts = key.split("/");
    const repo = parts.slice(0, 2).join("/");
    const file = parts.slice(2).join("/");
    let gb = 0;
    try {
      gb = fs.statSync(modelPath(repo, file)).size / 1024 ** 3;
    } catch {
      // vanished between listing and stat
    }
    return { repo, file, gb };
  }).filter((f) => !/^Modelfile$/.test(f.file));
  let ollama = [];
  try {
    const res = await fetchImpl(`${ollamaUrl(remote)}/api/tags`, { signal: AbortSignal.timeout(remote ? 4000 : 1500) });
    if (res.ok) ollama = ((await res.json()).models ?? []).map((m) => ({ name: m.name, gb: (m.size ?? 0) / 1024 ** 3 }));
  } catch {
    // not running; its models cannot be listed or removed until it is
  }
  // Models on a chat server take no room on this drive.
  const totalGb = files.reduce((t, f) => t + f.gb, 0) + (remote ? 0 : ollama.reduce((t, m) => t + m.gb, 0));
  return { files, ollama, ollamaRemote: remote, totalGb, outputs: folderSize(OUTPUT_DIR) + folderSize(UPLOAD_DIR), disk: diskSpace() };
}

// Free and total space on the drive that holds the data folder.
export function diskSpace() {
  try {
    const st = fs.statfsSync(DATA_DIR);
    return { freeGb: (st.bavail * st.bsize) / 1024 ** 3, totalGb: (st.blocks * st.bsize) / 1024 ** 3 };
  } catch {
    return { freeGb: null, totalGb: null };
  }
}

function folderSize(dir) {
  if (!fs.existsSync(dir)) return 0;
  return walk(dir).reduce((t, f) => {
    try {
      return t + fs.statSync(f).size / 1024 ** 3;
    } catch {
      return t;
    }
  }, 0);
}

// Generated pictures, transcripts and uploaded recordings.
export function clearOutputs() {
  for (const dir of [OUTPUT_DIR, UPLOAD_DIR]) {
    for (const f of walk(dir)) fs.rmSync(f, { force: true });
  }
}

export function removeFile(repo, file) {
  if (!REPO_RE.test(String(repo)) || !SUBPATH_RE.test(String(file))) throw new Error("Bad file arguments");
  const target = modelPath(repo, file);
  if (!fs.existsSync(target)) throw new Error("That file is not on this computer");
  if (imageServer.file === target) stopImageServer();
  fs.rmSync(target, { force: true });
  // A Modelfile only points at the file; drop it and any folders left empty.
  const dir = path.dirname(target);
  const modelfile = path.join(dir, "Modelfile");
  if (fs.existsSync(modelfile) && !fs.readdirSync(dir).some((n) => n !== "Modelfile")) fs.rmSync(modelfile, { force: true });
  pruneEmpty(dir);
}

// A whole repository folder (a diffusers layout is several files).
export function removeFolder(repo) {
  if (!REPO_RE.test(String(repo))) throw new Error("Bad repository name");
  const dir = path.join(MODELS_DIR, ...repo.split("/"));
  if (!fs.existsSync(dir)) throw new Error("That model is not on this computer");
  if (imageServer.file && imageServer.file.startsWith(dir + path.sep)) stopImageServer();
  fs.rmSync(dir, { recursive: true, force: true });
  pruneEmpty(path.dirname(dir));
}

function pruneEmpty(dir) {
  let d = dir;
  while (d.startsWith(MODELS_DIR) && d !== MODELS_DIR && fs.existsSync(d) && fs.readdirSync(d).length === 0) {
    fs.rmdirSync(d);
    d = path.dirname(d);
  }
}

export async function removeOllamaModel(name, fetchImpl = fetch, remote = "") {
  if (!OLLAMA_NAME_RE.test(String(name))) throw new Error("Bad model name");
  let res;
  try {
    res = await fetchImpl(`${ollamaUrl(remote)}/api/delete`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, name }) });
  } catch {
    throw new Error("Ollama is not running, so its models cannot be removed. Start it and try again");
  }
  if (res.status === 404) throw new Error("Ollama does not have that model");
  if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}`);
}

export function modelPath(repo, file) {
  return path.join(MODELS_DIR, ...repo.split("/"), file);
}

// ---- the commands, per step kind ------------------------------------------

const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/;
const FILE_RE = /^(?!\.+$)[\w.+-]+$/;
// A file up to two folders deep inside a repository, no dot-segments.
const SUBPATH_RE = /^(?!\.)[\w.+-]+(?:\/(?!\.)[\w.+-]+){0,2}$/;
const OLLAMA_NAME_RE = /^[\w.:/-]+$/;
// How hard a model is asked to work: the page offers these three for every kind.
export const EFFORTS = new Set(["quick", "standard", "thorough"]);

// Returns { argv, cwd?, description } for a step, or a { download } request
// the runner streams itself, or throws when the arguments are not allowed.
export function commandFor(kind, args, machine, hubBase = "https://huggingface.co") {
  const platform = machine.platform;
  switch (kind) {
    case "install-ollama":
      // The official release builds, unpacked into ~/HuggingFound/bin/ollama.
      // Package managers are avoided on purpose: on a macOS version Homebrew
      // no longer ships bottles for, `brew install ollama` compiles from
      // source inside a sandbox and fails.
      if (platform === "darwin") return { githubRelease: { repo: "ollama/ollama", match: /^ollama-darwin\.tgz$/, pick: /(^|\/)ollama$/, dir: "ollama" }, text: "Downloading the Ollama release for macOS" };
      if (platform === "win32") return { githubRelease: { repo: "ollama/ollama", match: machine.arch === "arm64" ? /^ollama-windows-arm64\.zip$/ : /^ollama-windows-amd64\.zip$/, pick: /(^|\/)ollama\.exe$/, dir: "ollama" }, text: "Downloading the Ollama release for Windows" };
      return { argv: ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"], text: "Installing Ollama with the official script" };
    case "start-ollama":
      return { argv: [needOllama(), "serve"], detached: true, text: "Starting Ollama in the background", waitFor: `${OLLAMA_URL}/api/tags` };
    case "pull-model": {
      const name = String(args.name ?? "");
      if (!OLLAMA_NAME_RE.test(name)) throw new Error("Bad model name");
      return { argv: [needOllama(), "pull", name], text: `Downloading ${name} through Ollama` };
    }
    case "create-model": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const name = String(args.name ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !OLLAMA_NAME_RE.test(name)) throw new Error("Bad model arguments");
      const modelfile = path.join(path.dirname(modelPath(repo, file)), "Modelfile");
      fs.mkdirSync(path.dirname(modelfile), { recursive: true });
      fs.writeFileSync(modelfile, `FROM ${modelPath(repo, file)}\n`);
      return { argv: [needOllama(), "create", name, "-f", modelfile], text: `Registering ${file} with Ollama as ${name}` };
    }
    case "download-file": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      if (!REPO_RE.test(repo) || !SUBPATH_RE.test(file)) throw new Error("Bad file arguments");
      return { download: { url: `${hubBase}/${repo}/resolve/main/${file}`, dest: modelPath(repo, file) }, text: `Downloading ${file}` };
    }
    case "download-files": {
      // Several files of one repository, each saved under the name the
      // runner expects (a diffusers folder's half-precision variants lose
      // their .fp16 suffix).
      const repo = String(args.repo ?? "");
      const files = Array.isArray(args.files) ? args.files : [];
      if (!REPO_RE.test(repo) || files.length === 0 || files.length > 8) throw new Error("Bad file arguments");
      const downloads = files.map((f) => {
        const from = String(f.from ?? "");
        const to = String(f.to ?? from);
        if (!SUBPATH_RE.test(from) || !SUBPATH_RE.test(to)) throw new Error("Bad file arguments");
        return { url: `${hubBase}/${repo}/resolve/main/${from}`, dest: modelPath(repo, to), name: from };
      });
      // A diffusers folder is merged into one checkpoint afterwards, which
      // is the form stable-diffusion.cpp identifies and loads reliably.
      let convert = null;
      if (args.convert === "diffusers") {
        const into = String(args.into ?? "");
        if (!FILE_RE.test(into) || !into.endsWith(".safetensors")) throw new Error("Bad file arguments");
        convert = { dir: path.join(MODELS_DIR, ...repo.split("/")), into: modelPath(repo, into) };
      }
      return { downloads, convert, text: `Downloading ${downloads.length} files of ${repo}` };
    }
    case "install-whisper":
      if (platform === "win32") return { githubRelease: { repo: "ggerganov/whisper.cpp", match: /^whisper-bin-x64\.zip$/, pick: /whisper-cli\.exe$/, dir: "whisper" }, text: "Downloading the whisper.cpp release for Windows" };
      // No macOS or Linux binaries are published; it builds in a minute or two.
      return {
        build: { repo: "ggerganov/whisper.cpp", dir: "whisper", cmakeArgs: ["-DBUILD_SHARED_LIBS=OFF", "-DWHISPER_BUILD_TESTS=OFF", "-DWHISPER_BUILD_SERVER=OFF"], pick: /(^|\/)whisper-cli$/ },
        text: "Building whisper.cpp from source",
      };
    case "install-sd": {
      const match = platform === "darwin"
        ? /Darwin.*arm64\.zip$/
        : platform === "win32"
          ? (/nvidia/i.test(machine.gpu) ? /win-cuda12-x64\.zip$/ : /win-cpu-x64\.zip$/)
          : /Linux-Ubuntu.*x86_64\.zip$/;
      // The release build is tried first and checked with --help. It is
      // compiled on the newest macOS, so on an older one it will not load;
      // then it is built from source instead.
      return {
        githubRelease: { repo: "leejet/stable-diffusion.cpp", match, pick: /(^|\/)sd(-cli)?(\.exe)?$/, dir: "sd", verify: ["--help"] },
        fallbackBuild: platform === "win32" ? null : { repo: "leejet/stable-diffusion.cpp", dir: "sd", cmakeArgs: platform === "darwin" ? ["-DSD_METAL=ON"] : [], pick: /(^|\/)sd-(cli|server)$/ },
        text: "Installing stable-diffusion.cpp",
      };
    }
    case "transcribe": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const audio = String(args.audio ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !FILE_RE.test(path.basename(audio)) || path.dirname(path.resolve(audio)) !== UPLOAD_DIR) throw new Error("Bad transcription arguments");
      const bin = whisperBinary();
      if (!bin) throw new Error("whisper-cli is not installed");
      const out = path.join(OUTPUT_DIR, path.basename(audio, path.extname(audio)));
      // Effort: a wider beam search hears more and takes longer; a single
      // beam is the quick pass.
      const effort = String(args.effort ?? "standard");
      if (!EFFORTS.has(effort)) throw new Error("Bad effort");
      const extra = effort === "thorough" ? ["-bs", "8", "-bo", "8"] : effort === "quick" ? ["-bs", "1", "-bo", "1"] : [];
      return { argv: [bin, "-m", modelPath(repo, file), "-f", audio, "-otxt", "-of", out, "-np", ...extra], text: effort === "thorough" ? "Transcribing carefully (wide beam search)" : "Transcribing", result: `${out}.txt` };
    }
    case "generate-image": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const prompt = String(args.prompt ?? "").slice(0, 1000);
      const negative = String(args.negative ?? "").slice(0, 1000).trim();
      const quality = String(args.quality ?? "default");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !prompt.trim() || !QUALITIES[quality]) throw new Error("Bad image arguments");
      const modelArg = modelPath(repo, file);
      const fast = isFastImageModel(`${repo}/${file}`);
      const xl = /xl/i.test(file) || /xl/i.test(repo);
      const settings = { ...imageSettings(quality, { fast, xl }), negative };
      const out = path.join(OUTPUT_DIR, `image-${Date.now()}.png`);

      // A remote image server makes the picture with the model loaded there.
      if (args.remote) {
        return { run: (emit, fetchImpl) => generateRemote(String(args.remote), prompt, settings, out, emit, fetchImpl), text: `Asking the image server at ${args.remote}`, result: out };
      }
      if (!fs.existsSync(modelArg)) throw new Error("The model file is not downloaded yet");
      const server = sdServerBinary();
      if (server) {
        return { run: (emit, fetchImpl) => generateWithServer(server, modelArg, prompt, settings, out, emit, fetchImpl), text: `Generating the image (${settings.label})`, result: out };
      }
      const bin = sdBinary();
      if (!bin) throw new Error("stable-diffusion.cpp is not installed");
      const argv = [bin, "-m", modelArg, "-p", prompt, "-o", out, ...settings.cliArgs];
      if (negative) argv.push("-n", negative);
      return { argv, text: `Generating the image (${settings.label})`, result: out };
    }
    // Editing a picture an earlier run made: the same kind of model paints
    // over it from a description, keeping its layout (img2img). Another
    // model than the one that made it may do the editing, which is how a
    // model that cannot edit hands its picture to one that can.
    case "edit-image": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const init = path.basename(String(args.init ?? ""));
      const prompt = String(args.prompt ?? "").slice(0, 1000);
      const negative = String(args.negative ?? "").slice(0, 1000).trim();
      const quality = String(args.quality ?? "default");
      const strength = Math.min(0.95, Math.max(0.1, Number(args.strength) || 0.55));
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !/^image-\d+(?:-edit-\d+)*\.png$/.test(init) || !prompt.trim() || !QUALITIES[quality]) throw new Error("Bad edit arguments");
      const initPath = path.join(OUTPUT_DIR, init);
      if (!fs.existsSync(initPath)) throw new Error("The picture to edit is no longer here");
      const modelArg = modelPath(repo, file);
      if (!fs.existsSync(modelArg)) throw new Error("The editing model is not downloaded yet");
      const bin = sdBinary();
      if (!bin) throw new Error("stable-diffusion.cpp is not installed");
      const fast = isFastImageModel(`${repo}/${file}`);
      const xl = /xl/i.test(file) || /xl/i.test(repo);
      const settings = imageSettings(quality, { fast, xl });
      const out = path.join(OUTPUT_DIR, `${init.slice(0, -4)}-edit-${Date.now()}.png`);
      // The command-line build does the editing one picture at a time; a
      // model held in memory by the image server would double the memory.
      stopImageServer();
      const argv = [bin, "-M", "img_gen", "-m", modelArg, "-i", initPath, "--strength", String(strength), "-p", prompt, "-o", out, ...settings.cliArgs.filter((a, i, all) => !["-W", "-H"].includes(a) && !["-W", "-H"].includes(all[i - 1]))];
      if (negative) argv.push("-n", negative);
      return { argv, text: `Editing ${init} with ${file} (${settings.label}, keeping ${Math.round((1 - strength) * 100)}% of the picture)`, result: out };
    }
    default:
      throw new Error(`Unknown step ${kind}`);
  }
}

// ---- image generation settings -----------------------------------------------

// Three presets. Default is exactly what stable-diffusion.cpp does on its
// own (20 steps, Euler a). Fast trades a few steps for a better sampler;
// Max spends twice the steps. Distilled models (Turbo, Lightning, LCM,
// Hyper) are built for 4 steps and ignore most of this. Flash attention is
// left off: on Metal it broke the VAE at 768 by 768 and saves little.
export const QUALITIES = {
  fast: { label: "Fast", steps: 12, sampler: "dpm++2m", scheduler: "karras" },
  default: { label: "Default", steps: 20, sampler: null, scheduler: null },
  max: { label: "Max", steps: 40, sampler: "dpm++2m", scheduler: "karras" },
};

export function isFastImageModel(name) {
  return /turbo|lightning|lcm|hyper/i.test(name);
}

export function imageSettings(quality, { fast, xl }) {
  const q = QUALITIES[quality] ?? QUALITIES.default;
  const size = xl && !fast ? 768 : 512;
  const steps = fast ? (quality === "max" ? 8 : 4) : q.steps;
  const sampler = fast ? "euler" : q.sampler;
  const scheduler = fast ? "sgm_uniform" : q.scheduler;
  const cfg = fast ? 1 : 7;
  const cliArgs = ["--steps", String(steps), "-W", String(size), "-H", String(size), "--cfg-scale", String(cfg)];
  if (sampler) cliArgs.push("--sampling-method", sampler);
  if (scheduler) cliArgs.push("--scheduler", scheduler);

  // sd-server takes the same sampler and scheduler names as the command line.
  const samplerName = sampler ?? "euler_a";
  const schedulerName = scheduler ?? "discrete";
  return { label: `${q.label}, ${steps} steps`, steps, size, cfg, sampler, scheduler, samplerName, schedulerName, cliArgs };
}

// ---- keeping the image model loaded ------------------------------------------

// sd-server holds one model in memory and answers over HTTP, so the second
// picture skips the 20 to 40 seconds of loading the first one paid. One
// server at a time, restarted when a different model is asked for, stopped
// after a quiet quarter hour, when the model is removed, and when the app
// exits.
const sdServerBinary = () => localBinary("sd", [`sd-server${EXE}`]);
const IMAGE_SERVER_PORT = 4189;
const IMAGE_SERVER_IDLE_MS = 15 * 60 * 1000;
const imageServer = { proc: null, file: null, ready: false, timer: null, errors: [], url: `http://127.0.0.1:${IMAGE_SERVER_PORT}` };

export function imageServerState() {
  return { file: imageServer.file, ready: imageServer.ready };
}

export function stopImageServer(reason = "") {
  if (imageServer.timer) clearTimeout(imageServer.timer);
  imageServer.timer = null;
  if (imageServer.proc) {
    try {
      imageServer.proc.kill();
    } catch {
      // already gone
    }
  }
  imageServer.proc = null;
  imageServer.file = null;
  imageServer.ready = false;
  imageServer.errors = [];
  return reason;
}

process.on("exit", () => stopImageServer());
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopImageServer();
    process.exit(0);
  });
}

function touchImageServer() {
  if (imageServer.timer) clearTimeout(imageServer.timer);
  imageServer.timer = setTimeout(() => stopImageServer("idle"), IMAGE_SERVER_IDLE_MS);
  imageServer.timer.unref?.();
}

async function ensureImageServer(bin, modelFile, emit, fetchImpl) {
  if (imageServer.proc && imageServer.file === modelFile && imageServer.ready) {
    emit("Using the model already loaded in memory.");
    touchImageServer();
    return imageServer.url;
  }
  if (imageServer.proc) {
    emit(`Unloading ${path.basename(imageServer.file)} to make room.`);
    stopImageServer();
  }
  emit(`Loading ${path.basename(modelFile)} into memory; it stays loaded for the next pictures.`);
  // VAE tiling decodes the picture in pieces; without it the decoder ran
  // out of room on a 16 GB Mac at 768 by 768 and the request never came back.
  const argv = ["-m", modelFile, "--listen-ip", "127.0.0.1", "--listen-port", String(IMAGE_SERVER_PORT), "--vae-tiling"];
  const proc = spawn(bin, argv, { cwd: DATA_DIR, stdio: ["ignore", "pipe", "pipe"] });
  imageServer.proc = proc;
  imageServer.file = modelFile;
  imageServer.ready = false;
  imageServer.errors = [];
  let tail = "";
  const onData = (chunk) => {
    tail = (tail + chunk.toString()).slice(-2000);
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (/\[ERROR/.test(line)) imageServer.errors.push({ at: Date.now(), line: line.trim() });
      if (/ERROR|Version:|listening/.test(line)) emit(line.trim());
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("exit", () => {
    if (imageServer.proc === proc) stopImageServer();
  });
  for (let i = 0; i < 180; i++) {
    if (proc.exitCode !== null) throw new Error(`the image server stopped: ${tail.split("\n").filter(Boolean).pop() ?? "no output"}`);
    try {
      const res = await fetchImpl(`${imageServer.url}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        imageServer.ready = true;
        touchImageServer();
        return imageServer.url;
      }
    } catch {
      // still loading
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stopImageServer();
  throw new Error("the image server did not answer in three minutes");
}

// Submits a job to sd-server's native async API and polls it. No request
// stays open for minutes, so nothing times out, and a job that fails on
// the server reports why.
async function txt2img(url, prompt, settings, out, emit, fetchImpl) {
  const body = {
    prompt,
    negative_prompt: settings.negative || "",
    width: settings.size,
    height: settings.size,
    seed: -1,
    sample_params: { sample_steps: settings.steps, sample_method: settings.samplerName, scheduler: settings.schedulerName, guidance: { txt_cfg: settings.cfg } },
    vae_tiling_params: { enabled: true },
    output_format: "png",
  };
  emit(`${settings.steps} steps at ${settings.size} by ${settings.size}, ${settings.samplerName}${settings.negative ? `; avoiding: ${settings.negative}` : ""}`);
  const submitted = await fetchImpl(`${url}/sdcpp/v1/img_gen`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  if (!submitted.ok) throw new Error(`the image server refused the request (HTTP ${submitted.status})`);
  const job = await submitted.json();
  const started = Date.now();
  let lastStatus = "";
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    // The local server sometimes logs a failure without failing the job;
    // that line ends the wait.
    if (url === imageServer.url) {
      const err = imageServer.errors.find((e) => e.at >= started);
      if (err || !imageServer.proc) {
        stopImageServer();
        throw new Error(err ? err.line : "the image server stopped");
      }
    }
    if (Date.now() - started > 30 * 60 * 1000) throw new Error("no picture after 30 minutes");
    let state;
    try {
      const res = await fetchImpl(`${url}/sdcpp/v1/jobs/${encodeURIComponent(job.id)}`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state = await res.json();
    } catch (err) {
      throw new Error(`lost the image server while waiting: ${err.message}`);
    }
    if (state.status !== lastStatus) {
      lastStatus = state.status;
      if (state.status === "queued" && state.queue_position > 0) emit(`Waiting behind ${state.queue_position} other job${state.queue_position === 1 ? "" : "s"}`);
      if (state.status === "generating") emit("Generating");
    }
    if (state.status === "completed") {
      const b64 = state.result?.images?.[0]?.b64_json;
      if (!b64) throw new Error("the image server returned no image");
      fs.writeFileSync(out, Buffer.from(b64, "base64"));
      return out;
    }
    if (state.status === "failed" || state.status === "cancelled") {
      throw new Error(state.error?.message ?? state.error?.error ?? JSON.stringify(state.error ?? state.status));
    }
  }
}

async function generateWithServer(bin, modelFile, prompt, settings, out, emit, fetchImpl) {
  const url = await ensureImageServer(bin, modelFile, emit, fetchImpl);
  const result = await txt2img(url, prompt, settings, out, emit, fetchImpl);
  touchImageServer();
  return result;
}

async function generateRemote(remote, prompt, settings, out, emit, fetchImpl) {
  const url = remote.replace(/\/+$/, "");
  return txt2img(url, prompt, settings, out, emit, fetchImpl);
}

// What a remote or local sd-server has loaded, for the page to show.
export async function describeImageServer(url, fetchImpl = fetch) {
  const base = String(url).replace(/\/+$/, "");
  const res = await fetchImpl(`${base}/sdapi/v1/sd-models`, { signal: AbortSignal.timeout(4000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const list = await res.json();
  return { model: list[0]?.model_name ?? list[0]?.title ?? "unknown model" };
}

function needOllama() {
  const bin = ollamaBinary();
  if (!bin) throw new Error("Ollama is not installed; run the install step first");
  return bin;
}

// ---- running steps with a live log -------------------------------------------

const runs = new Map();
// Ids are random, so on the hosted site one person cannot read another's
// log by counting; `owner` says whose run it is.
const newRunId = () => crypto.randomBytes(8).toString("hex");

export function startRun(kind, args, machine, { token = "", fetchImpl = fetch, hubBase, owner = null } = {}) {
  const spec = commandFor(kind, args, machine, hubBase);
  const id = newRunId();
  const run = { id, kind, status: "running", lines: [], listeners: new Set(), result: spec.result ?? null, startedAt: Date.now(), owner };
  runs.set(id, run);
  const emit = (line) => {
    run.lines.push(line);
    if (run.lines.length > 2000) run.lines.shift();
    for (const l of run.listeners) l(line);
  };
  const finish = (status, message) => {
    run.status = status;
    if (status === "done" && (kind === "generate-image" || kind === "transcribe")) {
      recordTiming(`${args.repo}/${args.file}`, { kind: kind === "generate-image" ? "image" : "transcribe", seconds: (Date.now() - run.startedAt) / 1000 });
    }
    if (message) emit(message);
    for (const l of run.listeners) l(null);
  };
  emit(spec.text);

  if (spec.run) {
    spec.run(emit, fetchImpl).then(() => finish("done", "Done.")).catch((err) => finish("failed", `Failed: ${err.message}`));
  } else if (spec.download) {
    downloadFile(spec.download.url, spec.download.dest, token, emit, fetchImpl).then(() => finish("done", "Download complete.")).catch((err) => finish("failed", `Download failed: ${err.message}`));
  } else if (spec.downloads) {
    (async () => {
      if (spec.convert && fs.existsSync(spec.convert.into)) {
        emit("The merged checkpoint is already here.");
        return;
      }
      for (const [i, d] of spec.downloads.entries()) {
        if (fs.existsSync(d.dest)) {
          emit(`File ${i + 1} of ${spec.downloads.length}: ${d.name} is already here`);
          continue;
        }
        emit(`File ${i + 1} of ${spec.downloads.length}: ${d.name}`);
        await downloadFile(d.url, d.dest, token, emit, fetchImpl);
      }
      if (spec.convert) {
        await convertDiffusersFolder(spec.convert.dir, spec.convert.into, emit);
        // The parts are not needed once the checkpoint exists.
        for (const d of spec.downloads) fs.rmSync(d.dest, { force: true });
        for (const sub of ["unet", "vae", "text_encoder", "text_encoder_2"]) {
          const dir = path.join(spec.convert.dir, sub);
          if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
        }
        emit(`Saved as ${spec.convert.into}`);
      }
    })().then(() => finish("done", spec.convert ? "Ready." : "All files downloaded.")).catch((err) => finish("failed", `Download failed: ${err.message}`));
  } else if (spec.githubRelease) {
    installRelease(spec.githubRelease, emit, fetchImpl)
      .catch(async (err) => {
        if (!spec.fallbackBuild) throw err;
        emit(`The release build did not work here (${err.message}).`);
        await buildFromSource(spec.fallbackBuild, emit, fetchImpl);
      })
      .then(() => finish("done", "Installed."))
      .catch((err) => finish("failed", `Install failed: ${err.message}`));
  } else if (spec.build) {
    buildFromSource(spec.build, emit, fetchImpl).then(() => finish("done", "Installed.")).catch((err) => finish("failed", `Install failed: ${err.message}`));
  } else if (spec.detached) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { detached: true, stdio: "ignore", cwd: DATA_DIR });
    child.on("error", (err) => finish("failed", err.message));
    child.unref();
    waitForUrl(spec.waitFor, fetchImpl).then((ok) => finish(ok ? "done" : "failed", ok ? "Ollama is running." : "Ollama did not answer in time."));
  } else {
    // Children run from the data folder. Installers that sandbox themselves
    // (Homebrew does) cannot read a working directory under Documents or
    // Desktop and abort with "getcwd: Operation not permitted".
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: DATA_DIR, env: { ...process.env, HF_TOKEN: token || "" } });
    const onData = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n|\r/)) if (line.trim()) emit(line.trimEnd());
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", (err) => finish("failed", err.message));
    child.on("close", (code) => finish(code === 0 ? "done" : "failed", code === 0 ? "Done." : `Exited with code ${code}.`));
  }
  return run;
}

// How long real runs took here, by model file or Ollama name, so the page
// can show a measured time instead of a guess.
const TIMINGS_FILE = path.join(DATA_DIR, "timings.json");

export function readTimings() {
  try {
    return JSON.parse(fs.readFileSync(TIMINGS_FILE, "utf8"));
  } catch {
    return {};
  }
}

export function recordTiming(key, timing) {
  const all = readTimings();
  all[key] = { ...timing, at: new Date().toISOString() };
  fs.writeFileSync(TIMINGS_FILE, JSON.stringify(all, null, 2));
}

// A run driven by server code rather than a command: `work(emit)` does the
// job and the page follows the same live log.
export function startCustomRun(text, work, { owner = null } = {}) {
  const id = newRunId();
  const run = { id, kind: "custom", status: "running", lines: [], listeners: new Set(), result: null, startedAt: Date.now(), cancelled: false, owner };
  // Settles when the work is over, for callers that wait rather than watch.
  let settle;
  run.finished = new Promise((resolve) => (settle = resolve));
  runs.set(id, run);
  const emit = (line) => {
    run.lines.push(line);
    if (run.lines.length > 2000) run.lines.shift();
    for (const l of run.listeners) l(line);
  };
  const finish = (status, message) => {
    run.status = status;
    if (message) emit(message);
    for (const l of run.listeners) l(null);
    settle(status);
  };
  emit(text);
  Promise.resolve()
    .then(() => work(emit, () => run.cancelled))
    .then((result) => {
      run.result = result ?? null;
      finish("done", run.cancelled ? "Stopped." : "Done.");
    })
    .catch((err) => finish("failed", `Failed: ${err.message}`));
  return run;
}

// Asks the chat server to download a model itself, through Ollama's own
// API, and relays its progress. Nothing passes through this computer.
export function pullOnChatServer(name, fetchImpl = fetch, remote = "", { owner = null } = {}) {
  if (!OLLAMA_NAME_RE.test(name)) throw new Error("Bad model name");
  if (!remote) throw new Error("No chat server is set");
  const base = ollamaUrl(remote);
  return startCustomRun(`Downloading ${name} on the chat server`, async (emit, cancelled) => {
    // A machine rented a moment ago reports itself running before Ollama
    // on it answers (its container is still being fetched); the download
    // waits for it rather than failing on the proxy's 404.
    const started = Date.now();
    let said = false;
    for (;;) {
      if (cancelled()) return;
      try {
        const probe = await fetchImpl(`${base}/api/version`, { signal: AbortSignal.timeout(5000) });
        if (probe.ok) break;
      } catch {
        // not up yet
      }
      if (Date.now() - started > 10 * 60e3) throw new Error("Ollama on the chat server did not answer in ten minutes; check the machine in Settings");
      if (!said) emit("Waiting for Ollama on the machine to start (a new machine takes a few minutes)");
      said = true;
      await new Promise((r) => setTimeout(r, 5000));
    }
    if (said) emit("The machine is up.");
    const stop = new AbortController();
    const res = await fetchImpl(`${base}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, name, stream: true }), signal: stop.signal });
    if (!res.ok) throw new Error(`the chat server answered HTTP ${res.status}`);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let last = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (cancelled()) {
        stop.abort();
        return;
      }
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const j = JSON.parse(line);
        if (j.error) throw new Error(j.error);
        // One line per whole percent, so a long download does not flood the log.
        const text = j.total ? `${j.status}: ${Math.floor(((j.completed ?? 0) / j.total) * 100)}% of ${(j.total / 1024 ** 3).toFixed(1)} GB` : String(j.status ?? "");
        if (text && text !== last) emit(text);
        last = text;
      }
    }
  }, { owner });
}

export function cancelRun(id) {
  const run = runs.get(id);
  if (!run) return false;
  run.cancelled = true;
  return true;
}

export function getRun(id) {
  return runs.get(id);
}

async function waitForUrl(url, fetchImpl) {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function downloadFile(url, dest, token, emit, fetchImpl) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const headers = { "User-Agent": "huggingfound" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetchImpl(url, { headers, redirect: "follow" });
  if (res.status === 401 || res.status === 403) throw new Error("this file is gated; add a Hugging Face token and accept the licence on the model page");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  let lastPct = -1;
  const tmp = `${dest}.part`;
  const out = fs.createWriteStream(tmp);
  const reader = res.body.getReader();
  await pipeline(
    (async function* () {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct && pct % 2 === 0) {
            lastPct = pct;
            emit(`${pct}% of ${(total / 1024 ** 3).toFixed(2)} GB`);
          }
        }
        yield value;
      }
    })(),
    out,
  );
  fs.renameSync(tmp, dest);
}

// Fetches the matching asset of a project's latest GitHub release. With
// `dir` the whole archive is kept under bin/<dir> (Ollama needs its libraries
// next to the binary); otherwise only the picked program is copied out.
async function installRelease({ repo, match, pick, dir, verify }, emit, fetchImpl) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { "User-Agent": "huggingfound", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub replied HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets ?? []).find((a) => match.test(a.name));
  if (!asset) throw new Error(`no download for this computer in ${repo} ${release.tag_name}`);
  const archive = path.join(BIN_DIR, asset.name);
  emit(`Fetching ${asset.name} (${(asset.size / 1024 ** 2).toFixed(0)} MB)`);
  await downloadFile(asset.browser_download_url, archive, "", emit, fetchImpl);
  const extractDir = path.join(BIN_DIR, dir ?? asset.name.replace(/\.(zip|tgz|tar\.gz)$/, ""));
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  emit("Unpacking");
  extract(archive, extractDir);
  const found = walk(extractDir).find((f) => pick.test(f));
  if (!found) throw new Error("the download did not contain the program");
  fs.rmSync(archive, { force: true });
  if (dir) {
    if (process.platform !== "win32") fs.chmodSync(found, 0o755);
    if (verify) {
      const problem = await tryRun(found, verify);
      if (problem) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        throw new Error(problem);
      }
    }
    emit(`Installed to ${found}`);
    return;
  }
  const dest = path.join(BIN_DIR, path.basename(found));
  fs.copyFileSync(found, dest);
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
  fs.rmSync(extractDir, { recursive: true, force: true });
  emit(`Installed to ${dest}`);
}

// Runs a program once to see whether it loads on this machine. Returns a
// short reason when it does not, null when it does.
function tryRun(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: DATA_DIR });
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => resolve(e.message));
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(null);
      const m = /built for macOS [\d.]+ which is newer than running OS/.exec(err);
      resolve(m ? "it is compiled for a newer macOS than this one" : `it exited with ${signal ?? code}`);
    });
  });
}

// ---- building from source --------------------------------------------------

// git comes with the Xcode command line tools on macOS and with build
// essentials on Linux; CMake is fetched as a self-contained release when
// it is not already on the machine.
async function buildFromSource({ repo, dir, cmakeArgs, pick }, emit, fetchImpl) {
  const git = which("git");
  if (!git) {
    throw new Error(process.platform === "darwin" ? "git is needed; run `xcode-select --install` in Terminal, then try again" : "git is needed; install it with your package manager and try again");
  }
  if (process.platform === "darwin" && !fs.existsSync("/Library/Developer/CommandLineTools/usr/bin/clang") && !which("clang")) {
    throw new Error("the C compiler is missing; run `xcode-select --install` in Terminal, then try again");
  }
  const cmake = await ensureCmake(emit, fetchImpl);
  const src = path.join(BIN_DIR, `${dir}-src`);
  fs.rmSync(src, { recursive: true, force: true });
  emit(`Cloning github.com/${repo}`);
  await runLogged([git, "clone", "--depth", "1", "--recursive", "--shallow-submodules", `https://github.com/${repo}.git`, src], emit);
  emit("Configuring the build");
  await runLogged([cmake, "-S", src, "-B", path.join(src, "build"), "-DCMAKE_BUILD_TYPE=Release", ...cmakeArgs], emit);
  emit(`Compiling (this takes a few minutes; ${os.cpus().length} cores)`);
  await runLogged([cmake, "--build", path.join(src, "build"), "--config", "Release", "-j", String(Math.max(1, os.cpus().length - 1))], emit, /\[\s*\d+%\]|error|warning: unused/i);
  const found = walk(path.join(src, "build")).filter((f) => pick.test(f));
  if (!found.length) throw new Error("the build finished but the program was not found");
  const dest = path.join(BIN_DIR, dir);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  let target;
  for (const f of found) {
    target = path.join(dest, path.basename(f));
    fs.copyFileSync(f, target);
    fs.chmodSync(target, 0o755);
  }
  // The checkout and its build tree run to hundreds of megabytes; only the
  // program is kept.
  fs.rmSync(src, { recursive: true, force: true });
  emit(`Installed to ${target}`);
}

async function ensureCmake(emit, fetchImpl) {
  const onPath = which("cmake");
  if (onPath) return onPath;
  const local = fs.existsSync(path.join(BIN_DIR, "cmake")) ? walk(path.join(BIN_DIR, "cmake")).find((f) => path.basename(f) === "cmake") : null;
  if (local) return local;
  emit("CMake is not installed; fetching a self-contained copy");
  const match = process.platform === "darwin" ? /^cmake-[\d.]+-macos-universal\.tar\.gz$/ : os.arch() === "arm64" ? /^cmake-[\d.]+-linux-aarch64\.tar\.gz$/ : /^cmake-[\d.]+-linux-x86_64\.tar\.gz$/;
  await installRelease({ repo: "Kitware/CMake", match, pick: /(^|\/)bin\/cmake$/, dir: "cmake" }, emit, fetchImpl);
  const cmake = walk(path.join(BIN_DIR, "cmake")).find((f) => path.basename(f) === "cmake");
  if (!cmake) throw new Error("CMake could not be set up");
  return cmake;
}

// Runs a command to completion, streaming its output; `keep` limits which
// lines make it into the log for very chatty builds.
function runLogged(argv, emit, keep) {
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: DATA_DIR, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    const onData = (chunk) => {
      for (const line of chunk.toString().split(/\r?\n|\r/)) {
        if (!line.trim()) continue;
        if (!keep || keep.test(line)) emit(line.trimEnd());
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(argv[0])} exited with code ${code}`))));
  });
}

function extract(archive, dest) {
  if (/\.(tgz|tar\.gz)$/.test(archive)) {
    execFileSync("tar", ["-xzf", archive, "-C", dest], { cwd: DATA_DIR });
  } else if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${archive}' -DestinationPath '${dest}'`], { cwd: DATA_DIR });
  } else {
    execFileSync("unzip", ["-o", "-q", archive, "-d", dest], { cwd: DATA_DIR });
  }
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
