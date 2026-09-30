import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./runners.js";

// What people say about a model, from the two places the Hub keeps it: the
// model card the author wrote, and the community discussions under the
// repository. Gathered on request into ~/HuggingFound/voices.json and
// searched locally, since the Hub's own search only matches names.

export const VOICES_FILE = path.join(DATA_DIR, "voices.json");
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;

export function readVoices(file = VOICES_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function writeVoices(index, file = VOICES_FILE) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(index));
}

// The readable part of a model card: front matter, HTML, badges, code and
// markdown syntax dropped, whitespace folded, cut to a sensible length.
export function cardExcerpt(markdown, max = 1500) {
  let text = String(markdown ?? "");
  text = text.replace(/^---[\s\S]*?\n---\s*/m, "");
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/^\s{0,3}#{1,6}\s*/gm, "");
  // Tables are benchmark grids and download lists, not prose.
  text = text.replace(/^.*\|.*$/gm, " ");
  text = text.replace(/[*_`>|]/g, " ");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return text;
}

// Gathers the card and the discussion list for one model.
export async function gatherVoices(hub, id) {
  const [card, discussions] = await Promise.all([hub.card(id).catch(() => ""), hub.discussions(id).catch(() => [])]);
  return {
    at: new Date().toISOString(),
    card: cardExcerpt(card),
    discussions: discussions
      .filter((d) => !d.isPullRequest)
      .slice(0, 30)
      .map((d) => ({ num: d.num, title: String(d.title ?? "").slice(0, 200), comments: d.numComments ?? 0, status: d.status ?? "open" })),
  };
}

export function isFresh(entry) {
  return Boolean(entry?.at) && Date.now() - new Date(entry.at).getTime() < FRESH_MS;
}

// Everything said about a model, as one lowercase string for matching.
export function voiceText(entry) {
  if (!entry) return "";
  return [entry.card ?? "", ...(entry.discussions ?? []).map((d) => d.title)].join(" \n ").toLowerCase();
}

// Which models people describe with these words. Every word has to appear
// in the card or a discussion title; models where the words appear in
// more places rank first. Returns matches with the passage that matched.
export function searchVoices(index, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const hits = [];
  for (const [id, entry] of Object.entries(index)) {
    const text = voiceText(entry);
    if (!words.every((w) => text.includes(w))) continue;
    const score = words.reduce((t, w) => t + text.split(w).length - 1, 0);
    hits.push({ id, score, snippet: snippetFor(entry, words) });
  }
  return hits.sort((a, b) => b.score - a.score);
}

// A short passage around the first word that matches, preferring a
// discussion title (what a user said) over the card (what the author said).
export function snippetFor(entry, words) {
  const lowerWords = words.map((w) => w.toLowerCase());
  const title = (entry.discussions ?? []).find((d) => lowerWords.some((w) => d.title.toLowerCase().includes(w)));
  if (title) return { from: "discussion", text: title.title, num: title.num };
  const card = entry.card ?? "";
  const lower = card.toLowerCase();
  const at = Math.min(...lowerWords.map((w) => lower.indexOf(w)).filter((i) => i >= 0));
  if (!Number.isFinite(at)) return null;
  const start = Math.max(0, card.lastIndexOf(" ", Math.max(0, at - 80)));
  const end = Math.min(card.length, card.indexOf(" ", at + 120) === -1 ? card.length : card.indexOf(" ", at + 120));
  return { from: "card", text: (start > 0 ? "…" : "") + card.slice(start, end).trim() + (end < card.length ? "…" : "") };
}

// The one line a card shows: the busiest discussion title, or the card's
// first sentence.
export function headline(entry) {
  if (!entry) return "";
  const busiest = [...(entry.discussions ?? [])].sort((a, b) => b.comments - a.comments)[0];
  if (busiest && busiest.comments > 0) return { from: "discussion", text: busiest.title, num: busiest.num, comments: busiest.comments };
  const first = (entry.card ?? "").split(/(?<=[.!?])\s+/)[0];
  return first ? { from: "card", text: first.slice(0, 160) } : "";
}
