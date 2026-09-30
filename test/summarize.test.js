import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-sum-"));
const { collectVoices, extractiveSummary, modelSummary, summarize } = await import("../src/summarize.js");

const entry = {
  name: "Llama-3.2-3B-Instruct-GGUF",
  card: "Llama 3.2 3B Instruct A small assistant that is great for quick answers and summaries. Runs on a laptop. Download the GGUF from the files tab.",
  discussions: [
    { num: 3, title: "Works well for roleplay and story writing", comments: 4, comments_text: [{ author: "sam", text: "Tried it for roleplay and it keeps characters straight." }] },
    { num: 2, title: "Demo for this model on Spaces", comments: 0 },
    { num: 1, title: "Refuses some prompts and repeats itself", comments: 2 },
  ],
};

test("collectVoices keeps user words apart from the author's and drops automated threads", () => {
  const { users, author } = collectVoices(entry);
  assert.ok(users.some((u) => u.text === "Works well for roleplay and story writing"));
  assert.ok(!users.some((u) => /Demo for this model/.test(u.text)));
  assert.match(author, /great for quick answers/);
  const withWeb = collectVoices(entry, { github: [{ title: "Crashes on load", excerpt: "with the Q4" }], civitai: [{ thumbsUp: 100, thumbsDown: 2 }], civitaiPrompts: [{ prompt: "a portrait" }] });
  assert.ok(withWeb.users.some((u) => /thumbs up/.test(u.text)));
  assert.ok(withWeb.users.some((u) => /People make: a portrait/.test(u.text)));
});

test("extractiveSummary lifts opinionated lines, users first, and never quotes noise", () => {
  const s = extractiveSummary(entry);
  assert.equal(s.by, "extract");
  assert.equal(s.short.length, 2);
  assert.ok(s.short.every((l) => l.startsWith("Users: ")));
  assert.ok(s.short.some((l) => /roleplay/.test(l)));
  assert.ok(s.long.some((l) => /Refuses some prompts/.test(l)));
  assert.ok(s.long.at(-1).startsWith("Author: "), "the author's claim comes last");
  assert.ok(!s.long.some((l) => /Download the GGUF/.test(l)), "download instructions are noise");
  const quiet = extractiveSummary({ card: "A tiny test model for the unit suite.", discussions: [] });
  assert.deepEqual(quiet.short, ["Author: A tiny test model for the unit suite."]);
  assert.deepEqual(extractiveSummary({ card: "", discussions: [] }).short, []);
});

test("modelSummary asks the chat model and normalises its lines", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ message: { content: "- Users: Good at roleplay, keeps characters consistent\n* complaint: refuses some prompts\nAuthor: a small assistant for quick answers\n\n" } }) };
  };
  const s = await modelSummary("llama3.2:3b", entry, null, fetchImpl);
  assert.deepEqual(s.long, ["Users: Good at roleplay, keeps characters consistent", "Users: refuses some prompts", "Author: a small assistant for quick answers"]);
  assert.equal(s.short.length, 2);
  assert.equal(s.by, "llama3.2:3b");
  assert.equal(calls[0].body.model, "llama3.2:3b");
  assert.equal(calls[0].body.stream, false);
  assert.match(calls[0].body.messages[1].content, /Works well for roleplay/);
  assert.ok(!/sam/.test(calls[0].body.messages[0].content), "the prompt tells the model to leave names out");
});

test("summarize falls back to extractive lines when the model fails or is absent", async () => {
  const failing = async () => ({ ok: false, status: 500 });
  const s = await summarize(entry, null, { model: "x", fetchImpl: failing });
  assert.equal(s.by, "extract");
  const none = await summarize(entry, null, { model: null });
  assert.equal(none.by, "extract");
  assert.ok(none.at);
});
