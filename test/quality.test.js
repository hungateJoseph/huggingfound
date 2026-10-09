import assert from "node:assert/strict";
import { test } from "node:test";
import { qualityScore } from "../src/quality.js";
import { rankModels } from "../src/find.js";

// A model's likely capability from its size and family, and its place in
// a search: after relevance, ahead of likes.

const chat = (id, extra = {}) => ({ id, name: id.split("/").pop(), author: id.split("/")[0], pipeline: "text-generation", categories: ["chat"], runner: { id: "ollama", easy: true }, likes: 10, downloads: 100, ...extra });

test("bigger chat models score higher, on a gentle curve, and an unnamed size is guessed from the file", () => {
  const q = (id, extra) => qualityScore(chat(id, extra));
  assert.ok(q("a/Tiny-1B-GGUF") < q("a/Llama-3.2-3B-Instruct-GGUF"));
  assert.ok(q("a/Llama-3.2-3B-Instruct-GGUF") < q("a/Qwen2.5-7B-Instruct-GGUF"));
  assert.ok(q("a/Qwen2.5-7B-Instruct-GGUF") < q("a/Qwen2.5-32B-Instruct-GGUF"));
  assert.ok(q("a/Qwen2.5-32B-Instruct-GGUF") < q("a/Llama-3.3-70B-Instruct-GGUF"));
  assert.equal(q("a/DeepSeek-V3-671B-GGUF"), 3, "capped at the top");
  assert.ok(q("a/Mystery-GGUF", { gb: 40 }) > q("a/Mystery-GGUF", { gb: 4 }), "a 40 GB file is a bigger model than a 4 GB one");
  assert.equal(q("a/Mystery-GGUF"), 1, "nothing known: the middle");
});

test("image and video models rank by family, speech models by size", () => {
  const img = (id) => qualityScore({ id, pipeline: "text-to-image", categories: ["images"], runner: { id: "sd", easy: true } });
  assert.ok(img("b/FLUX.1-dev") > img("b/sdxl-turbo"));
  assert.ok(img("b/sdxl-turbo") > img("b/stable-diffusion-v1-5"));
  assert.ok(img("b/pony-realism-v23-sdxl") > img("b/stable-diffusion-2-1"));
  const vid = (id, gb) => qualityScore({ id, pipeline: "text-to-video", categories: [], runner: null, gb });
  assert.ok(vid("c/Wan2.2-T2V-A14B") > vid("c/HunyuanVideo"));
  assert.ok(vid("c/HunyuanVideo") > vid("c/CogVideoX-5b"));
  assert.ok(vid("c/CogVideoX-5b") > vid("c/stable-video-diffusion-img2vid"));
  assert.ok(vid("c/Wan2.1-T2V-14B") > vid("c/Wan2.1-T2V-1.3B"), "the bigger of a family wins");
  const sp = (id) => qualityScore({ id, pipeline: "automatic-speech-recognition", categories: ["speech"], runner: { id: "whisper", easy: true } });
  assert.ok(sp("d/whisper-large-v3") > sp("d/whisper-medium"));
  assert.ok(sp("d/whisper-medium") > sp("d/whisper-tiny"));
});

test("in a search, relevance comes first and capability orders the rest", () => {
  const hub = [chat("x/Writer-3B-GGUF", { likes: 900 }), chat("x/Writer-70B-GGUF", { likes: 50 }), chat("x/Other-120B-GGUF", { likes: 5 })];
  const { models } = rankModels("writer", { hub, scanned: [], picks: [], voices: {} });
  assert.deepEqual(models.map((m) => m.name), ["Writer-70B-GGUF", "Writer-3B-GGUF", "Other-120B-GGUF"], "both Writers match the name; the bigger comes first; the biggest of all does not match and stays last");
  assert.ok(models[0].quality > models[1].quality);
  const vids = [
    { id: "v/stable-video-diffusion", name: "stable-video-diffusion", author: "v", pipeline: "text-to-video", categories: [], runner: null, likes: 3000, downloads: 9000 },
    { id: "v/Wan2.2-T2V-A14B", name: "Wan2.2-T2V-A14B", author: "v", pipeline: "text-to-video", categories: [], runner: null, likes: 400, downloads: 2000 },
  ];
  const ranked = rankModels("video generation", { hub: vids, scanned: [], picks: [], voices: {} }).models;
  assert.equal(ranked[0].name, "Wan2.2-T2V-A14B", "the strongest video family leads a video search, likes notwithstanding");
});
