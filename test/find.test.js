import assert from "node:assert/strict";
import { test } from "node:test";
import { intentCategories, queryWords, rankModels } from "../src/find.js";

const chat = { id: "bartowski/Llama-3.2-3B-Instruct-GGUF", name: "Llama-3.2-3B-Instruct-GGUF", categories: ["easy", "chat"], runner: { id: "ollama", easy: true }, likes: 400, summary: { long: ["Users: Works well for roleplay and story writing", "Users: Refuses some prompts"] } };
const coder = { id: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", name: "Qwen2.5-Coder-7B-Instruct-GGUF", categories: ["easy", "coding", "chat"], runner: { id: "ollama", easy: true }, likes: 120, summary: { long: ["Users: Best local model for Rust coding help"] } };
const python = { id: "meta-llama/Llama-3.1-8B-Instruct", name: "Llama-3.1-8B-Instruct", categories: ["chat"], runner: { id: "python-transformers", easy: false }, likes: 4000, summary: null };
const image = { id: "John6666/pony-realism-v23-sdxl", name: "pony-realism-v23-sdxl", categories: ["easy", "images", "nsfw-images"], runner: { id: "sd", easy: true }, likes: 90, summary: { long: ["Users: Realistic people, good hands"] } };

test("query words drop filler and intents come from the wording", () => {
  assert.deepEqual(queryWords("a model good for creative writing"), ["creative", "writing"]);
  assert.deepEqual([...intentCategories("model for porn writing")], ["nsfw-images", "nsfw-writing", "chat"]);
  assert.ok(intentCategories("anime pictures").has("images"));
  assert.ok(intentCategories("transcribe meetings").has("speech"));
  assert.equal(intentCategories("something else").size, 0);
});

test("what people say and the category outrank a bare name, and Python-only models sink", () => {
  const { models } = rankModels("good for roleplay and story writing", { hub: [python], scanned: [chat, coder, python, image] });
  assert.equal(models[0].id, chat.id, "the model whose users praise roleplay comes first");
  assert.ok(models[0].why.includes("what people say"));
  assert.ok(models[0].why.includes("category"));
  assert.ok(models.findIndex((m) => m.id === python.id) > models.findIndex((m) => m.id === chat.id));
  assert.ok(!models.some((m) => m.id === image.id), "an image model does not match a writing search");
});

test("category intent finds image models even without the word in their notes", () => {
  const { models } = rankModels("realistic photos", { hub: [], scanned: [chat, coder, image] });
  assert.equal(models[0].id, image.id);
  assert.deepEqual(models.map((m) => m.id), [image.id]);
});

test("Hub name hits, discussions and curated picks all say why they are there", () => {
  const voices = { [coder.id]: { card: "", discussions: [{ title: "rust borrow checker help", comments: 2 }] } };
  const picks = [{ id: "ggerganov/whisper.cpp", runner: "whisper", categories: ["easy", "speech"], why: "Transcribes offline", file: "ggml-base.en.bin", gb: 0.15 }];
  const { models } = rankModels("rust", { hub: [{ ...coder, summary: null }], scanned: [], picks, voices });
  assert.equal(models[0].id, coder.id);
  assert.ok(models[0].why.includes("name") || models[0].why.includes("discussions"));
  const speech = rankModels("transcribe a podcast", { hub: [], scanned: [], picks }).models;
  assert.equal(speech[0].id, "ggerganov/whisper.cpp");
  assert.ok(speech[0].why.includes("curated pick") && speech[0].why.includes("category"));
});

test("a complaint that uses the words ranks below praise and is marked mixed", () => {
  const praised = { id: "a/story-writer", name: "story-writer", categories: ["chat"], runner: { id: "ollama", easy: true }, likes: 10, summary: { long: ["Users: Excellent for creative writing and stories"] } };
  const panned = { id: "b/creative-rogue", name: "creative-rogue", categories: ["chat"], runner: { id: "ollama", easy: true }, likes: 500, summary: { long: ["Users: Not suitable for creative writing, low quality"] } };
  const { models } = rankModels("creative writing", { hub: [], scanned: [panned, praised] });
  assert.equal(models[0].id, praised.id);
  assert.ok(models[1].why.includes("mixed reviews"));
  assert.ok(!models[1].why.includes("what people say"));
});
