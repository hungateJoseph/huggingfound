import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { startStubAgent } from "./stub-agent.js";
import { startStubOllama } from "./stub-ollama.js";
import { startStubRunpod } from "./stub-runpod.js";
import { startStubVast, VAST_KEY } from "./stub-vast.js";
import { instanceStatus } from "../src/vast.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-vast-"));
const { createServer } = await import("../src/server.js");
const { GPU_IMAGE } = await import("../src/rent.js");
const { readEnv } = await import("../src/envfile.js");

// Renting at Vast.ai, the second place: its cards listed with RunPod's,
// a machine rented there whose HTTPS addresses (Cloudflare tunnels) are
// learned from the machine itself, and stopped, started, watched for and
// deleted the same way as a RunPod one. The stub Vast.ai maps the
// machine's agent port to the stub agent, which says the tunnels.

let hub;
let runpod;
let vast;
let ollama;
let agent;
let server;
let base;
const home = process.env.HUGGINGFOUND_HOME;
const envFile = path.join(home, ".env");
const dead = "http://127.0.0.1:1";

before(async () => {
  hub = await startStubHub();
  runpod = await startStubRunpod();
  ollama = await startStubOllama();
  agent = await startStubAgent();
  vast = await startStubVast({ agentPort: () => new URL(agent.url).port, ollamaPort: () => new URL(ollama.url).port });
  // The machine answers only the secret it was started with.
  agent.state.token = () => Object.values(vast.state.instances).map((i) => i.env?.HF_AGENT_TOKEN).filter(Boolean);
  agent.state.diskFreeGb = 400;
  agent.state.diskTotalGb = 500;
  server = createServer({ envFile, scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: hub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => dead, runpodAgent: () => dead, runpodImageCheck: async () => true, runpodStatusTtl: 0, runpodBudget: { minute: 600, hour: 5000 }, vastBase: vast.base, vastTunnelCheck: (u) => /^http:\/\/127\.0\.0\.1:\d+$/.test(u), idleWatch: false, stockFile: path.join(home, "stock.json"), pushFile: path.join(home, "push-keys.json"), pushSend: async () => {} });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  for (const s of [server, hub.server, runpod.server, vast.server, ollama.server, agent.server]) s.close();
});

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (p) => (await get(p)).json();
// Polls the rental until it says so, a few times.
async function until(check, tries = 8) {
  let r;
  for (let i = 0; i < tries; i++) {
    r = await json("/api/rent");
    if (check(r)) return r;
  }
  return r;
}

test("Vast.ai's status words read as RunPod's", () => {
  assert.equal(instanceStatus({ actual_status: "running", intended_status: "running", cur_state: "running" }), "RUNNING");
  assert.equal(instanceStatus({ actual_status: null, intended_status: "running" }), "PROVISIONING");
  assert.equal(instanceStatus({ actual_status: "loading", intended_status: "running" }), "STARTING");
  assert.equal(instanceStatus({ actual_status: "exited", intended_status: "stopped", cur_state: "stopped" }), "EXITED");
  assert.equal(instanceStatus({ actual_status: "exited", intended_status: "running", cur_state: "stopped" }), "EXITED", "asked to run but its host's card is taken: not running");
  assert.equal(instanceStatus({ actual_status: "exited", intended_status: "running", cur_state: "running" }), "STARTING");
});

test("a Vast.ai key alone lists Vast.ai's cards by size, the cheapest first, without the cards the image cannot run", async () => {
  let res = await post("/api/settings", { VAST_API_KEY: "short" });
  assert.equal(res.status, 400);
  res = await post("/api/settings", { VAST_API_KEY: VAST_KEY });
  assert.equal(res.status, 200);
  const s = await json("/api/state");
  assert.match(s.vastKey, /\*+/);
  assert.ok(!s.vastKey.includes(VAST_KEY), "the key itself never goes back to the page");
  assert.equal(s.runpodKey, "");
  const o = await json("/api/rent/options?fresh=1");
  assert.equal(o.configured, true);
  assert.deepEqual(o.providers, { runpod: false, vast: true });
  const by = Object.fromEntries(o.tiers.map((t) => [t.gb, t]));
  assert.equal(by[24].available, false, "nothing from RunPod without its key");
  assert.deepEqual([by[24].vast.gpu.name, by[24].vast.pricePerHour, by[24].vast.gpu.cloud, by[24].vast.gpu.location, by[24].vast.gpu.memory], ["RTX 4090", 0.35, "VAST", "Norway, NO", 24]);
  assert.deepEqual(by[24].vast.cards.map((c) => c.id), ["1001", "1002"], "two hosts of the same card in different places");
  assert.ok(!o.tiers.some((t) => t.vast?.cards.some((c) => /V100|5090|MI300X/.test(c.name))), "older cards, a Blackwell card on too old a CUDA, and AMD cards are never offered");
  assert.deepEqual([by[80].vast.gpu.name, by[80].vast.gpu.memory], ["H100 SXM", 80], "an 80 GB card reporting 81559 MB is of the 80 GB size");
  assert.equal(by[141].vast.available, false);
  assert.deepEqual([by[282].vast.gpu.name, by[282].vast.pricePerHour], ["H200", 5.2], "two cards on one host for the two-card size");
  // The search asks Vast.ai for what the machine needs.
  const q = vast.state.queries.find((x) => x.num_gpus.eq === 1);
  assert.deepEqual([q.verified.eq, q.rentable.eq, q.rented.eq, q.cuda_max_good.gte, q.direct_port_count.gte, q.cpu_arch.eq, q.gpu_ram.gte, q.type], [true, true, false, 12.4, 2, "amd64", 20000, "on-demand"]);
  // The plan for a model counts a Vast.ai key as a key to rent with.
  assert.equal(runpod.state.calls.length, 0, "RunPod is never asked without its key");
});

test("a size rented at Vast.ai runs the image with its tunnels, and its HTTPS addresses come from the machine once it runs", async () => {
  vast.state.taken.add(1010);
  // The cheapest offer goes between the listing and the rent: the next one is taken.
  let res = await post("/api/rent", { gb: 80, diskGb: 60, provider: "vast" });
  assert.equal(res.status, 200, await res.clone().text());
  let r = await res.json();
  assert.deepEqual([r.rented, r.provider, r.cloud, r.gpu, r.gb, r.diskGb, r.url, r.costPerHour], [true, "vast", "VAST", "H100 SXM", 80, 60, "", 2.05]);
  assert.ok(Math.abs(r.startAskedAt - Date.now()) < 5000, "the status says when the machine was asked for, for the page's progress");
  const made = vast.state.created.at(-1);
  assert.equal(made.offerId, 1011);
  assert.deepEqual([made.image, made.disk, made.label, made.runtype, made.cancel_unavail], [GPU_IMAGE, 60, "huggingfound", "args", true]);
  assert.equal(made.env["-p 7860:7860"], "1");
  assert.equal(made.env["-p 11434:11434"], "1");
  assert.equal(made.env.HF_TUNNEL, "1");
  assert.equal(made.env.HF_DISK_GB, "60");
  assert.match(made.env.HF_AGENT_TOKEN, /^[0-9a-f]{48}$/);
  assert.ok(made.env.HF_ORIGINS.split(",").includes(base), "the page's own address may call the machine");
  let env = readEnv(envFile);
  assert.deepEqual([env.RUNPOD_POD_PROVIDER, env.RUNPOD_POD_CLOUD, env.RUNPOD_POD_DISK_RATE, env.OLLAMA_SERVER ?? ""], ["vast", "VAST", "0.2", ""], "nothing to point chat at until the tunnels are known");
  // The machine runs and says its tunnels: chat and pictures point at them.
  agent.state.tunnels = { ollama: ollama.url, agent: agent.url };
  r = await until((x) => x.ready && x.imagesReady);
  assert.deepEqual([r.status, r.ready, r.imagesReady, r.url, r.agent, r.containerUp], ["RUNNING", true, true, ollama.url, agent.url, true]);
  env = readEnv(envFile);
  assert.deepEqual([env.OLLAMA_SERVER, env.GPU_AGENT, env.OLLAMA_SERVER_GB], [ollama.url, agent.url, "80"]);
  assert.equal(r.diskPerDay, Math.round((60 * 0.2) / 30 * 10000) / 10000, "the host's own disk price, the same running or stopped");
  // A call to the agent from the site carries the machine's secret.
  const models = await json("/api/rent/models");
  assert.ok(Array.isArray(models.images), JSON.stringify(models));
  // A disk is set once at Vast.ai.
  res = await post("/api/rent/grow", { diskGb: 120 });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /A Vast\.ai machine's disk cannot be grown: it stays at the 60 GB it was rented with/);
});

test("a Vast.ai machine stops and starts, with new tunnels learned after the start; one that waits for its host's card says so", async () => {
  let res = await post("/api/rent/stop", {});
  assert.equal(res.status, 200, await res.clone().text());
  let r = await res.json();
  assert.equal(r.status, "EXITED");
  assert.deepEqual(vast.state.stateChanges.at(-1).state, "stopped");
  let env = readEnv(envFile);
  assert.deepEqual([env.OLLAMA_SERVER ?? "", env.GPU_AGENT ?? "", env.RUNPOD_POD_URL ?? "", env.RUNPOD_POD_AGENT_URL ?? ""], ["", "", "", ""], "the tunnels go with the container");
  // Started again on a host whose card someone else has meanwhile.
  const inst = Object.values(vast.state.instances)[0];
  inst.gpuTaken = true;
  const before = (await json("/api/rent")).startAskedAt;
  await new Promise((done) => setTimeout(done, 5));
  res = await post("/api/rent/start", {});
  assert.equal(res.status, 200, await res.clone().text());
  r = await json("/api/rent");
  assert.ok(r.startAskedAt > before, "a start begins the wait afresh");
  assert.deepEqual([r.status, r.waitingForGpu], ["EXITED", true]);
  // The card comes free: it runs, with fresh tunnels.
  inst.gpuTaken = false;
  inst.hold = false;
  inst.cur_state = "running";
  agent.state.tunnels = { ollama: ollama.url, agent: agent.url };
  r = await until((x) => x.ready);
  assert.deepEqual([r.status, r.ready, r.url, r.waitingForGpu], ["RUNNING", true, ollama.url, false]);
  env = readEnv(envFile);
  assert.equal(env.OLLAMA_SERVER, ollama.url);
});

test("a container that ends on its own while the machine should run is stopped, so the card does not go on billing", async () => {
  const inst = Object.values(vast.state.instances)[0];
  inst.actual_status = "exited";
  inst.hold = true;
  const changes = vast.state.stateChanges.length;
  const r = await json("/api/rent");
  assert.equal(r.status, "EXITED");
  assert.equal(vast.state.stateChanges.length, changes + 1);
  assert.equal(vast.state.stateChanges.at(-1).state, "stopped");
  assert.equal(readEnv(envFile).OLLAMA_SERVER ?? "", "");
  inst.hold = false;
});

test("other HuggingFound machines at Vast.ai are listed and deleted, and the machine in force is deleted there", async () => {
  // A machine from before, on the same account.
  vast.state.instances[9999] = { id: 9999, label: "huggingfound", gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24564, dph_total: 0.35, disk_space: 40, storage_cost: 0.15, actual_status: "exited", intended_status: "stopped", cur_state: "stopped", polls: 0 };
  // And one of the person's own, not HuggingFound's: never touched.
  vast.state.instances[8888] = { id: 8888, label: "my own thing", gpu_name: "A40", num_gpus: 1, gpu_ram: 49140, dph_total: 0.4, disk_space: 20, actual_status: "running", intended_status: "running", cur_state: "running", polls: 0 };
  const { others } = await json("/api/rent/others");
  assert.deepEqual(others.map((o) => [o.id, o.provider, o.gpu, o.diskGb, o.running]), [["vast:9999", "vast", "RTX 4090", 40, false]]);
  assert.equal(others[0].diskPerDay, Math.round((40 * 0.15) / 30 * 10000) / 10000);
  let res = await post("/api/rent/others/delete", { ids: ["vast:9999"] });
  assert.deepEqual((await res.json()).deleted, ["vast:9999"]);
  assert.ok(vast.state.destroyed.includes(9999));
  assert.ok(vast.state.instances[8888], "someone else's instance stays");
  const mine = Object.values(vast.state.instances).find((i) => i.label === "huggingfound");
  res = await post("/api/rent/delete", {});
  assert.equal(res.status, 200);
  assert.ok(vast.state.destroyed.includes(mine.id));
  const env = readEnv(envFile);
  assert.deepEqual([env.RUNPOD_POD_ID ?? "", env.RUNPOD_POD_PROVIDER ?? "", env.RUNPOD_POD_URL ?? "", env.RUNPOD_AGENT_TOKEN ?? ""], ["", "", "", ""]);
  assert.equal((await json("/api/rent")).rented, false);
  delete vast.state.instances[8888];
});

test("a watch for a sold-out size rents it at Vast.ai the moment one is free there within the price", async () => {
  let res = await post("/api/rent/watch", { gb: 141, diskGb: 80, maxPricePerHour: 3, hours: 2, holdMinutes: 20 });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).watch.gb, 141);
  await server.checkWatches();
  assert.equal((await json("/api/rent")).rented, false, "none free, nothing rented");
  // One above the price: still watching, and said why.
  vast.state.offers.push({ id: 1030, gpu_name: "H200", num_gpus: 1, gpu_ram: 143771, dph_total: 3.4, cuda_max_good: 12.8, reliability2: 0.99, geolocation: "Utah, US", storage_cost: 0.25, cpu_arch: "amd64" });
  await server.checkWatches();
  let r = await json("/api/rent");
  assert.equal(r.rented, false);
  assert.match(r.watch.lastNote, /one is free at \$3\.40 an hour, above the \$3\.00 you set/);
  // One within it: rented at Vast.ai and held.
  vast.state.offers.push({ id: 1031, gpu_name: "H200", num_gpus: 1, gpu_ram: 143771, dph_total: 2.6, cuda_max_good: 12.8, reliability2: 0.99, geolocation: "Texas, US", storage_cost: 0.25, cpu_arch: "amd64" });
  await server.checkWatches();
  r = await json("/api/rent");
  assert.deepEqual([r.rented, r.provider, r.gpu], [true, "vast", "H200"]);
  assert.equal(vast.state.created.at(-1).offerId, 1031);
  assert.equal(vast.state.created.at(-1).disk, 80);
  assert.match(r.watchResult.text, /^H200 141 GB at Vast\.ai, \$2\.60 an hour, with a 80 GB disk; held for you for 20 minutes$/);
  assert.ok(r.holdUntil > Date.now());
  assert.equal((await post("/api/rent/delete", {})).status, 200);
});

test("with both keys, each size lists RunPod's card and Vast.ai's, and a rent goes to the place asked for", async () => {
  const { KEY } = await import("./stub-runpod.js");
  assert.equal((await post("/api/settings", { RUNPOD_API_KEY: KEY })).status, 200);
  const o = await json("/api/rent/options?fresh=1");
  assert.deepEqual(o.providers, { runpod: true, vast: true });
  const by = Object.fromEntries(o.tiers.map((t) => [t.gb, t]));
  assert.deepEqual([by[24].gpu.name, by[24].available, by[24].vast.gpu.name, by[24].vast.available], ["RTX 4090", true, "RTX 4090", true]);
  const res = await post("/api/rent", { gb: 24, diskGb: 50 });
  assert.equal(res.status, 200, await res.clone().text());
  const r = await res.json();
  assert.deepEqual([r.provider, r.cloud], ["runpod", "SECURE"], "no place named: RunPod, as before");
  assert.equal(readEnv(envFile).RUNPOD_POD_PROVIDER ?? "", "");
  assert.equal((await post("/api/rent/delete", {})).status, 200);
});
