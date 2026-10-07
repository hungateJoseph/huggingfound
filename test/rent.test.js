import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";
import { startStubOllama } from "./stub-ollama.js";
import { KEY, startStubRunpod } from "./stub-runpod.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-rent-"));
const { createServer } = await import("../src/server.js");
const { createRental, TIERS, tierFor } = await import("../src/rent.js");
const { readEnv, writeEnv } = await import("../src/envfile.js");

// Renting a GPU by the hour: HuggingFound asks RunPod for a machine with
// Ollama on it, makes it the chat server, watches it start, stops it when
// idle or on request, and deletes it. The stub RunPod moves a pod along one
// state per poll; the stub Ollama plays the machine's Ollama behind the
// proxy address.

let stub;
let runpod;
let ollama;
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
  server = createServer({ envFile, scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => ollama.url, idleWatch: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
  runpod.server.close();
  ollama.server.close();
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
  assert.equal(by[24].gpu.name, "RTX 4090", "the cheaper A5000 has no capacity");
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
  assert.equal(made.image, "ollama/ollama");
  assert.equal(made.name, "huggingfound");
  assert.deepEqual(made.gpu, { id: "NVIDIA A40", count: 1 });
  assert.equal(made.cloud, "SECURE");
  assert.deepEqual(made.ports, ["11434/http"]);
  assert.equal(made.env.OLLAMA_HOST, "0.0.0.0");
  assert.deepEqual(made.mounts, { persistent: { size: 60, path: "/root/.ollama" } });
  const saved = readEnv(envFile);
  assert.equal(saved.RUNPOD_POD_ID, r.id);
  assert.equal(saved.OLLAMA_SERVER, ollama.url);
  assert.equal(saved.OLLAMA_SERVER_GB, "48");
  const s = await json("/api/state");
  assert.deepEqual(s.chatServer, { url: ollama.url, gpuGb: 48, comfortableGb: 43, rented: true, direct: false });
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

test("stopping ends the charge and frees the chat server; starting brings both back", async () => {
  const stopped = await (await post("/api/rent/stop", {})).json();
  assert.equal(stopped.rented, true);
  assert.equal(stopped.status, "EXITED");
  assert.deepEqual(runpod.state.actions, [`${stopped.id}:stop`]);
  let s = await json("/api/state");
  assert.equal(s.chatServer, null, "chat models go back to this computer while it is stopped");
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

test("the idle watch stops a machine nobody has used, but not during a download or when turned off", async () => {
  let clock = 1_000_000_000_000;
  const file = path.join(home, "idle.env");
  writeEnv(file, { RUNPOD_API_KEY: KEY, RUNPOD_IDLE_MINUTES: "20" });
  const rental = createRental({ env: () => readEnv(file), save: (u) => writeEnv(file, u), base: runpod.base, proxyUrl: () => ollama.url, now: () => clock });
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
