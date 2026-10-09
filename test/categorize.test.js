import assert from "node:assert/strict";
import { test } from "node:test";
import { CATEGORIES, categorize, describe, paramSize } from "../src/categorize.js";

const gguf = (id, extra = {}) => ({ id, pipeline_tag: "text-generation", library_name: "gguf", tags: ["gguf"], ...extra });

test("every category has an id, a name and a blurb", () => {
  for (const c of CATEGORIES) {
    assert.ok(c.id && c.name && c.blurb);
  }
  assert.equal(CATEGORIES[0].id, "easy");
  assert.ok(CATEGORIES.some((c) => c.id === "nsfw-writing") && CATEGORIES.some((c) => c.id === "nsfw-images"));
});

test("a gguf instruct model is chat, easy and runs on Ollama", () => {
  const r = categorize(gguf("bartowski/Llama-3.2-3B-Instruct-GGUF"));
  assert.deepEqual(r.categories, ["easy", "chat"]);
  assert.equal(r.runner.id, "ollama");
  assert.equal(r.gguf, true);
});

test("coder and math names land in their own buckets", () => {
  assert.deepEqual(categorize(gguf("bartowski/Qwen2.5-Coder-7B-Instruct-GGUF")).categories, ["easy", "coding", "chat"]);
  assert.deepEqual(categorize(gguf("bartowski/DeepSeek-R1-Distill-Qwen-7B-GGUF")).categories, ["easy", "math"]);
  assert.ok(categorize(gguf("x/some-math-model-GGUF", { tags: ["gguf", "math"] })).categories.includes("math"));
});

test("a transformers checkpoint is not easy and needs Python", () => {
  const r = categorize({ id: "meta-llama/Llama-3.1-8B-Instruct", pipeline_tag: "text-generation", library_name: "transformers", tags: ["transformers", "conversational"] });
  assert.deepEqual(r.categories, ["chat"]);
  assert.equal(r.runner.id, "python-transformers");
  assert.equal(r.runner.easy, false);
});

test("vision, image, and speech pipelines get their runners", () => {
  const vision = categorize({ id: "unsloth/gemma-3-4b-it-GGUF", pipeline_tag: "image-text-to-text", tags: ["gguf"] });
  assert.deepEqual(vision.categories, ["easy", "vision"]);
  assert.equal(vision.runner.id, "ollama");

  const sdGguf = categorize({ id: "second-state/stable-diffusion-v1-5-GGUF", pipeline_tag: "text-to-image", tags: ["gguf"] });
  assert.deepEqual(sdGguf.categories, ["easy", "images"]);
  assert.equal(sdGguf.runner.id, "sd");

  const sdSingle = categorize({ id: "stabilityai/sdxl-turbo", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "diffusion-single-file"] });
  assert.equal(sdSingle.runner.id, "sd");

  const flux = categorize({ id: "black-forest-labs/FLUX.1-dev", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers"] });
  assert.deepEqual(flux.categories, ["images"]);
  assert.equal(flux.runner.id, "diffusers", "FLUX runs on a rented GPU through the diffusers library");
  assert.equal(flux.runner.gpu, true);

  const qwenImage = categorize({ id: "unsloth/Qwen-Image-2.1-GGUF", pipeline_tag: "text-to-image", tags: ["gguf"] });
  assert.equal(qwenImage.runner.id, "diffusers");
  assert.equal(qwenImage.runner.easy, false);

  const other = categorize({ id: "someone/painting-model", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers"] });
  assert.equal(other.runner.id, "diffusers");

  const wan = categorize({ id: "Wan-AI/Wan2.2-TI2V-5B-Diffusers", pipeline_tag: "text-to-video", library_name: "diffusers", tags: ["diffusers"] });
  assert.ok(wan.categories.includes("images"));
  assert.equal(wan.runner.id, "diffusers", "video families too");

  const whisper = categorize({ id: "ggerganov/whisper.cpp", pipeline_tag: "automatic-speech-recognition", tags: [] });
  assert.deepEqual(whisper.categories, ["easy", "speech"]);
  assert.equal(whisper.runner.id, "whisper");

  const hfWhisper = categorize({ id: "openai/whisper-large-v3", pipeline_tag: "automatic-speech-recognition", library_name: "transformers", tags: [] });
  assert.equal(hfWhisper.runner.id, "python-transformers");
});

test("models outside the supported pipelines have no runner and no category", () => {
  const r = categorize({ id: "x/some-embedding", pipeline_tag: "feature-extraction", tags: [] });
  assert.deepEqual(r.categories, []);
  assert.equal(r.runner, null);
});

test("describe and paramSize read the name", () => {
  assert.equal(paramSize("bartowski/Qwen2.5-7B-Instruct-GGUF"), "7B");
  assert.equal(paramSize("x/model-1.5B-chat"), "1.5B");
  assert.equal(paramSize("x/no-size"), null);
  assert.equal(describe({ id: "x/Qwen2.5-Coder-7B" }, ["coding"]), "7B parameters, trained for code");
  assert.equal(describe({ id: "x/thing" }, ["chat"]), "general chat and writing");
  assert.equal(describe({ id: "x/thing" }, []), "General purpose");
});

test("adult models are flagged and land in the NSFW buckets as well as their own", () => {
  const tagged = categorize(gguf("TheDrummer/Cydonia-24B-v2-GGUF", { tags: ["gguf", "not-for-all-audiences"] }));
  assert.equal(tagged.adult, true);
  assert.deepEqual(tagged.categories, ["easy", "chat", "nsfw-writing"]);
  const named = categorize(gguf("someone/Llama-3-8B-Uncensored-GGUF"));
  assert.ok(named.categories.includes("nsfw-writing"));
  const image = categorize({ id: "John6666/pony-realism-v23-sdxl", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "stable-diffusion-xl", "not-for-all-audiences", "diffusers:StableDiffusionXLPipeline"] });
  assert.deepEqual(image.categories, ["easy", "images", "nsfw-images"]);
  assert.equal(image.runner.id, "sd");
  const plain = categorize(gguf("bartowski/Qwen2.5-7B-Instruct-GGUF"));
  assert.equal(plain.adult, false);
  assert.ok(!plain.categories.some((c) => c.startsWith("nsfw")));
});

test("parts of a model are not offered as models", () => {
  for (const id of ["pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-GGUF", "x/sdxl-vae-fp16-fix", "y/detail-tweaker-lora", "z/gemma-3-mmproj-GGUF"]) {
    const r = categorize({ id, pipeline_tag: "text-generation", tags: ["gguf"] });
    assert.deepEqual(r.categories, [], id);
    assert.equal(r.runner, null);
  }
});

test("diffusers repositories of the Stable Diffusion families run here; other pipelines run on a rented GPU", () => {
  const sdxl = categorize({ id: "someone/my-anime-mix", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "diffusers:StableDiffusionXLPipeline"] });
  assert.equal(sdxl.runner.id, "sd");
  const sd15 = categorize({ id: "someone/dreamy-photos", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "stable-diffusion"] });
  assert.equal(sd15.runner.id, "sd");
  const sd3 = categorize({ id: "stabilityai/stable-diffusion-3.5-medium", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "diffusers:StableDiffusion3Pipeline"] });
  assert.equal(sd3.runner.id, "diffusers");
  const unknown = categorize({ id: "someone/painting-model", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "diffusers:KandinskyPipeline"] });
  assert.equal(unknown.runner.id, "diffusers");
});

test("an image-editing model with a bundled text encoder is an image model, never a chat model", () => {
  const r = categorize({ id: "rectangleworm/PornMaster_Klein-9b", pipeline_tag: "image-to-image", library_name: "diffusers", tags: ["diffusers", "gguf", "flux", "image-to-image", "conversational", "not-for-all-audiences", "diffusion-single-file"] });
  assert.ok(!r.categories.includes("chat"));
  assert.ok(r.categories.includes("images"));
  assert.ok(r.categories.includes("nsfw-images"));
  assert.equal(r.runner.id, "diffusers", "FLUX runs on a rented GPU, not here");
  assert.equal(r.runner.easy, false);
  const chat = categorize({ id: "x/some-chat-GGUF", pipeline_tag: "text-generation", tags: ["gguf", "conversational"] });
  assert.ok(chat.categories.includes("chat"));
});
