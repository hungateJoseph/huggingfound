import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { startStubHub } from "./stub-hub.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-review-"));
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;
const { REVIEW_MODEL, ReviewError, buildRequest, createReviewer } = await import("../src/review.js");
const { createServer } = await import("../src/server.js");

const outputDir = path.join(process.env.HUGGINGFOUND_HOME, "output");
fs.mkdirSync(outputDir, { recursive: true });
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
fs.writeFileSync(path.join(outputDir, "pic.png"), PNG);

// A stand-in for the Anthropic client: remembers the request and plays back a stream.
function fakeClient({ texts = ["Looks right."], stop = "end_turn", model = REVIEW_MODEL, fail = null } = {}) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        stream(params) {
          calls.push(params);
          return {
            async *[Symbol.asyncIterator]() {
              if (fail) throw fail;
              yield { type: "content_block_start", content_block: { type: "thinking" } };
              yield { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } };
              for (const text of texts) yield { type: "content_block_delta", delta: { type: "text_delta", text } };
            },
            finalMessage: async () => ({ stop_reason: stop, model }),
          };
        },
      },
    },
  };
}

test("a text check asks Opus with the question, the answer and the model's instructions", () => {
  const req = buildRequest({ kind: "text", model: "qwen-coder", question: "Write fizzbuzz", answer: "for i in range(15): print(i)", system: "Be terse." });
  assert.equal(req.model, "claude-opus-5");
  assert.deepEqual(req.thinking, { type: "adaptive" });
  assert.equal(req.fallbacks, "default");
  assert.deepEqual(req.betas, ["server-side-fallback-2026-07-01"]);
  assert.match(req.system, /small open-source language models/);
  const text = req.messages[0].content;
  assert.match(text, /a local model \(qwen-coder\)/);
  assert.match(text, /<request>\nWrite fizzbuzz\n<\/request>/);
  assert.match(text, /<instructions>\nBe terse\.\n<\/instructions>/);
  assert.match(text, /<answer>\nfor i in range\(15\): print\(i\)\n<\/answer>/);
  assert.equal(req.messages.length, 1);
});

test("nothing is cut from a long answer", () => {
  const answer = "x = 1\n".repeat(20000);
  assert.ok(buildRequest({ kind: "text", question: "q", answer }).messages[0].content.includes(answer));
});

test("a picture check sends the image with its description and avoid list", () => {
  const req = buildRequest({ kind: "image", model: "sd15", file: "../output/pic.png", prompt: "a lighthouse at dusk", negative: "anime" }, { outputDir });
  const [image, text] = req.messages[0].content;
  assert.deepEqual(image, { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  assert.match(text.text, /<description>\na lighthouse at dusk\n<\/description>/);
  assert.match(text.text, /<avoid>\nanime\n<\/avoid>/);
  assert.match(req.system, /Description:.*Avoid:/s);
});

test("bad requests are refused before anything is sent", () => {
  assert.throws(() => buildRequest({ kind: "text", question: "q", answer: "  " }), ReviewError);
  assert.throws(() => buildRequest({ kind: "image", file: "notes.txt" }, { outputDir }), /not a picture/);
  assert.throws(() => buildRequest({ kind: "image", file: "gone.png" }, { outputDir }), /no longer on this computer/);
  assert.throws(() => buildRequest({ kind: "video" }), /Unknown/);
  fs.writeFileSync(path.join(outputDir, "big.png"), Buffer.alloc(5 * 1024 * 1024 + 1));
  assert.throws(() => buildRequest({ kind: "image", file: "big.png" }, { outputDir }), /larger than 5 MB/);
});

test("the review streams text only, and reports the model that wrote it", async () => {
  const client = fakeClient({ texts: ["This has ", "one problem."] });
  const seen = [];
  const result = await createReviewer({ client, outputDir }).review({ kind: "text", question: "q", answer: "a" }, (t) => seen.push(t));
  assert.deepEqual(seen, ["This has ", "one problem."]);
  assert.deepEqual(result, { declined: false, model: "claude-opus-5", note: "" });
  assert.equal(client.calls.length, 1);
});

test("a declined or cut-off review says so", async () => {
  const declined = await createReviewer({ client: fakeClient({ texts: ["partial"], stop: "refusal" }) }).review({ kind: "text", question: "q", answer: "a" }, () => {});
  assert.equal(declined.declined, true);
  assert.equal(declined.discard, true);
  const cut = await createReviewer({ client: fakeClient({ stop: "max_tokens" }) }).review({ kind: "text", question: "q", answer: "a" }, () => {});
  assert.match(cut.note, /cut off/);
});

test("API failures become sentences a person can act on", async () => {
  const sdk = (await import("@anthropic-ai/sdk")).default;
  const cases = [
    [new sdk.AuthenticationError(401, {}, "bad key", new Headers()), /refused the API key/, 401],
    [new sdk.RateLimitError(429, {}, "slow down", new Headers()), /rate limiting/, 429],
    [new sdk.BadRequestError(400, {}, "image too large", new Headers()), /rejected the request/, 400],
    [new sdk.APIConnectionError({ message: "offline" }), /Could not reach Anthropic/, 502],
  ];
  for (const [fail, pattern, status] of cases) {
    await assert.rejects(
      createReviewer({ sdk, client: fakeClient({ fail }) }).review({ kind: "text", question: "q", answer: "a" }, () => {}),
      (err) => err instanceof ReviewError && pattern.test(err.message) && err.status === status,
    );
  }
});

// ---- through the server -----------------------------------------------------

let stub;
let server;
let base;
let asked;
const home = process.env.HUGGINGFOUND_HOME;
const dead = "http://127.0.0.1:1";
const common = () => ({ envFile: path.join(home, ".env"), scanFile: path.join(home, "scan.json"), voicesFile: path.join(home, "voices.json"), hubBase: stub.base, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false });
const listen = (s) => new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${s.address().port}`)));
const post = (b, p, body) => fetch(b + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

before(async () => {
  stub = await startStubHub();
  asked = [];
  server = createServer({
    ...common(),
    reviewer: {
      async review(input, onText) {
        asked.push(input);
        if (input.answer === "boom") throw new ReviewError("Anthropic refused the API key. Check it in Settings.", 401);
        onText("This is ");
        if (input.answer === "late") throw new Error("socket closed");
        onText("correct.");
        return { declined: false, model: "claude-opus-5", note: "" };
      },
    },
  });
  base = await listen(server);
});

after(() => {
  server.close();
  stub.server.close();
});

test("without a key the check explains what is missing, and the key setting is validated and masked", async () => {
  const plain = createServer(common());
  const b = await listen(plain);
  try {
    let s = await (await fetch(`${b}/api/state`)).json();
    assert.equal(s.claudeReady, false);
    assert.equal(s.claudeKey, "");
    const res = await post(b, "/api/review", { kind: "text", question: "q", answer: "a" });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /Anthropic API key in Settings/);
    assert.equal((await post(b, "/api/settings", { ANTHROPIC_API_KEY: "hello" })).status, 400);
    assert.equal((await post(b, "/api/settings", { ANTHROPIC_API_KEY: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz" })).status, 200);
    s = await (await fetch(`${b}/api/state`)).json();
    assert.equal(s.claudeReady, true);
    assert.match(s.claudeKey, /^sk-a\*+wxyz$/);
    assert.equal((await post(b, "/api/settings", { ANTHROPIC_API_KEY: "" })).status, 200);
    assert.equal((await (await fetch(`${b}/api/state`)).json()).claudeReady, false);
  } finally {
    plain.close();
  }
});

test("a check streams back as lines: the text, then how it ended", async () => {
  const res = await post(base, "/api/review", { kind: "text", model: "m", question: "q", answer: "a" });
  assert.equal(res.status, 200);
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ text: "This is " }, { text: "correct." }, { done: true, declined: false, model: "claude-opus-5", note: "" }]);
  assert.deepEqual(asked.at(-1), { kind: "text", model: "m", question: "q", answer: "a" });
});

test("a failure before any text is an error status; one after it ends the stream with the reason", async () => {
  const early = await post(base, "/api/review", { kind: "text", question: "q", answer: "boom" });
  assert.equal(early.status, 401);
  assert.match((await early.json()).error, /refused the API key/);
  const late = await post(base, "/api/review", { kind: "text", question: "q", answer: "late" });
  assert.equal(late.status, 200);
  const lines = (await late.text()).trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines, [{ text: "This is " }, { error: "The check failed: socket closed" }]);
});
