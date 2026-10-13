import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { startStubAgent } from "./stub-agent.js";
import { startStubOllama } from "./stub-ollama.js";
import { GPUS, KEY, startStubRunpod } from "./stub-runpod.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-rent-"));
const { createServer } = await import("../src/server.js");
const { createRental, GPU_IMAGE, TIERS, tierFor } = await import("../src/rent.js");
const { readEnv, writeEnv } = await import("../src/envfile.js");

// Renting a GPU by the hour: HuggingFound asks RunPod for a machine with
// Ollama on it, makes it the chat server, watches it start, stops it when
// idle or on request, and deletes it. The stub RunPod moves a pod along one
// state per poll; the stub Ollama plays the machine's Ollama behind the
// proxy address.

let stub;
let runpod;
let ollama;
let agent;
let server;
let base;
const home = process.env.HUGGINGFOUND_HOME;
const envFile = path.join(home, ".env");
const dead = "http://127.0.0.1:1";
const QWEN = "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF";
const PULLED = `hf.co/${QWEN}:Q4_K_M`;

before(async () => {
  stub = await startStubHub();
  runpod = await startStubRunpod();
  ollama = await startStubOllama();
  agent = await startStubAgent();
  server = createServer({ envFile, scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => ollama.url, runpodAgent: () => agent.url, runpodImageCheck: async () => !process.env.HF_TEST_NO_IMAGE, runpodStatusTtl: 0, idleWatch: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
  runpod.server.close();
  ollama.server.close();
  agent.server.close();
});

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (p) => (await get(p)).json();

test("the sizes on offer match the fit thresholds, and a file picks its size", () => {
  assert.deepEqual(TIERS.map((t) => t.gb), [24, 48, 80, 141, 282, 564]);
  assert.equal(tierFor(4.7).gb, 24);
  assert.equal(tierFor(19.7).gb, 48, "a 20 GB file is tight on 24 GB, so the next size up");
  assert.equal(tierFor(40).gb, 80);
  assert.equal(tierFor(130).gb, 282, "beyond one card: two in a machine");
  assert.equal(tierFor(500), null, "beyond anything on offer");
  assert.equal(tierFor(0), null);
});

test("without a key nothing can be rented, and the page is told so", async () => {
  const s = await json("/api/state");
  assert.deepEqual(s.rental, { rented: false });
  assert.equal(s.runpodKey, "");
  assert.equal(s.rentTiers.length, 6);
  assert.equal(s.stopOnQuit, true);
  const options = await json("/api/rent/options");
  assert.equal(options.configured, false);
  assert.equal(options.tiers[0].gpu, null);
  const res = await post("/api/rent", { gb: 24 });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /RunPod API key/);
  assert.equal((await post("/api/settings", { RUNPOD_API_KEY: "short" })).status, 400);
  assert.equal((await post("/api/settings", { RUNPOD_IDLE_MINUTES: -5 })).status, 400);
});

test("with a key, each size names the cheapest card that is actually free", async () => {
  assert.equal((await post("/api/settings", { RUNPOD_API_KEY: KEY })).status, 200);
  assert.match((await json("/api/state")).runpodKey, /^rpa_\*+cdef$/);
  const { configured, tiers } = await json("/api/rent/options");
  assert.equal(configured, true);
  const by = Object.fromEntries(tiers.map((t) => [t.gb, t]));
  assert.equal(by[24].gpu.name, "RTX 4090", "the cheaper A5000 has no capacity, and the cheaper 5090 and V100 are cards the image server is not built for");
  assert.equal(by[80].gpu.name, "A100 PCIe", "the cheaper RTX PRO 6000 is Blackwell, which the image server is not built for");
  assert.equal(by[24].pricePerHour, 0.44);
  assert.equal(by[24].available, true);
  assert.equal(by[48].gpu.name, "A40");
  assert.equal(by[80].gpu.name, "A100 PCIe", "LOW availability still counts as free");
  assert.equal(by[141].gpu.name, "H200 SXM");
  assert.equal(by[141].available, false, "listed but none free");
  // Several cards in one machine, for models no single card holds: the same card, priced per card.
  assert.deepEqual([by[282].count, by[282].label, by[282].gpu.name, by[282].pricePerHour], [2, "2 × 141 GB GPUs", "H200 SXM", by[141].pricePerHour * 2]);
  assert.deepEqual([by[564].count, by[564].label, by[564].files], [4, "4 × 141 GB GPUs", 400]);
  assert.ok(!tiers.some((t) => t.gpu?.name === "MI300X"), "cards outside the secure cloud are left out");
  assert.equal(runpod.state.calls.filter((c) => c === "GET /catalog/gpus").length, 1);
  await json("/api/rent/options");
  assert.equal(runpod.state.calls.filter((c) => c === "GET /catalog/gpus").length, 1, "the offer is cached for a while");
});

test("renting makes a machine with Ollama on it and points the chat server at it", async () => {
  assert.equal((await post("/api/rent", { gb: 141 })).status, 503, "no 141 GB card is free");
  assert.equal((await post("/api/rent", { gb: 30 })).status, 400, "not a size on offer");
  assert.equal((await post("/api/rent", { gb: 48, diskGb: 5 })).status, 400, "disk too small");
  ollama.state.down = true;
  const res = await post("/api/rent", { gb: 48, diskGb: 60 });
  assert.equal(res.status, 200);
  const r = await res.json();
  assert.equal(r.rented, true);
  assert.equal(r.status, "PROVISIONING");
  assert.equal(r.ready, false);
  assert.equal(r.costPerHour, 0.4);
  assert.equal(r.gb, 48);
  assert.equal(r.diskGb, 60);
  assert.equal(r.url, ollama.url);
  assert.equal(r.idleMinutes, 30);
  const made = runpod.state.created[0];
  assert.equal(made.image, GPU_IMAGE, "Ollama plus the image agent");
  assert.equal(made.name, "huggingfound");
  assert.deepEqual(made.gpu, { id: "NVIDIA A40", count: 1, minCudaVersion: "12.4" }, "a host whose driver the compiled CUDA runtime accepts");
  assert.equal(made.cloud, "SECURE");
  assert.deepEqual(made.ports, ["11434/http", "7860/http"]);
  assert.equal(made.env.OLLAMA_HOST, "0.0.0.0");
  assert.match(made.env.OLLAMA_ORIGINS, /^http:\/\/127\.0\.0\.1:\d+,http:\/\/localhost:\d+$/, "the app's own page may call the machine");
  assert.equal(made.env.HF_ORIGINS, made.env.OLLAMA_ORIGINS);
  assert.deepEqual(made.mounts, { persistent: { size: 60, path: "/root/.ollama" } });
  const saved = readEnv(envFile);
  assert.equal(saved.RUNPOD_POD_ID, r.id);
  assert.equal(saved.OLLAMA_SERVER, ollama.url);
  assert.equal(saved.OLLAMA_SERVER_GB, "48");
  assert.equal(saved.GPU_AGENT, agent.url);
  assert.equal(r.agent, agent.url);
  const s = await json("/api/state");
  assert.deepEqual(s.chatServer, { url: ollama.url, agent: agent.url, gpuGb: 48, comfortableGb: 43, rented: true, direct: false });
  assert.equal(s.rental.id, r.id);
  assert.equal(s.rental.status, "PROVISIONING");
  assert.equal((await post("/api/rent", { gb: 24 })).status, 409, "one machine at a time");
});

test("while it starts, the plan says so; once Ollama answers it is ready", async () => {
  let { plan } = await json(`/api/model?id=${QWEN}`);
  assert.equal(plan.remote, ollama.url);
  assert.match(plan.steps[0].text, /rented GPU is still starting/);
  // Two polls: PROVISIONING to STARTING to RUNNING; Ollama is still down.
  await json("/api/rent");
  const running = await json("/api/rent");
  assert.equal(running.status, "RUNNING");
  assert.equal(running.ready, false);
  ({ plan } = await json(`/api/model?id=${QWEN}`));
  assert.match(plan.steps[0].text, /Ollama on it has not answered yet/);
  ollama.state.down = false;
  const ready = await json("/api/rent");
  assert.equal(ready.ready, true);
  assert.ok(ready.uptimeSeconds >= 900, "the stub adds a quarter of an hour per poll");
  assert.equal(ready.spent, Math.round(0.4 * (ready.uptimeSeconds / 3600) * 100) / 100, "0.4 an hour, for the time it has run");
  ({ plan } = await json(`/api/model?id=${QWEN}`));
  assert.equal(plan.steps[0].done, false);
  assert.doesNotMatch(plan.steps[0].text, /not answering|starting/);
});

test("a download waits for Ollama on a machine that is still starting, then runs there and loads the model afterwards", async () => {
  ollama.state.down = true;
  const res = await post("/api/run", { kind: "pull-model", args: { name: PULLED } });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  // The machine comes up a moment later; the run's log is a live stream that ends with the run.
  await new Promise((r) => setTimeout(r, 200));
  ollama.state.down = false;
  const log = await (await get(`/api/runs/${id}`)).text();
  assert.match(log, /Waiting for Ollama on the machine to start/);
  assert.match(log, /The machine is up\./);
  assert.match(log, /on the chat server/);
  assert.match(log, /Done\./);
  assert.deepEqual(ollama.state.pulls, [PULLED]);
  for (let i = 0; i < 20 && !ollama.state.loaded.length; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(ollama.state.loaded, [PULLED], "warmed so the first message is quick");
  const chat = await post("/api/chat", { model: PULLED, messages: [{ role: "user", content: "hi" }] });
  assert.match(await chat.text(), /from the server/);
});

test("an image model's plan on the rented GPU is one download, done by the machine, with pictures made there", async () => {
  const SD = "second-state/stable-diffusion-v1-5-GGUF";
  const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf";
  const { plan, choice } = await json(`/api/model?id=${SD}`);
  assert.deepEqual(choice, { where: "rented", rented: true, tier: 24, hasRunpodKey: true });
  assert.equal(plan.runnable, true);
  assert.equal(plan.remote, agent.url);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, "pull-image-model");
  assert.equal(plan.steps[0].done, false);
  assert.match(plan.steps[0].title, /on the rented GPU/);
  assert.match(plan.fit.text, /Fits the server's 48 GB GPU/);
  assert.deepEqual(plan.tryWith, { kind: "image", repo: SD, file: FILE, agent: agent.url });
  assert.deepEqual(plan.remove, [{ kind: "gpu-file", repo: SD, file: FILE }]);
  assert.equal(plan.qualities.default.steps, 20);
  assert.deepEqual([plan.qualities.default.size, plan.qualities.default.cfg, plan.qualities.default.sampler, plan.qualities.default.scheduler], [512, 7, "euler_a", "discrete"], "the presets carry the settings the machine needs");
  assert.equal(plan.qualities.fast.sampler, "dpm++2m");
  const local = await json(`/api/model?id=${SD}&where=local`);
  assert.equal(local.choice.where, "local");
  assert.ok(local.plan.steps.length >= 2);
  assert.equal(local.plan.remote, undefined);
  // A gated model cannot be fetched by the machine.
  const gated = await json("/api/model?id=black-forest-labs/FLUX.1-dev");
  assert.equal(gated.plan.runnable, false);
  // A folder-layout model is fetched in parts and merged on the machine into one checkpoint.
  const PONY = "John6666/pony-realism-v23-sdxl";
  const MERGED = "pony-realism-v23-sdxl.safetensors";
  const folder = (await json(`/api/model?id=${PONY}`)).plan;
  assert.equal(folder.runnable, true);
  assert.equal(folder.steps.length, 1);
  assert.equal(folder.steps[0].kind, "pull-image-folder");
  assert.match(folder.steps[0].title, /4 files on the rented GPU and merge them \(6\.5 GB\)/);
  assert.deepEqual(folder.steps[0].args.files.map((f) => f.to), ["unet/diffusion_pytorch_model.safetensors", "vae/diffusion_pytorch_model.safetensors", "text_encoder/model.safetensors", "text_encoder_2/model.safetensors"]);
  assert.equal(folder.steps[0].args.into, MERGED);
  assert.deepEqual(folder.tryWith, { kind: "image", repo: PONY, file: MERGED, agent: agent.url });
  assert.deepEqual(folder.remove, [{ kind: "gpu-file", repo: PONY, file: MERGED }]);
  const merged = await post("/api/run", { kind: "pull-image-folder", args: folder.steps[0].args, where: "rented" });
  assert.equal(merged.status, 200);
  const mergeLog = await (await get(`/api/runs/${(await merged.json()).id}`)).text();
  assert.match(mergeLog, /Downloading 4 files of John6666\/pony-realism-v23-sdxl on the rented GPU and merging them/);
  assert.match(mergeLog, /100% of 1\.30 GB \(unet\/diffusion_pytorch_model\.fp16\.safetensors\)/);
  assert.match(mergeLog, /merging the parts into one checkpoint/);
  assert.match(mergeLog, /Done\./);
  assert.equal(agent.state.downloads.at(-1).into, MERGED);
  assert.equal((await json(`/api/model?id=${PONY}`)).plan.steps[0].done, true, "the merged checkpoint on the machine counts as done");
  assert.equal((await post("/api/remove", { kind: "gpu-file", repo: PONY, file: MERGED })).status, 200);
  // The download runs on the machine with progress; afterwards the step is done, and the file can be removed there.
  const res = await post("/api/run", { kind: "pull-image-model", args: { repo: SD, file: FILE }, where: "rented" });
  assert.equal(res.status, 200);
  const log = await (await get(`/api/runs/${(await res.json()).id}`)).text();
  assert.match(log, /Downloading stable-diffusion-v1-5-pruned-emaonly-Q8_0\.gguf on the rented GPU/);
  assert.match(log, /50% of 1\.10 GB/);
  assert.match(log, /Done\./);
  assert.deepEqual(agent.state.downloads.filter((d) => d.file).map((d) => d.file), [FILE]);
  assert.equal((await json(`/api/model?id=${SD}`)).plan.steps[0].done, true);
  assert.equal((await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE })).status, 200);
  assert.deepEqual(agent.state.deleted.at(-1), `${SD}/${FILE}`);
  assert.equal((await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE })).status, 400, "gone already");
  // A machine still starting: the plan says so.
  agent.state.down = true;
  assert.match((await json(`/api/model?id=${SD}`)).plan.steps[0].text, /rented GPU is up but|still starting|stopped/);
  agent.state.down = false;
});

test("a diffusers-family model is fetched as a folder on the rented GPU, and a video family answers with a clip", async () => {
  const QWEN_IMAGE = "Qwen/Qwen-Image";
  const { plan, choice } = await json(`/api/model?id=${QWEN_IMAGE}`);
  assert.deepEqual(choice, { where: "rented", rented: true, tier: 80, hasRunpodKey: true, gpuOnly: true }, "rented only; 58 GB of weights load at 8 bits with room on an 80 GB card");
  assert.equal(plan.runnable, true);
  assert.equal(plan.steps[0].kind, "pull-image-repo");
  assert.match(plan.fit.text, /Loads at 8 bits on the server's 48 GB \(57\.6 GB in full precision\)/, "the fit follows the worker's ladder");
  assert.ok(!plan.steps[0].args.files.some((f) => /README|assets\//.test(f)), "no card or demo pictures");
  assert.ok(plan.steps[0].args.files.includes("transformer/diffusion_pytorch_model-00001-of-00002.safetensors"));
  assert.match(plan.steps[0].title, /files on the rented GPU \(57\.6 GB\)/);
  assert.deepEqual(plan.tryWith, { kind: "image", repo: QWEN_IMAGE, file: "model_index.json", agent: agent.url, engine: "diffusers" });
  const res = await post("/api/run", { kind: "pull-image-repo", args: plan.steps[0].args, where: "rented" });
  assert.equal(res.status, 200);
  const log = await (await get(`/api/runs/${(await res.json()).id}`)).text();
  assert.match(log, /Downloading \d+ files of Qwen\/Qwen-Image on the rented GPU/);
  assert.match(log, /100% of 0\.50 GB \(model_index\.json\)/);
  assert.match(log, /Done\./);
  assert.equal(agent.state.downloads.at(-1).repo, QWEN_IMAGE);
  assert.equal((await json(`/api/model?id=${QWEN_IMAGE}`)).plan.steps[0].done, true);
  // The same machine answers a picture job for it, and a clip for a video family.
  const job = await (await fetch(`${agent.url}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: QWEN_IMAGE, file: "model_index.json", prompt: "a cat" }) })).json();
  let state = await (await fetch(`${agent.url}/jobs/${job.id}`)).json();
  assert.equal(state.kind, "image");
  const models = await json("/api/rent/models");
  assert.ok(models.images.some((m) => m.repo === QWEN_IMAGE && m.file === "model_index.json" && m.loaded), "listed on the machine, by its index file, as the loaded one");
  const WAN = "Wan-AI/Wan2.2-TI2V-5B-Diffusers";
  const wan = (await json(`/api/model?id=${WAN}`)).plan;
  assert.equal(wan.tryWith.kind, "video");
  const clip = await (await fetch(`${agent.url}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: WAN, file: "model_index.json", prompt: "waves" }) })).json();
  state = await (await fetch(`${agent.url}/jobs/${clip.id}`)).json();
  state = await (await fetch(`${agent.url}/jobs/${clip.id}`)).json();
  assert.equal(state.kind, "video");
  assert.ok(state.video);
  assert.equal((await post("/api/remove", { kind: "gpu-file", repo: QWEN_IMAGE, file: "model_index.json" })).status, 200);
});

test("a download already going shows in the model's plan, in the list of runs and in the machine's status, with the model it is for", async () => {
  const SD = "second-state/stable-diffusion-v1-5-GGUF";
  const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf";
  agent.state.slowMs = 150;
  const started = await post("/api/run", { kind: "pull-image-model", args: { repo: SD, file: FILE }, where: "rented", model: SD, title: "Download the model on the rented GPU (1.1 GB)" });
  const { id } = await started.json();
  // Opening the window again finds the step running rather than offering it again.
  const plan = (await json(`/api/model?id=${SD}`)).plan;
  assert.equal(plan.steps[0].running, id);
  const listed = (await json("/api/runs")).runs;
  assert.equal(listed.length >= 1, true);
  const mine = listed.find((r) => r.id === id);
  assert.deepEqual([mine.status, mine.model, mine.title, mine.kind], ["running", SD, "Download the model on the rented GPU (1.1 GB)", "custom"]);
  assert.match(mine.first, /Downloading stable-diffusion-v1-5-pruned-emaonly-Q8_0\.gguf on the rented GPU/);
  assert.equal((await json("/api/rent")).downloading, 1, "the status counts it, for the bar");
  assert.ok((await json("/api/rent/models")).runs.some((r) => r.id === id), "the machine's listing names it");
  await get(`/api/runs/${id}`).then((r) => r.text());
  agent.state.slowMs = 5;
  const after = (await json("/api/runs")).runs.find((r) => r.id === id);
  assert.equal(after.status, "done");
  assert.equal((await json(`/api/model?id=${SD}`)).plan.steps[0].running, undefined);
  assert.equal((await json("/api/rent")).downloading, undefined, "nothing going: no count");
  await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE });
});

test("a download the machine already has going is found by the model's window, and starting the same step twice is one run", async () => {
  const SD = "second-state/stable-diffusion-v1-5-GGUF";
  const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf";
  agent.state.slowMs = 200;
  // Begun on the machine by someone this server does not remember (another tab, a restart).
  const begun = await (await fetch(`${agent.url}/download`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: SD, file: FILE, detach: true }) })).json();
  const plan = (await json(`/api/model?id=${SD}`)).plan;
  assert.ok(plan.steps[0].running, "the step is shown running, attached to the machine's task");
  const attached = (await json("/api/runs")).runs.find((r) => r.id === plan.steps[0].running);
  assert.match(attached.first, /found going on the machine/);
  assert.match(attached.title, /^Download the model on the rented GPU/);
  assert.equal(attached.model, SD);
  // Starting the step now joins that run rather than starting a second download.
  const again = await (await post("/api/run", { kind: "pull-image-model", args: { repo: SD, file: FILE }, where: "rented", model: SD })).json();
  assert.deepEqual(again, { id: plan.steps[0].running, attached: true });
  const log = await (await get(`/api/runs/${plan.steps[0].running}`)).text();
  assert.match(log, /Done\./);
  assert.equal(agent.state.tasks.get(begun.id).status, "done");
  agent.state.slowMs = 5;
  await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE });
});

test("a machine from before a feature is told apart by its agent's version, and the plan says to replace it", async () => {
  agent.state.version = 1;
  const addon = (await json("/api/model?id=h94/IP-Adapter-FaceID")).plan;
  assert.equal(addon.runnable, false);
  assert.equal(addon.staleMachine, true);
  assert.match(addon.reason, /older HuggingFound image \(version 1\) from before add-ons could be applied there/);
  assert.equal((await json("/api/model?id=John6666/pony-realism-v23-sdxl")).plan.staleMachine, true);
  assert.equal((await json("/api/model?id=Qwen/Qwen-Image")).plan.staleMachine, true);
  assert.equal((await json("/api/model?id=second-state/stable-diffusion-v1-5-GGUF")).plan.runnable, true, "a single-file model still runs on the old machine");
  assert.equal((await json("/api/rent")).agentCurrent, 8, "the status says which version is current");
  agent.state.version = 8;
  assert.equal((await json("/api/model?id=h94/IP-Adapter-FaceID")).plan.runnable, true);
});

test("a gated folder model runs on the machine with the person's Hugging Face token, and a pieces repository points at its diffusers twin", async () => {
  const LTX = "Lightricks/LTX-2.5";
  const TWIN = "Lightricks/LTX-2.5-Diffusers";
  const token = `hf_${"x".repeat(30)}`;
  // Without a token the gated twin cannot even be looked at, so the pieces repository has no way forward yet.
  const blocked = (await json(`/api/model?id=${TWIN}`)).plan;
  assert.equal(blocked.gated, true);
  assert.equal((await post("/api/settings", { HF_TOKEN: token })).status, 200);
  const pieces = (await json(`/api/model?id=${LTX}`)).plan;
  assert.equal(pieces.runnable, false);
  assert.deepEqual(pieces.twin, { id: TWIN, name: "LTX-2.5-Diffusers" }, "the -Diffusers twin is found on the Hub");
  const plan = (await json(`/api/model?id=${TWIN}`)).plan;
  assert.equal(plan.runnable, true, plan.reason);
  assert.equal(plan.steps[0].kind, "pull-image-repo");
  assert.match(plan.steps[0].text, /with your Hugging Face token/);
  assert.equal(plan.tryWith.kind, "video");
  assert.equal(plan.tryWith.startPicture, "optional");
  const res = await post("/api/run", { kind: "pull-image-repo", args: plan.steps[0].args, where: "rented" });
  await (await get(`/api/runs/${(await res.json()).id}`)).text();
  assert.equal(agent.state.downloads.at(-1).token, token, "the machine fetches with the token");
  await post("/api/remove", { kind: "gpu-file", repo: TWIN, file: "model_index.json" });
  await post("/api/settings", { HF_TOKEN: "" });
});

test("an add-on is downloaded onto the rented GPU and applied there to a base model", async () => {
  const ADDON = "h94/IP-Adapter-FaceID";
  const { plan, choice } = await json(`/api/model?id=${ADDON}`);
  assert.equal(choice.gpuOnly, true);
  assert.equal(choice.where, "rented");
  assert.equal(plan.runnable, true, plan.reason);
  assert.equal(plan.steps[0].kind, "pull-addon");
  const res = await post("/api/run", { kind: "pull-addon", args: plan.steps[0].args, where: "rented" });
  assert.equal(res.status, 200);
  const log = await (await get(`/api/runs/${(await res.json()).id}`)).text();
  assert.match(log, /Downloading the add-on h94\/IP-Adapter-FaceID on the rented GPU/);
  assert.match(log, /Done\./);
  assert.equal(agent.state.downloads.at(-1).addon, true);
  assert.equal((await json(`/api/model?id=${ADDON}`)).plan.steps[0].done, true);
  assert.equal((await post("/api/remove", { kind: "gpu-addon", repo: ADDON, file: "ip-adapter-faceid_sd15.bin" })).status, 200);
  assert.equal(agent.state.deleted.at(-1), `addon:${ADDON}/ip-adapter-faceid_sd15.bin`);
  assert.equal((await json(`/api/model?id=${ADDON}`)).plan.steps[0].done, false, "a missing file makes the step pending again");
});

test("a touch from the page renews the machine's own lease, so the machine stops itself only when the site has stopped seeing use", async () => {
  assert.equal((await post("/api/rent/touch", {})).status, 200);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(agent.state.leases.length >= 1, "a lease was sent straight to the machine");
  const count = agent.state.leases.length;
  await post("/api/rent/touch", {});
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(agent.state.leases.length, count, "not again within a minute");
});

test("hiding a model also clears it off the machine: its chat model, image files and add-on files", async () => {
  const SD = "second-state/stable-diffusion-v1-5-GGUF";
  const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf";
  await post("/api/run", { kind: "pull-image-model", args: { repo: SD, file: FILE }, where: "rented" }).then((r) => r.json()).then(({ id }) => get(`/api/runs/${id}`).then((r) => r.text()));
  const ADDON = "h94/IP-Adapter-FaceID";
  await post("/api/run", { kind: "pull-addon", args: { repo: ADDON, files: ["ip-adapter-faceid_sd15.bin", "ip-adapter-faceid_sd15_lora.safetensors"] }, where: "rented" }).then((r) => r.json()).then(({ id }) => get(`/api/runs/${id}`).then((r) => r.text()));
  assert.equal((await post("/api/rent/forget", { id: "nope" })).status, 400);
  const image = await (await post("/api/rent/forget", { id: SD })).json();
  assert.deepEqual(image.removed, [`${SD}/${FILE}`]);
  assert.ok(!agent.state.files.some((f) => f.repo === SD));
  const addon = await (await post("/api/rent/forget", { id: ADDON })).json();
  assert.ok(addon.removed.includes(`${ADDON}/ip-adapter-faceid_sd15.bin`) && addon.removed.includes(`${ADDON}/ip-adapter-faceid_sd15_lora.safetensors`));
  assert.ok(addon.removed.every((k) => k.startsWith(`${ADDON}/`)), "every file of that add-on, and nothing else");
  assert.ok(!agent.state.addons.some((a) => a.repo === ADDON));
  const chat = await (await post("/api/rent/forget", { id: QWEN })).json();
  assert.deepEqual(chat.removed, [PULLED], "the chat model pulled from that repository goes too");
  assert.deepEqual((await (await post("/api/rent/forget", { id: QWEN })).json()).removed, [], "nothing left to remove");
  // Back onto the machine for the tests that follow.
  await post("/api/run", { kind: "pull-model", args: { name: PULLED }, where: "rented" }).then((r) => r.json()).then(({ id }) => get(`/api/runs/${id}`).then((r) => r.text()));
  await post("/api/chat", { model: PULLED, messages: [{ role: "user", content: "hi" }] });
});

test("everything on the machine is listed in one place: chat models with the loaded one, image models with the one in the GPU", async () => {
  const SD = "second-state/stable-diffusion-v1-5-GGUF";
  const FILE = "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf";
  await post("/api/run", { kind: "pull-image-model", args: { repo: SD, file: FILE }, where: "rented" }).then((r) => r.json()).then(({ id }) => get(`/api/runs/${id}`).then((r) => r.text()));
  // A picture job on the agent marks the file as loaded; a chat marks the chat model as running.
  await fetch(`${agent.url}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo: SD, file: FILE, prompt: "a cat" }) });
  await post("/api/chat", { model: PULLED, messages: [{ role: "user", content: "hi" }] });
  const models = await json("/api/rent/models");
  assert.equal(models.chatOk, true);
  assert.equal(models.imagesOk, true);
  const qwen = models.chat.find((m) => m.name === PULLED);
  assert.deepEqual(qwen, { name: PULLED, id: QWEN, gb: 4, running: true }, "an hf.co name maps back to its repository");
  const llama = models.chat.find((m) => m.name === "llama3.2:3b");
  assert.equal(llama.id, null, "a model not from the Hub has no window to open");
  assert.equal(llama.running, false);
  assert.deepEqual(models.images, [{ repo: SD, file: FILE, id: SD, gb: 1.1, loaded: true }]);
  // The status carries the counts, for the bar.
  const status = await json("/api/rent");
  assert.equal(status.chatModels, 2);
  assert.equal(status.imageModels, 1);
  await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE });
  assert.deepEqual((await json("/api/rent/models")).images, []);
});

test("stopping ends the charge and frees the chat server; starting brings both back", async () => {
  // A stop from the page's still-there check says so.
  const stopped = await (await post("/api/rent/stop", { reason: "away", minutes: 10 })).json();
  assert.equal(stopped.rented, true);
  assert.equal(stopped.status, "EXITED");
  assert.equal(stopped.stopReason, "away:10");
  assert.deepEqual(runpod.state.actions, [`${stopped.id}:stop`]);
  assert.equal((await json("/api/state")).presenceMinutes, 10, "the still-there check defaults to ten minutes");
  assert.equal((await post("/api/settings", { RUNPOD_PRESENCE_MINUTES: 0.05 })).status, 400, "no shorter than six seconds");
  let s = await json("/api/state");
  assert.equal(s.chatServer, null, "chat models go back to this computer while it is stopped");
  assert.equal(readEnv(envFile).GPU_AGENT, undefined, "and so do image models");
  assert.equal(s.rental.status, "EXITED");
  assert.equal(readEnv(envFile).RUNPOD_POD_ID, stopped.id, "the machine and its disk are kept");
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.ok(plan.steps.length >= 3, "the local plan again");
  // Stopping twice is harmless.
  assert.equal((await post("/api/rent/stop", {})).status, 200);
  // A stopped machine whose host has no free card says so, with the way out.
  runpod.state.noGpu = true;
  const busy = await post("/api/rent/start", {});
  assert.equal(busy.status, 503);
  const why = await busy.json();
  assert.match(why.error, /No free GPU on this machine's host right now/);
  assert.equal(why.noGpu, true);
  runpod.state.noGpu = false;
  const started = await (await post("/api/rent/start", {})).json();
  assert.ok(["STARTING", "RUNNING"].includes(started.status), started.status);
  assert.deepEqual(runpod.state.actions.slice(-1), [`${stopped.id}:start`]);
  s = await json("/api/state");
  assert.equal(s.chatServer.url, ollama.url);
  assert.equal(s.chatServer.rented, true);
  const stoppedAgain = await (await post("/api/rent/stop", {})).json();
  assert.equal(stoppedAgain.status, "EXITED");
  const remote = await json(`/api/model?id=${QWEN}`);
  assert.ok(remote.plan.steps.length >= 3);
});

test("a stopped machine's plan note, when the server address is set by hand, says it is stopped", async () => {
  // The user points the chat server at the stopped machine's address themselves.
  const id = readEnv(envFile).RUNPOD_POD_ID;
  ollama.state.down = true;
  assert.equal((await post("/api/settings", { OLLAMA_SERVER: ollama.url, OLLAMA_SERVER_GB: "48" })).status, 200);
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.match(plan.steps[0].text, /rented GPU is stopped/);
  ollama.state.down = false;
  assert.equal(readEnv(envFile).RUNPOD_POD_ID, id);
});

test("a machine rented with a key that is then removed is still accounted for: the error names the way out", async () => {
  await post("/api/settings", { RUNPOD_API_KEY: "" });
  const stop = await post("/api/rent/stop", {});
  assert.equal(stop.status, 400);
  assert.match((await stop.json()).error, /The RunPod key is gone but a machine is still rented\. Enter the key of the account that rented it[\s\S]*stops by itself after \d+ minutes/);
  assert.equal((await json("/api/state")).rental.rented, true, "the machine is still shown");
  await post("/api/settings", { RUNPOD_API_KEY: KEY });
});

test("deleting removes the machine, the address and every trace in the settings", async () => {
  const gone = await (await post("/api/rent/delete", {})).json();
  assert.deepEqual(gone, { rented: false });
  const saved = readEnv(envFile);
  assert.equal(saved.RUNPOD_POD_ID, undefined);
  assert.equal(saved.OLLAMA_SERVER, undefined);
  assert.equal(saved.RUNPOD_API_KEY, KEY, "the key stays for next time");
  assert.deepEqual(await json("/api/rent"), { rented: false });
  assert.equal((await json("/api/state")).chatServer, null);
  assert.equal((await post("/api/rent/stop", {})).status, 404);
});

test("a machine deleted at RunPod itself is forgotten on the next look", async () => {
  const r = await (await post("/api/rent", { gb: 24, diskGb: 50 })).json();
  assert.equal(r.status, "PROVISIONING");
  assert.equal(r.costPerHour, 0.44);
  runpod.state.pods[r.id].status = "TERMINATED";
  assert.deepEqual(await json("/api/rent"), { rented: false, gone: true });
  assert.equal(readEnv(envFile).RUNPOD_POD_ID, undefined);
  assert.equal(readEnv(envFile).OLLAMA_SERVER, undefined);
});

test("a refused key is explained and the saved state is kept", async () => {
  const r = await (await post("/api/rent", { gb: 24 })).json();
  runpod.state.badKey = true;
  const status = await json("/api/rent");
  assert.equal(status.rented, true);
  assert.equal(status.id, r.id);
  assert.match(status.error, /refused the API key/);
  assert.equal((await post("/api/rent/stop", {})).status, 401);
  runpod.state.badKey = false;
  await post("/api/rent/delete", {});
});

test("when the full image cannot be pulled, a plain Ollama machine is rented instead and image models stay local", async () => {
  const file = path.join(home, "plain.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, agentUrl: () => agent.url, imageCheck: async () => false });
  const r = await rental.rent({ gb: 24, diskGb: 50 });
  const made = runpod.state.created.at(-1);
  assert.equal(made.image, "ollama/ollama");
  assert.deepEqual(made.ports, ["11434/http"]);
  assert.equal(r.images, false);
  assert.equal(r.agent, null);
  assert.equal(readEnv(file).GPU_AGENT, undefined, "no agent to point image models at");
  assert.equal(readEnv(file).OLLAMA_SERVER, ollama.url);
  await rental.remove();
  assert.equal(readEnv(file).RUNPOD_POD_AGENT, undefined);
});

test("a registry login chosen in Settings keeps the image private: it travels with the pod and the public check is skipped", async () => {
  const { registries } = await json("/api/rent/registries");
  assert.deepEqual(registries, [{ id: "reg_abc123", name: "GitHub packages" }, { id: "reg_other", name: "Docker Hub" }]);
  assert.equal((await post("/api/settings", { RUNPOD_REGISTRY_AUTH: "bad id!" })).status, 400);
  const file = path.join(home, "private.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY, RUNPOD_REGISTRY_AUTH: "reg_abc123" });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, agentUrl: () => agent.url, imageCheck: async () => false });
  const r = await rental.rent({ gb: 24, diskGb: 50 });
  const made = runpod.state.created.at(-1);
  assert.equal(made.registry, "reg_abc123");
  assert.notEqual(made.image, "ollama/ollama");
  assert.equal(r.images, true);
  await rental.remove();
});

test("a page asking several times at once costs one RunPod call, and a throttled key gets the last known answer", async () => {
  let clock = 1_700_000_000_000;
  const file = path.join(home, "throttle.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, agentUrl: () => agent.url, imageCheck: async () => true, now: () => clock });
  await rental.rent({ gb: 24, diskGb: 50 });
  const before = runpod.state.calls.filter((c) => c.startsWith("GET /pods/")).length;
  const [a, b, c] = await Promise.all([rental.status(), rental.status(), rental.status()]);
  assert.equal(runpod.state.calls.filter((cl) => cl.startsWith("GET /pods/")).length, before + 1, "three askers, one call");
  assert.equal(a, b);
  assert.equal(b, c);
  clock += 2000;
  await rental.status({ probe: false });
  assert.equal(runpod.state.calls.filter((cl) => cl.startsWith("GET /pods/")).length, before + 1, "a fresh answer is reused for a few seconds");
  clock += 5000;
  await rental.status({ probe: false });
  assert.equal(runpod.state.calls.filter((cl) => cl.startsWith("GET /pods/")).length, before + 2);
  // RunPod throttles: the catalogue falls back to the last prices, and nothing is asked again for half a minute.
  const tiers = await rental.tiers();
  runpod.state.rateLimited = true;
  clock += 16 * 60e3;
  const calls = runpod.state.calls.length;
  const stale = await rental.tiers();
  assert.deepEqual(stale, tiers, "yesterday's prices beat none");
  assert.equal(runpod.state.calls.length, calls + 1, "the one throttled call");
  await assert.rejects(rental.remove(), /stopped answering this account for now; it accepts requests again in \d+ seconds/);
  const kept = await rental.status();
  assert.equal(kept.rented, true, "the machine is still shown");
  assert.match(kept.error, /stopped answering this account/);
  assert.equal(runpod.state.calls.length, calls + 1, "nothing else reached RunPod during the back-off");
  // A fresh key is not held to the old key's back-off.
  writeEnv(file, { RUNPOD_API_KEY: `${KEY}` });
  runpod.state.rateLimited = false;
  writeEnv(file, { RUNPOD_API_KEY: "rpa_anotherkey_0123456789abcdef" });
  runpod.state.extraKeys = ["rpa_anotherkey_0123456789abcdef"];
  const fresh = await rental.status({ probe: false });
  assert.equal(fresh.rented, true);
  assert.equal(fresh.error, undefined, "the new key is asked straight away");
  clock += 31e3;
  await rental.remove();
});

test("one rental can never spend a key: calls beyond the budget are answered from what was last known", async () => {
  let clock = 1_800_000_000_000;
  const file = path.join(home, "budget.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, agentUrl: () => agent.url, imageCheck: async () => true, statusTtl: 0, now: () => clock });
  await rental.rent({ gb: 24, diskGb: 50 });
  const before = runpod.state.calls.length;
  // A runaway page: a hundred status requests in a minute.
  let kept = 0;
  for (let i = 0; i < 100; i++) {
    const r = await rental.status({ probe: false });
    if (r.error) kept++;
    clock += 500;
  }
  const made = runpod.state.calls.length - before;
  assert.ok(made <= 60, `at most sixty calls reached RunPod, not ${made}`);
  assert.ok(kept >= 40, "the rest were answered from the last known status");
  // The budget refills with time.
  clock += 61e3;
  assert.equal((await rental.status({ probe: false })).error, undefined);
  await rental.remove();
});

test("the idle watch stops a machine nobody has used, but not during a download or when turned off", async () => {
  let clock = 1_000_000_000_000;
  const file = path.join(home, "idle.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY, RUNPOD_IDLE_MINUTES: "20" });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0, now: () => clock });
  assert.equal(await rental.checkIdle(), false, "nothing rented");
  const r = await rental.rent({ gb: 24, diskGb: 50 });
  assert.equal(runpod.state.created.at(-1).env.HF_IDLE_MINUTES, "20", "the machine's own watch gets the same idle time");
  await rental.status({ probe: false });
  await rental.status({ probe: false });
  assert.equal((await rental.status({ probe: false })).status, "RUNNING");
  clock += 19 * 60e3;
  assert.equal(await rental.checkIdle(), false, "not idle long enough");
  assert.equal(readEnv(file).RUNPOD_LAST_ACTIVITY !== undefined, true, "the activity clock is kept in the settings, so a restart does not reset it");
  clock += 2 * 60e3;
  const release = rental.hold();
  assert.equal(await rental.checkIdle(), false, "a download keeps it awake");
  release();
  assert.equal(await rental.checkIdle(), false, "the download just ended, so the clock restarted");
  clock += 21 * 60e3;
  rental.touch();
  assert.equal(await rental.checkIdle(), false, "a chat restarted it too");
  clock += 21 * 60e3;
  assert.equal(await rental.checkIdle(), true);
  assert.equal(runpod.state.pods[r.id].status, "EXITED");
  assert.equal(readEnv(file).OLLAMA_SERVER, undefined);
  assert.equal(readEnv(file).RUNPOD_LAST_STOP, "idle:20");
  assert.equal((await rental.status({ probe: false })).stopReason, "idle:20", "the card can say why it stopped");
  assert.equal(await rental.checkIdle(), false, "already stopped");
  // A machine last seen stopped is not asked about every minute: that only spends the account's allowance.
  const before = runpod.state.calls.length;
  clock += 60e3;
  await rental.checkIdle();
  clock += 60e3;
  await rental.checkIdle();
  assert.equal(runpod.state.calls.length, before, "no RunPod call while it is known to be stopped");
  clock += 15 * 60e3;
  await rental.checkIdle();
  assert.equal(runpod.state.calls.length, before + 1, "looked at again after a quarter of an hour");
  // A download that never ends cannot keep the machine awake for ever.
  await rental.start();
  await rental.status({ probe: false });
  await rental.status({ probe: false });
  assert.equal((await rental.status({ probe: false })).status, "RUNNING");
  const stuck = rental.hold();
  clock += 5 * 3600e3;
  assert.equal(await rental.checkIdle(), false, "a download of five hours still counts");
  clock += 2 * 3600e3;
  assert.equal(await rental.checkIdle(), true, "after six hours the hold has expired and the idle machine stops");
  stuck();
  // A session that has cost more than the cap stops even while in use.
  await rental.start();
  assert.ok(!readEnv(file).RUNPOD_LAST_STOP, "a start clears the reason");
  await rental.status({ probe: false });
  await rental.status({ probe: false });
  writeEnv(file, { RUNPOD_MAX_SPEND: "0.3" });
  for (let i = 0; i < 6; i++) await rental.status({ probe: false });
  assert.ok((await rental.status({ probe: false })).spent >= 0.3, "the stand-in machine has run long enough to pass the cap");
  rental.touch();
  clock += 6 * 60e3;
  assert.equal(await rental.checkIdle(), true, "stopped at the cap although it was just used");
  assert.equal(readEnv(file).RUNPOD_LAST_STOP, "cap:0.3");
  writeEnv(file, { RUNPOD_MAX_SPEND: "0" });
  // Turned off, it never stops; quitting still does unless that is off too.
  await rental.start();
  await rental.status({ probe: false });
  await rental.status({ probe: false });
  writeEnv(file, { RUNPOD_IDLE_MINUTES: "0" });
  clock += 24 * 3600e3;
  assert.equal(await rental.checkIdle(), false);
  assert.equal(await rental.stopOnQuit(), true);
  assert.equal(runpod.state.pods[r.id].status, "EXITED");
  assert.equal(await rental.stopOnQuit(), false, "nothing running");
  await rental.start();
  writeEnv(file, { RUNPOD_STOP_ON_QUIT: "0" });
  assert.equal(await rental.stopOnQuit(), false);
  assert.notEqual(runpod.state.pods[r.id].status, "EXITED");
  await rental.remove();
});

test("what today's machines cost is counted across stops, starts and a restart of the server, and the cap is on that total", async () => {
  let clock = Date.UTC(2026, 9, 12, 10, 0, 0);
  const file = path.join(home, "meter.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const make = () => createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0, now: () => clock });
  let rental = make();
  const r = await rental.rent({ gb: 24, diskGb: 50 });
  for (let i = 0; i < 6; i++) await rental.status({ probe: false });
  const first = await rental.status({ probe: false });
  assert.equal(first.status, "RUNNING");
  assert.ok(first.spent > 0 && first.spentToday >= first.spent, "the day's total is at least this stretch");
  assert.equal(first.diskPerDay, Math.round(((50 * 0.1) / 30) * 10000) / 10000, "the disk's cost a day while running");
  await rental.stop();
  const stopped = await rental.status({ probe: false });
  assert.equal(stopped.diskPerDay, Math.round(((50 * 0.2) / 30) * 10000) / 10000, "twice as much a day while stopped");
  assert.equal(stopped.spentToday, first.spentToday, "a stop keeps the count");
  // A new server reads the count back and goes on from it after a start.
  rental = make();
  await rental.start();
  for (let i = 0; i < 2; i++) await rental.status({ probe: false });
  const second = await rental.status({ probe: false });
  assert.ok(second.spent < first.spent, "the stretch starts over");
  assert.ok(second.spentToday > first.spentToday, "the day's total goes on");
  assert.ok(Math.abs(second.spentToday - (first.spentToday + second.spent)) < 0.02, "first stretch plus second");
  // The cap is on the day, not on the stretch since the last start.
  writeEnv(file, { RUNPOD_MAX_SPEND: String(second.spentToday) });
  rental.touch();
  clock += 6 * 60e3;
  assert.equal(await rental.checkIdle(), true, "stopped at the cap on the day's total");
  assert.equal(readEnv(file).RUNPOD_LAST_STOP, `cap:${second.spentToday}`);
  // Midnight UTC starts the count again.
  clock = Date.UTC(2026, 9, 13, 0, 1, 0);
  assert.equal((await rental.status({ probe: false })).spentToday, 0);
  await rental.remove();
});

test("a dear machine gets a short idle time unless one is set, and the price travels to the machine's own watch", async () => {
  const file = path.join(home, "pricey.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0 });
  assert.equal(rental.idleMinutes(), 30, "nothing rented: the plain default");
  // With the cheaper 80 GB card taken, the H100 at $2.69 an hour is the offer.
  const a100 = GPUS.find((g) => g.name === "A100 PCIe");
  const was = a100.availability;
  a100.availability = "NONE";
  try {
    await rental.rent({ gb: 80, diskGb: 100 });
  } finally {
    a100.availability = was;
  }
  assert.equal(runpod.state.created.at(-1).env.HF_IDLE_MINUTES, "10", "an H100 at $2.69 an hour: ten minutes on the machine too");
  assert.equal(rental.idleMinutes(), 10);
  assert.equal((await rental.status({ probe: false })).idleMinutes, 10);
  writeEnv(file, { RUNPOD_IDLE_MINUTES: "45" });
  assert.equal(rental.idleMinutes(), 45, "a setting wins");
  await rental.remove();
  writeEnv(file, { RUNPOD_IDLE_MINUTES: "" });
  await rental.rent({ gb: 24, diskGb: 50 });
  assert.equal(runpod.state.created.at(-1).env.HF_IDLE_MINUTES, "30", "a cheap card keeps half an hour");
  await rental.remove();
});

test("other machines on the account are listed with what their disks cost a day, and deleted on request; the bill tells GPU time from disks", async () => {
  const file = path.join(home, "others.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0 });
  // Two machines from earlier sessions, stopped, that this rental knows nothing of.
  const orphanFile = path.join(home, "orphan.env");
  writeEnv(orphanFile, { RUNPOD_API_KEY: KEY });
  const earlier = createRental({ env: () => readEnv(orphanFile), save: (u) => writeEnv(orphanFile, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0 });
  const a = await earlier.rent({ gb: 24, diskGb: 50 });
  for (let i = 0; i < 3; i++) await earlier.status({ probe: false });
  await earlier.stop();
  writeEnv(orphanFile, { RUNPOD_POD_ID: "" });
  const b = await earlier.rent({ gb: 48, diskGb: 200 });
  await earlier.stop();
  writeEnv(orphanFile, { RUNPOD_POD_ID: "" });
  // Our own machine is not among the others.
  const mine = await rental.rent({ gb: 24, diskGb: 50 });
  const others = await rental.others();
  // Earlier tests left stopped machines of their own on the stand-in account; they count too.
  assert.ok(others.some((o) => o.id === a.id) && others.some((o) => o.id === b.id));
  assert.ok(!others.some((o) => o.id === mine.id), "never this rental's own machine");
  assert.ok(others.every((o) => o.status === "EXITED" && !o.running));
  assert.equal(others.find((o) => o.id === b.id).diskGb, 200);
  assert.equal(others.find((o) => o.id === b.id).diskPerDay, Math.round(((200 * 0.2) / 30) * 10000) / 10000);
  const calls = runpod.state.calls.length;
  await rental.others();
  assert.equal(runpod.state.calls.length, calls, "asked once, then remembered for a while");
  // The bill: one record a pod, GPU apart from disk, ours marked.
  for (let i = 0; i < 3; i++) await rental.status({ probe: false });
  const bill = await rental.spend();
  assert.ok(bill.pods.some((p) => p.id === mine.id && p.ours));
  assert.ok(bill.pods.some((p) => p.id === a.id && !p.ours && p.gpu > 0 && p.disk > 0));
  assert.ok(bill.total.total >= bill.total.gpu + bill.total.disk - 0.01);
  assert.equal(bill.days.length, 1);
  assert.equal(typeof bill.metered, "number");
  // Deleting one leaves the other; deleting with no list clears them all, never ours.
  assert.deepEqual(await rental.removeOthers([a.id]), [a.id]);
  assert.equal(runpod.state.pods[a.id].status, "TERMINATED");
  assert.equal(runpod.state.pods[b.id].status, "EXITED");
  const rest = await rental.removeOthers();
  assert.ok(rest.includes(b.id) && !rest.includes(mine.id));
  assert.equal(runpod.state.pods[mine.id].status !== "TERMINATED", true);
  assert.deepEqual(await rental.others(), []);
  // Through the site: the same two routes.
  writeEnv(envFile, { RUNPOD_API_KEY: KEY });
  const over = await (await get("/api/rent/others")).json();
  assert.ok(Array.isArray(over.others));
  const spend = await (await get("/api/rent/spend")).json();
  assert.ok(Array.isArray(spend.days) && Array.isArray(spend.pods));
  await rental.remove();
});

test("a download asked to stop the machine when it is over does so, unless another download is still going", async () => {
  // A server of its own, whose budget of RunPod calls the tests above have not used.
  const ownEnv = path.join(home, "stopafter.env");
  writeEnv(ownEnv, { RUNPOD_API_KEY: KEY, RUNPOD_IDLE_MINUTES: "0" });
  const own = createServer({ envFile: ownEnv, scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => ollama.url, runpodAgent: () => agent.url, runpodImageCheck: async () => true, runpodStatusTtl: 0, idleWatch: false });
  await new Promise((resolve) => own.listen(0, "127.0.0.1", resolve));
  const ownBase = `http://127.0.0.1:${own.address().port}`;
  const get = (p) => fetch(ownBase + p);
  const post = (p, body) => fetch(ownBase + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = async (p) => (await get(p)).json();
  const rented = await (await post("/api/rent", { gb: 24, diskGb: 50 })).json();
  assert.ok(rented.id);
  for (let i = 0; i < 3; i++) await json("/api/rent");
  assert.equal((await json("/api/rent")).status, "RUNNING");
  // Two downloads; the first asked to stop the machine. It finishes first,
  // but the second, started later, is still going, so the machine stays up.
  agent.state.slowMs = 40;
  const quick = await (await post("/api/run", { kind: "pull-image-model", args: { repo: "stabilityai/stable-diffusion-xl-base-1.0", file: "sd_xl_base_1.0.safetensors" }, where: "rented", stopAfter: true })).json();
  await new Promise((r) => setTimeout(r, 400));
  const slow = await (await post("/api/run", { kind: "pull-image-model", args: { repo: "stabilityai/stable-diffusion-xl-base-1.0", file: "slow.bin" }, where: "rented" })).json();
  assert.ok(quick.id && slow.id);
  const wait = async (id) => {
    for (let i = 0; i < 400; i++) {
      const run = (await json("/api/runs")).runs.find((r) => r.id === id);
      if (run && run.status !== "running") return run.status;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error("never finished");
  };
  await wait(quick.id);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await json("/api/rent")).status, "RUNNING", "the other download keeps it up");
  // The flag can be put on the running one from the page, and taken back.
  assert.equal((await (await post(`/api/runs/${slow.id}/stop-after`, { on: true })).json()).stopAfter, true);
  assert.equal((await (await post(`/api/runs/${slow.id}/stop-after`, { on: false })).json()).stopAfter, false);
  assert.equal((await (await post(`/api/runs/${slow.id}/stop-after`, {})).json()).stopAfter, true);
  await wait(slow.id);
  // The stand-in's own record, not the site's status, which spends the per-minute budget of RunPod calls.
  for (let i = 0; i < 80 && runpod.state.pods[rented.id].status === "RUNNING"; i++) await new Promise((r) => setTimeout(r, 25));
  const after = await json("/api/rent");
  assert.equal(after.status, "EXITED", "the last download over, the machine stops");
  assert.equal(after.stopReason, "done");
  assert.equal((await (await post(`/api/runs/nope/stop-after`, {})).status), 404);
  agent.state.slowMs = undefined;
  await post("/api/rent/delete", {});
  own.close();
});

test("one machine at a time: renting is refused while another HuggingFound machine runs on the account", async () => {
  const file = path.join(home, "second.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY });
  const first = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0 });
  const a = await first.rent({ gb: 24, diskGb: 50 });
  await first.status({ probe: false });
  await first.status({ probe: false });
  assert.equal((await first.status({ probe: false })).status, "RUNNING");
  const other = path.join(home, "second-b.env");
  writeEnv(other, { RUNPOD_API_KEY: KEY });
  const second = createRental({ env: () => readEnv(other), save: (u) => writeEnv(other, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0 });
  await assert.rejects(second.rent({ gb: 24, diskGb: 50 }), /Another HuggingFound machine is already running on this RunPod account \(NVIDIA GeForce RTX 4090, \$0\.44 an hour, pod\d+abc\)\. One machine at a time/);
  assert.equal(Object.values(runpod.state.pods).filter((p) => p.status !== "TERMINATED" && p.status !== "EXITED").length, 1, "nothing new was made");
  await first.stop();
  // Stopped, it no longer blocks; it is only listed as another machine.
  const b = await second.rent({ gb: 24, diskGb: 50 });
  assert.ok(b.id && b.id !== a.id);
  assert.ok((await second.others()).some((o) => o.id === a.id && !o.running));
  await second.remove();
  await first.remove();
});
