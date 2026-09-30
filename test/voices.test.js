import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-voices-"));
const { cardExcerpt, gatherVoices, headline, isFresh, searchVoices, snippetFor } = await import("../src/voices.js");
const { createHub } = await import("../src/hf.js");
const { CARDS, startStubHub } = await import("./stub-hub.js");

test("cardExcerpt keeps the prose and drops front matter, markup and code", () => {
  const text = cardExcerpt(CARDS["bartowski/Llama-3.2-3B-Instruct-GGUF"]);
  assert.equal(text, "Llama 3.2 3B Instruct A small assistant that is great for quick answers and summaries. Runs on a laptop.");
  assert.equal(cardExcerpt(CARDS["bartowski/Qwen2.5-Coder-7B-Instruct-GGUF"]), "Qwen2.5 Coder Trained on code. People use it for coding help and refactoring.");
  assert.equal(cardExcerpt("<div align=\"center\"><img src=\"x.png\"></div>\n\n| a | b |\n|---|---|\n\nHello *world*"), "Hello world");
  assert.ok(cardExcerpt("word ".repeat(1000), 100).length <= 101);
  assert.equal(cardExcerpt(null), "");
});

test("gatherVoices reads the card and the discussion list, skipping pull requests", async () => {
  const stub = await startStubHub();
  try {
    const hub = createHub({ base: stub.base });
    const v = await gatherVoices(hub, "bartowski/Llama-3.2-3B-Instruct-GGUF");
    assert.match(v.card, /great for quick answers/);
    assert.deepEqual(v.discussions.map((d) => d.num), [3, 1], "the pull request is left out");
    assert.equal(v.discussions[0].comments, 4);
    assert.ok(isFresh(v));
    assert.equal(isFresh({ at: "2020-01-01T00:00:00.000Z" }), false);
    const none = await gatherVoices(hub, "nobody/nothing");
    assert.equal(none.card, "");
    assert.deepEqual(none.discussions, []);
  } finally {
    stub.server.close();
  }
});

test("searchVoices needs every word and ranks by how often they appear", () => {
  const index = {
    "a/roleplay": { card: "A chat model.", discussions: [{ num: 1, title: "Great for roleplay", comments: 3 }, { num: 2, title: "roleplay settings", comments: 0 }] },
    "b/coder": { card: "Coding help and refactoring.", discussions: [] },
    "c/both": { card: "Used for coding and roleplay.", discussions: [] },
  };
  assert.deepEqual(searchVoices(index, "roleplay").map((h) => h.id), ["a/roleplay", "c/both"]);
  assert.deepEqual(searchVoices(index, "coding roleplay").map((h) => h.id), ["c/both"]);
  assert.deepEqual(searchVoices(index, "hentai"), []);
  assert.deepEqual(searchVoices(index, " "), []);
  const hit = searchVoices(index, "roleplay")[0];
  assert.deepEqual(hit.snippet, { from: "discussion", text: "Great for roleplay", num: 1 }, "a user's discussion title beats the author's card");
  assert.equal(searchVoices(index, "refactoring")[0].snippet.from, "card");
});

test("snippets and headlines read naturally", () => {
  const entry = { card: "One sentence here. Second sentence about hands and fingers.", discussions: [{ num: 4, title: "Blurry output at 512", comments: 2 }, { num: 5, title: "Quiet", comments: 0 }] };
  assert.equal(snippetFor(entry, ["fingers"]).from, "card");
  assert.match(snippetFor(entry, ["fingers"]).text, /hands and fingers/);
  assert.equal(snippetFor(entry, ["nothing-here"]), null);
  assert.deepEqual(headline(entry), { from: "discussion", text: "Blurry output at 512", num: 4, comments: 2 });
  assert.deepEqual(headline({ card: "First. Second.", discussions: [] }), { from: "card", text: "First." });
  assert.equal(headline(null), "");
});
