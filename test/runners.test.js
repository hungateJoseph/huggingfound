import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-runners-"));
const { BIN_DIR, DATA_DIR, MODELS_DIR, UPLOAD_DIR, commandFor, detect, downloadedFiles, modelPath, removeFile, removeFolder, removeOllamaModel, storage, QUALITIES, imageSettings, isFastImageModel } = await import("../src/runners.js");

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
  const file = modelPath("a/b", "m.gguf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const spec = commandFor("generate-image", { repo: "a/b", file: "m.gguf", prompt: "a cat" }, mac);
  assert.ok(spec.argv[0].endsWith("sd-cli"));
  removeFolder("a/b");
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

test("transcribe only reads recordings from the upload folder, and effort sets the beam search", () => {
  const audio = path.join(UPLOAD_DIR, "clip.wav");
  fs.writeFileSync(audio, "");
  const dist = path.join(BIN_DIR, "whisper");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "whisper-cli"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dist, "whisper-cli"), 0o755);
  const spec = commandFor("transcribe", { repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", audio }, mac);
  assert.ok(spec.argv.includes(audio));
  assert.match(spec.result, /clip\.txt$/);
  assert.ok(!spec.argv.includes("-bs"), "standard effort leaves whisper's defaults");
  const careful = commandFor("transcribe", { repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", audio, effort: "thorough" }, mac);
  assert.equal(careful.argv[careful.argv.indexOf("-bs") + 1], "8");
  assert.equal(careful.argv[careful.argv.indexOf("-bo") + 1], "8");
  assert.match(careful.text, /carefully/);
  assert.equal(commandFor("transcribe", { repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", audio, effort: "quick" }, mac).argv.indexOf("-bs") > 0, true);
  assert.throws(() => commandFor("transcribe", { repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", audio, effort: "max" }, mac), /Bad effort/);
  assert.throws(() => commandFor("transcribe", { repo: "ggerganov/whisper.cpp", file: "ggml-base.en.bin", audio: "/etc/passwd" }, mac), /Bad transcription/);
  fs.rmSync(dist, { recursive: true, force: true });
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

test("several files of one repository download under the names the runner expects", () => {
  const spec = commandFor("download-files", { repo: "a/b", files: [{ from: "unet/diffusion_pytorch_model.fp16.safetensors", to: "unet/diffusion_pytorch_model.safetensors" }, { from: "vae/x.safetensors" }] }, mac, "http://stub");
  assert.equal(spec.downloads.length, 2);
  assert.equal(spec.downloads[0].url, "http://stub/a/b/resolve/main/unet/diffusion_pytorch_model.fp16.safetensors");
  assert.equal(spec.downloads[0].dest, modelPath("a/b", "unet/diffusion_pytorch_model.safetensors"));
  assert.equal(spec.downloads[1].dest, modelPath("a/b", "vae/x.safetensors"));
  assert.throws(() => commandFor("download-files", { repo: "a/b", files: [] }, mac), /Bad file/);
  assert.throws(() => commandFor("download-files", { repo: "a/b", files: [{ from: "../x" }] }, mac), /Bad file/);
  assert.throws(() => commandFor("download-files", { repo: "a/b", files: [{ from: "a/b/c/d" }] }, mac), /Bad file/);
  assert.throws(() => commandFor("download-file", { repo: "a/b", file: "unet/../../x" }, mac), /Bad file/);
});

test("nested files are listed and a whole folder can be removed", () => {
  const unet = modelPath("own/diffusers-repo", "unet/diffusion_pytorch_model.safetensors");
  fs.mkdirSync(path.dirname(unet), { recursive: true });
  fs.writeFileSync(unet, "");
  fs.writeFileSync(`${unet}.part`, "");
  const listed = downloadedFiles();
  assert.ok(listed.includes("own/diffusers-repo/unet/diffusion_pytorch_model.safetensors"));
  assert.ok(!listed.some((f) => f.endsWith(".part")));
  removeFolder("own/diffusers-repo");
  assert.ok(!fs.existsSync(path.join(MODELS_DIR, "own")));
  assert.throws(() => removeFolder("own/diffusers-repo"), /not on this computer/);
  assert.throws(() => removeFolder("../.."), /Bad repository/);
});

test("a merge target has to be a plain safetensors name", () => {
  const files = [{ from: "unet/diffusion_pytorch_model.fp16.safetensors", to: "unet/diffusion_pytorch_model.safetensors" }];
  const spec = commandFor("download-files", { repo: "a/b", files, convert: "diffusers", into: "b.safetensors" }, mac, "http://stub");
  assert.equal(spec.convert.into, modelPath("a/b", "b.safetensors"));
  assert.equal(spec.convert.dir, path.join(MODELS_DIR, "a", "b"));
  assert.throws(() => commandFor("download-files", { repo: "a/b", files, convert: "diffusers", into: "../b.safetensors" }, mac), /Bad file/);
  assert.throws(() => commandFor("download-files", { repo: "a/b", files, convert: "diffusers", into: "b.gguf" }, mac), /Bad file/);
  assert.equal(commandFor("download-files", { repo: "a/b", files }, mac).convert, null);
});

test("image generation needs the model file in place and sizes SDXL at 768", () => {
  const dist = path.join(BIN_DIR, "sd");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "sd-cli"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dist, "sd-cli"), 0o755);
  assert.throws(() => commandFor("generate-image", { repo: "a/b-sdxl", file: "b.safetensors", prompt: "x" }, mac), /not downloaded yet/);
  const file = modelPath("a/b-sdxl", "b.safetensors");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  const spec = commandFor("generate-image", { repo: "a/b-sdxl", file: "b.safetensors", prompt: "a cat" }, mac);
  assert.equal(spec.argv[spec.argv.indexOf("-m") + 1], file);
  assert.equal(spec.argv[spec.argv.indexOf("-W") + 1], "768", "SDXL renders at 768");
  removeFolder("a/b-sdxl");
  fs.rmSync(dist, { recursive: true, force: true });
});

test("editing a picture paints over an earlier result with img2img, by this or another image model", () => {
  const dist = path.join(BIN_DIR, "sd");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "sd-cli"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dist, "sd-cli"), 0o755);
  const model = modelPath("a/painter", "p.safetensors");
  fs.mkdirSync(path.dirname(model), { recursive: true });
  fs.writeFileSync(model, "");
  const made = path.join(DATA_DIR, "output", "image-1700000000000.png");
  fs.mkdirSync(path.dirname(made), { recursive: true });
  fs.writeFileSync(made, "");
  const args = { repo: "a/painter", file: "p.safetensors", init: "image-1700000000000.png", prompt: "a lighthouse at dusk, darker sky", negative: "blurry", strength: 0.4 };
  const spec = commandFor("edit-image", args, mac);
  assert.equal(spec.argv[spec.argv.indexOf("-i") + 1], made);
  assert.equal(spec.argv[spec.argv.indexOf("--strength") + 1], "0.4");
  assert.equal(spec.argv[spec.argv.indexOf("-m") + 1], model);
  assert.equal(spec.argv[spec.argv.indexOf("-n") + 1], "blurry");
  assert.ok(!spec.argv.includes("-W"), "the picture keeps its own size");
  assert.match(spec.result, /image-1700000000000-edit-\d+\.png$/);
  assert.match(spec.text, /keeping 60% of the picture/);
  assert.equal(commandFor("edit-image", { ...args, strength: 5 }, mac).argv[spec.argv.indexOf("--strength") + 1], "0.95", "strength is clamped");
  assert.throws(() => commandFor("edit-image", { ...args, init: "../.env" }, mac), /Bad edit arguments/);
  assert.throws(() => commandFor("edit-image", { ...args, init: "image-1.png" }, mac), /no longer here/);
  assert.throws(() => commandFor("edit-image", { ...args, file: "missing.safetensors" }, mac), /not downloaded yet/);
  removeFolder("a/painter");
  fs.rmSync(made, { force: true });
  fs.rmSync(dist, { recursive: true, force: true });
});

test("quality presets: Default is the plain 20 steps, Fast and Max change sampler and steps", () => {
  const d = imageSettings("default", { fast: false, xl: false });
  assert.equal(d.steps, 20);
  assert.deepEqual(d.cliArgs, ["--steps", "20", "-W", "512", "-H", "512", "--cfg-scale", "7"]);
  assert.equal(d.samplerName, "euler_a");
  const f = imageSettings("fast", { fast: false, xl: true });
  assert.equal(f.steps, 12);
  assert.equal(f.size, 768);
  assert.ok(f.cliArgs.includes("dpm++2m") && f.cliArgs.includes("karras"));
  assert.ok(!f.cliArgs.includes("--diffusion-fa"), "flash attention stays off");
  assert.equal(f.samplerName, "dpm++2m");
  assert.equal(f.schedulerName, "karras");
  const m = imageSettings("max", { fast: false, xl: false });
  assert.equal(m.steps, 40);
  // distilled models are built for four steps whatever the preset says
  const t = imageSettings("default", { fast: true, xl: true });
  assert.equal(t.steps, 4);
  assert.equal(t.cfg, 1);
  assert.equal(t.size, 512);
  assert.ok(t.cliArgs.includes("sgm_uniform"));
  assert.equal(imageSettings("max", { fast: true, xl: false }).steps, 8);
  assert.deepEqual(Object.keys(QUALITIES), ["fast", "default", "max"]);
  assert.equal(isFastImageModel("ByteDance/SDXL-Lightning/sdxl_lightning_4step.safetensors"), true);
  assert.equal(isFastImageModel("second-state/x/y.gguf"), false);
});

test("image generation refuses unknown presets, uses the server build when present and the remote address when set", () => {
  const dist = path.join(BIN_DIR, "sd");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, "sd-cli"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dist, "sd-cli"), 0o755);
  const file = modelPath("a/b", "m.safetensors");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  assert.throws(() => commandFor("generate-image", { repo: "a/b", file: "m.safetensors", prompt: "x", quality: "ultra" }, mac), /Bad image/);
  const cli = commandFor("generate-image", { repo: "a/b", file: "m.safetensors", prompt: "x", quality: "max", negative: "anime, cartoon" }, mac);
  assert.ok(cli.argv, "no server build: one-shot sd-cli");
  assert.equal(cli.argv[cli.argv.indexOf("--steps") + 1], "40");
  assert.equal(cli.argv[cli.argv.indexOf("-n") + 1], "anime, cartoon", "the avoid list is the negative prompt");
  assert.ok(!commandFor("generate-image", { repo: "a/b", file: "m.safetensors", prompt: "x" }, mac).argv.includes("-n"));
  fs.writeFileSync(path.join(dist, "sd-server"), "#!/bin/sh\n");
  fs.chmodSync(path.join(dist, "sd-server"), 0o755);
  const srv = commandFor("generate-image", { repo: "a/b", file: "m.safetensors", prompt: "x" }, mac);
  assert.equal(typeof srv.run, "function", "with the server build the picture goes through the loaded model");
  assert.match(srv.text, /Default, 20 steps/);
  const remote = commandFor("generate-image", { repo: "a/b", file: "not-here.safetensors", prompt: "x", remote: "http://10.0.0.5:1234" }, mac);
  assert.equal(typeof remote.run, "function", "a remote server needs no local file");
  removeFolder("a/b");
  fs.rmSync(dist, { recursive: true, force: true });
});
