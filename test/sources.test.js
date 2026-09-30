import assert from "node:assert/strict";
import { test } from "node:test";
import { SAME_MODEL, createCivitai, createReddit, htmlExcerpt, matchKnown, nameWords, plainName, similarity } from "../src/sources.js";

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
