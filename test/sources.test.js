import assert from "node:assert/strict";
import { test } from "node:test";
import { SAME_MODEL, createCivitai, createGithub, createHackerNews, createLemmy, createReddit, createYoutube, htmlExcerpt, matchKnown, nameWords, plainName, similarity } from "../src/sources.js";

test("plainName drops the author and file suffixes", () => {
  assert.equal(plainName("bartowski/Llama-3.2-3B-Instruct-GGUF"), "Llama 3.2 3B Instruct");
  assert.equal(plainName("second-state/stable-diffusion-v1-5-GGUF"), "stable diffusion v1 5");
  assert.equal(plainName("x/model-Q4_K_M.gguf"), "model");
});

test("similarity tells the same model from a namesake", () => {
  assert.ok(similarity("pony realism v23 sdxl", "Pony Realism") >= SAME_MODEL);
  assert.ok(similarity("wai nsfw illustrious sdxl v150 sdxl", "WAI-illustrious-SDXL") >= SAME_MODEL, "a dropped word is still the same model");
  assert.ok(similarity("cyberrealistic v41backtobasics", "CyberRealistic") >= SAME_MODEL);
  assert.ok(similarity("stable diffusion v1 5", "Stable-Diffusion-XL-Anime-Final") < SAME_MODEL, "a generic prefix is not a match");
  assert.ok(similarity("pony realism", "Indecent (Realism for Pony)") < SAME_MODEL, "an added word makes a different model");
  assert.ok(similarity("sdxl lightning", "Lightning Fusion XL") < SAME_MODEL);
  assert.ok(similarity("stable diffusion", "Stable-Diffusion-XL-Kawaii") < SAME_MODEL, "a name inside a much longer one is a different model");
  assert.ok(similarity("cyberrealistic", "CyberRealistic XL") >= SAME_MODEL, "a short variant suffix is the same family");
  assert.equal(similarity("", "x"), 0);
  assert.deepEqual(nameWords("SDXL Lightning v2 checkpoint"), ["lightning"]);
});

test("matchKnown finds the repositories a post names", () => {
  const ids = ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", "bartowski/Llama-3.2-3B-Instruct-GGUF", "x/ab"];
  assert.deepEqual(matchKnown("Tried Qwen2.5 Coder 7B Instruct today", ids), ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"]);
  assert.deepEqual(matchKnown("nothing here", ids), []);
});

test("htmlExcerpt flattens Civitai descriptions", () => {
  assert.equal(htmlExcerpt("<p>Hello <b>there</b> &amp; welcome</p>"), "Hello there & welcome");
  assert.ok(htmlExcerpt("<p>" + "word ".repeat(200) + "</p>", 50).length <= 51);
});

test("Civitai search maps items and forModel keeps only close checkpoints", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const items = [
      { id: 1, name: "Pony Realism", type: "Checkpoint", nsfw: true, stats: { thumbsUpCount: 32000, thumbsDownCount: 10, commentCount: 5, downloadCount: 900000 }, tags: ["realistic"], creator: { username: "ann" }, description: "<p>Photo real.</p>", modelVersions: [{ name: "v2.3" }] },
      { id: 2, name: "Pony Realism Slider", type: "LORA", stats: {}, tags: [] },
      { id: 3, name: "Indecent (Realism for Pony)", type: "Checkpoint", stats: { thumbsUpCount: 2400 }, tags: [] },
    ];
    return { ok: true, status: 200, json: async () => ({ items }) };
  };
  const civ = createCivitai({ fetchImpl, base: "http://stub" });
  const all = await civ.search("pony realism");
  assert.equal(all.length, 3);
  assert.equal(all[0].url, "https://civitai.com/models/1");
  assert.equal(all[0].thumbsUp, 32000);
  assert.equal(all[0].description, "Photo real.");
  assert.ok(calls[0].includes("query=pony+realism") && calls[0].includes("nsfw=true"));
  const mine = await civ.forModel("John6666/pony-realism-v23-sdxl");
  assert.deepEqual(mine.map((m) => m.name), ["Pony Realism"], "the LoRA and the namesake are left out");
  assert.equal(mine[0].match, 1);
  const failing = createCivitai({ fetchImpl: async () => ({ ok: false, status: 503 }), base: "http://stub" });
  await assert.rejects(failing.search("x"), /HTTP 503/);
});

test("Reddit needs an app id, fetches a token once and searches the model communities", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/api/v1/access_token")) return { ok: true, status: 200, json: async () => ({ access_token: "tok", expires_in: 3600 }) };
    return { ok: true, status: 200, json: async () => ({ data: { children: [{ data: { title: "Best model for roleplay?", subreddit: "LocalLLaMA", score: 120, num_comments: 40, permalink: "/r/LocalLLaMA/comments/1/x/", created_utc: 1700000000, selftext: "I tried  Llama 3.2 3B and\nit was fine." } }] } }) };
  };
  const off = createReddit({ fetchImpl, clientId: "" });
  assert.equal(off.configured(), false);
  await assert.rejects(off.search("x"), /app id/);
  const on = createReddit({ fetchImpl, clientId: "abc123def456", authBase: "http://auth", apiBase: "http://api" });
  const posts = await on.search("roleplay");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://www.reddit.com/r/LocalLLaMA/comments/1/x/");
  assert.equal(posts[0].excerpt, "I tried Llama 3.2 3B and it was fine.");
  assert.equal(posts[0].created, "2023-11-14T22:13:20.000Z");
  await on.forModel("bartowski/Llama-3.2-3B-Instruct-GGUF");
  const tokenCalls = calls.filter((c) => c.url.endsWith("/api/v1/access_token"));
  assert.equal(tokenCalls.length, 1, "the token is reused");
  assert.match(tokenCalls[0].init.headers.Authorization, /^Basic /);
  assert.match(tokenCalls[0].init.body, /installed_client/);
  const searches = calls.filter((c) => c.url.startsWith("http://api/search"));
  assert.equal(searches.length, 2);
  assert.ok(decodeURIComponent(searches[0].url).includes("subreddit:LocalLLaMA"));
  assert.ok(decodeURIComponent(searches[1].url).replace(/\+/g, " ").includes('"Llama 3.2 3B Instruct"'));
  assert.equal(searches[0].init.headers.Authorization, "bearer tok");
  const rejected = createReddit({ fetchImpl: async () => ({ ok: false, status: 401 }), clientId: "abc123def456" });
  await assert.rejects(rejected.search("x"), /rejected the app id/);
});

const ok = (body) => ({ ok: true, status: 200, json: async () => body });

test("GitHub issues are searched across the runner projects and rate limits are explained", async () => {
  const calls = [];
  const gh = createGithub({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return ok({ items: [{ title: "Llama 3.2 3B outputs garbage", repository_url: "https://api.github.com/repos/ollama/ollama", state: "closed", comments: 9, html_url: "https://github.com/ollama/ollama/issues/1", created_at: "2025-01-01T00:00:00Z", body: "After   updating\nit works." }] }); }, base: "http://stub" });
  const items = await gh.search("llama");
  assert.equal(items[0].repo, "ollama/ollama");
  assert.equal(items[0].kind, "issue");
  assert.equal(items[0].excerpt, "After updating it works.");
  assert.ok(decodeURIComponent(calls[0].url).includes("repo:ggml-org/llama.cpp"));
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const withToken = createGithub({ fetchImpl: async (url, init) => { calls.push({ url: String(url), init }); return ok({ items: [] }); }, base: "http://stub", token: "ghp_abcdefghijklmnopqrstuvwxyz" });
  await withToken.forModel("bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer ghp_abcdefghijklmnopqrstuvwxyz");
  assert.ok(decodeURIComponent(calls.at(-1).url).replace(/\+/g, " ").includes('"Llama 3.2 3B Instruct"'));
  await assert.rejects(createGithub({ fetchImpl: async () => ({ ok: false, status: 403 }), base: "http://stub" }).search("x"), /ten searches a minute/);
});

test("Hacker News stories and comments are both kept, with a link to the item", async () => {
  const hn = createHackerNews({ fetchImpl: async () => ok({ hits: [{ title: "Show HN: SDXL Lightning demo", points: 444, num_comments: 104, objectID: "1" }, { comment_text: "I run <i>Llama 3.2 3B</i> daily.", story_title: "Local models", points: 12, objectID: "2" }] }), base: "http://stub" });
  const hits = await hn.search("x");
  assert.equal(hits[0].kind, "story");
  assert.equal(hits[0].url, "https://news.ycombinator.com/item?id=1");
  assert.equal(hits[1].kind, "comment");
  assert.equal(hits[1].title, "Comment on: Local models");
  assert.equal(hits[1].excerpt, "I run <i>Llama 3.2 3B</i> daily.");
});

test("Lemmy posts are kept only from the model communities", async () => {
  const lemmy = createLemmy({ fetchImpl: async () => ok({ posts: [
    { post: { name: "Best local model?", ap_id: "https://lemmy.world/post/1", body: "asking" }, community: { name: "localllama", actor_id: "https://sh.itjust.works/c/localllama" }, counts: { score: 40, comments: 12 } },
    { post: { name: "Cat pictures", ap_id: "https://lemmy.world/post/2" }, community: { name: "cats", actor_id: "https://lemmy.world/c/cats" }, counts: { score: 400, comments: 1 } },
  ] }), base: "http://stub" });
  const posts = await lemmy.search("x");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].community, "localllama@sh.itjust.works");
  assert.equal(posts[0].score, 40);
});

test("YouTube needs a key, adds view counts, and per-model keeps only videos naming the model", async () => {
  const off = createYoutube({ fetchImpl: async () => ok({}), base: "http://stub" });
  assert.equal(off.configured(), false);
  await assert.rejects(off.search("x"), /API key/);
  const yt = createYoutube({ fetchImpl: async (url) => {
    if (String(url).includes("/youtube/v3/videos")) return ok({ items: [{ id: "a1", statistics: { viewCount: "12345" } }, { id: "b2", statistics: { viewCount: "7" } }] });
    return ok({ items: [
      { id: { videoId: "a1" }, snippet: { title: "Llama 3.2 3B Instruct on a laptop", channelTitle: "Cam", publishedAt: "2025-02-02T00:00:00Z", description: "Testing it" } },
      { id: { videoId: "b2" }, snippet: { title: "Some other model", channelTitle: "Dee", publishedAt: "2025-02-02T00:00:00Z", description: "" } },
    ] });
  }, base: "http://stub", key: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ" });
  const all = await yt.search("llama");
  assert.equal(all.length, 2);
  assert.equal(all[0].views, 12345);
  assert.equal(all[0].url, "https://www.youtube.com/watch?v=a1");
  const mine = await yt.forModel("bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.deepEqual(mine.map((v) => v.id), ["a1"]);
  await assert.rejects(createYoutube({ fetchImpl: async () => ({ ok: false, status: 403 }), base: "http://stub", key: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ" }).search("x"), /quota|not allowed/);
});

test("Civitai image posts carry the prompt and the reactions", async () => {
  const civ = createCivitai({ fetchImpl: async (url) => {
    assert.ok(String(url).includes("modelVersionId=42"));
    return ok({ items: [{ id: 9, username: "pat", nsfw: true, stats: { likeCount: 10, heartCount: 5, commentCount: 2 }, meta: { prompt: "a  portrait,\nsoft light" } }, { id: 10, stats: {}, meta: {} }] });
  }, base: "http://stub" });
  const posts = await civ.images(42);
  assert.equal(posts.length, 1, "posts without a prompt are dropped");
  assert.equal(posts[0].prompt, "a portrait, soft light");
  assert.equal(posts[0].reactions, 15);
  assert.equal(posts[0].url, "https://civitai.com/images/9");
});
