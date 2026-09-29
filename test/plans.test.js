import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../src/hf.js";
import { buildPlan } from "../src/plans.js";
import { FILES, MODELS } from "./stub-hub.js";

const machine = { platform: "darwin", arch: "arm64", os: "macOS", gpu: "Apple Silicon", comfortableGb: 11 };
const nothing = () => ({ brew: true, ffmpeg: false, ollama: { installed: false, running: false, models: [] }, whisper: { installed: false }, sd: { installed: false }, models: [] });
const withFiles = (id) => ({ ...summarize(MODELS.find((m) => m.id === id)), files: FILES[id].map((f) => ({ name: f.rfilename, gb: f.size / 1024 ** 3 })) });

test("an open gguf chat model pulls straight through Ollama", () => {
  const model = withFiles("bartowski/Llama-3.2-3B-Instruct-GGUF");
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, true);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["install-ollama", "start-ollama", "pull-model"]);
  assert.match(plan.steps[0].command, /ollama-darwin\.tgz/);
  assert.match(plan.steps[0].text, /release build for macOS/);
  assert.equal(plan.steps[2].args.name, "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M");
  assert.equal(plan.fit.level, "good");
  assert.deepEqual(plan.tryWith, { kind: "chat", model: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M" });
  assert.ok(plan.steps.every((s) => !s.done));
});

test("steps already taken are marked done", () => {
  const model = withFiles("bartowski/Llama-3.2-3B-Instruct-GGUF");
  const detected = { ...nothing(), ollama: { installed: true, running: true, models: ["hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M"] } };
  const plan = buildPlan({ model, files: model.files, machine, detected, hasToken: false });
  assert.deepEqual(plan.steps.map((s) => s.done), [true, true, true]);
});

test("install commands follow the platform", () => {
  const model = withFiles("bartowski/Llama-3.2-3B-Instruct-GGUF");
  const win = buildPlan({ model, files: model.files, machine: { ...machine, platform: "win32" }, detected: nothing(), hasToken: false });
  assert.match(win.steps[0].command, /ollama-windows-amd64\.zip/);
  const linux = buildPlan({ model, files: model.files, machine: { ...machine, platform: "linux" }, detected: nothing(), hasToken: false });
  assert.match(linux.steps[0].command, /ollama.com\/install.sh/);
});

test("a gated gguf model needs a token, then downloads with it and registers by hand", () => {
  const model = { ...withFiles("bartowski/Llama-3.2-3B-Instruct-GGUF"), gated: true };
  const locked = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(locked.runnable, false);
  assert.equal(locked.gated, true);
  assert.equal(locked.link, model.url);

  const open = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: true });
  assert.equal(open.runnable, true);
  assert.deepEqual(open.steps.map((s) => s.kind), ["install-ollama", "start-ollama", "download-file", "create-model"]);
  assert.equal(open.steps[3].args.name, "llama-3.2-3b-instruct");
  assert.match(open.steps[2].text, /token/);
  assert.equal(open.tryWith.model, "llama-3.2-3b-instruct");
});

test("a Python-only checkpoint explains itself and points at a GGUF search", () => {
  const model = { ...summarize(MODELS.find((m) => m.id === "meta-llama/Llama-3.1-8B-Instruct")), files: [] };
  const plan = buildPlan({ model, files: [], machine, detected: nothing(), hasToken: true });
  assert.equal(plan.runnable, false);
  assert.match(plan.reason, /Python/);
  assert.match(plan.link, /gguf/);
});

test("whisper plans install whisper.cpp and download the base model", () => {
  const model = withFiles("ggerganov/whisper.cpp");
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["install-whisper", "download-file"]);
  assert.equal(plan.steps[1].args.file, "ggml-base.en.bin");
  assert.equal(plan.tryWith.kind, "transcribe");
  const detected = { ...nothing(), whisper: { installed: true }, models: ["ggerganov/whisper.cpp/ggml-base.en.bin"] };
  assert.deepEqual(buildPlan({ model, files: model.files, machine, detected, hasToken: false }).steps.map((s) => s.done), [true, true]);
});

test("image plans use stable-diffusion.cpp with the 8-bit file", () => {
  const model = withFiles("second-state/stable-diffusion-v1-5-GGUF");
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.deepEqual(plan.steps.map((s) => s.kind), ["install-sd", "download-file"]);
  assert.equal(plan.file.name, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf");
  assert.equal(plan.tryWith.kind, "image");
});

test("a preferred file wins over the default choice", () => {
  const model = withFiles("bartowski/Llama-3.2-3B-Instruct-GGUF");
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false, preferredFile: "Llama-3.2-3B-Instruct-Q8_0.gguf" });
  assert.equal(plan.file.name, "Llama-3.2-3B-Instruct-Q8_0.gguf");
  assert.equal(plan.steps[2].args.name, "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q8_0");
});

test("a file too big for the machine is still planned but flagged", () => {
  const model = withFiles("bartowski/Llama-3.2-3B-Instruct-GGUF");
  const plan = buildPlan({ model, files: model.files, machine: { ...machine, comfortableGb: 1 }, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, true);
  assert.equal(plan.fit.level, "no");
});

test("a multi-file image model is shown but not set up", () => {
  const model = { ...summarize({ id: "unsloth/Qwen-Image-2.1-GGUF", pipeline_tag: "text-to-image", tags: ["gguf"] }), files: [{ name: "qwen-image-Q4_0.gguf", gb: 12 }] };
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, false);
  assert.match(plan.reason, /several files/);
  assert.equal(plan.link, model.url);
});

test("a repository without a loadable file says so", () => {
  const model = { ...summarize({ id: "stabilityai/stable-diffusion-xl-base-1.0", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers"] }), files: [{ name: "unet/diffusion_pytorch_model.safetensors", gb: 5 }] };
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, false);
  assert.match(plan.reason, /no single checkpoint/);
});
