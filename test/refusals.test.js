import assert from "node:assert/strict";
import { test } from "node:test";
import { refusalSignals } from "../src/refusals.js";

test("reports of refusals are found in titles, comments and summary lines", () => {
  const r = refusalSignals({ discussions: [{ title: "Refuses to write anything spicy, says it is against its guidelines", comments: 6 }, { title: "Context length?", comments: 1 }] });
  assert.equal(r.refuses, true);
  assert.match(r.example, /against its guidelines/);
  const s = refusalSignals({ discussions: [] }, { long: ["Users: Great at coding", "Users: Refuses some prompts and lectures the user"] });
  assert.equal(s.refuses, true);
  assert.match(s.example, /Refuses some prompts/);
});

test("uncensored reports cancel weak refusal talk, and a promise in the name counts a little", () => {
  const open = refusalSignals({ name: "Llama-3-8B-Uncensored-GGUF", discussions: [{ title: "Never refuses, no guidelines nonsense", comments: 3 }, { title: "Refuses nothing", comments: 0 }] });
  assert.equal(open.refuses, false);
  const mixed = refusalSignals({ name: "x", discussions: [{ title: "This model is not uncensored at all, it still refuses", comments: 4 }] });
  assert.equal(mixed.refuses, true, "a complaint that it is not really uncensored is a refusal report");
  const quiet = refusalSignals({ name: "x", discussions: [{ title: "How much VRAM?", comments: 2 }] });
  assert.equal(quiet.refuses, false);
  assert.equal(quiet.example, null);
});

test("the summarizer refusing to summarize is not a report about the model", () => {
  const r = refusalSignals({ discussions: [] }, { long: ["Users: I can't provide information about a model that promotes explicit content."] });
  assert.equal(r.refuses, false);
});

test("praise for few refusals and a user's own trouble are not refusal reports", () => {
  assert.equal(refusalSignals({ discussions: [] }, { long: ["Users: Low refusal rate, answers everything"] }).refuses, false);
  assert.equal(refusalSignals({ discussions: [] }, { long: ["Users: Effective at removing refusals from the base model"] }).refuses, false);
  assert.equal(refusalSignals({ discussions: [{ title: "I cant use with StableDiffusionImg2ImgPipeline", comments: 3 }] }).refuses, false);
  assert.equal(refusalSignals({ discussions: [{ title: "How to remove censorship?", comments: 2 }] }).refuses, false, "a lone question is too weak");
  assert.equal(refusalSignals({ discussions: [{ title: "It says it can't help with that, against the law apparently", comments: 2 }] }).refuses, true);
});
