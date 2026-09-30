import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { MODELS, startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-server-"));
const { createServer } = await import("../src/server.js");
const { MODELS_DIR, OUTPUT_DIR } = await import("../src/runners.js");
import http from "node:http";

// A stand-in sd-server: reports one loaded model and answers txt2img with a 1 by 1 PNG.
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// Stand-ins for Civitai and Reddit.
function startStubWeb() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/api/v1/models") {
      const q = (url.searchParams.get("query") ?? "").toLowerCase();
      const items = [
        { id: 11, name: "Pony Realism", type: "Checkpoint", nsfw: true, stats: { thumbsUpCount: 32000, thumbsDownCount: 10, commentCount: 5, downloadCount: 900000 }, tags: ["realistic"], creator: { username: "ann" }, description: "<p>Photo real people, great for roleplay scenes.</p>", modelVersions: [{ id: 1101, name: "v2.3" }] },
        { id: 12, name: "Roleplay Faces", type: "LORA", stats: { thumbsUpCount: 50 }, tags: [] },
      ].filter((m) => m.name.toLowerCase().includes(q.split(" ")[0]) || m.description?.toLowerCase().includes(q.split(" ")[0]));
      return res.end(JSON.stringify({ items }));
    }
    if (url.pathname === "/api/v1/models/11" || url.pathname === "/api/v1/images") return res.end(JSON.stringify({ items: [{ id: 501, username: "pat", nsfw: true, stats: { likeCount: 30, heartCount: 2, commentCount: 1 }, meta: { prompt: "photo of a woman in a garden, roleplay costume" } }] }));
    if (url.pathname === "/search/issues") return res.end(JSON.stringify({ items: [{ title: "Qwen2.5 Coder 7B Instruct stops mid answer", repository_url: "https://api.github.com/repos/ollama/ollama", state: "open", comments: 3, html_url: "https://github.com/ollama/ollama/issues/9", created_at: "2025-01-01T00:00:00Z", body: "roleplay prompts too" }] }));
    if (url.pathname === "/api/v1/search") return res.end(JSON.stringify({ hits: [{ title: "Roleplay with local models", points: 50, num_comments: 20, objectID: "77" }] }));
    if (url.pathname === "/api/v3/search") return res.end(JSON.stringify({ posts: [{ post: { name: "Roleplay model thread", ap_id: "https://lemmy.world/post/5", body: "" }, community: { name: "localllama", actor_id: "https://sh.itjust.works/c/localllama" }, counts: { score: 9, comments: 4 } }] }));
    if (url.pathname === "/youtube/v3/search") return res.end(JSON.stringify({ items: [{ id: { videoId: "v1" }, snippet: { title: "Qwen2.5 Coder 7B Instruct review", channelTitle: "Cam", publishedAt: "2025-02-02T00:00:00Z", description: "" } }] }));
    if (url.pathname === "/youtube/v3/videos") return res.end(JSON.stringify({ items: [{ id: "v1", statistics: { viewCount: "999" } }] }));
    if (url.pathname === "/api/v1/access_token") return res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    if (url.pathname === "/search") {
      if (req.headers.authorization !== "bearer tok") {
        res.statusCode = 401;
        return res.end("{}");
      }
      return res.end(JSON.stringify({ data: { children: [{ data: { title: "Qwen2.5 Coder 7B Instruct is my roleplay coding buddy", subreddit: "LocalLLaMA", score: 88, num_comments: 12, permalink: "/r/LocalLLaMA/comments/2/y/", created_utc: 1700000000, selftext: "" } }] } }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` })));
}

function startStubImageServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ path: req.url, body: body ? JSON.parse(body) : null });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/sdapi/v1/sd-models") return res.end(JSON.stringify([{ title: "sdxl_lightning_4step.safetensors", model_name: "sdxl_lightning_4step" }]));
      if (req.url === "/sdcpp/v1/img_gen") {
        res.statusCode = 202;
        return res.end(JSON.stringify({ id: "job_1", kind: "img_gen", status: "queued", created: 1, poll_url: "/sdcpp/v1/jobs/job_1" }));
      }
      if (req.url === "/sdcpp/v1/jobs/job_1") return res.end(JSON.stringify({ id: "job_1", kind: "img_gen", status: "completed", queue_position: 0, result: { output_format: "png", images: [{ index: 0, b64_json: ONE_PIXEL_PNG }] }, error: null }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, requests })));
}

let stub;
let server;
let base;
let envFile;
let scanFile;

let web;
before(async () => {
  stub = await startStubHub();
  web = await startStubWeb();
  envFile = path.join(process.env.HUGGINGFOUND_HOME, ".env");
  scanFile = path.join(process.env.HUGGINGFOUND_HOME, "scan.json");
  server = createServer({ envFile, scanFile, hubBase: stub.base, civitaiBase: web.url, redditAuthBase: web.url, redditApiBase: web.url, githubBase: web.url, hnBase: web.url, lemmyBase: web.url, youtubeBase: web.url, writtenSummaries: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
  web.server.close();
});

const get = (p) => fetch(base + p);
const post = (p, body, headers = {}) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("serves the page and the starting state", async () => {
  const page = await get("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /HuggingFound/);
  const s = await (await get("/api/state")).json();
  assert.ok(s.machine.ramGb > 0);
  assert.equal(s.categories.length, 9);
  assert.ok(s.picks.every((p) => typeof p.speed === "string" && p.speed.length > 0));
  assert.equal(s.scan, null);
  assert.equal(s.summarizer, null, "written summaries are off in the test server");
  assert.equal(s.token, "");
  assert.ok(s.picks.length >= 6);
  assert.ok(!s.envFile.startsWith(os.homedir()) || s.envFile.startsWith("~"));
});

test("static files stay inside the public folder", async () => {
  assert.equal((await get("/style.css")).status, 200);
  assert.equal((await get("/../package.json")).status, 404);
  assert.equal((await get("/%2e%2e/package.json")).status, 404);
});

test("api calls from another origin are refused", async () => {
  const res = await fetch(base + "/api/state", { headers: { Origin: "https://evil.example" } });
  assert.equal(res.status, 403);
});

test("a scan is saved, and the next scan marks what is new", async () => {
  const first = await (await post("/api/scan", {})).json();
  assert.equal(first.models.length, MODELS.length);
  assert.ok(first.models.every((m) => m.isNew === false));
  assert.ok(fs.existsSync(scanFile));

  const later = await startStubHub({ extraModels: [{ id: "new/Thing-GGUF", pipeline_tag: "text-generation", tags: ["gguf"], downloads: 1, likes: 1, createdAt: "2026-09-29T00:00:00.000Z" }] });
  const s2 = createServer({ envFile, scanFile, hubBase: later.base });
  await new Promise((resolve) => s2.listen(0, "127.0.0.1", resolve));
  try {
    const second = await (await fetch(`http://127.0.0.1:${s2.address().port}/api/scan`, { method: "POST" })).json();
    assert.equal(second.models.filter((m) => m.isNew).map((m) => m.id).join(), "new/Thing-GGUF");
    const meta = (await (await get("/api/state")).json()).scan;
    assert.equal(meta.count, MODELS.length + 1);
    assert.equal(meta.newCount, 1);
    const saved = await (await get("/api/models")).json();
    assert.equal(saved.models.length, MODELS.length + 1);
  } finally {
    s2.close();
    later.server.close();
  }
});

test("scan results carry a rough speed line and an adult flag", async () => {
  const { models } = await (await get("/api/models")).json();
  const llama = models.find((m) => m.id === "bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.match(llama.speed, /words a second/);
  assert.equal(llama.adult, false);
  const cydonia = models.find((m) => m.id === "TheDrummer/Cydonia-24B-v2-GGUF");
  assert.equal(cydonia.adult, true);
  assert.ok(cydonia.categories.includes("nsfw-writing"));
  const python = models.find((m) => m.id === "meta-llama/Llama-3.1-8B-Instruct");
  assert.equal(python.speed, "");
});

test("the trait search asks the hub and returns summarized, speed-tagged models", async () => {
  const found = await (await get("/api/search?q=coder")).json();
  assert.equal(found.q, "coder");
  assert.deepEqual(found.models.map((m) => m.id), ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"]);
  assert.ok(found.models[0].categories.includes("coding"));
  assert.match(found.models[0].speed, /words a second/);
  assert.equal((await get("/api/search?q=%20")).status, 400);
});

test("a measured time replaces the guess after a real run", async () => {
  const { recordTiming } = await import("../src/runners.js");
  recordTiming("second-state/stable-diffusion-v1-5-GGUF/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf", { kind: "image", seconds: 139 });
  const { plan } = await (await get("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).json();
  assert.match(plan.speed.text, /per 512 by 512 image/);
  assert.equal(plan.measured, "Measured here: 2.3 minutes per image");
});

test("model details come with a plan for this machine", async () => {
  const { model, plan } = await (await get("/api/model?id=bartowski/Llama-3.2-3B-Instruct-GGUF")).json();
  assert.equal(model.files.length, 4);
  assert.equal(plan.runnable, true);
  assert.equal(plan.steps.at(-1).kind, "pull-model");
  assert.equal(plan.file.name, "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.equal((await get("/api/model?id=nope")).status, 400);
});

test("a curated pick keeps its named file and runner", async () => {
  const { plan } = await (await get("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).json();
  assert.equal(plan.runner, "sd");
  assert.equal(plan.file.name, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf");
});

test("a gated model is blocked without a token and opens with one", async () => {
  const blocked = await (await get("/api/model?id=meta-llama/Llama-3.1-8B-Instruct")).json();
  assert.equal(blocked.plan.gated, true);
  assert.equal(blocked.plan.runnable, false);

  assert.equal((await post("/api/settings", { HF_TOKEN: "hf_abcdefghijklmnopqrstuvwxyz" })).status, 200);
  assert.equal((await (await get("/api/state")).json()).token, "hf_a************wxyz");
  assert.match(fs.readFileSync(envFile, "utf8"), /^HF_TOKEN=hf_abcdefghijklmnopqrstuvwxyz$/m);

  const s3 = createServer({ envFile, scanFile, hubBase: stub.base });
  await new Promise((resolve) => s3.listen(0, "127.0.0.1", resolve));
  try {
    const open = await (await fetch(`http://127.0.0.1:${s3.address().port}/api/model?id=meta-llama/Llama-3.1-8B-Instruct`)).json();
    assert.equal(open.model.gated, true);
    assert.equal(open.plan.gated, undefined);
    assert.match(open.plan.reason, /Python/);
  } finally {
    s3.close();
  }
  assert.equal((await post("/api/settings", { HF_TOKEN: 5 })).status, 400);
  assert.equal((await post("/api/settings", { HF_TOKEN: "" })).status, 200);
  assert.equal((await (await get("/api/state")).json()).token, "");
});

test("a download step streams progress and lands in the models folder", async () => {
  const { id } = await (await post("/api/run", { kind: "download-file", args: { repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" } })).json();
  const events = await readEvents(`${base}/api/runs/${id}`);
  assert.equal(events.at(-1).status, "done");
  assert.ok(events.some((e) => /Downloading/.test(e.line ?? "")));
  assert.ok(events.some((e) => /100% of/.test(e.line ?? "")));
  const dest = path.join(MODELS_DIR, "bartowski", "Llama-3.2-3B-Instruct-GGUF", "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.equal(fs.statSync(dest).size, 64 * 1024);
  assert.ok(!fs.existsSync(`${dest}.part`));

  const { plan } = await (await get("/api/model?id=bartowski/Llama-3.2-3B-Instruct-GGUF")).json();
  assert.ok(plan.steps.some((s) => s.kind === "pull-model"));
});

test("storage lists the download and remove deletes it", async () => {
  const before = await (await get("/api/storage")).json();
  const row = before.files.find((f) => f.file === "Llama-3.2-3B-Instruct-Q4_K_M.gguf");
  assert.ok(row);
  assert.ok(before.totalGb > 0);
  assert.ok(before.disk.freeGb > 0 && before.disk.totalGb >= before.disk.freeGb, "free and total space on the drive");
  assert.equal(typeof before.outputs, "number");

  const res = await post("/api/remove", { kind: "file", repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" });
  assert.equal(res.status, 200);
  const after = await res.json();
  assert.ok(!after.files.some((f) => f.file === "Llama-3.2-3B-Instruct-Q4_K_M.gguf"));
  assert.ok(!fs.existsSync(path.join(MODELS_DIR, "bartowski")));

  assert.equal((await post("/api/remove", { kind: "file", repo: "bartowski/Llama-3.2-3B-Instruct-GGUF", file: "Llama-3.2-3B-Instruct-Q4_K_M.gguf" })).status, 400);
  assert.equal((await post("/api/remove", { kind: "file", repo: "../x", file: "y" })).status, 400);
  assert.equal((await post("/api/remove", { kind: "nonsense" })).status, 400);
});

test("generated pictures and uploads count as space and can be cleared", async () => {
  fs.writeFileSync(path.join(OUTPUT_DIR, "image-1.png"), Buffer.alloc(2 * 1024 * 1024));
  const before = await (await get("/api/storage")).json();
  assert.ok(before.outputs >= 2 / 1024);
  const after = await (await post("/api/remove", { kind: "outputs" })).json();
  assert.ok(after.outputs < 1e-6);
  assert.ok(!fs.existsSync(path.join(OUTPUT_DIR, "image-1.png")));
});

test("the image server setting is validated, checked, used for pictures and cleared", async () => {
  assert.equal((await post("/api/settings", { IMAGE_SERVER: "ftp://nope" })).status, 400);
  assert.equal((await post("/api/settings", { IMAGE_SERVER: "box:1234" })).status, 400);
  assert.equal((await post("/api/settings", {})).status, 400);
  const off = await (await get("/api/image-server")).json();
  assert.deepEqual(off, { configured: "", ok: false });

  const stubImages = await startStubImageServer();
  try {
    assert.equal((await post("/api/settings", { IMAGE_SERVER: stubImages.url + "/" })).status, 200);
    assert.equal((await (await get("/api/state")).json()).imageServer, stubImages.url);
    const check = await (await get("/api/image-server")).json();
    assert.equal(check.ok, true);
    assert.equal(check.model, "sdxl_lightning_4step");

    const { plan } = await (await get("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).json();
    assert.deepEqual(plan.steps, [], "nothing to download when a server makes the pictures");
    assert.equal(plan.tryWith.remote, stubImages.url);
    assert.match(plan.speed.text, /sdxl_lightning_4step loaded/);

    const { id } = await (await post("/api/run", { kind: "generate-image", args: { repo: "second-state/stable-diffusion-v1-5-GGUF", file: "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf", prompt: "a cat", negative: "dog", quality: "fast", remote: "http://evil.example" } })).json();
    const events = await readEvents(`${base}/api/runs/${id}`);
    assert.equal(events.at(-1).status, "done", JSON.stringify(events));
    const sent = stubImages.requests.find((r) => r.path === "/sdcpp/v1/img_gen");
    assert.ok(sent, "the configured server got the request, not the address in the page's arguments");
    assert.equal(sent.body.prompt, "a cat");
    assert.equal(sent.body.negative_prompt, "dog");
    assert.equal(sent.body.sample_params.sample_steps, 12);
    assert.equal(sent.body.sample_params.sample_method, "dpm++2m");
    assert.equal(sent.body.vae_tiling_params.enabled, true);
    const png = fs.readFileSync(path.join(OUTPUT_DIR, events.at(-1).result));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
  } finally {
    stubImages.server.close();
  }
  assert.equal((await post("/api/settings", { IMAGE_SERVER: "" })).status, 200);
  assert.equal((await (await get("/api/state")).json()).imageServer, "");
  const { plan: local } = await (await get("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).json();
  assert.equal(local.steps.length, 2);
  assert.deepEqual(Object.keys(local.qualities), ["fast", "default", "max"]);
});

test("gathering what people say indexes the scan, and searches and cards use it", async () => {
  const { id } = await (await post("/api/voices/gather", { ids: ["not/scanned"] })).json();
  const events = await readEvents(`${base}/api/runs/${id}`);
  assert.equal(events.at(-1).status, "done", JSON.stringify(events));
  assert.ok(events.some((e) => /have community discussions/.test(e.line ?? "")));
  const index = JSON.parse(fs.readFileSync(path.join(process.env.HUGGINGFOUND_HOME, "voices.json"), "utf8"));
  assert.ok(index["bartowski/Llama-3.2-3B-Instruct-GGUF"].discussions.length === 2);
  assert.ok(index["not/scanned"], "ids the page passes along are gathered too");

  const found = await (await get("/api/voices/search?q=roleplay")).json();
  assert.deepEqual(found.hits.map((h) => h.id), ["bartowski/Llama-3.2-3B-Instruct-GGUF"]);
  assert.equal(found.hits[0].snippet.text, "Works well for roleplay and story writing");
  const rust = await (await get("/api/voices/search?q=rust%20coding")).json();
  assert.deepEqual(rust.hits.map((h) => h.id), ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"]);
  assert.deepEqual((await (await get("/api/voices/search?q=hentai")).json()).hits, []);

  assert.ok(events.some((e) => /lifted from the text for \d+ model/.test(e.line ?? "")));
  const { models } = await (await get("/api/models")).json();
  const llama = models.find((m) => m.id === "bartowski/Llama-3.2-3B-Instruct-GGUF");
  assert.equal(llama.voice.text, "Works well for roleplay and story writing");
  assert.equal(llama.talked, 2);
  assert.ok(llama.summary.short.length >= 1, "every gathered model carries a summary");
  assert.ok(llama.summary.short.some((l) => /roleplay/.test(l)));
  assert.equal(llama.summary.by, "extract");
  assert.equal((await post("/api/runs/999/cancel", {})).status, 404);
  const state = await (await get("/api/state")).json();
  assert.ok(state.voices.count >= MODELS.length);

  // Civitai answers without a key; Reddit waits for an app id, then answers.
  const web1 = await (await get("/api/voices/search?q=roleplay")).json();
  assert.equal(web1.civitai.length, 2);
  assert.equal(web1.civitai[0].name, "Pony Realism");
  assert.deepEqual(web1.civitai[0].matched, [], "no scanned model carries that name");
  assert.equal(web1.redditConfigured, false);
  assert.deepEqual(web1.reddit, []);
  assert.equal(typeof web1.took, "number");
  assert.equal(web1.github.length, 1);
  assert.deepEqual(web1.github[0].matched, ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"], "the issue names a scanned model");
  assert.equal(web1.hn[0].url, "https://news.ycombinator.com/item?id=77");
  assert.equal(web1.lemmy[0].community, "localllama@sh.itjust.works");
  assert.equal(web1.youtubeConfigured, false);
  assert.deepEqual(web1.youtube, []);
  assert.equal((await post("/api/settings", { YOUTUBE_API_KEY: "short" })).status, 400);
  assert.equal((await post("/api/settings", { YOUTUBE_API_KEY: "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ", GITHUB_TOKEN: "ghp_abcdefghijklmnopqrstuvwxyz" })).status, 200);
  const st = await (await get("/api/state")).json();
  assert.match(st.youtubeKey, /^AIza\*+WXYZ$/);
  assert.match(st.githubToken, /^ghp_\*+wxyz$/);
  const web1b = await (await get("/api/voices/search?q=roleplay")).json();
  assert.equal(web1b.youtube.length, 1);
  assert.equal(web1b.youtube[0].views, 999);
  assert.equal((await post("/api/settings", { REDDIT_CLIENT_ID: "not an id!" })).status, 400);
  assert.equal((await post("/api/settings", { REDDIT_CLIENT_ID: "abc123def456ghi" })).status, 200);
  assert.equal((await (await get("/api/state")).json()).redditApp, "abc1*******6ghi");
  const web2 = await (await get("/api/voices/search?q=roleplay")).json();
  assert.equal(web2.redditConfigured, true);
  assert.equal(web2.reddit.length, 1);
  assert.deepEqual(web2.reddit[0].matched, ["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"], "the post names a scanned model");
  const perModel = await (await get("/api/voices/web?id=bartowski/Qwen2.5-Coder-7B-Instruct-GGUF")).json();
  assert.equal(perModel.reddit.length, 1);
  assert.deepEqual(perModel.civitai, [], "a chat model is not looked up on Civitai");
  assert.equal(perModel.github.length, 1);
  assert.equal(perModel.hn.length, 1);
  assert.equal(perModel.lemmy.length, 1);
  assert.equal(perModel.youtube.length, 1, "the video names the model");
  assert.equal(typeof perModel.took, "number");
  const imageModel = await (await get("/api/voices/web?id=John6666/pony-realism-v23-sdxl&images=1")).json();
  assert.equal(imageModel.civitai[0].name, "Pony Realism");
  assert.equal(imageModel.civitai[0].thumbsUp, 32000);
  assert.equal(imageModel.civitaiPrompts.length, 1, "prompts posted under the matching page");
  assert.match(imageModel.civitaiPrompts[0].prompt, /garden/);
  const cached = JSON.parse(fs.readFileSync(path.join(process.env.HUGGINGFOUND_HOME, "voices.json"), "utf8"));
  assert.ok(cached["John6666/pony-realism-v23-sdxl"].web.data.civitai.length === 1, "off-Hub answers are cached");
  const again = await (await get("/api/voices/web?id=John6666/pony-realism-v23-sdxl&images=1")).json();
  assert.equal(again.cached, true);
  assert.equal((await post("/api/settings", { REDDIT_CLIENT_ID: "", YOUTUBE_API_KEY: "", GITHUB_TOKEN: "" })).status, 200);

  const detail = await (await get("/api/voices?id=bartowski/Llama-3.2-3B-Instruct-GGUF")).json();
  assert.match(detail.card, /great for quick answers/);
  assert.equal(detail.discussions[0].url, "https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/discussions/3");
  assert.equal(detail.discussions[0].comments_text[0].author, "sam");
  assert.match(detail.discussions[0].comments_text[0].text, /keeps characters straight/);
  assert.ok(detail.summary.long.some((l) => /keeps characters straight/.test(l)), "the comments feed the summary once fetched");
  assert.equal((await get("/api/voices?id=bad")).status, 400);
});

test("a diffusers repository downloads its parts into one folder and can be removed as one", async () => {
  const id = "John6666/pony-realism-v23-sdxl";
  const before = await (await get(`/api/model?id=${id}`)).json();
  assert.equal(before.plan.runnable, true);
  const step = before.plan.steps.find((s) => s.kind === "download-files");
  assert.equal(step.done, false);
  const { id: runId } = await (await post("/api/run", { kind: step.kind, args: step.args })).json();
  const events = await readEvents(`${base}/api/runs/${runId}`);
  assert.equal(events.at(-1).status, "done");
  assert.ok(events.some((e) => /File 1 of 4/.test(e.line ?? "")));
  assert.ok(events.some((e) => /Merging unet/.test(e.line ?? "")));
  const repoDir = path.join(MODELS_DIR, "John6666", "pony-realism-v23-sdxl");
  assert.ok(fs.existsSync(path.join(repoDir, "pony-realism-v23-sdxl.safetensors")), "the merged checkpoint exists");
  assert.ok(!fs.existsSync(path.join(repoDir, "unet")), "the parts are gone once merged");

  const after = await (await get(`/api/model?id=${id}`)).json();
  assert.equal(after.plan.steps.find((s) => s.kind === "download-files").done, true);
  assert.equal(after.plan.tryWith.file, "pony-realism-v23-sdxl.safetensors");
  const st = await (await get("/api/storage")).json();
  assert.ok(st.files.some((f) => f.repo === id && f.file === "pony-realism-v23-sdxl.safetensors"));

  const res = await post("/api/remove", { kind: "folder", repo: id });
  assert.equal(res.status, 200);
  assert.ok(!fs.existsSync(path.join(MODELS_DIR, "John6666")));
});

test("a run that fails says so on the stream", async () => {
  const { id } = await (await post("/api/run", { kind: "download-file", args: { repo: "nobody/missing", file: "x.gguf" } })).json();
  const events = await readEvents(`${base}/api/runs/${id}`);
  assert.equal(events.at(-1).status, "failed");
  assert.ok(events.some((e) => /HTTP 404/.test(e.line ?? "")));
});

test("bad or unknown steps are refused before anything runs", async () => {
  assert.equal((await post("/api/run", { kind: "pull-model", args: { name: "x && echo hi" } })).status, 400);
  assert.equal((await post("/api/run", { kind: "nonsense" })).status, 400);
  assert.equal((await get("/api/runs/999")).status, 404);
});

test("uploads land in the upload folder and results are read back", async () => {
  const res = await fetch(base + "/api/upload", { method: "POST", headers: { "x-filename": "my clip.wav" }, body: Buffer.from("RIFF") });
  const { path: saved } = await res.json();
  assert.match(saved, /my_clip\.wav$/);
  assert.ok(fs.existsSync(saved));
  assert.equal((await get("/api/result?file=missing.txt")).status, 404);
  assert.equal((await get("/output/../package.json")).status, 404);
});

async function readEvents(url) {
  const text = await (await fetch(url)).text();
  return text.split("\n\n").filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));
}
