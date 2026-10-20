import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-settings-"));
const { settingsAdvice, settingsLines, wantedSettings, givesSetting } = await import("../src/settings.js");
const { cleanSummary, extractiveSummary } = await import("../src/summarize.js");

const find = (advice, id) => advice.find((e) => e.id === id);

test("a card's recommended settings are read, with who said them", () => {
  const advice = settingsAdvice({
    users: [{ text: "Works great at 30 steps with DPM++ 2M Karras, cfg 4.5." }],
    author: "Recommended settings - Resolution: 1024 x 1024 - Sampling steps: 30 - CFG scale: 4.5 - Use a negative prompt for hands.",
  });
  assert.deepEqual(find(advice, "steps").values, { 30: 2 });
  assert.equal(find(advice, "steps").users, 1);
  assert.equal(find(advice, "steps").author, 1);
  assert.deepEqual(find(advice, "cfg").values, { 4.5: 2 });
  assert.deepEqual(find(advice, "sampler").values, { "DPM++ 2M": 1 });
  assert.deepEqual(find(advice, "scheduler").values, { Karras: 1 });
  assert.deepEqual(find(advice, "size").values, { "1024 by 1024": 1 });
  assert.ok(find(advice, "negative"));
});

test("questions count as asking, and numbers about training or measuring are not advice", () => {
  const advice = settingsAdvice({
    users: [{ text: "What are the recommended CFG, steps and samplers?" }, { text: "Temperature, etc?" }],
    author: "Fine-tuned for 595 steps at resolution 512x512. Evaluated with llama-perplexity at context 2048, greedy decoding (temp=0.0).",
  });
  assert.equal(find(advice, "cfg").asked, 1);
  assert.deepEqual(find(advice, "cfg").values, {});
  assert.equal(find(advice, "temperature").asked, 1);
  assert.equal(find(advice, "size"), undefined);
  assert.equal(find(advice, "context"), undefined);
  assert.equal(find(advice, "steps")?.values?.[595], undefined);
});

test("image advice is put in HuggingFound's terms: presets, Avoid, and what cannot be set", () => {
  const advice = settingsAdvice({ users: [], author: "Recommended: 30 steps, cfg 4.5, Euler a sampler, 1024 x 1024. Use a negative prompt." });
  const lines = settingsLines(advice, "images");
  assert.ok(lines.includes("In HuggingFound: The author suggests 30 steps; pick Max, which uses 40."), lines.join("\n"));
  assert.ok(lines.includes("In HuggingFound: The author suggests Euler a; pick Default, which uses it."));
  assert.ok(lines.includes("In HuggingFound: The author suggests a negative prompt; type it in Avoid."));
  assert.ok(lines.includes("Not here yet: The author suggests CFG 4.5; HuggingFound uses 7, or 1 on Turbo-type models."));
  assert.ok(lines.includes("Not here yet: The author suggests 1024 by 1024; HuggingFound picks 512 or 768 by itself."));
  // A distilled model's few steps point at Fast, which uses 4 on such models.
  assert.match(settingsLines(settingsAdvice({ author: "Use 6-8 steps." }), "images")[0], /6–8 steps; Fast uses 4 on Turbo/);
  // Video steps follow the quality level.
  assert.match(settingsLines(settingsAdvice({ author: "Use 30 steps." }), "video")[0], /Low, Medium and High levels set the steps/);
});

test("chat advice: sampling settings share one line, Effort and the system message are named", () => {
  const advice = settingsAdvice({
    users: [{ text: "Set temperature 0.6 and top p 0.95, it works best." }],
    author: "Recommended sampling: temperature=0.6, top p=0.95, top k=20. Use this system prompt for roleplay. Thinking mode on with enable_thinking=true. We recommend the Q6 K for 16 GB cards. Context of 32k at least.",
  });
  const lines = settingsLines(advice, "text");
  assert.ok(lines.includes("Not here yet: Users and the author suggest temperature 0.6, top p 0.95, top k 20; the chat has no sampling controls."), lines.join("\n"));
  assert.ok(lines.includes("In HuggingFound: The author suggests a system prompt; put it in the chat's system message."));
  assert.ok(lines.includes("In HuggingFound: The author suggests thinking on; pick Thorough Effort."));
  assert.ok(lines.some((l) => l === "Not here yet: The author suggests Q6_K; HuggingFound downloads Q4_K_M when there is one."));
  // The quant HuggingFound already takes is not something missing.
  assert.match(settingsLines(settingsAdvice({ author: "Q4 K M is recommended for most people." }), "text")[0], /^In HuggingFound: .*Q4_K_M; HuggingFound downloads it/);
  // At most three of each kind of line.
  assert.ok(lines.filter((l) => l.startsWith("Not here yet")).length <= 3);
});

test("settings for another kind of model, or that need the kind, are left out", () => {
  const advice = settingsAdvice({ author: "Use 30 steps and cfg 5. Set language: de for German audio. Use ChatML format." });
  assert.ok(settingsLines(advice, "text").every((l) => !/steps|CFG/.test(l)));
  assert.ok(settingsLines(advice, "speech").some((l) => /language de; whisper.cpp is run assuming English/.test(l)));
  // Without a kind, words that mean other things elsewhere stay out.
  assert.ok(settingsLines(advice, null).every((l) => !/language|ChatML/i.test(l)));
});

test("a summary shows the settings lines after the opinions, and the card never shows Not here yet", () => {
  const summary = extractiveSummary({
    name: "Some-SDXL",
    card: "A realistic SDXL model. Recommended: 25 steps, cfg 5.",
    discussions: [{ num: 1, title: "Amazing realistic portraits, best model I have tried", comments: 3 }, { num: 2, title: "Hands are blurry and broken sometimes", comments: 2 }],
  });
  assert.ok(Array.isArray(summary.settings));
  const shown = cleanSummary(summary, "images");
  assert.match(shown.long[0], /^Users:/);
  assert.ok(shown.long.includes("In HuggingFound: The author suggests 25 steps; pick Default, which uses 20."), shown.long.join("\n"));
  assert.ok(shown.long.some((l) => l.startsWith("Not here yet: The author suggests CFG 5")));
  assert.ok(shown.short.every((l) => !l.startsWith("Not here yet")));
  // The sentence that is only settings is not an opinion.
  assert.ok(!shown.long.some((l) => /^(Users|Author):.*cfg 5/i.test(l)));
  assert.equal(givesSetting("Recommended: 25 steps, cfg 5."), true);
  assert.equal(givesSetting("What CFG should I use?"), false);
  // Cleaning twice gives the same lines, and an old summary with no advice shows none.
  assert.deepEqual(cleanSummary(shown, "images").long, shown.long);
  assert.ok(cleanSummary({ long: ["Users: Great."] }, "images").long.length === 1);
});

test("wantedSettings tallies what HuggingFound cannot set, most models first, and skips what it can", () => {
  const entries = [
    { id: "a/img", kind: "images", settings: settingsAdvice({ author: "Use cfg 3.5 and 30 steps. Use a negative prompt." }) },
    { id: "b/img", kind: "images", settings: settingsAdvice({ author: "CFG scale: 4, DPM++ 2M Karras." }) },
    { id: "c/chat", kind: "text", settings: settingsAdvice({ users: [{ text: "Use temperature 0.7, works best." }] }) },
  ];
  const wanted = wantedSettings(entries);
  assert.equal(wanted[0].setting, "CFG");
  assert.equal(wanted[0].models, 2);
  assert.deepEqual(wanted[0].examples, ["a/img", "b/img"]);
  assert.match(wanted[0].build, /CFG field/);
  assert.ok(wanted.some((r) => r.setting === "temperature" && r.support === "no"));
  // Steps are a preset, still listed, after everything missing outright.
  assert.equal(wanted.at(-1).setting, "steps");
  assert.equal(wanted.at(-1).support, "preset");
  // A negative prompt, DPM++ 2M and Karras are all things HuggingFound does.
  assert.ok(!wanted.some((r) => ["negative prompt", "sampler", "scheduler"].includes(r.setting)));
});
