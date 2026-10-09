import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chooseFile, createHub, diffusersFolder, quantTag, repoFiles, summarize } from "../src/hf.js";
import { FILES, MODELS, startStubHub } from "./stub-hub.js";

let stub;
before(async () => {
  stub = await startStubHub();
});
after(() => stub.server.close());

test("scan merges the listings and drops duplicates", async () => {
  const hub = createHub({ base: stub.base });
  const models = await hub.scan();
  const ids = models.map((m) => m.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, MODELS.length);
  assert.ok(stub.requests.some((r) => r.path.includes("pipeline_tag=automatic-speech-recognition")));
  assert.ok(stub.requests.some((r) => r.path.includes("filter=gguf")));
  assert.ok(stub.requests.some((r) => r.path.includes("sort=likes")));
  assert.ok(stub.requests.some((r) => r.path.includes("not-for-all-audiences")));
  assert.ok(stub.requests.some((r) => r.path.includes("search=uncensored")));
  const llama = models.find((m) => m.id === "bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.deepEqual(llama.categories, ["easy", "chat"]);
  assert.equal(llama.runner.id, "ollama");
  assert.equal(llama.url, "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF");
});

test("model details carry file names and sizes in GB", async () => {
  const hub = createHub({ base: stub.base });
  const m = await hub.model("bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.equal(m.name, "Llama-3.2-3B-Instruct-GGUF");
  assert.equal(m.files.length, FILES["bartowski/Llama-3.2-3B-Instruct-GGUF"].length);
  const q4 = m.files.find((f) => f.name.endsWith("Q4_K_M.gguf"));
  assert.ok(Math.abs(q4.gb - 2.0) < 0.01);
});

test("a gated model without a token is reported, not thrown", async () => {
  const hub = createHub({ base: stub.base });
  const m = await hub.model("meta-llama/Llama-3.1-8B-Instruct");
  assert.deepEqual(m, { id: "meta-llama/Llama-3.1-8B-Instruct", gatedBlocked: true });
});

test("a token is sent as a bearer header and unlocks the gated model", async () => {
  const hub = createHub({ base: stub.base, token: "hf_test" });
  const m = await hub.model("meta-llama/Llama-3.1-8B-Instruct");
  assert.equal(m.gated, true);
  assert.equal(stub.requests.at(-1).auth, "Bearer hf_test");
});

test("an unreachable hub surfaces as an error from scan", async () => {
  const hub = createHub({ base: "http://127.0.0.1:1" });
  await assert.rejects(hub.scan());
});

test("chooseFile prefers Q4_K_M for Ollama and skips the vision projector", () => {
  const files = FILES["bartowski/Llama-3.2-3B-Instruct-GGUF"].map((f) => ({ name: f.rfilename, gb: f.size / 1024 ** 3 }));
  assert.equal(chooseFile(files, "ollama").name, "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  const gemma = FILES["unsloth/gemma-3-4b-it-GGUF"].map((f) => ({ name: f.rfilename, gb: 1 }));
  assert.equal(chooseFile(gemma, "ollama").name, "gemma-3-4b-it-Q4_K_M.gguf");
  assert.equal(chooseFile([{ name: "README.md" }], "ollama"), null);
});

test("chooseFile keeps image models at 8 bits and accepts a single safetensors", () => {
  const sd = FILES["second-state/stable-diffusion-v1-5-GGUF"].map((f) => ({ name: f.rfilename, gb: f.size / 1024 ** 3 }));
  assert.equal(chooseFile(sd, "sd").name, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf");
  const turbo = [
    { name: "sd_xl_turbo_1.0_fp16.safetensors", gb: 6.9 },
    { name: "sd_xl_turbo_1.0.safetensors", gb: 13.9 },
    { name: "vae/diffusion_pytorch_model.safetensors", gb: 0.3 },
  ];
  assert.equal(chooseFile(turbo, "sd").name, "sd_xl_turbo_1.0_fp16.safetensors");
});

test("chooseFile picks the base English Whisper model", () => {
  const w = FILES["ggerganov/whisper.cpp"].map((f) => ({ name: f.rfilename, gb: f.size / 1024 ** 3 }));
  assert.equal(chooseFile(w, "whisper").name, "ggml-base.en.bin");
  assert.equal(chooseFile([{ name: "ggml-tiny.bin" }], "whisper").name, "ggml-tiny.bin");
});

test("quantTag reads the suffix Ollama needs", () => {
  assert.equal(quantTag("Llama-3.2-3B-Instruct-Q4_K_M.gguf"), "Q4_K_M");
  assert.equal(quantTag("model.IQ4_XS.gguf"), "IQ4_XS");
  assert.equal(quantTag("model-f16.gguf"), "f16");
  assert.equal(quantTag("model.gguf"), null);
});

test("summarize keeps a short, colon-free tag list", () => {
  const s = summarize({ id: "a/b", tags: ["gguf", "license:apache-2.0", "region:us", "conversational"] });
  assert.deepEqual(s.tags, ["gguf", "conversational"]);
  assert.equal(s.author, "a");
  assert.equal(s.gated, false);
});

test("search sends the terms, merges the plain and gguf listings and drops duplicates", async () => {
  const hub = createHub({ base: stub.base });
  const found = await hub.search("  whisper  ");
  assert.deepEqual(found.map((m) => m.id).sort(), ["ggerganov/whisper.cpp", "openai/whisper-large-v3"]);
  assert.ok(stub.requests.some((r) => r.path.includes("search=whisper") && r.path.includes("filter=gguf")));
  assert.deepEqual(await hub.search("   "), []);
});

test("a search with several traits falls back to each word and ranks by words matched", async () => {
  const hub = createHub({ base: stub.base });
  const found = await hub.search("coder whisper gguf");
  const ids = found.map((m) => m.id);
  assert.ok(ids.includes("bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"));
  assert.ok(ids.includes("ggerganov/whisper.cpp"));
  assert.equal(ids[0], "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", "two words matched beats one");
});

test("a diffusers folder is chosen when there is no single file, taking the half-precision parts", () => {
  const files = FILES["John6666/pony-realism-v23-sdxl"].map((f) => ({ name: f.rfilename, gb: f.size / 1024 ** 3 }));
  const pick = chooseFile(files, "sd");
  assert.equal(pick.folder, true);
  assert.equal(pick.xl, true);
  assert.deepEqual(pick.parts.map((p) => [p.from, p.to]), [
    ["unet/diffusion_pytorch_model.fp16.safetensors", "unet/diffusion_pytorch_model.safetensors"],
    ["vae/diffusion_pytorch_model.fp16.safetensors", "vae/diffusion_pytorch_model.safetensors"],
    ["text_encoder/model.fp16.safetensors", "text_encoder/model.safetensors"],
    ["text_encoder_2/model.fp16.safetensors", "text_encoder_2/model.safetensors"],
  ]);
  assert.ok(Math.abs(pick.gb - 6.46) < 0.01);
  assert.equal(diffusersFolder([{ name: "vae/diffusion_pytorch_model.safetensors", gb: 0.1 }]), null, "no unet, no folder");
  const sd15 = diffusersFolder([{ name: "unet/diffusion_pytorch_model.safetensors", gb: 3.4 }, { name: "text_encoder/model.safetensors", gb: 0.5 }]);
  assert.equal(sd15.xl, false);
  assert.equal(sd15.parts.length, 2);
});

test("small add-on files at the top level are never taken for the checkpoint", () => {
  const files = [
    { name: "3d_render.safetensors", gb: 0.08 },
    { name: "Fixhands-unfilteredai.safetensors", gb: 0.002 },
    { name: "model.safetensors", gb: 6.46 },
    { name: "unet/diffusion_pytorch_model.fp16.safetensors", gb: 4.78 },
    { name: "text_encoder/model.safetensors", gb: 0.46 },
  ];
  assert.equal(chooseFile(files, "sd").name, "model.safetensors");
  const addOnsOnly = [{ name: "Fixhands.safetensors", gb: 0.002 }, { name: "unet/diffusion_pytorch_model.safetensors", gb: 4.7 }, { name: "text_encoder/model.safetensors", gb: 0.4 }];
  assert.equal(chooseFile(addOnsOnly, "sd").folder, true, "falls through to the diffusers folder");
  assert.equal(chooseFile([{ name: "tiny.safetensors", gb: 0.1 }], "sd"), null);
  assert.equal(chooseFile([{ name: "sd-lora-Q4_0.gguf", gb: 0.05 }, { name: "model-Q8_0.gguf", gb: 1.7 }], "sd").name, "model-Q8_0.gguf");
});

test("the files a diffusers folder needs: index, configs, one copy of each weight, no pictures or cards", () => {
  const files = [
    { name: ".gitattributes", gb: 0 }, { name: "README.md", gb: 0 }, { name: "model_index.json", gb: 0 }, { name: "images/sample.png", gb: 0.01 },
    { name: "scheduler/scheduler_config.json", gb: 0 }, { name: "tokenizer/tokenizer.json", gb: 0.01 },
    { name: "unet/config.json", gb: 0 }, { name: "unet/diffusion_pytorch_model.safetensors", gb: 10 }, { name: "unet/diffusion_pytorch_model.fp16.safetensors", gb: 5 }, { name: "unet/diffusion_pytorch_model.bin", gb: 10 },
    { name: "vae/diffusion_pytorch_model.bin", gb: 0.3 }, { name: "sd_xl_base_1.0.safetensors", gb: 6.9 },
  ];
  const repo = repoFiles(files);
  assert.deepEqual(repo.files.map((f) => f.from), ["model_index.json", "scheduler/scheduler_config.json", "tokenizer/tokenizer.json", "unet/config.json", "unet/diffusion_pytorch_model.fp16.safetensors", "vae/diffusion_pytorch_model.bin"], "the half-precision variant over the full one, safetensors over .bin, a .bin alone kept, no single-file checkpoint, no samples");
  assert.equal(repo.files.find((f) => /fp16/.test(f.from)).to, "unet/diffusion_pytorch_model.safetensors");
  assert.equal(repo.gb.toFixed(2), "5.31");
  assert.equal(repoFiles([{ name: "flux1-dev-Q8_0.gguf", gb: 12 }]), null, "no index, no folder");
});
