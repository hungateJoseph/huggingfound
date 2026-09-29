import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-runners-"));
const { BIN_DIR, DATA_DIR, MODELS_DIR, UPLOAD_DIR, commandFor, detect, downloadedFiles, modelPath, removeFile, removeOllamaModel, storage } = await import("../src/runners.js");

const mac = { platform: "darwin", gpu: "Apple Silicon" };
const win = { platform: "win32", gpu: "NVIDIA GeForce RTX 4070" };
const linux = { platform: "linux", gpu: "none detected" };

test("the data folder follows HUGGINGFOUND_HOME and is created", () => {
  assert.equal(DATA_DIR, process.env.HUGGINGFOUND_HOME);
  assert.ok(fs.existsSync(MODELS_DIR));
  assert.equal(modelPath("a/b", "c.gguf"), path.join(MODELS_DIR, "a", "b", "c.gguf"));
});

test("install commands per platform", () => {
  const macOllama = commandFor("install-ollama", {}, mac).githubRelease;
  assert.equal(macOllama.repo, "ollama/ollama");
  assert.ok(macOllama.match.test("ollama-darwin.tgz"));
  assert.equal(macOllama.dir, "ollama");
  assert.ok(commandFor("install-ollama", {}, win).githubRelease.match.test("ollama-windows-amd64.zip"));
  assert.ok(commandFor("install-ollama", {}, { ...win, arch: "arm64" }).githubRelease.match.test("ollama-windows-arm64.zip"));
  assert.match(commandFor("install-ollama", {}, linux).argv.join(" "), /ollama.com\/install.sh/);
  assert.equal(commandFor("install-whisper", {}, mac).build.repo, "ggerganov/whisper.cpp");
  assert.equal(commandFor("install-whisper", {}, linux).build.dir, "whisper");
  assert.equal(commandFor("install-whisper", {}, win).githubRelease.repo, "ggerganov/whisper.cpp");
  const sdMac = commandFor("install-sd", {}, mac);
  assert.match(sdMac.githubRelease.match.source, /Darwin/);
  assert.ok(sdMac.githubRelease.pick.test("x/sd-cli"));
  assert.ok(sdMac.githubRelease.pick.test("x/sd"));
  assert.deepEqual(sdMac.githubRelease.verify, ["--help"]);
  assert.ok(sdMac.fallbackBuild.cmakeArgs.includes("-DSD_METAL=ON"));
  assert.match(commandFor("install-sd", {}, win).githubRelease.match.source, /cuda12/);
  assert.equal(commandFor("install-sd", {}, win).fallbackBuild, null);
  assert.match(commandFor("install-sd", {}, { platform: "win32", gpu: "none detected" }).githubRelease.match.source, /cpu/);
  assert.match(commandFor("install-sd", {}, linux).githubRelease.match.source, /Linux/);
});

test("pull and download steps build from checked names", () => {
  try {
    const argv = commandFor("pull-model", { name: "hf.co/bartowski/x-GGUF:Q4_K_M" }, mac).argv;
    assert.match(argv[0], /ollama(\.exe)?$/);
    assert.deepEqual(argv.slice(1), ["pull", "hf.co/bartowski/x-GGUF:Q4_K_M"]);
  } catch (err) {
    assert.match(err.message, /not installed/);
  }
  const dl = commandFor("download-file", { repo: "a/b", file: "m.gguf" }, mac, "http://stub");
  assert.equal(dl.download.url, "http://stub/a/b/resolve/main/m.gguf");
  assert.equal(dl.download.dest, modelPath("a/b", "m.gguf"));
});

test("create-model writes a Modelfile next to the download", () => {
  try {
    const spec = commandFor("create-model", { repo: "a/b", file: "m.gguf", name: "b" }, mac);
    const modelfile = spec.argv[spec.argv.indexOf("-f") + 1];
    assert.equal(fs.readFileSync(modelfile, "utf8"), `FROM ${modelPath("a/b", "m.gguf")}\n`);
  } catch (err) {
    assert.match(err.message, /not installed/);
  }
});

test("a program in its own bin folder is found, whichever name the release uses", async () => {
  const dist = path.join(BIN_DIR, "sd");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "sd-cli"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dist, "sd-cli"), 0o755);
  const d = await detect(async () => {
    throw new Error("refused");
  });
  assert.equal(d.sd.installed, true);
  const spec = commandFor("generate-image", { repo: "a/b", file: "m.gguf", prompt: "a cat" }, mac);
  assert.ok(spec.argv[0].endsWith("sd-cli"));
  fs.rmSync(dist, { recursive: true, force: true });
});

test("an unpacked release build in the bin folder counts as installed", async () => {
  const dist = path.join(BIN_DIR, "ollama");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "ollama"), "#!/bin/sh\n");
  const d = await detect(async () => {
    throw new Error("refused");
  });
  assert.equal(d.ollama.installed, true);
  const spec = commandFor("start-ollama", {}, mac);
  assert.ok(spec.argv[0].endsWith("ollama"));
  fs.rmSync(dist, { recursive: true, force: true });
});

test("anything that is not a plain repo or file name is refused", () => {
  assert.throws(() => commandFor("pull-model", { name: "x; rm -rf /" }, mac), /Bad model name/);
  assert.throws(() => commandFor("download-file", { repo: "../etc", file: "passwd" }, mac), /Bad file/);
  assert.throws(() => commandFor("download-file", { repo: "a/b", file: "../x" }, mac), /Bad file/);
  assert.throws(() => commandFor("create-model", { repo: "a/b", file: "m.gguf", name: "a b" }, mac), /Bad model/);
  assert.throws(() => commandFor("transcribe", { repo: "a/b", file: "m.bin", audio: "/etc/passwd" }, mac), /Bad transcription/);
  assert.throws(() => commandFor("generate-image", { repo: "a/b", file: "m.gguf", prompt: "   " }, mac), /Bad image/);
  assert.throws(() => commandFor("make-coffee", {}, mac), /Unknown step/);
});

test("transcribe only reads recordings from the upload folder", () => {
  const audio = path.join(UPLOAD_DIR, "clip.wav");
  fs.writeFileSync(audio, "");
  try {
    const spec = commandFor("transcribe", { repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", audio }, mac);
    assert.ok(spec.argv.includes(audio));
    assert.match(spec.result, /clip\.txt$/);
  } catch (err) {
    assert.match(err.message, /not installed/);
  }
});

test("downloadedFiles lists repo/file paths under the models folder", () => {
  fs.mkdirSync(path.join(MODELS_DIR, "owner", "repo"), { recursive: true });
  fs.writeFileSync(path.join(MODELS_DIR, "owner", "repo", "x.gguf"), "");
  assert.ok(downloadedFiles().includes("owner/repo/x.gguf"));
});

test("detect never throws when nothing is installed or reachable", async () => {
  const d = await detect(async () => {
    throw new Error("refused");
  });
  assert.equal(typeof d.ollama.installed, "boolean");
  assert.equal(d.ollama.running, false);
  assert.deepEqual(d.ollama.models, []);
  assert.ok(Array.isArray(d.models));
});

test("storage lists files with sizes and removeFile cleans up after itself", async () => {
  const target = modelPath("some/repo", "big.gguf");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.alloc(3 * 1024 * 1024));
  fs.writeFileSync(path.join(path.dirname(target), "Modelfile"), `FROM ${target}\n`);
  const st = await storage(async () => {
    throw new Error("no ollama");
  });
  const row = st.files.find((f) => f.repo === "some/repo" && f.file === "big.gguf");
  assert.ok(row);
  assert.ok(Math.abs(row.gb - 3 / 1024) < 1e-6);
  assert.ok(!st.files.some((f) => f.file === "Modelfile"));
  assert.deepEqual(st.ollama, []);

  removeFile("some/repo", "big.gguf");
  assert.ok(!fs.existsSync(target));
  assert.ok(!fs.existsSync(path.join(MODELS_DIR, "some")), "empty owner and repo folders are removed");
  assert.throws(() => removeFile("some/repo", "big.gguf"), /not on this computer/);
  assert.throws(() => removeFile("../..", "passwd"), /Bad file/);
  assert.throws(() => removeFile("a/b", "../../.env"), /Bad file/);
});

test("removing an Ollama model talks to its delete endpoint and reports when it is down", async () => {
  const calls = [];
  await removeOllamaModel("hf.co/x/y-GGUF:Q4_K_M", async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  });
  assert.equal(calls[0].method, "DELETE");
  assert.match(calls[0].url, /\/api\/delete$/);
  assert.equal(calls[0].body.model, "hf.co/x/y-GGUF:Q4_K_M");
  await assert.rejects(removeOllamaModel("x", async () => ({ ok: false, status: 404 })), /does not have/);
  await assert.rejects(removeOllamaModel("x", async () => {
    throw new Error("ECONNREFUSED");
  }), /not running/);
  await assert.rejects(removeOllamaModel("x; rm", async () => ({ ok: true })), /Bad model name/);
});
