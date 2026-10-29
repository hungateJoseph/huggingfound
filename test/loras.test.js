import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { civitaiFiles, civitaiRecipe, createLoraFinder, CIVITAI_DOWNLOAD, creatorNotes, hubRecipe, parseLink, sampleSettings } from "../src/loras.js";
import { pullAddonOnAgent } from "../src/runners.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-loras-"));
const { createServer } = await import("../src/server.js");

// LoRAs and fine-tunes for a video model: found on Hugging Face (by the
// base model the repository names) and on Civitai (by the base model it is
// filed under), each Civitai file named plainly for the machine, the
// fine-tune's best precision first and 4-bit packs marked unreadable.

const dl = (version, file) => `https://civitai.com/api/download/models/${version}?fileId=${file}`;
const CIVITAI = {
  LORA: [
    { id: 11, name: "Better Human Motion", nsfw: false, type: "LORA", creator: { username: "mover" }, stats: { downloadCount: 15000, thumbsUpCount: 300 }, description: "<p>Smoother motion. <strong>Prompt in H3 style</strong>: subject, then the action.</p>", modelVersions: [{ id: 101, name: "v1", baseModel: "MiniMax H3", trainedWords: ["mvmt"], description: "<p>I recommend using strength 0.7, works great with and without turbo loras.</p><p>Thanks all!</p>", files: [{ id: 1001, name: "mvmt h3 lora v1.safetensors", type: "Model", sizeKB: 300 * 1024, metadata: { fp: "bf16" }, downloadUrl: dl(101, 1001) }, { id: 1002, name: "examples.zip", type: "Archive", sizeKB: 900, downloadUrl: dl(101, 1002) }], images: [
      // The showcase: a clip with its workflow kept (this LoRA at 0.75 beside a turbo one, on a fine-tune), an adult one, a plain one, and one with no prompt.
      { url: "https://image.civitai.com/x/a/original=true/9001.mp4", nsfwLevel: 1, type: "video", width: 832, height: 480, metadata: { duration: 5.04 }, meta: { prompt: "mvmt, a woman walks across a bridge", steps: 30, cfgScale: 5, sampler: "Euler", comfy: JSON.stringify({ prompt: { 1: { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "mvmt h3 lora v1.safetensors", strength_model: 0.75, model: ["2", 0] } }, 2: { class_type: "UNETLoader", inputs: { unet_name: "MiniMaxH3/dasiwa_hybrid_int8.safetensors" } }, 3: { class_type: "LoraLoaderModelOnly", inputs: { lora_name: "h3_turbo_4step.safetensors", strength_model: 1 } }, 4: { class_type: "KSampler", inputs: { steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } }, 5: { class_type: "EmptyHunyuanLatentVideo", inputs: { width: 832, height: 480, length: 121 } } } }) } },
      { url: "https://image.civitai.com/x/b/original=true/9002.mp4", nsfwLevel: 8, type: "video", width: 832, height: 480, meta: { prompt: "mvmt, explicit" } },
      { url: "https://image.civitai.com/x/c/original=true/9003.mp4", nsfwLevel: 1, type: "video", width: 480, height: 832, meta: { prompt: "mvmt, a man runs up a hill", steps: 30, cfgScale: 5 } },
      { url: "https://image.civitai.com/x/d/original=true/9004.mp4", nsfwLevel: 1, type: "video", meta: {} },
    ] }] },
    // Marked for adults: listed only when adult listings are asked for.
    { id: 2925727, name: "MiniMax H3 NSFW Unlocked", nsfw: true, type: "LORA", creator: { username: "lab" }, stats: { downloadCount: 5000 }, modelVersions: [{ id: 3413468, name: "Minimax_H3_V2.1", baseModel: "MiniMax H3", files: [{ id: 3305979, name: "Minimax_H3_Unlocked_V2.1.safetensors", type: "Model", sizeKB: 0.28 * 1024 * 1024, metadata: { fp: "fp32" }, downloadUrl: dl(3413468, 3305979) }] }, { id: 3354822, name: "Minimax_H3_V2", baseModel: "MiniMax H3", files: [{ id: 3242253, name: "Minimax_H3_Unlocked_V2.safetensors", type: "Model", sizeKB: 0.28 * 1024 * 1024, metadata: { fp: "fp32" }, downloadUrl: dl(3354822, 3242253) }] }] },
    // Made for another model.
    { id: 13, name: "A Wan LoRA", nsfw: false, type: "LORA", stats: {}, modelVersions: [{ id: 103, baseModel: "Wan Video 2.2 TI2V-5B", files: [{ id: 1004, name: "w.safetensors", type: "Model", sizeKB: 1000, downloadUrl: dl(103, 1004) }] }] },
  ],
  Checkpoint: [
    { id: 2877206, name: "DaSiWa MiniMax H3", nsfw: false, type: "Checkpoint", creator: { username: "darksidewalker" }, stats: { downloadCount: 61413, thumbsUpCount: 900 }, modelVersions: [{ id: 3391862, name: "DaSiWa Hybrid v4", baseModel: "MiniMax H3", files: [
      { id: 3281517, name: "DasiwaMinimaxH3_dasiwaHybridV4_int4a.safetensors", type: "Model", sizeKB: 11.68 * 1024 * 1024, metadata: { fp: "int4" }, downloadUrl: dl(3391862, 3281517) },
      { id: 3281578, name: "DasiwaMinimaxH3_dasiwaHybridV4_int8.safetensors", type: "Model", sizeKB: 19.53 * 1024 * 1024, metadata: { fp: "int8" }, downloadUrl: dl(3391862, 3281578) },
      { id: 3281599, name: "minimax_h3_video_vae_fp16.safetensors", type: "Model", sizeKB: 4.85 * 1024 * 1024, metadata: { fp: "fp16" }, downloadUrl: dl(3391862, 3281599) },
    ] }] },
  ],
};

let hub;
let civitai;
let server;
let base;
const asked = [];

before(async () => {
  hub = await startStubHub();
  civitai = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    asked.push(url.search);
    const ver = /^\/api\/v1\/model-versions\/(\d+)$/.exec(url.pathname);
    if (ver) {
      const v = [...CIVITAI.LORA, ...CIVITAI.Checkpoint].flatMap((m) => m.modelVersions).find((x) => String(x.id) === ver[1]);
      res.writeHead(v ? 200 : 404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(v ?? { error: "not found" }));
    }
    if (url.pathname === "/api/v1/images") {
      res.writeHead(200, { "Content-Type": "application/json" });
      const posts = url.searchParams.get("modelVersionId") === "101" && url.searchParams.get("username") === "mover" ? [{ id: 9003, stats: { likeCount: 10, heartCount: 5, laughCount: 0, cryCount: 0 } }, { id: 9001, stats: { likeCount: 2 } }] : [];
      return res.end(JSON.stringify({ items: posts }));
    }
    // One model by its number, as a pasted link reads it.
    const one = /^\/api\/v1\/models\/(\d+)$/.exec(url.pathname);
    if (one) {
      const m = [...CIVITAI.LORA, ...CIVITAI.Checkpoint].find((x) => String(x.id) === one[1]);
      res.writeHead(m ? 200 : 404, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(m ?? { error: "not found" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    const type = url.searchParams.get("types");
    const adult = url.searchParams.get("nsfw") === "true";
    const items = (CIVITAI[type] ?? []).filter((m) => (adult || !m.nsfw) && m.modelVersions[0].baseModel === "MiniMax H3");
    res.end(JSON.stringify({ items: url.searchParams.getAll("baseModels").includes("MiniMax H3") ? items : [] }));
  });
  await new Promise((r) => civitai.listen(0, "127.0.0.1", r));
  const home = process.env.HUGGINGFOUND_HOME;
  const dead = "http://127.0.0.1:1";
  server = createServer({ adult: true, envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: hub.base, civitaiBase: `http://127.0.0.1:${civitai.address().port}`, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, idleWatch: false, runpodBase: dead });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  hub.server.close();
  civitai.close();
  server.close();
});

test("a Civitai model's files: plain names for the machine, the fine-tune's int8 first, 4-bit packs and decoders left out of use", () => {
  const ft = civitaiFiles(CIVITAI.Checkpoint[0], "finetune");
  assert.deepEqual(ft.map((f) => [f.file, f.fp, Boolean(f.unreadable)]), [["v3391862_f3281578.safetensors", "int8", false], ["v3391862_f3281517.safetensors", "int4", true]], "the decoder is not a fine-tune; the 4-bit file comes last, marked");
  assert.equal(ft[0].gb, 19.53);
  assert.equal(ft[0].url, dl(3391862, 3281578));
  const lo = civitaiFiles(CIVITAI.LORA[0], "lora");
  assert.deepEqual(lo.map((f) => [f.file, f.label, f.kind, f.trigger]), [["v101_f1001.safetensors", "mvmt h3 lora v1.safetensors", "lora", ["mvmt"]]], "the archive is not a weights file");
  assert.ok(CIVITAI_DOWNLOAD.test(dl(1, 2)));
  assert.ok(!CIVITAI_DOWNLOAD.test("https://evil.example/api/download/models/1"));
});

test("the finder asks Hugging Face by base model and Civitai by the name it files the base under, safe for work only", async () => {
  const finder = createLoraFinder({ hubBase: hub.base, civitaiBase: `http://127.0.0.1:${civitai.address().port}` });
  const mm = await finder.find("MiniMaxAI/MiniMax-H3");
  assert.equal(mm.civitaiKnown, true);
  assert.deepEqual(mm.items.filter((i) => i.source === "civitai").map((i) => [i.id, i.kind, i.name]), [["civitai/11", "lora", "Better Human Motion"], ["civitai/2877206", "finetune", "DaSiWa MiniMax H3"]], "the adult-marked one is not listed");
  assert.ok(asked.every((q) => !/types=/.test(q) || /nsfw=false/.test(q)), "safe for work unless asked");
  const adult = await finder.find("MiniMaxAI/MiniMax-H3", { adult: true });
  assert.deepEqual(adult.items.filter((i) => i.adult).map((i) => i.id), ["civitai/2925727"], "asked for, the adult one comes, marked");
  assert.equal(adult.adult, true);
  assert.ok(asked.some((q) => /types=LORA/.test(q)) && asked.some((q) => /types=Checkpoint/.test(q)));
  const wan = await finder.find("Wan-AI/Wan2.2-TI2V-5B-Diffusers");
  assert.equal(wan.civitaiKnown, false, "Civitai is asked only for the bases it has a name for");
  assert.deepEqual(wan.items.map((i) => [i.source, i.id, i.kind]), [["hf", "motionlab/Wan-TI2V-Motion-LoRA", "lora"]]);
  const files = await finder.hubFiles("motionlab/Wan-TI2V-Motion-LoRA");
  assert.deepEqual(files.map((f) => [f.file, f.kind]), [["wan_motion_v1.safetensors", "lora"]]);
});

test("the site's finder routes, and a download from Civitai needs the person's Civitai key and a Civitai address", async () => {
  const found = await (await fetch(`${base}/api/loras?id=MiniMaxAI/MiniMax-H3`)).json();
  assert.ok(found.items.some((i) => i.id === "civitai/2877206"));
  assert.equal((await fetch(`${base}/api/loras?id=bad`)).status, 400);
  const files = await (await fetch(`${base}/api/loras/files?id=motionlab/Wan-TI2V-Motion-LoRA`)).json();
  assert.equal(files.files[0].file, "wan_motion_v1.safetensors");
  assert.equal((await fetch(`${base}/api/loras/files?id=civitai/2877206`)).status, 400, "a Civitai model's files come with the listing");
  const file = "v3391862_f3281578.safetensors";
  assert.throws(() => pullAddonOnAgent("civitai/2877206", [file], fetch, "http://agent", { sources: { [file]: dl(3391862, 3281578) } }), /add your Civitai API token in Settings/);
  assert.throws(() => pullAddonOnAgent("civitai/2877206", [file], fetch, "http://agent", { sources: { [file]: "https://evil.example/x" }, civitaiToken: "k" }), /Civitai download address only/);
  assert.throws(() => pullAddonOnAgent("civitai/2877206", [file], fetch, "http://agent", { sources: { "other.safetensors": dl(1, 2) }, civitaiToken: "k" }), /Civitai download address only/);
  // The key is a setting like the others, shown back masked.
  assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ CIVITAI_TOKEN: "short" }) })).status, 400);
  assert.equal((await fetch(`${base}/api/settings`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ CIVITAI_TOKEN: "0123456789abcdef0123456789abcdef" }) })).status, 200);
  const s = await (await fetch(`${base}/api/state`)).json();
  assert.match(s.civitaiToken, /\*/);
  assert.ok(!s.civitaiToken.includes("0123456789abcdef0123456789abcdef"));
});

test("a pasted link: a PromptHero model page reads as the Civitai model it copies, a Civitai page as its model or the version it names, a Hugging Face repository as itself", async () => {
  assert.deepEqual(parseLink("https://prompthero.com/ai-models/minimax-h3-nsfw-unlocked-2925727-download"), { source: "civitai", id: "2925727", version: null, via: "prompthero" });
  assert.deepEqual(parseLink("https://civitai.red/models/2877206?modelVersionId=3391862"), { source: "civitai", id: "2877206", version: "3391862", via: "civitai" });
  assert.deepEqual(parseLink("https://huggingface.co/motionlab/Wan-TI2V-Motion-LoRA/tree/main"), { source: "hf", id: "motionlab/Wan-TI2V-Motion-LoRA", via: "huggingface" });
  for (const bad of ["https://prompthero.com/prompt/abc", "https://evil.example/models/1", "https://huggingface.co/models?x=1", "nonsense"]) assert.equal(parseLink(bad), null, bad);
  const finder = createLoraFinder({ hubBase: hub.base, civitaiBase: `http://127.0.0.1:${civitai.address().port}` });
  const ph = await finder.fromLink("MiniMaxAI/MiniMax-H3", "https://prompthero.com/ai-models/minimax-h3-nsfw-unlocked-2925727-download");
  assert.deepEqual([ph.id, ph.kind, ph.adult, ph.via, ph.files.map((f) => f.file)], ["civitai/2925727", "lora", true, "prompthero", ["v3413468_f3305979.safetensors"]], "the newest version");
  const older = await finder.fromLink("MiniMaxAI/MiniMax-H3", "https://civitai.com/models/2925727?modelVersionId=3354822");
  assert.deepEqual(older.files.map((f) => f.file), ["v3354822_f3242253.safetensors"], "the version the link names");
  await assert.rejects(finder.fromLink("Wan-AI/Wan2.2-TI2V-5B-Diffusers", "https://prompthero.com/ai-models/minimax-h3-nsfw-unlocked-2925727-download"), /was made for MiniMax H3, not Wan2\.2-TI2V-5B-Diffusers/);
  await assert.rejects(finder.fromLink("MiniMaxAI/MiniMax-H3", "https://civitai.com/models/13"), /was made for Wan Video 2\.2 TI2V-5B, not MiniMax-H3/);
  await assert.rejects(finder.fromLink("MiniMaxAI/MiniMax-H3", "https://prompthero.com/ai-models/gone-99999-download"), /Civitai has no model 99999 \(the number in the PromptHero link\)/);
  const hf = await finder.fromLink("Wan-AI/Wan2.2-TI2V-5B-Diffusers", "https://huggingface.co/motionlab/Wan-TI2V-Motion-LoRA");
  assert.deepEqual([hf.id, hf.kind, hf.files.map((f) => f.file)], ["motionlab/Wan-TI2V-Motion-LoRA", "lora", ["wan_motion_v1.safetensors"]]);
  // Through the site.
  const res = await fetch(`${base}/api/loras/link?base=MiniMaxAI/MiniMax-H3&url=${encodeURIComponent("https://prompthero.com/ai-models/minimax-h3-nsfw-unlocked-2925727-download")}`);
  assert.equal((await res.json()).item.id, "civitai/2925727");
  const bad = await fetch(`${base}/api/loras/link?base=MiniMaxAI/MiniMax-H3&url=nonsense`);
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /paste a PromptHero model page, a Civitai model page or a Hugging Face repository/);
});


test("the creator's recipe: notes and the strength in them, showcase clips with their prompts and workflow settings, the most liked first, adult ones only when asked; and a model card read the same way", async () => {
  const notes = creatorNotes("Use it at 0.5 - 0.9 strength. Thanks all! Steps 8 and cfg 1 with the turbo LoRA.");
  assert.deepEqual(notes.strength, { low: 0.5, high: 0.9, from: "notes", text: "0.5 - 0.9 strength" });
  assert.deepEqual(notes.tips, ["Use it at 0.5 - 0.9 strength.", "Steps 8 and cfg 1 with the turbo LoRA."], "only the sentences with something to act on");
  assert.equal(creatorNotes("strength 7 is wrong").strength, null, "not a LoRA strength");
  const own = sampleSettings({ prompt: "x", civitaiResources: [{ type: "lora", modelVersionId: 101, weight: 0.6 }, { type: "lora", modelVersionId: 5, modelName: "Turbo", versionName: "4step", weight: 1 }, { type: "checkpoint", modelName: "DaSiWa", versionName: "v4" }], Size: "832x480" }, { versionId: 101 });
  assert.deepEqual([own.strength, own.with, own.checkpoint, own.width, own.height], [0.6, [{ name: "Turbo 4step", strength: 1 }], "DaSiWa v4", 832, 480]);
  const m = CIVITAI.LORA[0];
  const stats = new Map([["9003", 15], ["9001", 2]]);
  const r = civitaiRecipe(m, m.modelVersions[0], { stats });
  assert.equal(r.id, "civitai/11");
  assert.deepEqual(r.strength, { low: 0.7, high: 0.7, from: "notes", text: "strength 0.7" });
  assert.deepEqual(r.trigger, ["mvmt"]);
  assert.ok(r.tips.includes("I recommend using strength 0.7, works great with and without turbo loras.") && r.tips.includes("Prompt in H3 style : subject, then the action.") && !r.tips.includes("Thanks all!"), JSON.stringify(r.tips));
  assert.deepEqual(r.samples.map((s) => [s.id, s.reactions, s.prompt]), [["9003", 15, "mvmt, a man runs up a hill"], ["9001", 2, "mvmt, a woman walks across a bridge"]], "the most liked first; the adult one and the one with no prompt left out");
  assert.equal(r.hidden, 1);
  const s1 = r.samples[1];
  assert.deepEqual([s1.steps, s1.cfg, s1.sampler, s1.strength, s1.with, s1.checkpoint, s1.width, s1.height, s1.frames, s1.seconds], [30, 5, "Euler", 0.75, [{ name: "h3_turbo_4step.safetensors", strength: 1 }], "dasiwa_hybrid_int8.safetensors", 832, 480, 121, 5.04], "the plain fields first, the workflow for the rest");
  assert.deepEqual(r.settings, { steps: 30, cfg: 5 });
  const adult = civitaiRecipe(m, m.modelVersions[0], { stats, adult: true });
  assert.deepEqual(adult.samples.map((s) => s.id), ["9003", "9001", "9002"]);
  assert.equal(adult.hidden, 0);
  // Through the finder and the site: the version on the machine, the creator's posts' reactions joined in.
  const finder = createLoraFinder({ hubBase: hub.base, civitaiBase: `http://127.0.0.1:${civitai.address().port}` });
  const viaFinder = await finder.recipe("MiniMaxAI/MiniMax-H3", { id: "civitai/11", version: "101" });
  assert.deepEqual(viaFinder.samples.map((s) => [s.id, s.reactions]), [["9003", 15], ["9001", 2]]);
  assert.ok(asked.some((q) => /modelVersionId=101&username=mover/.test(q)), "the creator's own posts");
  const res = await fetch(`${base}/api/loras/recipe?base=MiniMaxAI/MiniMax-H3&id=civitai/11&version=101`);
  assert.equal((await res.json()).name, "Better Human Motion");
  assert.equal((await fetch(`${base}/api/loras/recipe?base=MiniMaxAI/MiniMax-H3&id=nonsense`)).status, 400);
  assert.equal((await fetch(`${base}/api/loras/recipe?base=MiniMaxAI/MiniMax-H3&id=civitai/999`)).status, 502);
  // A Hugging Face model card: the trigger word and example from the front
  // matter, the settings table as advice, the clip's address on the hub.
  const card = await finder.recipe("Wan-AI/Wan2.2-TI2V-5B-Diffusers", { id: "motionlab/Wan-TI2V-Motion-LoRA" });
  assert.deepEqual([card.source, card.creator, card.trigger, card.settings, card.strength?.low], ["hf", "motionlab", ["mvmt"], { steps: 30, cfg: 1 }, 0.8]);
  assert.deepEqual(card.samples.map((s) => [s.prompt, s.url, s.type]), [["mvmt, a dancer spins across a sunlit studio floor, slow dolly in", `${hub.base}/motionlab/Wan-TI2V-Motion-LoRA/resolve/main/samples/spin.mp4`, "video"]], "the install command is not a prompt");
  assert.ok(card.tips.includes("Works best at 0.7 to 0.9 strength; above 1.0 limbs smear.") && card.tips.includes("steps: 30."), JSON.stringify(card.tips));
  assert.ok(!card.notesText.includes("pip install"), "code blocks are not notes");
  const bare = hubRecipe("x/y", "# Nothing here\n\nA LoRA.");
  assert.deepEqual([bare.tips, bare.samples, bare.strength, bare.settings], [[], [], null, null]);
  const empty = await finder.recipe("Wan-AI/Wan2.2-TI2V-5B-Diffusers", { id: "nobody/no-card" });
  assert.deepEqual(empty.samples, [], "a repository without a card reads as an empty recipe");
});
