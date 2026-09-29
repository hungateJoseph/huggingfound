import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chooseFile, createHub, quantTag, summarize } from "../src/hf.js";
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
