// Sorts a Hugging Face model into the buckets a newcomer thinks in, and
// works out how it can be run here. Everything is inferred from the tags,
// pipeline and name the Hub already exposes; no model card is downloaded.

export const CATEGORIES = [
  { id: "easy", name: "Easy to set up", blurb: "One runner, one command. Start here." },
  { id: "chat", name: "Chat and writing", blurb: "General assistants: questions, drafts, summaries, rewriting." },
  { id: "coding", name: "Coding", blurb: "Models trained on code: write, explain and fix programs." },
  { id: "math", name: "Math and reasoning", blurb: "Models tuned for step-by-step problem solving." },
  { id: "vision", name: "Understands images", blurb: "Chat models you can show a picture to." },
  { id: "images", name: "Makes images", blurb: "Text-to-image models: describe a picture, get a picture." },
  { id: "speech", name: "Speech to text", blurb: "Turn recordings into transcripts, offline." },
  { id: "nsfw-writing", name: "NSFW writing", blurb: "Uncensored and role-play chat models. Adult content is possible; they are for adults." },
  { id: "nsfw-images", name: "NSFW images", blurb: "Image models trained or tuned for adult content. For adults only." },
];

const CODE_RE = /\b(code|coder|codellama|starcoder|deepseek-coder|codegemma|codestral|devstral|codeqwen)\b/i;
const MATH_RE = /\b(math|mathstral|numina|deepseek-math|qwen-math|r1|reasoning|reason|think|o1)\b/i;
const CHAT_RE = /\b(instruct|chat|assistant|it|conversational)\b/i;
const NSFW_RE = /\b(uncensored|abliterated|heretic|nsfw|lewd|erotic|roleplay|role play|rp|hentai|pony|nudity|adult)\b/i;

export function categorize(model) {
  const tags = new Set((model.tags ?? []).map((t) => t.toLowerCase()));
  const name = model.id.toLowerCase().replace(/[-_.]/g, " ");
  const pipeline = model.pipeline_tag ?? "";
  const gguf = tags.has("gguf") || /gguf/.test(name);
  const cats = [];

  // Pieces of a model (a text encoder, a VAE, a LoRA, a vision projector)
  // are not something to run on their own.
  if (/text.?encoder|\bvae\b|\blora\b|mmproj|\bembeddings?\b|controlnet/i.test(model.id)) {
    return { categories: [], runner: null, gguf, adult: false };
  }

  // A repository that bundles a text encoder GGUF next to an image model
  // gets a "conversational" tag on the Hub. It is still an image model;
  // handing that encoder to Ollama as a chat model is a mistake.
  const imageLike = /^(text-to-image|image-to-image|image-editing|image-to-video|text-to-video|video-to-video|inpainting)$/.test(pipeline) || tags.has("flux") || tags.has("diffusers");
  if (pipeline === "text-to-image" || (imageLike && !/text-generation/.test(pipeline))) {
    cats.push("images");
  } else if (pipeline === "automatic-speech-recognition") {
    cats.push("speech");
  } else if (pipeline === "image-text-to-text" || tags.has("image-text-to-text")) {
    cats.push("vision");
  } else if (pipeline === "text-generation" || tags.has("conversational") || tags.has("text-generation")) {
    if (CODE_RE.test(name) || tags.has("code")) cats.push("coding");
    if (MATH_RE.test(name) || tags.has("math")) cats.push("math");
    if (cats.length === 0 || CHAT_RE.test(name) || tags.has("conversational")) cats.push("chat");
  }

  const adult = tags.has("not-for-all-audiences") || tags.has("nsfw") || tags.has("uncensored") || NSFW_RE.test(name);
  if (adult && cats.includes("images")) cats.push("nsfw-images");
  if (adult && cats.some((c) => ["chat", "coding", "math", "vision"].includes(c))) cats.push("nsfw-writing");

  const runner = runnerFor(model, cats, gguf);
  if (runner && runner.easy) cats.unshift("easy");
  return { categories: cats, runner, gguf, adult };
}

// Which local runner can take this model, if any.
function runnerFor(model, cats, gguf) {
  if (cats.includes("images")) {
    // stable-diffusion.cpp loads Stable Diffusion 1.x, 2.x, XL and Turbo,
    // either as one file with the encoders and VAE inside or as a diffusers
    // folder. Newer families (FLUX, Qwen-Image, Wan and friends) ship the
    // pieces separately, which is a hand-assembly job, so they are shown
    // but not set up.
    const rawTags = (model.tags ?? []).map((t) => t.toLowerCase());
    const family = /stable.?diffusion|\bsd-?(1\.?5|2\.?1|xl)\b|sdxl|sd.?turbo|dreamshaper|realistic.?vision|juggernaut/i.test(model.id);
    const parts = /flux|klein|qwen|wan|hunyuan|z-image|lumina|chroma|kolors|pixart|sana|cogview|hidream|stable-diffusion-3|sd3|lora|openvino|onnx|tensorrt|coreml/i.test(model.id) || rawTags.some((t) => /^(flux|flux2|klein|qwen-image|wan|hunyuan|sd3|stable-diffusion-3)$/.test(t));
    const sdPipeline = rawTags.includes("stable-diffusion-xl") || rawTags.includes("stable-diffusion") || rawTags.some((t) => /^diffusers:stablediffusion(xl)?(img2img|inpaint)?pipeline$/.test(t));
    const single = !parts && (family || sdPipeline || model.library_name === "diffusion-single-file" || rawTags.includes("diffusion-single-file"));
    if (single) return { id: "sd", name: "stable-diffusion.cpp", easy: true };
    if (gguf || parts) return { id: "sd-parts", name: "stable-diffusion.cpp with separate encoder and VAE files", easy: false };
    return { id: "python-diffusers", name: "Python + diffusers", easy: false };
  }
  if (cats.includes("speech")) {
    // whisper.cpp loads ggml files; the Hub has them under ggerganov and in
    // repositories that say ggml, never in a transformers checkpoint.
    const tags = new Set((model.tags ?? []).map((t) => t.toLowerCase()));
    const whisper = /whisper/i.test(model.id) && (/ggml|whisper\.cpp/i.test(model.id) || tags.has("ggml") || !model.library_name);
    return whisper ? { id: "whisper", name: "whisper.cpp", easy: true } : { id: "python-transformers", name: "Python + transformers", easy: false };
  }
  if (cats.some((c) => ["chat", "coding", "math", "vision"].includes(c))) {
    return gguf ? { id: "ollama", name: "Ollama", easy: true } : { id: "python-transformers", name: "Python + transformers", easy: false };
  }
  return null;
}

// A short plain-language line about what the model is for.
export function describe(model, categories) {
  const parts = [];
  const size = paramSize(model.id);
  if (size) parts.push(`${size} parameters`);
  if (categories.includes("coding")) parts.push("trained for code");
  if (categories.includes("math")) parts.push("tuned for math and reasoning");
  if (categories.includes("vision")) parts.push("can look at images");
  if (categories.includes("images")) parts.push("generates images from text");
  if (categories.includes("speech")) parts.push("transcribes speech");
  if (categories.length === 1 && categories[0] === "chat") parts.push("general chat and writing");
  return parts.join(", ") || "General purpose";
}

// "7b", "3B", "70b" in a repo name.
export function paramSize(id) {
  const m = /(\d+(?:\.\d+)?)[bB]\b/.exec(id.split("/").pop() ?? "");
  return m ? `${m[1]}B` : null;
}
