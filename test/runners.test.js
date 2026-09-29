import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-runners-"));
const { DATA_DIR, MODELS_DIR, UPLOAD_DIR, commandFor, detect, downloadedFiles, modelPath } = await import("../src/runners.js");

const mac = { platform: "darwin", gpu: "Apple Silicon" };
const win = { platform: "win32", gpu: "NVIDIA GeForce RTX 4070" };
const linux = { platform: "linux", gpu: "none detected" };

test("the data folder follows HUGGINGFOUND_HOME and is created", () => {
  assert.equal(DATA_DIR, process.env.HUGGINGFOUND_HOME);
  assert.ok(fs.existsSync(MODELS_DIR));
  assert.equal(modelPath("a/b", "c.gguf"), path.join(MODELS_DIR, "a", "b", "c.gguf"));
});

test("install commands per platform", () => {
  assert.deepEqual(commandFor("install-ollama", {}, mac).argv, ["brew", "install", "ollama"]);
  assert.equal(commandFor("install-ollama", {}, win).argv[0], "winget");
  assert.match(commandFor("install-ollama", {}, linux).argv.join(" "), /ollama.com\/install.sh/);
  assert.deepEqual(commandFor("install-whisper", {}, mac).argv, ["brew", "install", "whisper-cpp"]);
  assert.equal(commandFor("install-whisper", {}, win).githubRelease.repo, "ggerganov/whisper.cpp");
  assert.match(commandFor("install-sd", {}, mac).githubRelease.match.source, /Darwin/);
  assert.match(commandFor("install-sd", {}, win).githubRelease.match.source, /cuda12/);
  assert.match(commandFor("install-sd", {}, { platform: "win32", gpu: "none detected" }).githubRelease.match.source, /cpu/);
  assert.match(commandFor("install-sd", {}, linux).githubRelease.match.source, /Linux/);
});

test("pull and download steps build from checked names", () => {
  assert.deepEqual(commandFor("pull-model", { name: "hf.co/bartowski/x-GGUF:Q4_K_M" }, mac).argv, ["ollama", "pull", "hf.co/bartowski/x-GGUF:Q4_K_M"]);
  const dl = commandFor("download-file", { repo: "a/b", file: "m.gguf" }, mac, "http://stub");
  assert.equal(dl.download.url, "http://stub/a/b/resolve/main/m.gguf");
  assert.equal(dl.download.dest, modelPath("a/b", "m.gguf"));
});

test("create-model writes a Modelfile next to the download", () => {
  const spec = commandFor("create-model", { repo: "a/b", file: "m.gguf", name: "b" }, mac);
  assert.equal(spec.argv[0], "ollama");
  const modelfile = spec.argv[spec.argv.indexOf("-f") + 1];
  assert.equal(fs.readFileSync(modelfile, "utf8"), `FROM ${modelPath("a/b", "m.gguf")}\n`);
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
