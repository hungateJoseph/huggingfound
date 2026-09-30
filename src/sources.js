import { randomBytes } from "node:crypto";

// What people say off the Hub: Civitai (ratings and comments on image
// models, mostly the same files mirrored on Hugging Face) and Reddit
// (r/LocalLLaMA, r/StableDiffusion and friends). Civitai has a public API.
// Reddit refuses anonymous JSON, so it needs the id of a Reddit "installed
// app" the user creates; the token flow below needs no secret and no login.

const UA = "huggingfound/0.1 (local desktop app; github.com/hungateJoseph/huggingfound)";
export const REDDIT_SUBS = ["LocalLLaMA", "StableDiffusion", "SillyTavernAI", "LocalLLM", "comfyui", "Oobabooga", "ollama"];

// ---- names ---------------------------------------------------------------------

// A repository name reduced to the words a person would use for it: no
// author, no GGUF or quantization suffixes, no "instruct" boilerplate.
export function plainName(id) {
  let name = String(id).split("/").pop() ?? "";
  name = name.replace(/[-_.]?(gguf|ggml|safetensors|fp16|fp8|bf16|q\d[_a-z0-9]*|imatrix|i1)\b/gi, "");
  name = name.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return name;
}

export function normalize(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

// The words of a name that identify it: version numbers and base-model
// tags (sdxl, sd15, xl, v2) dropped, since a Civitai page and a Hub mirror
// rarely agree on those.
export function nameWords(name) {
  return String(name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !/^v?\d+[a-z0-9]*$/.test(t) && !/^(sdxl|sd15|sd1|xl|checkpoint|model|merge|mix|the|for|and)$/.test(t));
}

// How alike two names are, from 0 to 1: one name written inside the other
// counts fully when they are close in length; otherwise how much of each
// name's words the other covers, weighted so that a candidate adding words
// of its own ("Indecent (Realism for Pony)" for "pony realism") scores
// lower than one that merely drops a word, and a generic prefix such as
// "stable diffusion" does not claim every model that starts with it.
export function similarity(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length >= 8 && long.includes(short) && short.length / long.length >= 0.75) return 1;
  const wa = [...new Set(nameWords(a))];
  const wb = [...new Set(nameWords(b))];
  if (!wa.length || !wb.length) return 0;
  const setA = new Set(wa);
  const setB = new Set(wb);
  const coverA = wa.filter((t) => setB.has(t)).length / wa.length;
  const coverB = wb.filter((t) => setA.has(t)).length / wb.length;
  return 0.4 * coverA + 0.6 * coverB;
}

// The score from which two names are taken to be the same model.
export const SAME_MODEL = 0.85;

// Which known repositories a piece of text mentions.
export function matchKnown(text, ids) {
  const flat = normalize(text);
  const out = [];
  for (const id of ids) {
    const key = normalize(plainName(id));
    if (key.length >= 6 && flat.includes(key)) out.push(id);
  }
  return out;
}

// ---- Civitai -------------------------------------------------------------------

export function createCivitai({ fetchImpl = fetch, base = "https://civitai.com" } = {}) {
  async function search(q, { limit = 12 } = {}) {
    const url = new URL("/api/v1/models", base);
    url.searchParams.set("query", String(q).slice(0, 100));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("nsfw", "true");
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Civitai replied HTTP ${res.status}`);
    const data = await res.json();
    return (data.items ?? []).map(item);
  }

  // The Civitai checkpoints that look like a Hugging Face image model,
  // best first: closest name, then most thumbs up. Merges and re-uploads
  // share names, so up to three are returned and the page shows them.
  async function forModel(id) {
    const words = nameWords(plainName(id));
    const seen = new Map();
    // Try the full name, then shorter ones, until checkpoints turn up.
    for (let n = words.length; n >= Math.min(2, words.length); n--) {
      const q = words.slice(0, n).join(" ");
      if (!q) break;
      for (const m of await search(q, { limit: 12 })) if (m.type === "Checkpoint" && !seen.has(m.id)) seen.set(m.id, m);
      if ([...seen.values()].some((m) => similarity(words.join(" "), m.name) >= SAME_MODEL)) break;
    }
    const scored = [...seen.values()]
      .map((m) => ({ ...m, match: similarity(words.join(" "), m.name) }))
      .filter((m) => m.match >= SAME_MODEL)
      .sort((a, b) => b.match - a.match || b.thumbsUp - a.thumbsUp);
    return scored.slice(0, 3);
  }

  return { search, forModel };
}

function item(m) {
  const s = m.stats ?? {};
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    url: `https://civitai.com/models/${m.id}`,
    thumbsUp: s.thumbsUpCount ?? 0,
    thumbsDown: s.thumbsDownCount ?? 0,
    comments: s.commentCount ?? 0,
    downloads: s.downloadCount ?? 0,
    nsfw: Boolean(m.nsfw),
    tags: (m.tags ?? []).slice(0, 8),
    creator: m.creator?.username ?? "",
    description: htmlExcerpt(m.description, 400),
    versions: (m.modelVersions ?? []).slice(0, 3).map((v) => v.name),
  };
}

export function htmlExcerpt(html, max = 400) {
  let text = String(html ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/, "") + "…";
  return text;
}

// ---- Reddit --------------------------------------------------------------------

export function createReddit({ fetchImpl = fetch, clientId = "", authBase = "https://www.reddit.com", apiBase = "https://oauth.reddit.com", deviceId = "" } = {}) {
  let token = null;
  const device = deviceId || randomBytes(12).toString("hex");

  async function accessToken() {
    if (!clientId) throw new Error("Reddit needs an app id; add one in Settings");
    if (token && token.expires > Date.now() + 60000) return token.value;
    const res = await fetchImpl(new URL("/api/v1/access_token", authBase), {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: `grant_type=${encodeURIComponent("https://oauth.reddit.com/grants/installed_client")}&device_id=${device}`,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(res.status === 401 ? "Reddit rejected the app id; check it in Settings" : `Reddit replied HTTP ${res.status} when asked for a token`);
    const data = await res.json();
    if (!data.access_token) throw new Error("Reddit sent no token; check the app id in Settings");
    token = { value: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
    return token.value;
  }

  async function search(q, { limit = 25, time = "year" } = {}) {
    const bearer = await accessToken();
    const url = new URL("/search", apiBase);
    url.searchParams.set("q", `${String(q).slice(0, 200)} (${REDDIT_SUBS.map((s) => `subreddit:${s}`).join(" OR ")})`);
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("t", time);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("raw_json", "1");
    const res = await fetchImpl(url, { headers: { Authorization: `bearer ${bearer}`, "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (res.status === 429) throw new Error("Reddit is rate limiting; try again in a minute");
    if (!res.ok) throw new Error(`Reddit replied HTTP ${res.status}`);
    const data = await res.json();
    return (data.data?.children ?? []).map((c) => post(c.data));
  }

  // Posts that talk about one model, by its plain name in quotes.
  async function forModel(id) {
    return search(`"${plainName(id)}"`, { limit: 15, time: "all" });
  }

  return { search, forModel, configured: () => Boolean(clientId) };
}

function post(p) {
  const text = String(p.selftext ?? "").replace(/\s+/g, " ").trim();
  return {
    title: String(p.title ?? ""),
    subreddit: p.subreddit ?? "",
    score: p.score ?? 0,
    comments: p.num_comments ?? 0,
    url: `https://www.reddit.com${p.permalink ?? ""}`,
    created: p.created_utc ? new Date(p.created_utc * 1000).toISOString() : null,
    excerpt: text.length > 300 ? text.slice(0, 300).replace(/\s+\S*$/, "") + "…" : text,
  };
}
