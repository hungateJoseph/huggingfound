import { OLLAMA_URL } from "./runners.js";

// Turns what people wrote about a model into a couple of short lines a
// person can scan: the strengths users mention, then the complaints, then
// what the author claims. A chat model already installed in Ollama writes
// them when one is running; otherwise the lines are lifted from the most
// opinionated sentences in the text. Either way nothing is quoted at length.

const OPINION = /\b(good|great|best|excellent|amazing|love|recommend|impressive|solid|fast|quick|slow|bad|worse|worst|terrible|garbage|broken|fails?|failed|crash|refuse[sd]?|censored|uncensored|works?|worked|better|quality|accurate|hallucinat|coherent|creative|boring|repetitive|blurry|detailed|realistic|anime|roleplay|coding|math|prefer|beats|outperform|disappoint|struggle|useless|perfect|surprisingly|smart|dumb|nsfw|hands|fingers|context|memory|ram|vram)\b/i;
const NOISE = /https?:\/\/|```|\bREADME\b|license|licence|\bsha256\b|quantiz|imatrix|\bQ[2-8]_|\bgguf\b|download|repo(sitory)?\b|changelog|how to run|^\s*(usage|install)/i;
const AUTOMATED = /^demo for this model on spaces|^add .* to .*collection|^update readme|^adding .*model card/i;

// The raw material: what users wrote (discussion titles and comments, off-Hub
// posts) kept separate from what the author wrote (the card).
export function collectVoices(entry, web = null) {
  const users = [];
  for (const d of entry?.discussions ?? []) {
    if (AUTOMATED.test(d.title ?? "")) continue;
    users.push({ text: d.title, weight: 1 + Math.min(3, (d.comments ?? 0) / 3) });
    for (const c of d.comments_text ?? []) users.push({ text: c.text, weight: 1 });
  }
  for (const key of ["reddit", "github", "hn", "lemmy"]) {
    for (const p of web?.[key] ?? []) {
      users.push({ text: p.title, weight: 1 });
      if (p.excerpt) users.push({ text: p.excerpt, weight: 0.8 });
    }
  }
  for (const v of web?.youtube ?? []) users.push({ text: v.title, weight: 0.8 });
  for (const c of web?.civitai ?? []) {
    if (c.thumbsUp) users.push({ text: `${c.thumbsUp} people gave the Civitai page a thumbs up and ${c.thumbsDown ?? 0} a thumbs down.`, weight: 1.5 });
    if (c.description) users.push({ text: c.description, weight: 0.4, author: true });
  }
  for (const p of web?.civitaiPrompts ?? []) users.push({ text: `People make: ${p.prompt}`, weight: 0.6 });
  return { users, author: entry?.card ?? "" };
}

function sentences(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+|\s+[-–]\s+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 220);
}

function tidy(line, max = 110) {
  let s = line.replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s+/g, " ");
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Fallback without a language model: the sentences that carry an opinion,
// ranked by how many opinion words they hold and how discussed they were.
export function extractiveSummary(entry, web = null) {
  const { users, author } = collectVoices(entry, web);
  const scored = [];
  for (const u of users) {
    for (const s of sentences(u.text)) {
      if (NOISE.test(s)) continue;
      const hits = (s.match(new RegExp(OPINION.source, "gi")) ?? []).length;
      if (!hits && !/^People make:|thumbs up/.test(s)) continue;
      // A question ("how much VRAM?") is not an opinion; it only counts when nothing else does.
      const question = /\?\s*$/.test(s) || /^(how|what|which|can|does|is there|any(one)?|why|where)\b/i.test(s);
      scored.push({ s, score: (hits + 0.5) * u.weight * (u.author ? 0.5 : 1) * (question ? 0.15 : 1), author: Boolean(u.author) });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const userLines = [];
  for (const { s } of scored) {
    const key = s.toLowerCase().slice(0, 40);
    if (seen.has(key)) continue;
    seen.add(key);
    userLines.push(tidy(s));
    if (userLines.length === 5) break;
  }
  const authorLine = sentences(author).find((s) => !NOISE.test(s));
  const short = userLines.slice(0, 2).map((l) => `Users: ${l}`);
  if (short.length < 2 && authorLine) short.push(`Author: ${tidy(authorLine)}`);
  const long = userLines.map((l) => `Users: ${l}`);
  if (authorLine) long.push(`Author: ${tidy(authorLine, 160)}`);
  return { short, long, by: "extract", sources: users.length };
}

// Which installed chat model can write the summaries: the first one Ollama
// lists, preferring an instruct model.
export async function summarizerModel(fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const names = ((await res.json()).models ?? []).map((m) => m.name);
    return names.find((n) => /instruct|chat|it\b/i.test(n)) ?? names[0] ?? null;
  } catch {
    return null;
  }
}

const PROMPT = `You summarize what people say about an AI model for someone choosing a model to run at home.
Write at most 5 lines. Each line under 100 characters, plain words, no markdown, no quotes, no names of commenters.
Start user opinions with "Users:" (strengths first, then complaints). If there are no user comments, write one line starting with "Author:" that says what the author claims.
Do not invent anything that is not in the text. Never write a line saying there are no complaints or nothing to report; leave it out. If the text has nothing useful at all, write exactly: Nothing said yet.`;

export async function modelSummary(model, entry, web, fetchImpl = fetch) {
  const { users, author } = collectVoices(entry, web);
  const userText = users.map((u) => `- ${String(u.text).replace(/\s+/g, " ").slice(0, 300)}`).slice(0, 40).join("\n");
  const content = `Model: ${entry.name ?? ""}\n\nWhat the author's card says:\n${String(author).slice(0, 900) || "(nothing)"}\n\nWhat users wrote (titles, comments, posts):\n${userText || "(no user comments)"}`;
  const res = await fetchImpl(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: false, options: { temperature: 0.2, num_predict: 220 }, messages: [{ role: "system", content: PROMPT }, { role: "user", content }] }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}`);
  const data = await res.json();
  const lines = cleanLines(
    String(data.message?.content ?? "")
      .split("\n")
      .map((l) => l.replace(/^[\s*\-•\d.)]+/, "").trim())
      .map((l) => (/^(users?|author|complaints?|strengths?|weaknesses?)\s*:/i.test(l) ? l.replace(/^(users?|strengths?|weaknesses?|complaints?)\s*:/i, "Users:").replace(/^author\s*:/i, "Author:") : `Users: ${l}`)),
  );
  return { short: lines.slice(0, 2), long: lines, by: model, sources: users.length };
}

// Filler a chat model tends to add ("Users: No complaints mentioned.") and
// empty headings are dropped; the rest is trimmed to a readable length.
const FILLER = /^(users|author):\s*(no (user )?(complaints?|comments?|issues?|concerns?|problems?|feedback|reviews?)( (were |are )?(mentioned|reported|noted|found|available|yet))?\.?|none( mentioned| reported)?\.?|nothing (said|mentioned|reported|to report|useful)( yet)?\.?|n\/a\.?|not (mentioned|specified|available)\.?|(strengths?|weaknesses?|complaints?|pros|cons)\s*:?)\s*$/i;
export function cleanLines(lines) {
  return lines
    .map((l) => String(l).trim())
    .filter((l) => /^(users|author):\s*\S/i.test(l) && !FILLER.test(l) && !/^nothing said yet/i.test(l) && !/:\s*$/.test(l))
    .map((l) => tidy(l, 130))
    .slice(0, 5);
}

export function cleanSummary(summary) {
  if (!summary) return summary;
  const long = cleanLines(summary.long ?? []);
  return { ...summary, long, short: long.slice(0, 2) };
}

// The summary for one model: by the local chat model when there is one and
// the text is worth it, otherwise extractive. Never throws.
export async function summarize(entry, web, { model = null, fetchImpl = fetch } = {}) {
  const { users } = collectVoices(entry, web);
  if (model && (users.length || entry?.card)) {
    try {
      const s = await modelSummary(model, entry, web, fetchImpl);
      if (s.long.length) return { ...s, at: new Date().toISOString() };
    } catch {
      // fall back to the extractive lines
    }
  }
  return { ...extractiveSummary(entry, web), at: new Date().toISOString() };
}
