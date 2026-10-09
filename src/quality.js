import { paramSize } from "./categorize.js";

// How capable a model is likely to be, on a 0 to 3 scale, from what its
// name and size say before anyone has tried it: a bigger chat model, a
// newer image family, a larger speech model. It never outweighs relevance;
// it orders models that match a search equally well, so a search for video
// shows the strongest video models first.

const IMAGE_FAMILIES = [
  [/\b(flux|sd3|sd-3|sd3\.5|stable-diffusion-3|hidream|auraflow|kolors|lumina|pixart|playground-v2\.5|cogview4|qwen-image|z-image)\b/i, 2.6],
  [/\b(sdxl|xl|pony|illustrious|animagine|juggernaut|realvis|noob)\b/i, 2],
  [/\b(sd2|sd-2|stable-diffusion-2|v2-1|2-1)\b/i, 1],
  [/\b(sd1|sd-1|stable-diffusion-v1|v1-5|v1-4|1\.5)\b/i, 0.6],
];
const VIDEO_FAMILIES = [
  [/\bwan\b|\bwan2/i, 2.4],
  [/\bltx-?2|\bltx[-_]?video[-_]?2/i, 2.2],
  [/\bhunyuan\s?video|\bhunyuanvideo/i, 2.1],
  [/\bltx|\bmochi|\bcogvideox/i, 1.6],
  [/\bsvd|stable-video|animatediff|zeroscope|modelscope|text2video-zero|text-to-video-ms/i, 0.6],
];
// Not a model but a piece for one: a LoRA, a VAE, a workflow file, a
// repackaging for some tool. Shown, but under the models themselves.
const ADDON = /\b(lora|loras|lycoris|vae|workflow|workflows|repackaged|embeddings?|textual[-_ ]inversion|controlnet|adapter|acc-loras|comfyui)\b/i;

// For a family nobody here has rated: how liked and how recent it is. A new
// family that thousands of people like is probably strong.
function crowdGuess(m) {
  const likes = Number(m.likes ?? 0);
  const months = m.createdAt ? (Date.now() - new Date(m.createdAt).getTime()) / (30 * 86400e3) : null;
  let x = 1.2;
  if (likes >= 3000) x += 0.9;
  else if (likes >= 1000) x += 0.6;
  else if (likes >= 300) x += 0.3;
  if (months != null && months <= 18) x += 0.3;
  else if (months != null && months >= 36) x -= 0.3;
  return x;
}

function params(m) {
  const named = paramSize(m.id);
  if (named) return parseFloat(named);
  // A model that does not name its size is guessed from its biggest file: about 0.6 GB per billion parameters at 4-bit.
  const gb = Number(m.gb ?? m.file?.gb);
  return gb > 0 ? gb / 0.6 : null;
}

// What comes out of a model: video, images, speech (a transcript), audio,
// vision (text about a picture) or text.
export function kindOf(m) {
  const pipeline = String(m.pipeline ?? "");
  const cats = m.categories ?? [];
  const runner = m.runner?.id ?? m.runner ?? "";
  if (/video/.test(pipeline)) return "video";
  if (cats.includes("images") || cats.includes("nsfw-images") || runner === "sd" || /^(text-to-image|image-to-image|image-editing|inpainting|unconditional-image-generation)$/.test(pipeline)) return "images";
  if (cats.includes("speech") || runner === "whisper" || pipeline === "automatic-speech-recognition") return "speech";
  if (pipeline === "text-to-speech" || pipeline === "text-to-audio") return "audio";
  if (cats.includes("vision") || pipeline === "image-text-to-text") return "vision";
  return "text";
}

// The kind a search is after, when its words say so.
export function wantedKind(q) {
  const t = String(q);
  if (/\b(videos?|animations?|animate|clips?|film|movie|img2vid|text-to-video|t2v)\b/i.test(t)) return "video";
  if (/\b(images?|pictures?|photos?|photographs?|art|artwork|draw|drawing|illustrations?|anime|wallpapers?|renders?|paintings?|portraits?|logos?|sketch|txt2img|text-to-image)\b/i.test(t)) return "images";
  if (/\b(speech|voice|audio|transcri\w+|dictation|whisper|subtitles?|podcast|meeting)\b/i.test(t)) return "speech";
  return null;
}

export function qualityScore(m) {
  const id = String(m.id ?? "");
  const name = id.split("/").pop() ?? "";
  const pipeline = String(m.pipeline ?? "");
  const cats = m.categories ?? [];
  const runner = m.runner?.id ?? m.runner ?? "";
  const family = (table) => table.find(([re]) => re.test(name))?.[1] ?? null;

  if (ADDON.test(name)) return 0.2;
  if (/video/.test(pipeline)) {
    // The family says most; within it, a bigger model is a little better.
    const base = family(VIDEO_FAMILIES) ?? crowdGuess(m);
    return clamp(base + Math.min(0.6, sizeBonus(params(m), 2, 8, 0.2)));
  }
  if (cats.includes("images") || cats.includes("nsfw-images") || runner === "sd" || /^(text-to-image|image-to-image|image-editing|inpainting)$/.test(pipeline)) {
    return clamp(family(IMAGE_FAMILIES) ?? 1);
  }
  if (cats.includes("speech") || runner === "whisper" || pipeline === "automatic-speech-recognition") {
    if (/large-v3|large_v3/i.test(name)) return 3;
    if (/large/i.test(name)) return 2.5;
    if (/medium/i.test(name)) return 1.8;
    if (/small/i.test(name)) return 1.2;
    if (/base/i.test(name)) return 0.6;
    if (/tiny/i.test(name)) return 0.2;
    return 1;
  }
  // Chat models and everything else that writes: size, on a log scale, so
  // 7B sits well below 32B and 70B, and a hundred billion is near the top.
  const p = params(m);
  if (!p) return 1;
  return clamp(sizeBonus(p, 2, 3, 0.55) + 0.2);
}

// log2(p / from) * step, from zero at `from`.
function sizeBonus(p, from, floorParams, step) {
  if (!p) return 0;
  return Math.max(0, Math.log2(Math.max(p, floorParams / 4) / Math.max(from, 0.5))) * step;
}

function clamp(x) {
  return Math.round(Math.min(3, Math.max(0, x)) * 100) / 100;
}
