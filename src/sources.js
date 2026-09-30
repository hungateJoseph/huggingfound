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

  // The pictures people post under a model version, with the prompts they
  // used and how many reactions they got: what the model is used for, in
  // users' own words.
  async function images(versionId, { limit = 8 } = {}) {
    const url = new URL("/api/v1/images", base);
    url.searchParams.set("modelVersionId", String(versionId));
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("sort", "Most Reactions");
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Civitai replied HTTP ${res.status}`);
    const data = await res.json();
    return (data.items ?? [])
      .map((i) => {
        const st = i.stats ?? {};
        return {
          prompt: String(i.meta?.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 240),
          reactions: (st.likeCount ?? 0) + (st.heartCount ?? 0) + (st.laughCount ?? 0) + (st.cryCount ?? 0),
          comments: st.commentCount ?? 0,
          user: i.username ?? "",
          nsfw: Boolean(i.nsfw),
          url: `https://civitai.com/images/${i.id}`,
        };
      })
      .filter((i) => i.prompt);
  }

  return { search, forModel, images };
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
    versionIds: (m.modelVersions ?? []).slice(0, 3).map((v) => v.id),
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

// ---- GitHub issues -------------------------------------------------------------

// The projects whose issue trackers carry "does model X work" reports.
export const GITHUB_REPOS = ["ggml-org/llama.cpp", "ollama/ollama", "leejet/stable-diffusion.cpp", "ggml-org/whisper.cpp", "SillyTavern/SillyTavern", "comfyanonymous/ComfyUI", "AUTOMATIC1111/stable-diffusion-webui", "oobabooga/text-generation-webui", "lllyasviel/Fooocus", "lmstudio-ai/lmstudio-bug-tracker"];

export function createGithub({ fetchImpl = fetch, base = "https://api.github.com", token = "" } = {}) {
  async function search(q, { limit = 15 } = {}) {
    const url = new URL("/search/issues", base);
    url.searchParams.set("q", `${String(q).slice(0, 150)} ${GITHUB_REPOS.map((r) => `repo:${r}`).join(" ")}`);
    url.searchParams.set("per_page", String(limit));
    const headers = { "User-Agent": UA, Accept: "application/vnd.github+json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15000) });
    if (res.status === 403 || res.status === 429) throw new Error(token ? "GitHub is rate limiting; try again in a minute" : "GitHub allows ten searches a minute without a token; wait a minute, or add a token in Settings");
    if (res.status === 401) throw new Error("GitHub rejected the token; check it in Settings");
    if (!res.ok) throw new Error(`GitHub replied HTTP ${res.status}`);
    const data = await res.json();
    return (data.items ?? []).map((i) => ({
      title: String(i.title ?? ""),
      repo: String(i.repository_url ?? "").split("/").slice(-2).join("/"),
      kind: i.pull_request ? "pull request" : "issue",
      state: i.state ?? "open",
      comments: i.comments ?? 0,
      url: i.html_url ?? "",
      created: i.created_at ?? null,
      excerpt: excerpt(i.body, 300),
    }));
  }
  async function forModel(id) {
    return search(`"${plainName(id)}"`, { limit: 10 });
  }
  return { search, forModel, configured: () => true };
}

// ---- Hacker News -------------------------------------------------------------

export function createHackerNews({ fetchImpl = fetch, base = "https://hn.algolia.com" } = {}) {
  async function search(q, { limit = 15 } = {}) {
    const url = new URL("/api/v1/search", base);
    url.searchParams.set("query", String(q).slice(0, 150));
    url.searchParams.set("tags", "(story,comment)");
    url.searchParams.set("hitsPerPage", String(limit));
    const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Hacker News replied HTTP ${res.status}`);
    const data = await res.json();
    return (data.hits ?? []).map((h) => {
      const comment = !h.title;
      const text = excerpt(h.comment_text ?? h.story_text ?? "", 300);
      return {
        title: comment ? `Comment on: ${h.story_title ?? "a story"}` : String(h.title),
        kind: comment ? "comment" : "story",
        points: h.points ?? 0,
        comments: h.num_comments ?? 0,
        url: `https://news.ycombinator.com/item?id=${h.objectID}`,
        created: h.created_at ?? null,
        excerpt: text,
      };
    });
  }
  async function forModel(id) {
    return search(`"${plainName(id)}"`, { limit: 10 });
  }
  return { search, forModel, configured: () => true };
}

// ---- Lemmy ---------------------------------------------------------------------

export const LEMMY_COMMUNITIES = new Set(["localllama", "fosai", "stable_diffusion", "stable_diffusion_art", "imageai", "selfhosted", "machinelearning", "artificial_intelligence", "opensource", "technology", "ai_", "aigen"]);

export function createLemmy({ fetchImpl = fetch, base = "https://lemmy.world" } = {}) {
  async function search(q, { limit = 25 } = {}) {
    const url = new URL("/api/v3/search", base);
    url.searchParams.set("q", String(q).slice(0, 150));
    url.searchParams.set("type_", "Posts");
    url.searchParams.set("sort", "TopAll");
    url.searchParams.set("limit", String(limit));
    const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Lemmy replied HTTP ${res.status}`);
    const data = await res.json();
    return (data.posts ?? [])
      .filter((p) => LEMMY_COMMUNITIES.has(String(p.community?.name ?? "").toLowerCase()))
      .map((p) => ({
        title: String(p.post?.name ?? ""),
        community: `${p.community?.name ?? ""}@${String(p.community?.actor_id ?? "").split("/")[2] ?? ""}`,
        score: p.counts?.score ?? 0,
        comments: p.counts?.comments ?? 0,
        url: p.post?.ap_id ?? "",
        created: p.post?.published ?? null,
        excerpt: excerpt(p.post?.body, 300),
      }));
  }
  async function forModel(id) {
    return search(`"${plainName(id)}"`, { limit: 20 });
  }
  return { search, forModel, configured: () => true };
}

// ---- YouTube -------------------------------------------------------------------

export function createYoutube({ fetchImpl = fetch, base = "https://www.googleapis.com", key = "" } = {}) {
  async function search(q, { limit = 10 } = {}) {
    if (!key) throw new Error("YouTube needs an API key; add one in Settings");
    const url = new URL("/youtube/v3/search", base);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("q", String(q).slice(0, 150));
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", String(limit));
    url.searchParams.set("key", key);
    const res = await fetchImpl(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (res.status === 403) throw new Error("YouTube refused: the key is not allowed to use the Data API, or today's quota is used up");
    if (res.status === 400) throw new Error("YouTube rejected the API key; check it in Settings");
    if (!res.ok) throw new Error(`YouTube replied HTTP ${res.status}`);
    const data = await res.json();
    const videos = (data.items ?? []).filter((i) => i.id?.videoId).map((i) => ({
      id: i.id.videoId,
      title: String(i.snippet?.title ?? ""),
      channel: String(i.snippet?.channelTitle ?? ""),
      published: i.snippet?.publishedAt ?? null,
      url: `https://www.youtube.com/watch?v=${i.id.videoId}`,
      excerpt: excerpt(i.snippet?.description, 200),
      views: null,
    }));
    if (videos.length) {
      const stats = new URL("/youtube/v3/videos", base);
      stats.searchParams.set("part", "statistics");
      stats.searchParams.set("id", videos.map((v) => v.id).join(","));
      stats.searchParams.set("key", key);
      const sres = await fetchImpl(stats, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (sres.ok) {
        const sdata = await sres.json();
        const views = new Map((sdata.items ?? []).map((v) => [v.id, Number(v.statistics?.viewCount ?? 0)]));
        for (const v of videos) v.views = views.get(v.id) ?? null;
      }
    }
    return videos;
  }
  // Videos whose title or description names the model.
  async function forModel(id) {
    const name = plainName(id);
    const key = normalize(name);
    const videos = await search(`${name} review`, { limit: 10 });
    return key.length >= 6 ? videos.filter((v) => normalize(`${v.title} ${v.excerpt}`).includes(key)) : videos;
  }
  return { search, forModel, configured: () => Boolean(key) };
}

function excerpt(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
}
