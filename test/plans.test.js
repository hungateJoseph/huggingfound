import assert from "node:assert/strict";
import { test } from "node:test";
import { summarize } from "../src/hf.js";
import { buildPlan, diskFor, framesFor, imageStyle } from "../src/plans.js";
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
  assert.deepEqual(plan.remove, [{ kind: "ollama", name: "hf.co/bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M" }]);
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
  assert.deepEqual(open.remove, [{ kind: "ollama", name: "llama-3.2-3b-instruct" }, { kind: "file", repo: model.id, file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" }]);
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
  assert.deepEqual(plan.remove, [{ kind: "file", repo: model.id, file: plan.file.name }]);
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

test("a quantised image model without the diffusers folder is shown but not set up, with the way to the folder version", () => {
  const model = { ...summarize({ id: "unsloth/Qwen-Image-2.1-GGUF", pipeline_tag: "text-to-image", tags: ["gguf"] }), files: [{ name: "qwen-image-Q4_0.gguf", gb: 12 }] };
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, false);
  assert.match(plan.reason, /loose pieces/);
  assert.match(plan.link, /search=Qwen-Image-2\.1%20diffusers/);
});

test("a repository without a loadable file says so", () => {
  const model = { ...summarize({ id: "stabilityai/stable-diffusion-xl-base-1.0", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers"] }), files: [{ name: "unet/diffusion_pytorch_model.safetensors", gb: 5 }] };
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, false);
  assert.match(plan.reason, /no single checkpoint/);
});

test("a diffusers family runs on a rented GPU only: the plan asks for one, then is one folder download with presets", () => {
  const files = [{ name: "README.md", gb: 0 }, { name: "model_index.json", gb: 0 }, { name: "assets/demo.png", gb: 0.01 }, { name: "transformer/config.json", gb: 0 }, { name: "transformer/diffusion_pytorch_model.safetensors", gb: 20 }, { name: "transformer/diffusion_pytorch_model.fp16.safetensors", gb: 10 }, { name: "text_encoder/model.safetensors", gb: 9 }, { name: "text_encoder/pytorch_model.bin", gb: 9 }, { name: "vae/diffusion_pytorch_model.safetensors", gb: 0.3 }, { name: "flux1-dev.safetensors", gb: 23 }];
  const model = { ...summarize({ id: "someone/Open-Flux", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "flux"] }), files };
  assert.equal(model.runner.id, "diffusers");
  const withoutGpu = buildPlan({ model, files, machine, detected: nothing(), hasToken: false });
  assert.equal(withoutGpu.runnable, false);
  assert.equal(withoutGpu.needsGpu, true);
  assert.match(withoutGpu.reason, /runs only on a rented GPU/);
  const gpu = { ...nothing(), gpu: { url: "http://agent", running: true, files: [] } };
  const plan = buildPlan({ model, files, machine: { ...machine, comfortableGb: 40 }, detected: gpu, hasToken: false });
  assert.equal(plan.runnable, true);
  assert.equal(plan.runner, "diffusers");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, "pull-image-repo");
  assert.deepEqual(plan.steps[0].args.files, ["model_index.json", "transformer/config.json", "transformer/diffusion_pytorch_model.fp16.safetensors", "text_encoder/model.safetensors", "vae/diffusion_pytorch_model.safetensors"], "the index, configs and one copy of each weight: the half-precision variant over the full one, safetensors over .bin, no single-file duplicate, no demo pictures");
  assert.equal(plan.file.files.find((f) => /fp16/.test(f.from)).to, "transformer/diffusion_pytorch_model.safetensors", "a variant is saved under the plain name");
  assert.match(plan.steps[0].title, /5 files on the rented GPU \(19\.3 GB\)/);
  assert.deepEqual(plan.tryWith, { kind: "image", repo: "someone/Open-Flux", file: "model_index.json", agent: "http://agent", engine: "diffusers" });
  assert.deepEqual([plan.qualities.default.steps, plan.qualities.default.width, plan.qualities.default.cfg], [28, 1024, 3.5], "FLUX presets");
  assert.equal(plan.qualities.max.expand, true, "a picture's Max preset has the words expanded first");
  assert.equal(plan.qualities.default.expand, undefined);
  assert.deepEqual(plan.remove, [{ kind: "gpu-file", repo: "someone/Open-Flux", file: "model_index.json" }]);
  const done = buildPlan({ model, files, machine, detected: { ...gpu, gpu: { ...gpu.gpu, files: ["someone/Open-Flux/model_index.json"] } }, hasToken: false });
  assert.equal(done.steps[0].done, true);
  // A video family gets clip presets and a video try box.
  const wan = { ...summarize({ id: "Wan-AI/Wan2.2-TI2V-5B-Diffusers", pipeline_tag: "text-to-video", library_name: "diffusers", tags: ["diffusers"] }), files: [{ name: "model_index.json", gb: 0 }, { name: "transformer/diffusion_pytorch_model.safetensors", gb: 10 }] };
  const clip = buildPlan({ model: wan, files: wan.files, machine, detected: gpu, hasToken: false });
  assert.equal(clip.tryWith.kind, "video");
  assert.deepEqual([clip.qualities.default.frames, clip.qualities.default.width, clip.qualities.default.height], [49, 832, 480]);
  // MiniMax-H3 makes 5 to 15 seconds with sound at 24 fps, 17n + 5 frames on multiples of 32.
  const mm = { ...summarize({ id: "MiniMaxAI/MiniMax-H3", pipeline_tag: "image-text-to-video", library_name: "minimax-h3", tags: ["diffusers", "text-to-video"] }), files: [{ name: "model_index.json", gb: 0 }, { name: "modular_model_index.json", gb: 0 }, { name: "transformer/diffusion_pytorch_model.safetensors", gb: 62 }, { name: "text_encoder/model.safetensors", gb: 62 }, { name: "transformer_ref/diffusion_pytorch_model.safetensors", gb: 62 }] };
  const h3 = buildPlan({ model: mm, files: mm.files, machine: { ...machine, gpuGb: 141 }, detected: gpu, hasToken: false });
  assert.equal(h3.file.gb, 124, "the reference partition is not fetched");
  assert.equal(h3.file.modular, true);
  assert.equal(h3.tierGb.toFixed(1), "86.8", "a modular pipeline wants a card with room for most of it, not a second card");
  assert.equal(h3.fit.level, "tight");
  assert.match(h3.fit.text, /take turns on the card/);
  assert.equal(h3.tryWith.kind, "video");
  assert.equal(h3.tryWith.startPicture, "optional");
  assert.deepEqual([h3.qualities.fast.frames, h3.qualities.fast.width, h3.qualities.fast.height, h3.qualities.fast.fps], [124, 960, 544, 24]);
  assert.deepEqual([h3.qualities.max.frames, h3.qualities.max.width, h3.qualities.max.height], [243, 1344, 768]);
  assert.match(h3.qualities.default.text, /5-second clip with sound at 768p/);
  for (const q of Object.values(h3.qualities)) assert.equal((q.frames - 5) % 17, 0, "a frame count the video VAE decodes");
  // A clip is asked for by length and quality: the page gets what the model makes and picks the frames.
  assert.deepEqual([h3.video.fps, h3.video.minSeconds, h3.video.maxSeconds, h3.video.defaultSeconds, h3.video.frameStep, h3.video.frameAdd, h3.video.sound, h3.video.heavy], [24, 5, 15, 5, 17, 5, true, 1.6]);
  assert.deepEqual(Object.keys(h3.video.levels), ["low", "medium", "high"]);
  assert.deepEqual([h3.video.levels.low.width, h3.video.levels.low.steps, h3.video.levels.medium.width, h3.video.levels.medium.steps, h3.video.levels.high.width, h3.video.levels.high.steps, h3.video.levels.high.expand], [960, 20, 1344, 30, 1344, 50, true], "a draft, the full canvas, and the full canvas with more passes and the words expanded");
  assert.equal(h3.video.levels.medium.expand, undefined);
  assert.match(h3.video.avoid, /blurry, low quality/, "the family's standard avoid list");
  assert.match(h3.video.levels.high.text, /expanded first/);
  assert.deepEqual([framesFor(5, h3.video), framesFor(10, h3.video), framesFor(15, h3.video), framesFor(0, h3.video)], [124, 243, 345, 124], "the nearest counts the VAE decodes, within the machine's limit, the default for nonsense");
  assert.deepEqual([clip.video.fps, clip.video.sound, framesFor(3, clip.video), framesFor(99, clip.video), framesFor(1, clip.video)], [16, false, 49, 81, 17]);
  assert.deepEqual([clip.video.levels.low.width, clip.video.levels.medium.width, clip.video.levels.medium.steps, clip.video.levels.high.width, clip.video.levels.high.steps, clip.video.levels.high.expand], [832, 1280, 30, 1280, 50, true], "medium already draws on the full canvas; high adds passes and the expansion");
  // Loose pieces without the folder cannot be assembled by the machine.
  const gguf = { ...summarize({ id: "city96/FLUX.1-dev-gguf", pipeline_tag: "text-to-image", tags: ["gguf"] }), files: [{ name: "flux1-dev-Q8_0.gguf", gb: 12 }] };
  const pieces = buildPlan({ model: gguf, files: gguf.files, machine, detected: gpu, hasToken: false });
  assert.equal(pieces.runnable, false);
  assert.match(pieces.reason, /loose pieces/);
  // With a known twin in the diffusers layout, the plan points at it instead.
  const ltx = { ...summarize({ id: "Lightricks/LTX-2.5", pipeline_tag: "image-to-video", library_name: "diffusion-single-file", tags: ["diffusion-single-file", "image-to-video"], gated: "auto" }), files: [{ name: "diffusion_models/ltx-2.5-22b-dev-transformer-bf16.safetensors", gb: 39 }] };
  const twinned = buildPlan({ model: ltx, files: ltx.files, machine, detected: gpu, hasToken: true, twin: { id: "Lightricks/LTX-2.5-Diffusers", name: "LTX-2.5-Diffusers" } });
  assert.equal(twinned.runnable, false);
  assert.deepEqual(twinned.twin, { id: "Lightricks/LTX-2.5-Diffusers", name: "LTX-2.5-Diffusers" });
  assert.match(twinned.reason, /The same model in the layout the rented GPU runs is LTX-2.5-Diffusers/);
  // A gated folder model runs with a token, fetched by the machine with it; an image-to-video model wants a starting picture.
  const ltxD = { ...summarize({ id: "Lightricks/LTX-2.5-Diffusers", pipeline_tag: "image-to-video", library_name: "diffusers", tags: ["diffusers", "image-to-video", "text-to-video"], gated: "auto" }), files: [{ name: "model_index.json", gb: 0 }, { name: "modular_model_index.json", gb: 0 }, { name: "transformer/diffusion_pytorch_model.safetensors", gb: 39 }, { name: "text_encoder/model.safetensors", gb: 24 }, { name: "connectors/model.safetensors", gb: 6 }, { name: "vae/diffusion_pytorch_model.safetensors", gb: 1.5 }, { name: "transformer_full/diffusion_pytorch_model.safetensors", gb: 110 }, { name: "prompt_enhancer/model.safetensors", gb: 10 }, { name: "latent_upsampler/model.safetensors", gb: 1 }, { name: "diffusion_decoder/model.safetensors", gb: 0.8 }, { name: "ltx-2.5-22b-distilled-lora-450-bf16.safetensors", gb: 9.7 }] };
  assert.equal(buildPlan({ model: ltxD, files: ltxD.files, machine, detected: gpu, hasToken: false }).gated, true);
  const gatedOk = buildPlan({ model: ltxD, files: ltxD.files, machine, detected: gpu, hasToken: true });
  assert.equal(gatedOk.runnable, true);
  assert.match(gatedOk.steps[0].text, /with your Hugging Face token since the model is gated/);
  assert.equal(gatedOk.tryWith.kind, "video");
  assert.equal(gatedOk.tryWith.startPicture, "optional", "it also takes words alone, so the picture is optional");
  assert.equal(buildPlan({ model: { ...ltxD, tags: ["diffusers", "image-to-video"] }, files: ltxD.files, machine, detected: gpu, hasToken: true }).tryWith.startPicture, "required");
  assert.equal(gatedOk.qualities.max.height, 704, "clip sizes are multiples of 32");
  // LTX-2.5: the pipeline's own components only (the full transformer, the
  // prompt enhancer, the upsamplers and the LoRA stay on the Hub), placed
  // whole on a card; clips with sound at 24 fps in 8n + 1 frames, eight
  // passes whatever the level, so the levels differ by canvas.
  assert.equal(gatedOk.file.gb, 70.5, "the distilled transformer, the text encoder, the connectors and the VAE");
  assert.equal(gatedOk.file.modular, true, "the repository carries a modular index");
  assert.equal(gatedOk.tierGb.toFixed(1), "81.1", "but the plain pipeline loads, whole on one card, never in turns");
  assert.match(buildPlan({ model: ltxD, files: ltxD.files, machine: { ...machine, gpuGb: 141 }, detected: gpu, hasToken: true }).fit.text, /^Fits the server's 141 GB \(70\.5 GB\)/);
  assert.match(buildPlan({ model: ltxD, files: ltxD.files, machine: { ...machine, gpuGb: 80 }, detected: gpu, hasToken: true }).fit.text, /Loads at 8 bits on the server's 80 GB/);
  assert.deepEqual([gatedOk.video.fps, gatedOk.video.minSeconds, gatedOk.video.maxSeconds, gatedOk.video.defaultSeconds, gatedOk.video.frameStep, gatedOk.video.frameAdd, gatedOk.video.sound, gatedOk.video.cfg], [24, 2, 10, 5, 8, 1, true, 3]);
  assert.deepEqual([gatedOk.video.levels.low.width, gatedOk.video.levels.low.height, gatedOk.video.levels.low.steps, gatedOk.video.levels.medium.width, gatedOk.video.levels.medium.steps, gatedOk.video.levels.high.steps, gatedOk.video.levels.high.expand], [768, 512, 8, 1280, 8, 8, true]);
  assert.match(gatedOk.video.levels.low.text, /eight-pass schedule/);
  assert.deepEqual([gatedOk.qualities.fast.frames, gatedOk.qualities.default.frames, gatedOk.qualities.max.frames, gatedOk.qualities.default.fps], [121, 121, 241, 24]);
  for (const q of Object.values(gatedOk.qualities)) assert.equal((q.frames - 1) % 8, 0, "a frame count the video VAE decodes");
  assert.deepEqual([framesFor(5, gatedOk.video), framesFor(2, gatedOk.video), framesFor(10, gatedOk.video)], [121, 49, 241]);
  assert.match(gatedOk.qualities.default.text, /5-second clip with sound at 720p/);
  // The fit follows the worker's ladder: whole, 8-bit, 4-bit, or not at all; the recommended size has room at 8 bits.
  const big = { ...summarize({ id: "MiniMaxAI/MiniMax-H3", pipeline_tag: "image-text-to-video", library_name: "minimax-h3", tags: ["video"] }), files: [{ name: "model_index.json", gb: 0 }, { name: "transformer/model.safetensors", gb: 62 }, { name: "text_encoder/model.safetensors", gb: 62 }, { name: "vae/model.safetensors", gb: 10 }, { name: "FL2VA/transformer/model.safetensors", gb: 134 }] };
  const on = (gpuGb) => buildPlan({ model: big, files: big.files, machine: { ...machine, remote: true, gpuGb, comfortableGb: gpuGb * 0.9 }, detected: gpu, hasToken: false });
  assert.equal(on(48).file.gb, 134, "the copies under their own folders do not count");
  assert.match(on(24).fit.text, /Too big for the server's 24 GB even at 4 bits/);
  assert.match(on(48).fit.text, /Loads at 4 bits on the server's 48 GB/);
  assert.match(on(80).fit.text, /Loads at 4 bits on the server's 80 GB/, "8 bits of 134 GB is just over 80");
  assert.match(on(141).fit.text, /Loads at 8 bits on the server's 141 GB/);
  assert.match(on(282).fit.text, /^Fits the server's 282 GB/);
  assert.equal(Math.round(on(48).tierGb), 80, "recommended: room for it at 8 bits");
});

test("an add-on such as an IP-Adapter asks for a rented GPU, then is applied there to a base model already on the machine", () => {
  const files = [{ name: "README.md", gb: 0 }, { name: "ip-adapter-faceid.jpg", gb: 0 }, { name: "ip-adapter-faceid_sd15.bin", gb: 0.09 }, { name: "ip-adapter-faceid_sd15_lora.safetensors", gb: 0.05 }, { name: "ip-adapter-faceid-plusv2_sd15.bin", gb: 0.15 }, { name: "ip-adapter-faceid-plusv2_sd15_lora.safetensors", gb: 0.05 }, { name: "ip-adapter-faceid_sdxl.bin", gb: 1 }, { name: "ip-adapter-faceid_sdxl_lora.safetensors", gb: 0.35 }];
  const model = { ...summarize({ id: "h94/IP-Adapter-FaceID", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "stable-diffusion"] }), files };
  const without = buildPlan({ model, files, machine, detected: nothing(), hasToken: false });
  assert.equal(without.runnable, false);
  assert.equal(without.addon, true);
  assert.equal(without.needsGpu, true);
  assert.match(without.reason, /is an IP-Adapter[\s\S]*applied on a rented GPU/);
  const gpu = { ...nothing(), gpu: { url: "http://agent", running: true, files: ["second-state/stable-diffusion-v1-5-GGUF/sd-v1-5.safetensors", "x/some-xl/model_index.json", "y/quant/model-Q8_0.gguf"], addons: [] } };
  const plan = buildPlan({ model, files, machine, detected: gpu, hasToken: false });
  assert.equal(plan.runnable, true);
  assert.equal(plan.runner, "addon");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, "pull-addon");
  assert.deepEqual(plan.steps[0].args.files, ["ip-adapter-faceid_sd15.bin", "ip-adapter-faceid-plusv2_sd15.bin", "ip-adapter-faceid_sdxl.bin", "ip-adapter-faceid_sd15_lora.safetensors", "ip-adapter-faceid-plusv2_sd15_lora.safetensors", "ip-adapter-faceid_sdxl_lora.safetensors"], "the adapters and their LoRAs, no pictures or card");
  assert.equal(plan.tryWith.engine, "addon");
  assert.equal(plan.tryWith.addonKind, "ip-adapter");
  assert.deepEqual(plan.tryWith.variants.map((v) => [v.file, v.lora, v.xl, v.faceid]), [["ip-adapter-faceid_sd15.bin", "ip-adapter-faceid_sd15_lora.safetensors", false, true], ["ip-adapter-faceid-plusv2_sd15.bin", "ip-adapter-faceid-plusv2_sd15_lora.safetensors", false, true], ["ip-adapter-faceid_sdxl.bin", "ip-adapter-faceid_sdxl_lora.safetensors", true, true]]);
  assert.deepEqual(plan.tryWith.bases.map((b) => [b.repo, b.file, b.xl]), [["second-state/stable-diffusion-v1-5-GGUF", "sd-v1-5.safetensors", false], ["x/some-xl", "model_index.json", true]], "checkpoints and folders on the machine, never a GGUF");
  assert.equal(plan.steps[0].done, false);
  const done = buildPlan({ model, files, machine, detected: { ...gpu, gpu: { ...gpu.gpu, addons: plan.steps[0].args.files.map((f) => `h94/IP-Adapter-FaceID/${f}`) } }, hasToken: false });
  assert.equal(done.steps[0].done, true);
  assert.equal(plan.remove.length, 6);
  // A plain IP-Adapter brings its image encoder along.
  const plain = { ...summarize({ id: "h94/IP-Adapter", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers"] }), files: [{ name: "models/ip-adapter_sd15.bin", gb: 0.04 }, { name: "models/ip-adapter_sd15.safetensors", gb: 0.04 }, { name: "models/image_encoder/config.json", gb: 0 }, { name: "models/image_encoder/model.safetensors", gb: 2.35 }, { name: "models/image_encoder/pytorch_model.bin", gb: 2.35 }] };
  const plainPlan = buildPlan({ model: plain, files: plain.files, machine, detected: gpu, hasToken: false });
  assert.deepEqual(plainPlan.steps[0].args.files, ["models/ip-adapter_sd15.safetensors", "models/image_encoder/config.json", "models/image_encoder/model.safetensors"], "one copy of the adapter, the encoder's config and safetensors");
  assert.equal(plainPlan.tryWith.variants[0].faceid, false);
});

test("a diffusers folder plans one download of all its parts and loads as a folder", () => {
  const model = withFiles("John6666/pony-realism-v23-sdxl");
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.runnable, true);
  assert.deepEqual(plan.steps.map((s) => s.kind), ["install-sd", "download-files"]);
  assert.equal(plan.steps[1].args.files.length, 4);
  assert.equal(plan.steps[1].args.files[0].to, "unet/diffusion_pytorch_model.safetensors");
  assert.equal(plan.steps[1].args.convert, "diffusers");
  assert.equal(plan.steps[1].args.into, "pony-realism-v23-sdxl.safetensors");
  assert.match(plan.steps[1].title, /4 files and merge them \(6\.5 GB\)/);
  assert.match(plan.speed.text, /768 by 768/);
  assert.deepEqual(plan.tryWith, { kind: "image", repo: model.id, file: "pony-realism-v23-sdxl.safetensors" });
  assert.deepEqual(plan.remove, [{ kind: "folder", repo: model.id }]);
  const have = { ...nothing(), sd: { installed: true }, models: [`${model.id}/pony-realism-v23-sdxl.safetensors`] };
  assert.deepEqual(buildPlan({ model, files: model.files, machine, detected: have, hasToken: false }).steps.map((s) => s.done), [true, true]);
  const partsOnly = { ...have, models: plan.steps[1].args.files.map((f) => `${model.id}/${f.to}`) };
  assert.equal(buildPlan({ model, files: model.files, machine, detected: partsOnly, hasToken: false }).steps[1].done, false, "parts alone are not enough; the merge has to have happened");
});

test("image plans carry the three presets with times, and a remote server empties the steps", () => {
  const model = withFiles("second-state/stable-diffusion-v1-5-GGUF");
  const plan = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false });
  assert.deepEqual(Object.keys(plan.qualities), ["fast", "default", "max"]);
  assert.deepEqual([plan.qualities.fast.steps, plan.qualities.default.steps, plan.qualities.max.steps], [12, 20, 40]);
  assert.ok(plan.qualities.fast.seconds < plan.qualities.default.seconds && plan.qualities.default.seconds < plan.qualities.max.seconds);
  assert.equal(plan.fast, false);
  assert.equal(plan.keepsLoaded, undefined, "no server build in this detection");
  const remote = buildPlan({ model, files: model.files, machine, detected: nothing(), hasToken: false, imageServer: { url: "http://box:1234", model: "sdxl-lightning" } });
  assert.equal(remote.runnable, true);
  assert.deepEqual(remote.steps, []);
  assert.equal(remote.tryWith.remote, "http://box:1234");
  assert.match(remote.speed.text, /sdxl-lightning loaded/);
  assert.deepEqual(remote.remove, []);
});

test("image models are labelled anime or realistic from their names", () => {
  assert.equal(imageStyle({ id: "John6666/wai-nsfw-illustrious-sdxl-v150-sdxl", tags: [] }).kind, "anime");
  assert.equal(imageStyle({ id: "John6666/pony-realism-v23-sdxl", tags: [] }).kind, "realistic", "a realism merge of an anime base is for photographs");
  assert.equal(imageStyle({ id: "someone/pony-diffusion-v6-xl", tags: [] }).kind, "anime");
  assert.equal(imageStyle({ id: "stablediffusionapi/cyberrealistic-v41", tags: [] }).kind, "realistic");
  assert.equal(imageStyle({ id: "second-state/stable-diffusion-v1-5-GGUF", tags: [] }), null);
  const plan = buildPlan({ model: withFiles("John6666/pony-realism-v23-sdxl"), files: withFiles("John6666/pony-realism-v23-sdxl").files, machine, detected: nothing(), hasToken: false });
  assert.equal(plan.style.kind, "realistic");
});

test("a model bigger than the rented machine's disk is stopped before the download, with the disk to grow to", () => {
  const files = [{ name: "model_index.json", gb: 0 }, { name: "transformer/config.json", gb: 0 }, { name: "transformer/diffusion_pytorch_model.safetensors", gb: 62 }, { name: "text_encoder/model.safetensors", gb: 62 }, { name: "vae/diffusion_pytorch_model.safetensors", gb: 10 }];
  const model = { ...summarize({ id: "someone/Huge-Video", pipeline_tag: "text-to-video", library_name: "diffusers", tags: ["diffusers"] }), files };
  const gpu = (extra) => ({ ...nothing(), gpu: { url: "http://agent", running: true, files: [], ...extra } });
  // A newer agent says what is free; the whole model is weighed against it.
  const tight = buildPlan({ model, files, machine, detected: gpu({ diskFreeGb: 48.9, diskTotalGb: 50, rented: { rented: true, diskGb: 50 } }), hasToken: false });
  assert.equal(tight.runnable, false);
  assert.equal(tight.needsDisk, true);
  assert.equal(tight.growTo, 160, "the model with a margin, over what the disk holds, in tens");
  assert.match(tight.reason, /needs 134\.0 GB more on the rented machine's disk, and its 50 GB disk has no room for that \(48\.9 GB free of 50\)\. Grow the disk to 160 GB/);
  // An older agent leaves only the disk's size, from the rental.
  const old = buildPlan({ model, files, machine, detected: gpu({ rented: { rented: true, diskGb: 100 } }), hasToken: false });
  assert.equal(old.needsDisk, true);
  assert.equal(old.growTo, 160);
  // Room enough: the download goes ahead, the size along for the machine's own check.
  const roomy = buildPlan({ model, files, machine, detected: gpu({ diskFreeGb: 190, diskTotalGb: 200, rented: { rented: true, diskGb: 200 } }), hasToken: false });
  assert.equal(roomy.runnable, true);
  assert.equal(roomy.steps[0].args.gb, 134);
  // A download that stopped partway: the index is there and the weights are not, so the step is not done, and only what is missing is weighed.
  const half = { files: ["someone/Huge-Video/model_index.json"], folders: { "someone/Huge-Video": ["model_index.json", "transformer/config.json", "transformer/diffusion_pytorch_model.safetensors"] } };
  const partial = buildPlan({ model, files, machine, detected: gpu({ ...half, diskFreeGb: 80, diskTotalGb: 150, rented: { rented: true, diskGb: 150 } }), hasToken: false });
  assert.equal(partial.runnable, true);
  assert.equal(partial.steps[0].done, false, "a folder with files missing is not a whole model");
  const partialTight = buildPlan({ model, files, machine, detected: gpu({ ...half, diskFreeGb: 60, diskTotalGb: 150, rented: { rented: true, diskGb: 150 } }), hasToken: false });
  assert.equal(partialTight.needsDisk, true);
  assert.match(partialTight.reason, /needs 72\.0 GB more/);
  // An agent that does not list a folder's files: the index alone still counts as the model, as before.
  const older = buildPlan({ model, files, machine, detected: gpu({ files: ["someone/Huge-Video/model_index.json"], diskFreeGb: 1, diskTotalGb: 150 }), hasToken: false });
  assert.equal(older.steps[0].done, true);
  // Without a GPU the plan says what disk to rent with.
  const none = buildPlan({ model, files, machine, detected: nothing(), hasToken: false });
  assert.equal(none.diskGb, 160);
  assert.equal(diskFor(134.2), 160);
  assert.equal(diskFor(3), 50);
});
