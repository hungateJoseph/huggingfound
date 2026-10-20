import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { civitaiFiles, createLoraFinder, CIVITAI_DOWNLOAD } from "../src/loras.js";
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
    { id: 11, name: "Better Human Motion", nsfw: false, type: "LORA", creator: { username: "mover" }, stats: { downloadCount: 15000, thumbsUpCount: 300 }, modelVersions: [{ id: 101, name: "v1", baseModel: "MiniMax H3", trainedWords: ["mvmt"], files: [{ id: 1001, name: "mvmt h3 lora v1.safetensors", type: "Model", sizeKB: 300 * 1024, metadata: { fp: "bf16" }, downloadUrl: dl(101, 1001) }, { id: 1002, name: "examples.zip", type: "Archive", sizeKB: 900, downloadUrl: dl(101, 1002) }] }] },
    // Marked for adults: never listed.
    { id: 12, name: "Something else", nsfw: true, type: "LORA", stats: {}, modelVersions: [{ id: 102, files: [{ id: 1003, name: "x.safetensors", type: "Model", sizeKB: 1000, downloadUrl: dl(102, 1003) }] }] },
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
    res.writeHead(200, { "Content-Type": "application/json" });
    const type = url.searchParams.get("types");
    const right = url.searchParams.getAll("baseModels").includes("MiniMax H3") && url.searchParams.get("nsfw") === "false";
    res.end(JSON.stringify({ items: right ? CIVITAI[type] ?? [] : [] }));
  });
  await new Promise((r) => civitai.listen(0, "127.0.0.1", r));
  const home = process.env.HUGGINGFOUND_HOME;
  const dead = "http://127.0.0.1:1";
  server = createServer({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: hub.base, civitaiBase: `http://127.0.0.1:${civitai.address().port}`, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, idleWatch: false, runpodBase: dead });
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
