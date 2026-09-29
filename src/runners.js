import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

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

for (const d of [DATA_DIR, MODELS_DIR, BIN_DIR, OUTPUT_DIR, UPLOAD_DIR]) fs.mkdirSync(d, { recursive: true });

export function which(cmd) {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    return execFileSync(finder, [cmd], { encoding: "utf8", timeout: 3000 }).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function sdBinary() {
  const local = path.join(BIN_DIR, process.platform === "win32" ? "sd.exe" : "sd");
  return fs.existsSync(local) ? local : which("sd");
}

function whisperBinary() {
  const local = path.join(BIN_DIR, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
  return fs.existsSync(local) ? local : which("whisper-cli");
}

export async function detect(fetchImpl = fetch) {
  const ollamaPath = which("ollama");
  let ollamaRunning = false;
  let ollamaModels = [];
  if (ollamaPath) {
    try {
      const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
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
    ollama: { installed: Boolean(ollamaPath), running: ollamaRunning, models: ollamaModels },
    whisper: { installed: Boolean(whisperBinary()) },
    sd: { installed: Boolean(sdBinary()) },
    models: downloadedFiles(),
  };
}

// Files already in the models folder, keyed by "repo/file".
export function downloadedFiles() {
  const out = [];
  if (!fs.existsSync(MODELS_DIR)) return out;
  for (const owner of fs.readdirSync(MODELS_DIR)) {
    const ownerDir = path.join(MODELS_DIR, owner);
    if (!fs.statSync(ownerDir).isDirectory()) continue;
    for (const repo of fs.readdirSync(ownerDir)) {
      const repoDir = path.join(ownerDir, repo);
      if (!fs.statSync(repoDir).isDirectory()) continue;
      for (const file of fs.readdirSync(repoDir)) out.push(`${owner}/${repo}/${file}`);
    }
  }
  return out;
}

export function modelPath(repo, file) {
  return path.join(MODELS_DIR, ...repo.split("/"), file);
}

// ---- the commands, per step kind ------------------------------------------

const REPO_RE = /^(?!\.)[\w.-]+\/(?!\.)[\w.-]+$/;
const FILE_RE = /^(?!\.+$)[\w.+-]+$/;
const OLLAMA_NAME_RE = /^[\w.:/-]+$/;

// Returns { argv, cwd?, description } for a step, or a { download } request
// the runner streams itself, or throws when the arguments are not allowed.
export function commandFor(kind, args, machine, hubBase = "https://huggingface.co") {
  const platform = machine.platform;
  switch (kind) {
    case "install-ollama":
      if (platform === "darwin") return { argv: ["brew", "install", "ollama"], text: "Installing Ollama with Homebrew" };
      if (platform === "win32") return { argv: ["winget", "install", "--id", "Ollama.Ollama", "-e", "--accept-package-agreements", "--accept-source-agreements"], text: "Installing Ollama with winget" };
      return { argv: ["sh", "-c", "curl -fsSL https://ollama.com/install.sh | sh"], text: "Installing Ollama with the official script" };
    case "start-ollama":
      return { argv: ["ollama", "serve"], detached: true, text: "Starting Ollama in the background", waitFor: `${OLLAMA_URL}/api/tags` };
    case "pull-model": {
      const name = String(args.name ?? "");
      if (!OLLAMA_NAME_RE.test(name)) throw new Error("Bad model name");
      return { argv: ["ollama", "pull", name], text: `Downloading ${name} through Ollama` };
    }
    case "create-model": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const name = String(args.name ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !OLLAMA_NAME_RE.test(name)) throw new Error("Bad model arguments");
      const modelfile = path.join(path.dirname(modelPath(repo, file)), "Modelfile");
      fs.mkdirSync(path.dirname(modelfile), { recursive: true });
      fs.writeFileSync(modelfile, `FROM ${modelPath(repo, file)}\n`);
      return { argv: ["ollama", "create", name, "-f", modelfile], text: `Registering ${file} with Ollama as ${name}` };
    }
    case "download-file": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file)) throw new Error("Bad file arguments");
      return { download: { url: `${hubBase}/${repo}/resolve/main/${file}`, dest: modelPath(repo, file) }, text: `Downloading ${file}` };
    }
    case "install-whisper":
      if (platform === "darwin" || platform === "linux") return { argv: ["brew", "install", "whisper-cpp"], text: "Installing whisper.cpp with Homebrew" };
      return { githubRelease: { repo: "ggerganov/whisper.cpp", match: /whisper-bin-x64\.zip$/, pick: /whisper-cli\.exe$/ }, text: "Downloading the whisper.cpp release for Windows" };
    case "install-sd": {
      const match = platform === "darwin"
        ? /Darwin.*arm64\.zip$/
        : platform === "win32"
          ? (/nvidia/i.test(machine.gpu) ? /win-cuda12-x64\.zip$/ : /win-cpu-x64\.zip$/)
          : /Linux-Ubuntu.*x86_64\.zip$/;
      return { githubRelease: { repo: "leejet/stable-diffusion.cpp", match, pick: /(^|\/)sd(\.exe)?$/ }, text: "Downloading the stable-diffusion.cpp release for this computer" };
    }
    case "transcribe": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const audio = String(args.audio ?? "");
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !FILE_RE.test(path.basename(audio)) || path.dirname(path.resolve(audio)) !== UPLOAD_DIR) throw new Error("Bad transcription arguments");
      const bin = whisperBinary();
      if (!bin) throw new Error("whisper-cli is not installed");
      const out = path.join(OUTPUT_DIR, path.basename(audio, path.extname(audio)));
      return { argv: [bin, "-m", modelPath(repo, file), "-f", audio, "-otxt", "-of", out, "-np"], text: "Transcribing", result: `${out}.txt` };
    }
    case "generate-image": {
      const repo = String(args.repo ?? "");
      const file = String(args.file ?? "");
      const prompt = String(args.prompt ?? "").slice(0, 1000);
      if (!REPO_RE.test(repo) || !FILE_RE.test(file) || !prompt.trim()) throw new Error("Bad image arguments");
      const bin = sdBinary();
      if (!bin) throw new Error("stable-diffusion.cpp is not installed");
      const out = path.join(OUTPUT_DIR, `image-${Date.now()}.png`);
      const steps = /turbo/i.test(file) ? "4" : "20";
      const argv = [bin, "-m", modelPath(repo, file), "-p", prompt, "-o", out, "--steps", steps, "-W", "512", "-H", "512"];
      if (/turbo/i.test(file)) argv.push("--cfg-scale", "1");
      return { argv, text: "Generating the image", result: out };
    }
    default:
      throw new Error(`Unknown step ${kind}`);
  }
}

// ---- running steps with a live log -------------------------------------------

const runs = new Map();
let nextRun = 1;

export function startRun(kind, args, machine, { token = "", fetchImpl = fetch, hubBase } = {}) {
  const spec = commandFor(kind, args, machine, hubBase);
  const id = String(nextRun++);
  const run = { id, kind, status: "running", lines: [], listeners: new Set(), result: spec.result ?? null, startedAt: Date.now() };
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
  };
  emit(spec.text);

  if (spec.download) {
    downloadFile(spec.download.url, spec.download.dest, token, emit, fetchImpl).then(() => finish("done", "Download complete.")).catch((err) => finish("failed", `Download failed: ${err.message}`));
  } else if (spec.githubRelease) {
    installRelease(spec.githubRelease, emit, fetchImpl).then(() => finish("done", "Installed.")).catch((err) => finish("failed", `Install failed: ${err.message}`));
  } else if (spec.detached) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { detached: true, stdio: "ignore" });
    child.on("error", (err) => finish("failed", err.message));
    child.unref();
    waitForUrl(spec.waitFor, fetchImpl).then((ok) => finish(ok ? "done" : "failed", ok ? "Ollama is running." : "Ollama did not answer in time."));
  } else {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { env: { ...process.env, HF_TOKEN: token || "" } });
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

async function installRelease({ repo, match, pick }, emit, fetchImpl) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { "User-Agent": "huggingfound", Accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`GitHub replied HTTP ${res.status}`);
  const release = await res.json();
  const asset = (release.assets ?? []).find((a) => match.test(a.name));
  if (!asset) throw new Error(`no download for this computer in ${repo} ${release.tag_name}`);
  const zip = path.join(BIN_DIR, asset.name);
  emit(`Fetching ${asset.name} (${(asset.size / 1024 ** 2).toFixed(0)} MB)`);
  await downloadFile(asset.browser_download_url, zip, "", emit, fetchImpl);
  const extractDir = path.join(BIN_DIR, asset.name.replace(/\.zip$/, ""));
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  emit("Unpacking");
  if (process.platform === "win32") {
    execFileSync("powershell", ["-NoProfile", "-Command", `Expand-Archive -Force -Path '${zip}' -DestinationPath '${extractDir}'`]);
  } else {
    execFileSync("unzip", ["-o", "-q", zip, "-d", extractDir]);
  }
  const found = walk(extractDir).find((f) => pick.test(f));
  if (!found) throw new Error("the download did not contain the program");
  const dest = path.join(BIN_DIR, path.basename(found));
  fs.copyFileSync(found, dest);
  if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
  fs.rmSync(zip, { force: true });
  emit(`Installed to ${dest}`);
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
