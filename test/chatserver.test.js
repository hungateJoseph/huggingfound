import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-chatserver-"));
const { createServer } = await import("../src/server.js");
const { fitFor, chatServerMachine } = await import("../src/machine.js");

// A stand-in for Ollama on a rented GPU box: it holds models, pulls new
// ones with progress lines, chats and deletes.
function startStubOllama() {
  const state = { models: [{ name: "llama3.2:3b", size: 2 * 1024 ** 3 }], chats: [], pulls: [], deleted: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const data = body ? JSON.parse(body) : {};
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.9.9" }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: state.models }));
      if (req.url === "/api/pull") {
        state.pulls.push(data.model);
        const total = 4 * 1024 ** 3;
        for (const line of [{ status: "pulling manifest" }, { status: "pulling 5ee4f07cdb9b", total, completed: total / 2 }, { status: "pulling 5ee4f07cdb9b", total, completed: total / 2 + 10 }, { status: "pulling 5ee4f07cdb9b", total, completed: total }, { status: "success" }]) {
          res.write(`${JSON.stringify(line)}\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        state.models.push({ name: data.model, size: total });
        return res.end();
      }
      if (req.url === "/api/chat") {
        state.chats.push(data);
        res.write(`${JSON.stringify({ message: { role: "assistant", content: "from the server" } })}\n`);
        return res.end(`${JSON.stringify({ done: true, eval_count: 10, eval_duration: 1e9 })}\n`);
      }
      if (req.url === "/api/delete") {
        state.deleted.push(data.model);
        state.models = state.models.filter((m) => m.name !== data.model);
        return res.end("{}");
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}

let stub;
let ollama;
let server;
let base;
const home = process.env.HUGGINGFOUND_HOME;
const dead = "http://127.0.0.1:1";
const QWEN = "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF";
const PULLED = `hf.co/${QWEN}:Q4_K_M`;

before(async () => {
  stub = await startStubHub();
  ollama = await startStubOllama();
  server = createServer({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  stub.server.close();
  ollama.server.close();
});

const get = (p) => fetch(base + p);
const post = (p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const json = async (p) => (await get(p)).json();

test("a server's GPU decides the fit: wording and thresholds", () => {
  const box = chatServerMachine("http://x", 48);
  assert.equal(box.comfortableGb, 43);
  assert.match(fitFor(20, box).text, /Fits the server's 48 GB GPU \(20\.0 GB\)/);
  assert.equal(fitFor(40, box).level, "tight");
  assert.match(fitFor(60, box).text, /Too big for the server's 48 GB GPU/);
  assert.equal(chatServerMachine("http://x", "").gpuGb, 24, "a sensible default when the size is missing");
});

test("without a chat server everything is as before", async () => {
  const s = await json("/api/state");
  assert.equal(s.chatServer, null);
  assert.equal(s.runners.ollama.remote, "");
  assert.deepEqual(await json("/api/chat-server"), { configured: "", ok: false });
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.ok(plan.steps.length >= 3);
  assert.equal(plan.remote, undefined);
});

test("hidden models are kept with the settings and checked", async () => {
  assert.equal((await post("/api/settings", { HIDDEN_MODELS: ["bad id"] })).status, 400);
  assert.equal((await post("/api/settings", { HIDDEN_MODELS: ["a/b", "c/d", "a/b"] })).status, 200);
  assert.deepEqual((await json("/api/state")).hidden, ["a/b", "c/d"]);
  assert.equal((await post("/api/settings", { HIDDEN_MODELS: "c/d" })).status, 200, "a comma-separated string works too");
  assert.deepEqual((await json("/api/state")).hidden, ["c/d"]);
  assert.equal((await post("/api/settings", { HIDDEN_MODELS: [] })).status, 200);
  assert.deepEqual((await json("/api/state")).hidden, []);
});

test("the setting wants an address and the GPU's memory", async () => {
  assert.equal((await post("/api/settings", { OLLAMA_SERVER: "ssh://box", OLLAMA_SERVER_GB: "48" })).status, 400);
  const noSize = await post("/api/settings", { OLLAMA_SERVER: ollama.url });
  assert.equal(noSize.status, 400);
  assert.match((await noSize.json()).error, /GPU memory/);
  assert.equal((await post("/api/settings", { OLLAMA_SERVER: `${ollama.url}/`, OLLAMA_SERVER_GB: "48" })).status, 200);
  const s = await json("/api/state");
  assert.deepEqual(s.chatServer, { url: ollama.url, gpuGb: 48, comfortableGb: 43, rented: false, direct: false });
  assert.equal(s.runners.ollama.installed, true, "nothing to install here");
  assert.equal(s.runners.ollama.running, true);
  assert.equal(s.runners.ollama.remote, ollama.url);
  assert.deepEqual(s.runners.ollama.models, ["llama3.2:3b"]);
  assert.deepEqual(await json("/api/chat-server"), { configured: ollama.url, ok: true, version: "0.9.9", models: 1 });
});

test("a chat model's plan is one step: the server downloads it", async () => {
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.equal(plan.runnable, true);
  assert.equal(plan.remote, ollama.url);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].kind, "pull-model");
  assert.equal(plan.steps[0].done, false);
  assert.match(plan.steps[0].title, /on the chat server/);
  assert.match(plan.steps[0].text, /nothing is downloaded to this computer/);
  assert.match(plan.fit.text, /Fits the server's 48 GB GPU/);
  assert.match(plan.speed.text, /words a second/);
  assert.deepEqual(plan.tryWith, { kind: "chat", model: PULLED });
});

test("speed lines for chat models follow the server's GPU; other runners stay local", async () => {
  const s = await json("/api/state");
  const chat = s.picks.find((p) => p.runner === "ollama");
  const words = Number(/About (\d+) words?/.exec(chat.speed)[1]);
  assert.ok(words >= 20, `a GPU box is fast: ${chat.speed}`);
});

test("local Ollama steps are refused, and the download runs on the server with progress", async () => {
  for (const kind of ["install-ollama", "start-ollama"]) {
    const res = await post("/api/run", { kind });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /chat server/);
  }
  const res = await post("/api/run", { kind: "pull-model", args: { name: PULLED } });
  assert.equal(res.status, 200);
  const { id } = await res.json();
  const log = await (await get(`/api/runs/${id}`)).text();
  assert.match(log, /Downloading hf\.co\/bartowski\/Qwen2\.5-Coder-7B-Instruct-GGUF:Q4_K_M on the chat server/);
  assert.match(log, /pulling 5ee4f07cdb9b: 50% of 4\.0 GB/);
  assert.match(log, /100% of 4\.0 GB/);
  assert.equal((log.match(/50% of 4\.0 GB/g) ?? []).length, 1, "one line per percent");
  assert.match(log, /Done\./);
  assert.deepEqual(ollama.state.pulls, [PULLED]);
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.equal(plan.steps[0].done, true, "the server now holds it");
  assert.equal((await post("/api/run", { kind: "pull-model", args: { name: "bad name; rm -rf" } })).status, 400);
});

test("chat goes to the server, and its models are listed and removed there", async () => {
  const res = await post("/api/chat", { model: PULLED, messages: [{ role: "user", content: "hi" }] });
  assert.match(await res.text(), /from the server/);
  assert.equal(ollama.state.chats.at(-1).model, PULLED);
  assert.equal(ollama.state.chats.at(-1).think, undefined, "no effort knobs unless the page sends them");
  // Effort knobs pass through; anything else from the page does not.
  await post("/api/chat", { model: PULLED, messages: [{ role: "user", content: "hi" }], think: true, options: { num_predict: 400, num_ctx: "big", seed: 7 }, keep_alive: "forever" });
  const sent = ollama.state.chats.at(-1);
  assert.equal(sent.think, true);
  assert.deepEqual(sent.options, { num_predict: 400 });
  assert.equal(sent.keep_alive, undefined);
  const st = await json("/api/storage");
  assert.equal(st.ollamaRemote, ollama.url);
  assert.equal(st.ollama.length, 2);
  assert.equal(st.totalGb, 0, "models on the server take no room on this drive");
  assert.equal((await post("/api/remove", { kind: "ollama", name: PULLED })).status, 200);
  assert.deepEqual(ollama.state.deleted, [PULLED]);
});

test("a server that does not answer says so, and clearing the setting returns to this computer", async () => {
  assert.equal((await post("/api/settings", { OLLAMA_SERVER: "http://127.0.0.1:1", OLLAMA_SERVER_GB: "24" })).status, 200);
  const check = await json("/api/chat-server");
  assert.equal(check.ok, false);
  assert.ok(check.error);
  const { plan } = await json(`/api/model?id=${QWEN}`);
  assert.match(plan.steps[0].text, /not answering right now/);
  assert.equal((await post("/api/settings", { OLLAMA_SERVER: "" })).status, 200);
  const s = await json("/api/state");
  assert.equal(s.chatServer, null);
  assert.ok((await json(`/api/model?id=${QWEN}`)).plan.steps.length >= 3);
});
