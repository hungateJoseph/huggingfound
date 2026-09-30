import { voiceText } from "./voices.js";

// Ranks models for a plain-language search ("model good for creative
// writing", "anime images", "porn writing") by how well the name, the
// category and what people say match, with runnable models ahead. Every
// model in the answer says why it is there.

// Words that point at a category, so "pictures" finds image models even
// when nobody wrote the word on the card.
const INTENTS = [
  { cats: ["images", "nsfw-images"], re: /\b(image|images|picture|pictures|photo|photos|art|drawing|drawings|illustration|render|renders|anime|waifu|hentai|txt2img|text-to-image|sdxl|stable diffusion)\b/i },
  { cats: ["nsfw-images", "nsfw-writing"], re: /\b(nsfw|porn|porno|pornographic|adult|erotic|erotica|explicit|uncensored|lewd|hentai|smut|sex|sexual|nude|nudes|nudity)\b/i },
  { cats: ["nsfw-writing", "chat"], re: /\b(roleplay|role-play|rp|story|stories|storytelling|fiction|novel|writer|writing|creative|character|characters|companion|girlfriend|boyfriend)\b/i },
  { cats: ["coding"], re: /\b(code|coding|coder|program|programming|programmer|software|developer|python|javascript|typescript|rust|java|sql|debug|debugging|refactor)\b/i },
  { cats: ["math"], re: /\b(math|maths|mathematics|reasoning|reason|logic|proof|proofs|equation|equations|calculus|algebra)\b/i },
  { cats: ["speech"], re: /\b(speech|voice|audio|transcribe|transcription|transcript|dictation|whisper|subtitle|subtitles|podcast|meeting)\b/i },
  { cats: ["vision"], re: /\b(see|sees|look|vision|screenshot|screenshots|ocr|describe (an? )?image|image understanding|multimodal)\b/i },
  { cats: ["chat"], re: /\b(chat|chatbot|assistant|question|questions|answer|answers|summar(y|ize|ise)|translate|translation|general)\b/i },
];

const STOP = new Set(["a", "an", "the", "for", "of", "to", "in", "on", "with", "and", "or", "that", "this", "is", "are", "be", "model", "models", "good", "best", "great", "at", "about", "knows", "know", "which", "what", "some", "any", "me", "my", "i", "want", "need", "find", "like", "can", "does", "do", "it", "its", "one", "open", "source", "local", "free", "ai", "llm"]);

export function queryWords(q) {
  return [...new Set(String(q).toLowerCase().split(/[^a-z0-9.+-]+/).filter((w) => w.length > 1 && !STOP.has(w)))];
}

export function intentCategories(q) {
  const cats = new Set();
  for (const { cats: c, re } of INTENTS) if (re.test(q)) for (const x of c) cats.add(x);
  return cats;
}

// How many of the words appear in a text, counting each word once.
function coverage(words, text) {
  const t = String(text).toLowerCase();
  return words.filter((w) => t.includes(w)).length;
}

function summaryText(m) {
  return (m.summary?.long ?? []).join(" ");
}

// `hub` is the Hub's own name search (in its order), `scanned` the scan with
// summaries attached, `voices` the gathered index by id.
export function rankModels(q, { hub = [], scanned = [], picks = [], voices = {} }) {
  const words = queryWords(q);
  const intents = intentCategories(q);
  const byId = new Map();
  const add = (m, source) => {
    const cur = byId.get(m.id);
    if (cur) {
      cur.sources.add(source);
      if (source === "hub") cur.hubIndex = cur.hubIndex ?? hub.findIndex((h) => h.id === m.id);
      return;
    }
    byId.set(m.id, { m, sources: new Set([source]), hubIndex: source === "hub" ? hub.findIndex((h) => h.id === m.id) : null });
  };
  for (const m of hub) add(m, "hub");
  for (const m of scanned) add(m, "scan");
  for (const p of picks) add({ ...p, name: p.id.split("/").pop(), author: p.id.split("/")[0], summary: null, runner: { id: p.runner, easy: true }, categories: p.categories, likes: 0, downloads: 0, isPick: true }, "pick");

  const ranked = [];
  for (const { m, sources, hubIndex } of byId.values()) {
    const why = [];
    let score = 0;
    const nameHits = coverage(words, `${m.id} ${m.summary?.long ? "" : ""}`);
    if (nameHits) {
      score += 3 * nameHits;
      why.push("name");
    }
    if (hubIndex != null && hubIndex >= 0) score += Math.max(0, 2 - hubIndex / 15);
    const said = summaryText(m);
    const saidHits = coverage(words, said);
    if (saidHits) {
      score += 2.5 * saidHits;
      why.push("what people say");
    }
    const notes = voiceText(voices[m.id]);
    const noteHits = notes ? coverage(words, notes) : 0;
    if (noteHits && !saidHits) {
      score += 1.2 * noteHits;
      why.push("discussions");
    }
    const catHit = (m.categories ?? []).some((c) => intents.has(c));
    if (catHit) {
      score += 2;
      why.push("category");
    }
    if (m.isPick) {
      score += 0.5;
      why.push("curated pick");
    }
    if (m.runner?.easy) score += 1;
    else score -= 1.5;
    score += Math.log10((m.likes ?? 0) + 1) / 4;
    // A model that matches nothing but a broad category only stays when the
    // search was mostly about that category.
    if (!nameHits && !saidHits && !noteHits && !catHit && !sources.has("hub")) continue;
    if (!nameHits && !saidHits && !noteHits && catHit && words.length > 3 && !sources.has("hub")) score -= 1;
    ranked.push({ ...m, score: Math.round(score * 100) / 100, why });
  }
  ranked.sort((a, b) => b.score - a.score || (b.likes ?? 0) - (a.likes ?? 0));
  return { words, intents: [...intents], models: ranked };
}
