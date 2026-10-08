import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { startStubAgent } from "./stub-agent.js";
import { startStubOllama } from "./stub-ollama.js";
import { KEY, startStubRunpod } from "./stub-runpod.js";

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
  assert.deepEqual(TIERS.map((t) => t.gb), [24, 48, 80, 141]);
  assert.equal(tierFor(4.7).gb, 24);
  assert.equal(tierFor(19.7).gb, 48, "a 20 GB file is tight on 24 GB, so the next size up");
  assert.equal(tierFor(40).gb, 80);
  assert.equal(tierFor(130), null, "beyond anything on offer");
  assert.equal(tierFor(0), null);
});

test("without a key nothing can be rented, and the page is told so", async () => {
  const s = await json("/api/state");
  assert.deepEqual(s.rental, { rented: false });
  assert.equal(s.runpodKey, "");
  assert.equal(s.rentTiers.length, 4);
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
  // Gated and multi-part image models cannot be fetched by the machine.
  const gated = await json("/api/model?id=black-forest-labs/FLUX.1-dev");
  assert.equal(gated.plan.runnable, false);
  // The download runs on the machine with progress; afterwards the step is done, and the file can be removed there.
  const res = await post("/api/run", { kind: "pull-image-model", args: { repo: SD, file: FILE }, where: "rented" });
  assert.equal(res.status, 200);
  const log = await (await get(`/api/runs/${(await res.json()).id}`)).text();
  assert.match(log, /Downloading stable-diffusion-v1-5-pruned-emaonly-Q8_0\.gguf on the rented GPU/);
  assert.match(log, /50% of 1\.10 GB/);
  assert.match(log, /Done\./);
  assert.deepEqual(agent.state.downloads.map((d) => d.file), [FILE]);
  assert.equal((await json(`/api/model?id=${SD}`)).plan.steps[0].done, true);
  assert.equal((await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE })).status, 200);
  assert.deepEqual(agent.state.deleted, [`${SD}/${FILE}`]);
  assert.equal((await post("/api/remove", { kind: "gpu-file", repo: SD, file: FILE })).status, 400, "gone already");
  // A machine still starting: the plan says so.
  agent.state.down = true;
  assert.match((await json(`/api/model?id=${SD}`)).plan.steps[0].text, /rented GPU is up but|still starting|stopped/);
  agent.state.down = false;
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
  const stopped = await (await post("/api/rent/stop", {})).json();
  assert.equal(stopped.rented, true);
  assert.equal(stopped.status, "EXITED");
  assert.deepEqual(runpod.state.actions, [`${stopped.id}:stop`]);
  let s = await json("/api/state");
  assert.equal(s.chatServer, null, "chat models go back to this computer while it is stopped");
  assert.equal(readEnv(envFile).GPU_AGENT, undefined, "and so do image models");
  assert.equal(s.rental.status, "EXITED");
  assert.equal(readEnv(envFile).RUNPOD_POD_ID, stopped.id, "the machine and its disk are kept");
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.ok(plan.steps.length >= 3, "the local plan again");
  // Stopping twice is harmless.
  assert.equal((await post("/api/rent/stop", {})).status, 200);
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
  await assert.rejects(rental.remove(), /rate limiting this key; it accepts requests again in \d+ seconds/);
  const kept = await rental.status();
  assert.equal(kept.rented, true, "the machine is still shown");
  assert.match(kept.error, /rate limiting/);
  assert.equal(runpod.state.calls.length, calls + 1, "nothing else reached RunPod during the back-off");
  runpod.state.rateLimited = false;
  clock += 31e3;
  await rental.remove();
});

test("the idle watch stops a machine nobody has used, but not during a download or when turned off", async () => {
  let clock = 1_000_000_000_000;
  const file = path.join(home, "idle.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY, RUNPOD_IDLE_MINUTES: "20" });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, imageCheck: async () => true, statusTtl: 0, now: () => clock });
  assert.equal(await rental.checkIdle(), false, "nothing rented");
  const r = await rental.rent({ gb: 24, diskGb: 50 });
  await rental.status({ probe: false });
  await rental.status({ probe: false });
  assert.equal((await rental.status({ probe: false })).status, "RUNNING");
  clock += 19 * 60e3;
  assert.equal(await rental.checkIdle(), false, "not idle long enough");
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
  assert.equal(await rental.checkIdle(), false, "already stopped");
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
