// Drives the page in a real Chrome against a stand-in Hub: scans, switches
// categories, filters, opens a model and its plan, saves a token, checks the
// gated flow. Nothing is installed or downloaded. Run with
// `npm run test:browser` after `npm install`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { MODELS, startStubHub } from "../stub-hub.js";
import { startStubAgent } from "../stub-agent.js";
import { startStubOllama } from "../stub-ollama.js";
import { KEY as RUNPOD_KEY, startStubRunpod } from "../stub-runpod.js";
import { VAST_KEY, startStubVast } from "../stub-vast.js";

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-browser-"));
const { createServer } = await import("../../src/server.js");

const stub = await startStubHub();
// Renting a GPU is played by a stand-in RunPod, and the rented machine's
// Ollama by a stand-in that answers at the proxy address.
const runpod = await startStubRunpod();
const rentedOllama = await startStubOllama();
const rentedAgent = await startStubAgent();
const vast = await startStubVast({ agentPort: () => new URL(rentedAgent.url).port, ollamaPort: () => new URL(rentedOllama.url).port });
// The agent on a rented machine answers only with the secret it was started
// with: every call, from the page or the site, has to carry it.
rentedAgent.state.token = () => Object.values(runpod.state.pods).map((p) => p.env?.HF_AGENT_TOKEN).filter(Boolean);
const envFile = path.join(process.env.HUGGINGFOUND_HOME, ".env");
const scanFile = path.join(process.env.HUGGINGFOUND_HOME, "scan.json");
const dead = "http://127.0.0.1:1";
// Ollama is not installed here; its chat endpoint is answered by a slow
// stand-in so the chat box can be driven while a reply is still arriving.
const REPLY_WORDS = 40;
const chatBodies = [];
const fetchImpl = (url, init) => {
  if (String(url).endsWith("/api/chat")) {
    const asked = JSON.parse(init.body);
    chatBodies.push(asked);
    const stream = new ReadableStream({
      async start(controller) {
        // Asked to think, it thinks first, apart from its answer, as Qwen3 does.
        if (asked.think === true) {
          for (let i = 0; i < 10; i++) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: "", thinking: `step${i} ` } })}\n`));
            await new Promise((r) => setTimeout(r, 60));
          }
        }
        // A model that thinks for its whole budget and never answers; asked again from its notes, it answers.
        if (/think forever/.test(asked.messages.at(-1)?.content ?? "") && asked.think !== false) {
          for (let i = 0; i < 10; i++) controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: "", thinking: `step${i} ` } })}\n`));
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, done_reason: "length", eval_count: 10, eval_duration: 1e9 })}\n`));
          controller.close();
          return;
        }
        // A model that closes its thinking and stops without a word; asked again from its notes, it answers.
        if (/think then hush/.test(asked.messages.at(-1)?.content ?? "") && asked.think !== false) {
          for (let i = 0; i < 4; i++) controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: "", thinking: `quiet${i} ` } })}\n`));
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: "" }, done: true, done_reason: "stop", eval_count: 4, eval_duration: 1e9 })}\n`));
          controller.close();
          return;
        }
        if (/^Stop thinking and answer now/.test(asked.messages.at(-1)?.content ?? "")) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: "answered from notes" } })}\n`));
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, eval_count: 3, eval_duration: 1e9 })}\n`));
          controller.close();
          return;
        }
        if (/HANDOFF TO CLAUDE/.test(asked.messages.at(-1)?.content ?? "")) {
          const answer = "I can do the board and the tiles; the mine odds are hard for me, so I leave them to Claude.\n```js\nfunction mineOdds(board) {\n  // HANDOFF TO CLAUDE: mineOdds\n  // Returns, for each hidden cell, the chance it holds a mine.\n}\nconsole.log(mineOdds([[0]]));\n```";
          for (const piece of answer.match(/[\s\S]{1,20}/g)) controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: piece } })}\n`));
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, eval_count: 60, eval_duration: 2e9 })}\n`));
          controller.close();
          return;
        }
        for (let i = 0; i < REPLY_WORDS; i++) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ message: { role: "assistant", content: `word${i} ` } })}\n`));
          await new Promise((r) => setTimeout(r, 60));
        }
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify({ done: true, eval_count: REPLY_WORDS, eval_duration: 2e9 })}\n`));
        controller.close();
      },
    });
    return Promise.resolve(new Response(stream, { status: 200 }));
  }
  return fetch(url, init);
};
// Claude's check is answered by a stand-in that remembers what it was sent.
const reviewed = [];
const reviewer = {
  async review(input, onText) {
    reviewed.push(input);
    // An expansion comes back as the words with more in them.
    if (input.mode === "expand" && /declined please/.test(input.prompt)) return { declined: true, discard: false, model: "claude-opus-5", note: "Claude declined to expand this one." };
    if (input.mode === "expand") {
      onText(`${input.prompt}, in golden light, a slow pan`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // How a LoRA's creator uses it, from their notes and showcase prompts.
    if (input.mode === "lora") {
      onText(`Strength: ${input.lora.strength || "1"}, as the creator says\nPrompt: start with ${input.lora.trigger?.[0] ?? "the trigger word"} and describe one continuous movement, as the showcase does\nSettings: 30 steps, guidance 1`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // A better description for what was typed: the motion spelt out, the unwanted moved to the avoid list.
    if (input.mode === "suggest" && input.loras?.length) {
      onText(`Description: ${input.loras[0].trigger?.[0] ?? "mvmt"}, ${input.prompt.replace(/^show this man /, "the man as in the picture ")} in one continuous movement, medium shot, camera still, as the showcase describes it.\nAvoid: ${input.negative ? `${input.negative}, a tangled rope` : "nothing"}\nStrength: ${input.loras[0].name} = 0.7\nSettings: 30 steps, guidance 1\nWhy: Written in the shape of the showcase prompts with the trigger word first, at the strength the creator recommends.`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    if (input.mode === "suggest") {
      onText(`Description: a woman in a bright gym doing jumping jacks in bare feet, feet apart as her hands meet overhead, then together as her arms come down; medium shot, camera still, whole body in frame.${input.image ? " She stays as she is in the picture." : ""}\nAvoid: socks, shoes, zooming in, closed eyes\nWhy: Spelt out the motion and moved what you did not want into the avoid list, since the model cannot read "not".`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // One shot changed as asked, and all the shots changed as asked.
    if (input.mode === "revise") {
      onText(`Description: ${input.prompt.replace(/, sunny back garden$/, "")}, the arm in one slow arc, sunny back garden\nAvoid: ${input.negative ? `${input.negative}, ` : ""}a stiff arm\nChanged: the arm's motion is spelt out.`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    if (input.mode === "revise-all") {
      onText(`${input.shots.map((x) => `Shot ${x.index} (${x.seconds} s): ${x.text}, at dusk\nAvoid: ${[x.negative, "bright daylight"].filter(Boolean).join(", ")}`).join("\n")}\nChanged: every shot is now at dusk.`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // A scene as shots, each with its length and its own words; one that
    // cannot be laid out comes back without Shot lines.
    if (input.mode === "scene") {
      if (/no shots please/.test(input.prompt)) onText("I cannot lay this one out as shots.");
      // Shown a photo of the person, no shots; told of it instead, the shots keep them as in the picture.
      else if (/shy with the picture/.test(input.prompt) && input.image) onText("I would rather not describe this particular person from the photo.");
      else if (/shy with the picture/.test(input.prompt)) onText(`Shot 1 (4 s): the woman as in the picture, in the same clothes and place, pulls her sweater up and over her head, camera still${input.pictureUnseen ? ", the picture's setting kept" : ""}\nShot 2 (4 s): the same woman as in the picture folds the sweater and sets it down, the place unchanged\nNote: the person and place are taken as they are in the picture.`);
      // The lines as a model dresses them: bold, a bullet, "seconds", a range as a running time, and a closing note.
      // Each shot with its own avoid list, one of them empty.
      else onText("Shot 1 (4 s): a man in a grey T-shirt bounces on a trampoline in a sunny back garden, camera still\nAvoid: a second person, a flip\n**Shot 2 (3 seconds):** the same man in the grey T-shirt does a front flip and lands flat on his face on the trampoline, sunny back garden\n**Avoid:** nothing\n- Shot 3 (7–12 s) – the man in the grey T-shirt does a backflip and lands on his feet on the trampoline; the camera pans to his elderly father applauding at the garden fence\nAvoid: a second trampoline\nNote: the father is in frame from the first shot.");
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // Coding: the hard parts named, the code checked and fixed, the handed-off parts written.
    if (input.kind === "code" && input.mode === "handoff-plan") {
      onText("Part: mineOdds | the chance each hidden cell holds a mine | constraint counting is easy to get wrong\nPart: wordScore | Scrabble scoring with premium squares | many exact rules");
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    if (input.kind === "code" && input.mode === "fix") {
      onText("Found:\n- mineOdds returns nothing, so the log prints undefined\n=== Corrected ===\n```js\nfunction mineOdds(board) {\n  return board.map((row) => row.map(() => 0));\n}\n```");
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    if (input.kind === "code" && input.mode === "finish") {
      // A while before the first word, as Claude thinks first.
      await new Promise((r) => setTimeout(r, 4500));
      onText("Wrote:\n- mineOdds: counts the constraints around each number\n=== Finished ===\n```js\nfunction mineOdds(board) {\n  return board.map((row) => row.map(() => 0.5));\n}\nconsole.log(mineOdds([[0]]));\n```");
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // A shot made shorter by hand, fitted to its new length, with what had to go.
    if (input.mode === "fit") {
      onText(`Description: ${input.prompt.split(",")[0]}, camera still\nDropped: the bow at the end`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // A fix to a pieced clip: which shot to make again, with its words, and whether the rest follow.
    if (input.mode === "fix") {
      if (/no idea/.test(input.request)) onText("I cannot tell which shot from this.");
      else onText(`Shot 2: ${input.shots[1].text}, his wife beside him in a big orange hat\nCarry: ${/from the second shot on/.test(input.request) ? "yes" : "no"}\nWhy: the hat was left out of shot 2.`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    // The next shot: what happens next, as the scene goes on.
    if (input.mode === "continue") {
      onText(`${input.request.replace(/^ok, now /, "")}, the scene going on`);
      return { declined: false, model: "claude-opus-5", note: "" };
    }
    onText("This has one problem.\n");
    await new Promise((r) => setTimeout(r, 150));
    onText("word7 is not a word.");
    return { declined: false, model: "claude-opus-5", note: "" };
  },
};
const server = createServer({ envFile, scanFile, hubBase: stub.base, fetchImpl, reviewer, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => rentedOllama.url, runpodAgent: () => rentedAgent.url, runpodImageCheck: async () => true, runpodStatusTtl: 0, runpodBudget: { minute: 600, hour: 5000 }, vastBase: vast.base, vastTunnelCheck: (u) => /^http:\/\/127\.0\.0\.1:\d+$/.test(u), idleWatch: false });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
// Deliberate 400s (a rejected setting) log as resource errors; those are not page bugs.
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
// Confirm prompts are dismissed unless a step says otherwise.
let acceptDialogs = false;
page.on("dialog", (d) => (acceptDialogs ? d.accept() : d.dismiss()));

let failed = 0;
// The kind of clip: Short clip or Scene by tab, and inside a scene,
// Claude's shots or the words in pieces.
async function pickKind(p, kind) {
  await p.click(`.clip-tab[data-kind=${kind === "short" ? "short" : "scene"}]`);
  if (kind !== "short" && !(await p.isChecked(`#clip-kind input[value=${kind}]`))) await p.click(`#clip-kind input[value=${kind}]`);
}

// Settings open with only the rental section unfolded; the tests unfold the rest.
async function openSettings(p = page) {
  await p.click("#open-settings");
  await unfoldSettings(p);
}
const unfoldSettings = (p = page) => p.$$eval("#settings details", (ds) => ds.forEach((d) => (d.open = true)));

async function step(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    const where = (err.stack ?? "").split("\n").find((l) => /scan\.mjs:\d+/.test(l)) ?? "";
    console.log(`FAIL ${name}\n     ${err.message.split("\n").slice(0, 12).join("\n     ")}\n     ${where.trim()}`);
    // Close whatever the failed step left open and reset the filters, so the next steps start clean.
    await page.keyboard.press("Escape").catch(() => {});
    await page.evaluate(() => {
      for (const [id, value] of [["#since", "0"], ["#sort", "trending"]]) {
        const el = document.querySelector(id);
        if (el && el.value !== value) {
          el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
      const runnable = document.querySelector("#only-runnable");
      if (runnable && !runnable.checked) runnable.click();
    }).catch(() => {});
  }
}

await page.goto(base);
await page.waitForSelector("#trait");

await step("the page opens on a single search box", async () => {
  assert.equal(await page.locator("#trait").isVisible(), true);
  assert.equal(await page.locator("#browse").isVisible(), false, "the lists stay out of the way");
  assert.equal(await page.locator("#results").isVisible(), false);
  assert.match(await page.locator("#home-hint").innerText(), /No scan yet/);
  // Under the search, why to use it: the outage case first, then the rest; gone once a search is up.
  // The examples are the kinds of work a team would own up to.
  assert.deepEqual(await page.$$eval("#examples .chip", (els) => els.map((e) => e.textContent)), ["coding help", "summarize documents", "transcribe meetings", "product photos", "video clips", "math and reasoning", "creative writing"]);
  // Two flowcharts under the search: a day's work handed from model to model, and where it runs.
  assert.equal(await page.locator("#flow").isVisible(), true);
  assert.equal(await page.locator("#flow-title").innerText(), "A day's work, on open models");
  assert.deepEqual(await page.$$eval("#flow .node .label:not(.sub)", (els) => els.map((e) => e.textContent)), ["Hugging Face", "Notes model", "Coding model", "Video model"]);
  assert.equal(await page.$eval("#flow .pill text", (e) => e.textContent), "Assigned: the export script, with tests");
  assert.equal(await page.locator("#runs-title").innerText(), "Where it runs");
  assert.deepEqual(await page.$$eval("#runs .node .label:not(.sub)", (els) => els.map((e) => e.textContent)), ["HuggingFound", "Your computer", "A rented GPU", "Your paid model, optional"]);
  assert.equal(await page.locator("#flow .flow-art").isVisible(), true, "the drawing at desktop width");
  assert.equal(await page.locator("#why").isVisible(), true);
  assert.equal(await page.locator("#why-title").innerText(), "Why use HuggingFound?");
  assert.deepEqual(await page.$$eval("#why .reason h3", (els) => els.map((e) => e.textContent)), ["When the service everyone relies on goes down", "Every kind of model in one place", "Runs where you choose", "Know a model before you fetch it", "Yours to keep"]);
  assert.match(await page.locator("#why .lead-reason").innerText(), /One morning it stops answering, the status page says nothing[\s\S]*runs on your own computer or on a GPU rented by the minute/);
  await page.click("#examples [data-example='coding help']");
  await page.waitForSelector("#found .model");
  assert.equal(await page.locator("#results").isVisible(), true);
  assert.equal(await page.locator("#why").isVisible(), false, "the reasons step aside for the results");
  assert.equal(await page.locator("#flow").isVisible(), false, "and so do the flowcharts");
  assert.match(await page.locator("#found-title").innerText(), /coding help/i);
  const names = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.ok(names.includes("Qwen2.5-Coder-7B-Instruct-GGUF"), "the curated coding pick answers before any scan");
  // A search for a kind of output leads with the models that make it,
  // the strongest first, and the Order control can reorder what was found.
  await page.fill("#trait", "video generation");
  await page.click("#trait-go");
  await page.waitForFunction(() => /video generation/.test(document.querySelector("#found-title").textContent));
  await page.waitForSelector("#found .model");
  const videos = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(videos.slice(0, 5), ["Wan2.2-T2V-A14B", "Wan2.2-TI2V-5B-Diffusers", "LTX-2.5", "LTX-2.5-Diffusers", "stable-video-diffusion-img2vid"], "the stronger video families first, the far more liked old one last, chat models after all of them");
  assert.equal(await page.locator("#found-sort").inputValue(), "match");
  await page.selectOption("#found-sort", "likes");
  const byLikes = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(byLikes.slice(0, 2), ["LTX-2.5", "stable-video-diffusion-img2vid"], "by users' opinion the most liked lead, and video models still come before the rest");
  assert.equal(await page.locator("#found-sort").inputValue(), "likes");
  await page.selectOption("#found-sort", "match");
  await page.fill("#trait", "");
  await page.click("#trait-go");
  await page.waitForFunction(() => document.querySelector("#results").hidden);
});

await page.click("#nav-browse");
await page.waitForSelector("#picks .model");

await step("browse shows the easy list with the curated picks", async () => {
  assert.match(await page.locator("#machine-line").innerText(), /GB memory/);
  assert.match(await page.locator(".tab.on").innerText(), /Easy to set up/);
  assert.ok((await page.locator("#picks .model").count()) >= 5);
  assert.match(await page.locator("#scan-status").innerText(), /No scan yet/);
  assert.equal(await page.locator("#scan-title").isVisible(), false);
});

await step("a scan fills the categories from the hub", async () => {
  await page.click("#scan");
  await page.waitForSelector("#scan-title:not([hidden])");
  assert.match(await page.locator("#scan-status").innerText(), new RegExp(`${MODELS.length} models`));
  assert.match(await page.locator("#models .model .speed").first().innerText(), /About/);
  const names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.ok(names.includes("Llama-3.2-3B-Instruct-GGUF"));
  assert.ok(!names.includes("Llama-3.1-8B-Instruct"), "python-only models stay hidden while the runnable filter is on");
});

await step("turning the runnable filter off shows Python-only models with their runner", async () => {
  await page.uncheck("#only-runnable");
  await page.click(".tab[data-tab=chat]");
  const card = page.locator("#models .model", { hasText: "Llama-3.1-8B-Instruct" });
  await card.waitFor();
  assert.match(await card.innerText(), /Gated/);
  assert.match(await card.innerText(), /Python \+ transformers/);
  await page.check("#only-runnable");
});

await step("categories and the name filter narrow the list", async () => {
  await page.click(".tab[data-tab=speech]");
  const names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["whisper.cpp"]);
  await page.click(".tab[data-tab=images]");
  assert.ok((await page.locator("#models .model").count()) >= 1);
  await page.fill("#search", "zzzz");
  await page.waitForSelector("#empty:not([hidden])");
  assert.match(await page.locator("#empty").innerText(), /Nothing matches/);
  await page.fill("#search", "");
});

await step("Browse has no adult tabs; adult models stay in their own category with an 18+ mark, and sorting and recency work", async () => {
  const tabs = await page.$$eval("#tabs .tab", (els) => els.map((e) => e.dataset.tab));
  assert.deepEqual(tabs, ["easy", "chat", "coding", "math", "vision", "images", "speech"]);
  await page.click(".tab[data-tab=images]");
  let names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.ok(names.includes("pony-realism-v23-sdxl"), "still listed under Makes images");
  await page.click(".tab[data-tab=chat]");
  names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.ok(names.includes("Cydonia-24B-v2-GGUF"), "still listed under Chat and writing");
  assert.match(await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).locator(".pill.adult").innerText(), /18\+/);

  await page.selectOption("#sort", "capable");
  names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.equal(names[0], "Cydonia-24B-v2-GGUF", "the biggest chat model first when sorted by capability");
  await page.selectOption("#sort", "likes");
  names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.equal(names[0], "Polite-Chat-7B-GGUF", "most liked runnable chat model first");
  await page.selectOption("#since", "30");
  names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["Cydonia-24B-v2-GGUF"], "only the model released this month");
  assert.equal(await page.locator("#picks-title").isVisible(), false, "curated picks step aside for a recency filter");
  await page.selectOption("#since", "0");
  await page.selectOption("#sort", "trending");
});

await step("a trait search asks the hub and lists what it finds", async () => {
  await page.fill("#trait", "whisper");
  await page.click("#trait-go");
  await page.waitForSelector("#found .model");
  // The title renders in capitals; innerText follows the CSS.
  assert.match(await page.locator("#found-title").innerText(), /whisper/i);
  let names = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["whisper.cpp"], "the runnable filter hides the Python-only one");
  await page.uncheck("#only-runnable");
  names = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names.sort(), ["whisper-large-v3", "whisper.cpp"]);
  await page.check("#only-runnable");
  await page.fill("#trait", "");
  await page.click("#trait-go");
  await page.waitForFunction(() => document.querySelector("#results").hidden);
});

await step("gathering what people say puts summary lines on cards, with More to expand", async () => {
  await page.click("#gather-voices");
  await page.waitForFunction(() => /Gathered for \d+ models/.test(document.querySelector("#voices-status").textContent));
  await page.click(".tab[data-tab=easy]");
  const card = page.locator("#models .model", { hasText: "Llama-3.2-3B-Instruct-GGUF" });
  assert.match(await card.locator(".said").innerText(), /roleplay/i);
  assert.match(await card.locator(".said .line").first().innerText(), /^Users/);
  await card.locator("button[data-more]").click();
  await card.locator(".expanded:not([hidden])").waitFor();
  assert.match(await card.locator(".expanded").innerText(), /Open the model for every source/);
  assert.equal(await page.locator("#modal").isVisible(), false, "More does not open the model window");
  await card.locator("button[data-more]").click();
  assert.equal(await card.locator(".expanded").isVisible(), false);
});

await step("one search box finds models by name and by what people say", async () => {
  await page.fill("#trait", "rust coding");
  await page.click("#trait-go");
  await page.waitForSelector("#found .model");
  const names = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.equal(names[0], "Qwen2.5-Coder-7B-Instruct-GGUF", "the model whose users mention Rust ranks first");
  assert.match(await page.locator("#found .model").first().locator(".said").innerText(), /rust/i);
  await page.fill("#trait", "chat");
  await page.click("#trait-go");
  await page.waitForSelector("#toggle-refusing");
  assert.match(await page.locator("#found-hint").innerText(), /hidden: users report refusals/);
  assert.equal(await page.locator("#found .model", { hasText: "Polite-Chat-7B-GGUF" }).count(), 0, "hidden by default");
  await page.click("#toggle-refusing");
  await page.locator("#found .model", { hasText: "Polite-Chat-7B-GGUF" }).waitFor();
  assert.match(await page.locator("#found .model", { hasText: "Polite-Chat-7B-GGUF" }).innerText(), /Users report refusals/);
  await page.click("#toggle-refusing");
  await page.waitForFunction(() => document.querySelectorAll("#found .model").length > 0 && !document.querySelector("#found .model .pill.no"));
  assert.equal(await page.locator("#web-found").isVisible(), true, "outside sources are listed, collapsed");
  assert.match(await page.locator("#web-found-summary").innerText(), /also mentioned elsewhere/i);
  await page.click("#web-found-summary");
  assert.match(await page.locator("#reddit-note").innerText(), /app id in Settings/);
  assert.match(await page.locator("#youtube-note").innerText(), /API key in Settings/);
  assert.match(await page.locator("#github-note").innerText(), /did not answer/, "the unreachable stub is reported, not hidden");
  await page.fill("#trait", "zzzqqq");
  await page.click("#trait-go");
  await page.waitForSelector("#found-empty:not([hidden])");
  assert.match(await page.locator("#found-empty").innerText(), /Nothing matches/);
  await page.fill("#trait", "");
  await page.click("#trait-go");
  await page.waitForFunction(() => document.querySelector("#results").hidden);
});

await step("opening a model shows its plan with the install, start and pull steps", async () => {
  await page.click(".tab[data-tab=easy]");
  await page.locator("#models .model", { hasText: "Llama-3.2-3B-Instruct-GGUF" }).locator(".name").click();
  await page.waitForSelector("#steps .step");
  const titles = await page.$$eval("#steps .step .title", (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, ["Install Ollama", "Start Ollama", "Download the model (2.0 GB)"]);
  // One step on show at a time: the rest wait until it is done.
  assert.deepEqual(await page.$$eval("#steps .step", (els) => els.map((e) => e.hidden)), [false, true, true]);
  assert.equal(await page.locator("#steps .steps-later").innerText(), "Then 2 more steps, shown when this one is done.");
  assert.match(await page.locator("#modal-body .facts").innerText(), /Q4_K_M\.gguf/);
  assert.match(await page.locator("#modal-body .facts").innerText(), /words a second/i);
  assert.match(await page.locator("#steps .step code").first().innerText(), /ollama/);
  assert.match(await page.locator("#try").innerText(), /Run the steps above/);
  await page.waitForFunction(() => /roleplay and story writing/.test(document.querySelector("#voices")?.textContent ?? ""));
  assert.match(await page.locator("#voices").innerText(), /keeps characters straight/);
});

await step("running a step asks first, and a dismissed prompt runs nothing", async () => {
  const before = stub.requests.length;
  await page.locator("#steps .step .go").first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator("#steps .step.running").count(), 0);
  assert.equal(stub.requests.length, before);
  await page.click("#close-modal");
});

await step("a gated model explains the token and links to the model page", async () => {
  await page.uncheck("#only-runnable");
  await page.click(".tab[data-tab=chat]");
  await page.locator("#models .model", { hasText: "Llama-3.1-8B-Instruct" }).locator(".name").click();
  await page.waitForSelector("#modal-body .notice");
  assert.match(await page.locator("#modal-body .notice").innerText(), /gated/i);
  assert.equal(await page.locator("#open-settings-from-model").isVisible(), true);
  await page.click("#close-modal");
  await page.check("#only-runnable");
});

await step("saving a token masks it and it lands in the env file", async () => {
  await openSettings();
  await page.waitForSelector("#settings:not([hidden])");
  assert.match(await page.locator("#runner-list").innerText(), /Ollama/);
  await page.fill("#token", "hf_browsertesttoken12345");
  await page.click("#save-token");
  await page.waitForSelector("#notice:not([hidden])");
  assert.match(await page.locator("#notice").innerText(), /Token saved/);
  assert.match(fs.readFileSync(envFile, "utf8"), /HF_TOKEN=hf_browsertesttoken12345/);
  await openSettings();
  assert.match(await page.locator("#token-current").innerText(), /hf_b\*+2345/);
  await page.click("#close-settings");
});

await step("with a token the gated model gets a real answer instead of the lock", async () => {
  await page.uncheck("#only-runnable");
  await page.click(".tab[data-tab=chat]");
  await page.locator("#models .model", { hasText: "Llama-3.1-8B-Instruct" }).locator(".name").click();
  await page.waitForSelector("#modal-body .notice");
  assert.match(await page.locator("#modal-body .notice").innerText(), /Python/);
  await page.keyboard.press("Escape");
});

await step("settings lists downloaded models with sizes and removes one", async () => {
  // A real Ollama may be running on the machine with models of its own;
  // the test only touches the file it planted.
  const { MODELS_DIR } = await import("../../src/runners.js");
  const dir = path.join(MODELS_DIR, "second-state", "stable-diffusion-v1-5-GGUF");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf"), Buffer.alloc(2 * 1024 * 1024));
  await openSettings();
  const row = page.locator("#storage-list li", { hasText: "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf" });
  await row.waitFor();
  assert.match(await row.locator(".size").innerText(), /0\.00 GB/);
  assert.match(await page.locator("#storage-total").innerText(), /GB in \d+ model/);
  const before = await page.locator("#storage-list li").count();
  acceptDialogs = true;
  await row.locator("button[data-remove]").click();
  await page.waitForFunction((n) => document.querySelectorAll("#storage-list li").length === n - 1, before);
  acceptDialogs = false;
  assert.equal(await row.count(), 0);
  assert.equal(fs.existsSync(dir), false);
  await page.click("#close-settings");
});

await step("the main page scans this computer, shows free space, and removing a model rescans", async () => {
  const { MODELS_DIR } = await import("../../src/runners.js");
  const dir = path.join(MODELS_DIR, "bartowski", "Qwen2.5-Coder-7B-Instruct-GGUF");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf"), Buffer.alloc(3 * 1024 * 1024));
  assert.equal(await page.locator("#local-body").isVisible(), false, "nothing shown before a scan");
  await page.click("#scan-local");
  const row = page.locator("#local-list li", { hasText: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf" });
  await row.waitFor();
  assert.match(await page.locator("#disk-line").innerText(), /\d+(\.\d)? GB free of \d+ GB on this drive/);
  assert.match(await page.locator("#machine-line").innerText(), /GB free on disk/);
  assert.match(await page.locator("#scan-local").innerText(), /Scan again/);
  await row.locator("button.use").click();
  await page.waitForSelector("#steps .step");
  assert.equal(await page.locator("#modal-title").innerText(), "Qwen2.5-Coder-7B-Instruct-GGUF", "Use opens the model ready to try");
  // A chat model pulled through Ollama is done when Ollama holds it, not when a file exists; the window simply opens.
  assert.ok((await page.locator("#steps .step").count()) >= 3);
  await page.click("#close-modal");
  const before = await page.locator("#local-list li").count();
  acceptDialogs = true;
  await row.locator("button[data-remove]").click();
  await page.waitForFunction((n) => document.querySelectorAll("#local-list li").length === n - 1, before);
  acceptDialogs = false;
  assert.equal(fs.existsSync(dir), false);
  assert.match(await page.locator("#disk-line").innerText(), /GB free/, "the free space line is redrawn after removal");
});

await step("a set-up model offers to remove itself from the model window", async () => {
  const { MODELS_DIR } = await import("../../src/runners.js");
  const dir = path.join(MODELS_DIR, "ggerganov", "whisper.cpp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ggml-base.en.bin"), Buffer.alloc(1024));
  await page.click(".tab[data-tab=speech]");
  await page.locator("#models .model", { hasText: "whisper.cpp" }).locator(".name").click();
  await page.waitForSelector("#steps .step");
  const done = await page.$$eval("#steps .step", (els) => els.map((e) => e.classList.contains("done")));
  assert.equal(done[1], true, "the download step is marked done because the file is on disk");
  if (done[0]) {
    await page.waitForSelector("#remove-model");
    acceptDialogs = true;
    await page.click("#remove-model");
    await page.waitForFunction(() => !document.querySelector("#remove-model"));
    acceptDialogs = false;
    assert.equal(fs.existsSync(path.join(dir, "ggml-base.en.bin")), false);
  } else {
    assert.equal(await page.locator("#remove-model").count(), 0, "no remove button until every step is done");
    fs.rmSync(path.join(MODELS_DIR, "ggerganov"), { recursive: true, force: true });
  }
  await page.click("#close-modal");
});

await step("a chat model's try box has an instructions field", async () => {
  await page.click(".tab[data-tab=easy]");
  await page.locator("#models .model", { hasText: "Llama-3.2-3B-Instruct-GGUF" }).locator(".name").click();
  await page.waitForSelector("#steps .step");
  const done = await page.$$eval("#steps .step", (els) => els.map((e) => e.classList.contains("done")));
  if (done.every(Boolean)) {
    await page.waitForSelector("#chat-system");
    assert.match(await page.locator(".instructions").innerText(), /Instructions for the model/);
  } else {
    assert.equal(await page.locator("#chat-system").count(), 0, "no chat box until the steps are done");
  }
  await page.click("#close-modal");
});

await step("an image model offers Fast, Default and Max with Default chosen", async () => {
  const { MODELS_DIR } = await import("../../src/runners.js");
  const dir = path.join(MODELS_DIR, "second-state", "stable-diffusion-v1-5-GGUF");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf"), Buffer.alloc(1024));
  await page.click(".tab[data-tab=images]");
  await page.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).locator(".name").click();
  await page.waitForSelector("#steps .step");
  const done = await page.$$eval("#steps .step", (els) => els.map((e) => e.classList.contains("done")));
  assert.equal(done[1], true, "the planted file counts as downloaded");
  if (done[0]) {
    await page.waitForSelector("#quality input");
    assert.match(await page.locator("#try .effort-title").innerText(), /Effort/);
    const values = await page.$$eval("#quality input", (els) => els.map((e) => [e.value, e.checked]));
    assert.deepEqual(values, [["fast", false], ["default", true], ["max", false]]);
    assert.match(await page.locator("#quality").innerText(), /20 steps, the standard settings/);
    assert.match(await page.locator("#quality").innerText(), /40 steps/);
    assert.equal(await page.locator("#image-negative").count(), 1, "an Avoid field for the negative prompt");
  } else {
    assert.equal(await page.locator("#quality").count(), 0);
  }
  await page.click("#close-modal");
  fs.rmSync(path.join(MODELS_DIR, "second-state"), { recursive: true, force: true });
});

await step("settings has the image server field and rejects a bad address", async () => {
  await openSettings();
  await page.waitForSelector("#settings:not([hidden])");
  assert.match(await page.locator("#image-server-status").innerText(), /on this computer/);
  await page.fill("#image-server", "not an address");
  acceptDialogs = true;
  await page.click("#save-image-server");
  await page.waitForTimeout(300);
  acceptDialogs = false;
  assert.equal(await page.locator("#image-server").inputValue(), "not an address", "nothing saved");
  await page.click("#close-settings");
});

await step("a reload keeps the scan and reports when it was made", async () => {
  await page.reload();
  await page.waitForSelector("#trait");
  assert.equal(await page.locator("#home-hint").isVisible(), false, "nothing to say once there is a scan");
  await page.click("#nav-browse");
  await page.waitForSelector("#scan-title:not([hidden])");
  assert.match(await page.locator("#scan-status").innerText(), /Last scan (just now|\d+ minutes ago)/);
});

await step("a download of many files says which file is on, out of how many, in front of the percentage, and the bar runs over the whole set", async () => {
  const seen = await page.evaluate(() => {
    const li = document.createElement("li");
    const log = document.createElement("pre");
    li.appendChild(log);
    document.body.appendChild(li);
    const p = stepProgress(li, log);
    const out = [];
    for (const line of ["Downloading 64 files of MiniMaxAI/MiniMax-H3 on the rented GPU", "file 1 of 64: model_index.json", "100% of 0.00 GB (model_index.json)", "file 12 of 64: transformer/diffusion_pytorch_model-00003-of-00030.safetensors", "45% of 4.60 GB (transformer/diffusion_pytorch_model-00003-of-00030.safetensors)"]) {
      p.line(line);
      out.push([li.querySelector(".progress-text").innerText, li.querySelector(".progress-files")?.innerText ?? null, `${Math.round(parseFloat(li.querySelector(".fill").style.width) * 10) / 10}%`]);
    }
    li.remove();
    return out;
  });
  assert.deepEqual(seen, [
    ["Starting", null, "0%"],
    ["File 1 of 64 model_index.json", "File 1 of 64", "0%"],
    ["File 1 of 64 100% of 0.00 GB, model_index.json", "File 1 of 64", "1.6%"],
    ["File 12 of 64 transformer/diffusion_pytorch_model-00003-of-00030.safetensors", "File 12 of 64", "17.2%"],
    ["File 12 of 64 45% of 4.60 GB, transformer/diffusion_pytorch_model-00003-of-00030.safetensors", "File 12 of 64", "17.9%"],
  ]);
});

await step("a conversation survives re-renders, an outside click and closing the window, and scrolling up is not undone while a reply streams", async () => {
  const id = "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF";
  // The plan says every step is done and the model answers through Ollama, as if it had been pulled.
  await page.route((u) => u.pathname === "/api/model" && u.searchParams.get("id") === id, async (route) => {
    const data = await (await route.fetch()).json();
    for (const s of data.plan.steps) s.done = true;
    data.plan.tryWith = { kind: "chat", model: "qwen-test" };
    data.plan.remove = [];
    await route.fulfill({ json: data });
  });
  // An earlier conversation is on this computer already, long enough to need scrolling.
  await page.evaluate(() => {
    const old = [];
    for (let i = 0; i < 12; i++) old.push({ role: "user", content: `earlier question ${i}` }, { role: "assistant", content: `earlier answer ${i}\nwith a second line` });
    localStorage.setItem("chat:qwen-test", JSON.stringify(old));
  });
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  // What each reads when files go with a message: every chat model reads
  // code, one trained on code says so, one trained on decompilation reads binaries too.
  const readsPill = async (name) => page.locator("#models .model", { hasText: name }).first().locator(".pill.reads").innerText();
  assert.equal(await readsPill("Qwen2.5-Coder-7B-Instruct-GGUF"), "Trained on code");
  assert.equal(await readsPill("Llama-3.2-3B-Instruct-GGUF"), "Reads code");
  assert.equal(await readsPill("llm4decompile-6.7b-v2-GGUF"), "Reads code and binaries");
  assert.match(await page.locator("#models .model", { hasText: "llm4decompile" }).first().locator(".pill.reads").getAttribute("title"), /reads the file's header and the readable strings inside it[\s\S]*nothing is run/);
  await page.locator("#models .model", { hasText: "Qwen2.5-Coder-7B-Instruct-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#chat-send");
  assert.equal(await page.locator("#messages .msg").count(), 24, "the earlier conversation is back");
  assert.match(await page.locator("#messages .msg").last().innerText(), /earlier answer 11/);

  // Asking a text model for a picture is caught before it is sent, with the way to an image model.
  const sentBefore = chatBodies.length;
  await page.fill("#chat-text", "draw me a cat on a bicycle");
  await page.click("#chat-send");
  await page.waitForSelector("#messages .picture-note");
  assert.match(await page.locator("#messages .picture-note").innerText(), /writes text only[\s\S]*cannot make a picture/);
  assert.equal(chatBodies.length, sentBefore, "nothing was sent");
  assert.equal(await page.locator("#chat-text").inputValue(), "draw me a cat on a bicycle", "the message is kept");
  await page.click("#note-dismiss");
  assert.equal(await page.locator("#messages .picture-note").count(), 0);
  // Effort: Standard is chosen by default; Thorough turns the model's thinking on and adds a care instruction, for this request only.
  assert.equal(await page.locator('.effort[data-kind="chat"] input:checked').inputValue(), "standard");
  await page.click('.effort[data-kind="chat"] input[value="thorough"]');
  await page.fill("#chat-text", "hello there");
  await page.click("#chat-send");
  // The thinking shows as it comes, folded above the answer, with how far along the reply is.
  await page.waitForFunction(() => /^Thinking · about \d+ words$/.test(document.querySelector("#chat-live .thinking summary")?.textContent ?? ""));
  await page.waitForFunction(() => /^Thinking · \d+ tokens/.test(document.querySelector("#chat-progress .progress-text")?.textContent ?? ""));
  await page.waitForFunction(() => /word3 /.test(document.querySelector("#chat-live")?.textContent ?? ""));
  await page.waitForFunction(() => /^Writing the answer after 10 tokens of thinking · \d+ tokens.* · about \d+%.*\(a first guess; it learns this model's lengths\)$/.test(document.querySelector("#chat-progress .progress-text")?.textContent ?? ""));
  assert.equal(chatBodies.at(-1).options.num_predict, 49152, "every reply has an end, so a model thinking in circles cannot hold the machine");
  // Scroll up while the reply is still arriving; new words must not drag the view back down.
  await page.evaluate(() => (document.querySelector("#messages").scrollTop = 0));
  await page.waitForFunction(() => /word9 /.test(document.querySelector("#chat-live")?.textContent ?? ""));
  assert.ok((await page.evaluate(() => document.querySelector("#messages").scrollTop)) < 10, "the view stays where the reader put it");
  assert.equal(await page.locator("#chat-send").isDisabled(), true);
  assert.equal(chatBodies.at(-1).think, true);
  assert.equal(chatBodies.at(-1).messages[0].role, "system");
  assert.match(chatBodies.at(-1).messages[0].content, /check your work/);
  assert.equal(chatBodies.at(-1).messages.at(-1).content, "hello there");
  assert.equal(await page.evaluate(() => localStorage.getItem("effort:chat")), "thorough", "remembered for next time");

  // Re-drawing the try box, as a finished step does, keeps the reply that is still streaming.
  await page.evaluate(() => renderTry(state.model, state.plan));
  await page.waitForSelector("#chat-live");
  assert.match(await page.locator("#chat-live").innerText(), /word\d+ /);
  assert.equal(await page.locator("#chat-send").isDisabled(), true, "still busy after the re-render");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  assert.equal(await page.locator("#chat-live").count(), 0);
  assert.match(await page.locator("#messages .msg").last().innerText(), /word0 .*word39 /s, "the whole reply landed in the transcript");
  assert.equal(await page.locator("#messages .msg").last().locator(".thinking summary").innerText(), "Thought it through · about 10 words", "the thinking stays with the answer, folded");
  assert.equal(await page.locator("#chat-progress").isHidden(), true);
  assert.equal(await page.evaluate(() => localStorage.getItem("chatTokens:qwen-test:thorough") ?? Object.keys(localStorage).filter((k) => k.startsWith("chatTokens:")).map((k) => localStorage.getItem(k))[0]), "40", "the reply's length is learned for the next guess");
  assert.ok(!chatBodies.at(-1).messages.some((m) => /step\d/.test(m.content)), "the thinking is not sent back to the model");
  // A click beside the window closes it; the conversation is kept and is back when the window reopens.
  await page.mouse.click(8, 8);
  await page.waitForFunction(() => document.querySelector("#modal").hidden);
  await page.locator("#models .model", { hasText: "Qwen2.5-Coder-7B-Instruct-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#chat-send");
  assert.equal(await page.locator("#messages .msg").count(), 26, "the earlier conversation and the new exchange are back");
  await page.evaluate(() => {
    const m = document.querySelector("#messages");
    m.scrollTop = m.scrollHeight;
  });
  const scrolled = await page.evaluate(() => {
    const m = document.querySelector("#messages");
    m.scrollTop = m.scrollHeight;
    return m.scrollHeight - m.scrollTop - m.clientHeight < 2;
  });
  assert.ok(scrolled);

  // One control per answer: Claude's check comes first in it, and the review streams in under it.
  assert.equal(await page.locator("#messages .improve-go").count(), 13, "one control per answer");
  await page.locator("#messages .improve-go").last().click();
  const improve = page.locator("#messages .improve-wrap").last();
  await improve.locator(".improve").waitFor();
  assert.equal(await improve.locator(".improve-by").inputValue(), "claude-check", "the check is the first choice");
  await improve.locator(".improve-run").click();
  await page.waitForFunction(() => /word7 is not a word\./.test([...document.querySelectorAll("#messages .improve-wrap .review-body")].at(-1)?.textContent ?? ""));
  assert.match(await improve.locator(".review-foot").innerText(), /Checked by claude-opus-5\. Sent to Anthropic: your question and this answer\./);
  assert.equal(reviewed.length, 1);
  assert.equal(reviewed[0].kind, "text");
  assert.equal(reviewed[0].model, "qwen-test");
  assert.equal(reviewed[0].question, "hello there", "the question that led to the answer goes with it");
  assert.match(reviewed[0].answer, /^word0 .*word39 $/s);

  // The same control hands the answer on to be improved: Claude revises it, and the revision joins the conversation with its chain of hands.
  assert.ok((await improve.locator(".improve-by option").allTextContents()).some((t) => /Claude \(revises the answer\)/.test(t)));
  await improve.locator(".improve-request").fill("shorter");
  await improve.locator(".improve-by").selectOption("claude");
  await improve.locator(".improve-run").click();
  await page.waitForFunction(() => /^Claude's revision/.test([...document.querySelectorAll("#messages .improve-wrap .review-head")].at(-1)?.textContent ?? "") && /word7 is not a word\./.test([...document.querySelectorAll("#messages .improve-wrap .review-body")].at(-1)?.textContent ?? ""));
  assert.equal(reviewed.at(-1).mode, "edit");
  assert.equal(reviewed.at(-1).request, "shorter");
  await improve.locator("button", { hasText: "Use this as the answer" }).click();
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 27);
  assert.match(await page.locator("#messages .msg").last().innerText(), /word7 is not a word/);
  assert.match(await page.locator("#messages .chain").last().innerText(), /Made by qwen-test, revised by Claude \(shorter\)/);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("chat:qwen-test"))).at(-1).chain[0].by, "Claude", "the chain is kept with the message");
  // The conversation downloads as a Markdown file.
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#chat-download")]);
  assert.equal(download.suggestedFilename(), "qwen-test-conversation.md");

  // Closing and reopening the model brings the conversation back, reply included.
  await page.click("#close-modal");
  assert.equal(await page.locator("#modal").isVisible(), false);
  await page.locator("#models .model", { hasText: "Qwen2.5-Coder-7B-Instruct-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#chat-send");
  assert.equal(await page.locator("#messages .msg").count(), 27);
  assert.match(await page.locator("#messages .msg").last().innerText(), /word7 is not a word/);
  assert.equal(JSON.parse(await page.evaluate(() => localStorage.getItem("chat:qwen-test"))).length, 27, "kept on this computer");
  // Opened again, the answer's Claude box looks as it was left: the revision last asked for, with its way to use it.
  const kept = page.locator("#messages .improve-wrap", { hasText: "Claude's revision" });
  assert.equal(await kept.count(), 1);
  assert.match(await kept.locator(".review-body").innerText(), /word7 is not a word\./, "the revision is kept with the answer");
  assert.match(await kept.locator(".review-foot").innerText(), /By claude-opus-5/);
  assert.equal(await kept.locator("button", { hasText: "Use this as the answer" }).count(), 1);

  // A picture link in an answer shows as the picture, with its alt text as a caption; the rest stays text.
  await page.evaluate(() => addMsg("assistant", "Here it is: ![a red cat](https://example.com/cat.png) and also https://example.com/dog.jpg?x=1 done"));
  const pics = page.locator("#messages .msg").last().locator(".msg-image");
  assert.equal(await pics.count(), 2);
  assert.equal(await pics.first().locator("img").getAttribute("src"), "https://example.com/cat.png");
  assert.equal(await pics.first().locator("img").getAttribute("alt"), "a red cat");
  assert.equal(await pics.first().locator(".caption").innerText(), "a red cat");
  assert.equal(await pics.nth(1).locator("img").getAttribute("src"), "https://example.com/dog.jpg?x=1");
  assert.match(await page.locator("#messages .msg").last().innerText(), /Here it is:[\s\S]*done/);
  assert.equal(await page.locator("#messages .msg.user").last().locator(".msg-image").count(), 0, "what the person typed stays plain");
  // Stop ends a reply part way: what came is kept, and the box is free again.
  await page.click('.effort[data-kind="chat"] input[value="standard"]');
  await page.fill("#chat-text", "a long one please");
  await page.click("#chat-send");
  await page.waitForFunction(() => /word3 /.test(document.querySelector("#chat-live")?.textContent ?? ""));
  assert.equal(chatBodies.at(-1).options.num_predict, 24576, "Standard has an end too");
  await page.click("#chat-stop");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled);
  assert.match(await page.locator("#messages .msg.assistant").last().innerText(), /word3 [\s\S]*Stopped\.$/);
  assert.equal(await page.locator("#chat-progress").isHidden(), true);
  // Handing the hard parts to Claude: Claude names them first, the model
  // writes the rest and leaves a marked stub, and Claude writes that part to fit.
  await page.check("#chat-handoff");
  assert.equal(await page.evaluate(() => localStorage.getItem("handoff:chat")), "1", "the switch is remembered");
  await page.fill("#chat-text", "write me Minesweeper combined with Scrabble");
  await page.click("#chat-send");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled && /HANDOFF TO CLAUDE: mineOdds/.test([...document.querySelectorAll("#messages .msg.assistant")].at(-1)?.textContent ?? ""), null, { timeout: 15000 });
  assert.deepEqual([reviewed.at(-1).kind, reviewed.at(-1).mode, reviewed.at(-1).question], ["code", "handoff-plan", "write me Minesweeper combined with Scrabble"]);
  const toModel = chatBodies.at(-1).messages.at(-1).content;
  assert.match(toModel, /^write me Minesweeper combined with Scrabble\n\n---\nHow to do this:[\s\S]*- mineOdds: the chance each hidden cell holds a mine\n- wordScore: Scrabble scoring with premium squares[\s\S]*"HANDOFF TO CLAUDE: <the part's name>", followed by a method description/);
  assert.equal(await page.locator("#messages .msg.user").last().innerText(), "write me Minesweeper combined with Scrabble", "the conversation shows what was typed");
  assert.equal(await page.locator("#messages .handoff-note summary").last().innerText(), "Claude named the parts to leave to it: mineOdds, wordScore");
  const lastAnswer = page.locator("#messages .msg.assistant").last();
  const tools = page.locator("#messages .code-tools").last();
  assert.deepEqual(await tools.locator("> button").allInnerTexts(), ["Claude: check and fix the code", "Claude: write the parts handed to it"]);
  // The two are separate: a check that fixes, and the handed-off parts written.
  await tools.locator(".code-fix").click();
  await tools.locator(".code-result .code-foot button").waitFor();
  assert.equal(await tools.locator(".code-head").innerText(), "Claude checked the code");
  assert.match(await tools.locator(".code-body").innerText(), /^Found:\n- mineOdds returns nothing/);
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).question, /HANDOFF TO CLAUDE: mineOdds/.test(reviewed.at(-1).answer)], ["fix", "write me Minesweeper combined with Scrabble", true]);
  await tools.locator(".code-finish").click();
  // Before Claude's first word, the time it has been at it is shown.
  await page.waitForFunction(() => /^(Waiting for Claude to start|Claude is thinking it through) · \d+ s$/.test([...document.querySelectorAll("#messages .code-tools")].at(-1)?.querySelector(".code-progress .progress-text")?.textContent ?? ""));
  // Left and opened again while Claude works: the work is there as it stands, and goes on.
  await page.mouse.click(8, 8);
  await page.waitForFunction(() => document.querySelector("#modal").hidden);
  await page.locator("#models .model", { hasText: "Qwen2.5-Coder-7B-Instruct-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#chat-send");
  assert.match(await page.locator("#messages .code-tools").last().locator(".code-head").innerText(), /^Claude is writing the parts handed to it$/, "the running job shows in the window opened again");
  assert.equal(await page.locator("#messages .handoff-note summary").last().innerText(), "Claude named the parts to leave to it: mineOdds, wordScore", "the split is kept with the request");
  await page.waitForFunction(() => /Add the finished program to the chat/.test([...document.querySelectorAll("#messages .code-tools")].at(-1)?.textContent ?? ""));
  assert.equal(await tools.locator(".code-head").innerText(), "Claude wrote the parts handed to it");
  assert.equal(reviewed.at(-1).mode, "finish");
  const before = await page.locator("#messages .msg.assistant").count();
  await tools.locator(".code-foot button").click();
  // Opened again after: Claude's work and what was added look the same.
  await page.waitForFunction((n) => document.querySelectorAll("#messages .msg.assistant").length === n + 1, before);
  await page.mouse.click(8, 8);
  await page.waitForFunction(() => document.querySelector("#modal").hidden);
  await page.locator("#models .model", { hasText: "Qwen2.5-Coder-7B-Instruct-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#chat-send");
  const reopened = page.locator("#messages .code-tools").nth(-2);
  assert.equal(await reopened.locator(".code-head").innerText(), "Claude wrote the parts handed to it");
  assert.equal(await reopened.locator(".code-foot button").innerText(), "Added below");
  assert.equal(await reopened.locator(".code-foot button").isDisabled(), true);
  assert.match(await page.locator("#messages .msg.assistant").last().innerText(), /return board\.map\(\(row\) => row\.map\(\(\) => 0\.5\)\);/);
  assert.match(await page.locator("#messages .chain").last().innerText(), /Claude/);
  assert.ok(await lastAnswer.count());
  await page.uncheck("#chat-handoff");

  // New chat starts over.
  await page.click("#chat-clear");
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("chat:qwen-test")), "[]");
  await page.keyboard.press("Escape");
  await page.unroute((u) => u.pathname === "/api/model" && u.searchParams.get("id") === id);
});

await step("files go with a chat message: chosen as chips, sent under their names in fenced blocks with the window grown to hold them, and kept folded under the bubble", async () => {
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  await page.locator("#models .model", { hasText: "Qwen2.5-Coder-7B-Instruct-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#chat-send");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  if (await page.isChecked("#chat-handoff")) await page.uncheck("#chat-handoff");
  const rows = Array.from({ length: 1200 }, (_, i) => `export const row${i} = ${i}; // one line of the module`).join("\n");
  await page.setInputFiles("#chat-files", [
    { name: "main.py", mimeType: "text/x-python", buffer: Buffer.from("def add(a, b):\n    return a + b\n") },
    { name: "rows.js", mimeType: "text/javascript", buffer: Buffer.from(rows) },
    { name: "logo.png", mimeType: "image/png", buffer: Buffer.from([137, 80, 78, 71, 0, 1]) },
  ]);
  await page.waitForFunction(() => document.querySelectorAll("#chat-chips .chip").length === 2);
  assert.match(await page.locator("#chat-chips").innerText(), /main\.py\s+32 B[\s\S]*rows\.js\s+\d+ KB[\s\S]*2 files, about [\d,]+ tokens$/);
  assert.match(await page.locator("#notice").innerText(), /1 file left out: logo\.png is not a text file/);
  // A chip comes off; the file can be chosen again.
  await page.click('#chat-chips .chip-off[data-i="0"]');
  await page.waitForFunction(() => document.querySelectorAll("#chat-chips .chip").length === 1);
  await page.setInputFiles("#chat-files", [{ name: "main.py", mimeType: "text/x-python", buffer: Buffer.from("def add(a, b):\n    return a + b\n") }]);
  await page.waitForFunction(() => document.querySelectorAll("#chat-chips .chip").length === 2);
  // An executable is read, not run: its header and the strings inside it go as a digest.
  const elf = Buffer.alloc(64 + 48);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]).copy(elf, 0);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(62, 18);
  elf.write("secret_handshake_v3\0/usr/lib/libcrypto.so\0", 64);
  await page.setInputFiles("#chat-files", [{ name: "tool", mimeType: "application/octet-stream", buffer: elf }]);
  await page.waitForFunction(() => document.querySelectorAll("#chat-chips .chip").length === 3);
  assert.match(await page.locator("#chat-chips .chip").last().innerText(), /^tool\s+112 B, binary/);
  await page.fill("#chat-text", "what does add do?");
  await page.click("#chat-send");
  await page.waitForFunction(() => document.querySelectorAll("#chat-chips .chip").length === 0, null, { timeout: 5000 });
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  const body = chatBodies.at(-1);
  const toModel = body.messages.at(-1).content;
  assert.match(toModel, /^Files attached \(3\):\n\n### rows\.js\n```js\nexport const row0 = 0; \/\/ one line of the module\n/, "each file under its name, fenced");
  assert.match(toModel, /### main\.py\n```py\ndef add\(a, b\):\n    return a \+ b\n\n```\n\n### tool \(an executable, read as its header and strings; not run\)\n```text\nExecutable or binary file, not run: read as its header and the readable strings inside it\.\nFormat: ELF 64-bit executable, x86-64, little-endian\nSize: 112 bytes\nFirst bytes:\n00000000  7f 45 4c 46 02 01 01 00[\s\S]*Strings \(2 kept of 2 distinct\):\nsecret_handshake_v3\n\/usr\/lib\/libcrypto\.so\n```\n\nwhat does add do\?$/, "the executable's digest, then the words");
  assert.ok(body.options.num_ctx >= 24576 && body.options.num_ctx % 4096 === 0, `the window holds the files and the answer (${body.options.num_ctx})`);
  const bubble = page.locator("#messages .msg.user").last();
  assert.match(await bubble.innerText(), /^what does add do\?/, "the bubble shows the words");
  assert.deepEqual(await bubble.locator(".msg-file summary").allInnerTexts(), ["rows.js · 62 KB", "main.py · 32 B", "tool · 112 B · read as header and strings"]);
  await bubble.locator(".msg-file summary").nth(1).click();
  assert.match(await bubble.locator(".msg-file pre").nth(1).innerText(), /^def add\(a, b\):/);
  // The window drawn again, as leaving and coming back does, shows the same, and the files' text is kept with the conversation.
  await page.evaluate(() => renderTry(state.model, state.plan));
  await page.waitForSelector("#chat-send");
  assert.equal(await page.locator("#messages .msg.user").last().locator(".msg-file").count(), 3);
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem("chat:qwen-test") ?? "[]").findLast((m) => m.role === "user"));
  assert.deepEqual([kept.content, kept.files.map((f) => f.name), typeof kept.files[1].text, kept.files[2].binary], ["what does add do?", ["rows.js", "main.py", "tool"], "string", true]);
  // A later message carries the earlier files along, so a follow-up question still has them.
  await page.fill("#chat-text", "and in one word?");
  await page.click("#chat-send");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  const follow = chatBodies.at(-1).messages;
  assert.equal(follow.at(-1).content, "and in one word?");
  assert.match(follow.at(-3).content, /^Files attached \(3\):/);
  assert.ok(chatBodies.at(-1).options.num_ctx >= 24576);
  // A model that spends its whole budget thinking is asked again at once to answer from its notes, thinking off.
  await page.fill("#chat-text", "think forever about this");
  await page.click("#chat-send");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  const again = chatBodies.at(-1);
  assert.equal(again.think, false);
  assert.match(again.messages.at(-1).content, /^Stop thinking and answer now, directly and completely, from your notes above/);
  assert.match(again.messages.at(-2).content, /^My notes so far, before answering:\nstep0 step1 /);
  assert.equal(again.messages.at(-3).content, "think forever about this");
  assert.match(await page.locator("#messages .msg.assistant").last().innerText(), /Thought it through[\s\S]*answered from notes[\s\S]*It thought for the whole length limit \(24576 tokens\) without starting the answer, so it was asked again to answer from its notes, with thinking off\./);
  // One that closes its thinking under the cap and says nothing gets the same second ask.
  await page.fill("#chat-text", "think then hush");
  await page.click("#chat-send");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  const hushed = chatBodies.at(-1);
  assert.equal(hushed.think, false);
  assert.match(hushed.messages.at(-2).content, /^My notes so far, before answering:\nquiet0 quiet1 quiet2 quiet3$/);
  assert.match(await page.locator("#messages .msg.assistant").last().innerText(), /answered from notes[\s\S]*It finished thinking \(about 4 words\) and stopped without an answer, so it was asked again to answer from its notes, with thinking off\./);
  await page.click("#chat-clear");
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 0);
  await page.keyboard.press("Escape");
});

await step("cards carry what users say and one tag for what the model makes; the author's text and the runner stay in the window", async () => {
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  assert.equal(await page.locator("#models .model .summary").count(), 0, "no Hub blurb on cards");
  assert.equal(await page.locator("#models .model .said .line.author").count(), 0, "no author lines on cards");
  const card = page.locator("#models .model", { hasText: "Llama-3.2-3B-Instruct-GGUF" });
  assert.equal(await card.locator(".pill.makes").count(), 1);
  assert.equal(await card.locator(".pill.runner").count(), 0, "the runner is not a card tag");
  assert.ok((await card.locator(".said .line").count()) <= 2, "at most two lines before More");
  await card.locator("button[data-more]").click();
  await card.locator(".expanded:not([hidden])").waitFor();
  const shown = await card.locator(".said > .line span").allTextContents();
  const more = await card.locator(".expanded .line span").allTextContents();
  assert.ok(more.every((t) => !shown.includes(t)), "More shows only what the card did not");
  assert.doesNotMatch(await card.locator(".expanded .by").innerText(), /lifted from the comments/);
  await card.locator("button[data-more]").click();
  // The window still names the author and the runner, and keeps the facts to one row.
  await card.locator(".name").click();
  await page.waitForSelector("#modal-body .facts");
  assert.match(await page.locator("#modal-sub").innerText(), /bartowski/);
  assert.equal(await page.locator("#modal-body .spec").count(), 0, "no grid of boxes");
  assert.match(await page.locator("#modal-body .facts").innerText(), /Text only[\s\S]*GB/);
  await page.keyboard.press("Escape");
});

await step("every chat model asks where to run it; picking a GPU without a key asks for the key", async () => {
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#steps .step");
  const options = await page.$$eval(".where .where-opt", (els) => els.map((e) => [e.textContent, e.classList.contains("on")]));
  assert.deepEqual(options, [["On this computer", true], ["On a rented GPU, by the hour", false]]);
  assert.match(await page.locator("#modal-body .notice.warn").innerText(), /Larger than this computer has to spare.*pick On a rented GPU above/);
  assert.equal(await page.locator("#modal-body .notice.info").count(), 0, "no second notice saying the same");
  assert.equal(await page.locator("#rent-bar").isVisible(), false, "nothing rented yet");
  await page.click('.where-opt[data-where="rented"]');
  await page.waitForSelector(".rent-ask");
  assert.match(await page.locator(".rent-ask").innerText(), /Do you have a RunPod API key\?[\s\S]*wants a 48 GB card/);
  assert.equal(await page.locator(".where-opt.on").innerText(), "On a rented GPU, by the hour", "the chosen button shows as chosen while the questions are up");
  assert.ok((await page.locator("#steps .step").count()) >= 3, "the plan underneath is still the local one until a machine exists");
  await page.click("#ask-no");
  assert.match(await page.locator("#ask-no-box").innerText(), /runpod\.io/);
  await page.click("#ask-yes");
  assert.equal(await page.locator("#ask-no-box").isVisible(), false);
  await page.fill("#ask-key", RUNPOD_KEY);
  await page.click("#ask-save");
  // The key entry gives way to the rental offer in the same window; Settings stays closed.
  await page.waitForSelector(".rent-offer #ask-size");
  assert.equal(await page.locator("#settings").isHidden(), true);
  assert.equal(await page.locator("#ask-key").count(), 0, "the key entry is gone");
  assert.equal(await page.locator(".rent-offer #ask-size").inputValue(), "48", "the size the model wants is chosen");
  assert.match(await page.locator(".rent-offer #ask-rent").innerText(), /Rent it, \$0\.40 an hour/);
  await page.waitForSelector("#rent-panel .tier", { state: "attached" });
  assert.match(await page.locator("#runpod-status").evaluate((el) => el.textContent), /A key is saved \(rpa_\*+cdef\)/);
  const tiers = await page.$$eval("#rent-panel .tier", (els) => els.map((e) => [e.querySelector("b").textContent, e.querySelector(".price").textContent, e.querySelector("input").disabled, e.querySelector("input").checked]));
  // The model window asked for 48 GB, so that size is chosen.
  assert.deepEqual(tiers, [
    ["24 GB GPU", "RTX 4090, $0.44 an hour", false, false],
    ["48 GB GPU", "A40, $0.40 an hour", false, true],
    ["80 GB GPU", "A100 PCIe, $1.64 an hour", false, false],
    ["141 GB GPU", "H200 SXM, none free right now", true, false],
    ["2 × 141 GB GPUs", "H200 SXM, none free right now", true, false],
    ["4 × 141 GB GPUs", "H200 SXM, none free right now", true, false],
  ]);
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(`RUNPOD_API_KEY=${RUNPOD_KEY}`));
});

await step("renting from the model window preselects its size, and the bar shows the running cost", async () => {
  await page.waitForFunction(() => /Rent a GPU for this[\s\S]*wants a 48 GB card/.test(document.querySelector(".rent-ask")?.textContent ?? "") && document.querySelector(".rent-offer #ask-size"), null, { timeout: 10000 });
  assert.match(await page.locator(".rent-offer #ask-size option:checked").innerText(), /48 GB, A40, \$0\.40 an hour \(recommended\)/, "with a key saved, the question is an offer with the right size chosen");
  // Another size: the button's price follows it.
  await page.selectOption(".rent-offer #ask-size", "80");
  assert.match(await page.locator(".rent-offer #ask-rent").innerText(), /Rent it, \$1\.64 an hour/, "the price on the button is the chosen size's");
  await page.selectOption(".rent-offer #ask-size", "48");
  assert.match(await page.locator(".rent-offer #ask-rent").innerText(), /Rent it, \$0\.40 an hour/);
  rentedOllama.state.down = true;
  acceptDialogs = true;
  await page.click("#ask-rent");
  await page.waitForSelector("#rent-bar:not([hidden])");
  acceptDialogs = false;
  assert.match(await page.locator("#rent-bar").innerText(), /Rented GPU: NVIDIA A40 48 GB, starting, \$0\.40 an hour\./);
  assert.equal(runpod.state.created.length, 1);
  assert.deepEqual(runpod.state.created[0].mounts, { persistent: { size: 50, path: "/root/.ollama" } }, "the default disk; Disk size and other settings opens the full panel");
  // Renting from a model's window closes Settings and goes back to that window, which plans one step on the machine.
  await page.waitForFunction(() => document.querySelector("#settings").hidden);
  await page.waitForSelector("#steps .step");
  assert.equal(await page.locator("#modal-title").innerText(), "Cydonia-24B-v2-GGUF");
  // Settings, opened again, show the machine and the chat server pointing at it.
  await page.evaluate(() => document.querySelector("#open-settings").click());
  await page.waitForSelector("#settings:not([hidden])");
  await unfoldSettings(page);
  assert.match(await page.locator("#rent-panel .rent-card").innerText(), /starting[\s\S]*Stops by itself after 30 minutes/);
  assert.equal(await page.locator("#chat-server").inputValue(), rentedOllama.url, "the chat server is the rented machine");
  assert.match(await page.locator("#chat-server-status").innerText(), /rented GPU; Ollama on it is not answering yet/);
  await page.click("#close-settings");
  await page.waitForSelector("#steps .step");
  assert.equal(await page.locator(".where-opt.on").innerText(), "On a rented GPU");
  let titles = await page.$$eval("#steps .step .title", (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, ["Download the model on the chat server (25.6 GB)"]);
  assert.match(await page.locator("#steps .step .text").innerText(), /rented GPU is still starting/);
  assert.match(await page.locator("#modal-body .facts").innerText(), /Fits the server's 48 GB GPU/);
  // The other button plans it for this computer again, machine or no machine.
  await page.click('.where-opt[data-where="local"]');
  await page.waitForFunction(() => document.querySelectorAll("#steps .step").length >= 3);
  assert.equal(await page.locator(".where-opt.on").innerText(), "On this computer");
  await page.click('.where-opt[data-where="rented"]');
  await page.waitForFunction(() => document.querySelectorAll("#steps .step").length === 1);
  await page.keyboard.press("Escape");
});

await step("left alone while the machine runs, the page asks whether anyone is there and stops the machine when nobody answers", async () => {
  // Six seconds for the test; the default is ten minutes.
  await openSettings();
  await page.waitForSelector("#rent-presence");
  await page.fill("#rent-presence", "0.1");
  await page.click("#rent-save-idle");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#notice")?.textContent ?? ""));
  await page.click("#close-settings");
  await page.waitForSelector("#presence:not([hidden])", { timeout: 20000 });
  assert.match(await page.locator("#presence-text").innerText(), /while the rented GPU \(\$0\.40 an hour\) runs[\s\S]*it stops when the count reaches zero/);
  assert.match(await page.locator("#presence-left").innerText(), /^0:0[0-3]$/);
  await page.click("#presence-yes");
  assert.equal(await page.locator("#presence").isHidden(), true);
  assert.equal(runpod.state.actions.some((a) => a.endsWith(":stop")), false, "answering keeps it running");
  // Left alone again, the countdown runs out and the machine stops, with the reason on the card.
  await page.waitForSelector("#presence:not([hidden])", { timeout: 20000 });
  await page.waitForFunction(() => /stopped/.test(document.querySelector("#rent-bar").textContent), null, { timeout: 20000 });
  assert.ok(runpod.state.actions.some((a) => a.endsWith(":stop")));
  await page.waitForFunction(() => /without anyone here/.test(document.querySelector("#notice")?.textContent ?? ""), null, { timeout: 10000 });
  await openSettings();
  await page.waitForSelector("#rent-panel .rent-card");
  assert.match(await page.locator("#rent-panel .rent-card").innerText(), /stopped when nobody answered the still-there check/);
  await page.fill("#rent-presence", "10");
  await page.click("#rent-save-idle");
  await page.waitForFunction(() => /Saved/.test(document.querySelector("#notice")?.textContent ?? ""));
  await page.click("#close-settings");
  await page.click("#bar-start");
  await page.waitForFunction(() => /starting|ready/.test(document.querySelector("#rent-bar").textContent));
  runpod.state.actions.length = 0;
});

await step("stopping from the bar frees the chat server; starting and deleting work from Settings", async () => {
  acceptDialogs = true;
  await page.click("#bar-stop");
  await page.waitForFunction(() => /stopped/.test(document.querySelector("#rent-bar").textContent));
  acceptDialogs = false;
  await page.waitForFunction(() => /Stopped the rented GPU: the hourly charge has ended/.test(document.querySelector("#notice")?.textContent ?? ""));
  assert.equal(await page.locator("#bar-start").count(), 1);
  assert.ok(runpod.state.actions.some((a) => a.endsWith(":stop")));
  await openSettings();
  await page.waitForSelector("#rent-panel .rent-card");
  assert.match(await page.locator("#rent-panel .rent-card").innerText(), /Stopped: no hourly charge\. The 50 GB disk keeps its models for about \$0\.33 a day \(\$10\.00 a month\)/);
  // The account's bill, GPU apart from disks, and the day's total.
  await page.waitForSelector("#rent-spend .spend");
  assert.match(await page.locator("#rent-spend summary").innerText(), /RunPod's bill for this account: \$[\d.]+ in the last \d days?, \$[\d.]+ today/);
  assert.match(await page.locator("#rent-spend").evaluate((e) => e.textContent), /GPU \$[\d.]+, disks \$[\d.]+/);
  assert.match(await page.locator("#rent-panel").innerText(), /Stop once today's machines have cost this many dollars/);
  assert.equal(await page.locator("#chat-server").inputValue(), "", "chat models are back on this computer");
  assert.match(await page.locator("#chat-server-status").innerText(), /run on this computer/);
  await page.fill("#rent-idle", "45");
  await page.click("#rent-save-idle");
  await page.waitForFunction(() => /after 45 minutes/.test(document.querySelector("#rent-panel").textContent));
  await page.click("#close-settings");
  // A stopped machine is started from the model window, not replaced by a new rental.
  await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await page.waitForSelector(".where");
  await page.click('.where-opt[data-where="rented"]');
  await page.waitForSelector("#ask-start");
  assert.match(await page.locator(".rent-ask").innerText(), /Your rented GPU \(NVIDIA A40, 48 GB\) is stopped/);
  assert.equal(await page.locator("#ask-replace").count(), 1, "a stopped machine can be replaced from the model window");
  // When the machine's host has no free card, the panel says so and offers a fresh machine instead of a raw error.
  runpod.state.noGpu = true;
  await page.click("#ask-start");
  await page.waitForSelector("#rent-replace");
  assert.match(await page.locator("#rent-panel .notice").innerText(), /No free GPU on this machine's host right now/);
  runpod.state.noGpu = false;
  await page.click("#rent-start");
  await page.waitForFunction(() => /starting|ready/.test(document.querySelector("#rent-bar").textContent));
  await page.waitForFunction(() => document.querySelector(".where-opt.on")?.textContent === "On a rented GPU");
  assert.equal(await page.locator("#steps .step").count(), 1, "planned for the machine again");
  await page.keyboard.press("Escape");
  await openSettings();
  await page.waitForSelector("#rent-panel .rent-card");
  assert.equal(await page.locator("#chat-server").inputValue(), rentedOllama.url, "pointed back at it");
  // Two machines left on the account from before, which the delete below brings to light.
  runpod.state.pods.leftover1 = { id: "leftover1", name: "huggingfound", status: "EXITED", cost: 0.4, gpu: { id: "NVIDIA A40", count: 1, memory: 48 }, mounts: { persistent: { size: 50, path: "/root/.ollama" } }, createdAt: new Date().toISOString(), runtime: null };
  runpod.state.pods.leftover2 = { id: "leftover2", name: "huggingfound", status: "EXITED", cost: 10.58, gpu: { id: "NVIDIA H200", count: 2, memory: 141 }, mounts: { persistent: { size: 200, path: "/root/.ollama" } }, createdAt: new Date().toISOString(), runtime: null };
  acceptDialogs = true;
  await page.click("#rent-delete");
  // The bar goes, or stays only to point at the leftovers: the account's
  // other machines are kept for a few minutes, so the bar knows of them
  // only when it happened to ask after they appeared.
  await page.waitForFunction(() => document.querySelector("#rent-bar").hidden || /No GPU rented, but 2 other HuggingFound machines/.test(document.querySelector("#rent-bar").textContent));
  acceptDialogs = false;
  // What the click did is said, and the sizes to rent again are right there.
  await page.waitForFunction(() => /Deleted the rented machine and its models\. Nothing is charged any more\. Rent a new one below/.test(document.querySelector("#notice")?.textContent ?? ""));
  await page.waitForSelector("#rent-panel .tier");
  assert.equal(await page.locator("#chat-server").inputValue(), "");
  const saved = fs.readFileSync(envFile, "utf8");
  assert.doesNotMatch(saved, /RUNPOD_POD_ID|OLLAMA_SERVER/);
  assert.match(saved, /RUNPOD_API_KEY=/, "the key stays");
  rentedOllama.state.down = false;
  // Machines left on the account from before, each billing for its disk,
  // are listed under the offer with what they cost and one button to be rid of them.
  await page.waitForSelector("#rent-others .notice", { timeout: 10000 });
  const othersText = await page.locator("#rent-others").innerText();
  assert.match(othersText, /2 other HuggingFound machines on this RunPod account/);
  assert.match(othersText, /NVIDIA H200 × 2, 200 GB disk, stopped/);
  assert.match(othersText, /Their disks cost about \$1\.67 a day \(\$50\.00 a month\)/);
  acceptDialogs = true;
  await page.click("#rent-others-delete");
  await page.waitForFunction(() => /Deleted 2 machines at RunPod/.test(document.querySelector("#notice")?.textContent ?? ""));
  acceptDialogs = false;
  assert.equal(runpod.state.pods.leftover1.status, "TERMINATED");
  assert.equal(runpod.state.pods.leftover2.status, "TERMINATED");
  assert.equal(await page.locator("#rent-others .notice").count(), 0);
  // A sold-out size says what the site has seen of it, and can be watched:
  // checked every minute, and said when one comes free.
  // The Community Cloud is a choice, off unless set.
  assert.equal(await page.isChecked("#rent-community"), false);
  assert.match(await page.locator("#rent-panel .check.community").innerText(), /Also rent from RunPod's Community Cloud/);
  const h200 = page.locator("#rent-panel .tier").nth(3);
  assert.match(await h200.locator(".stock-note").innerText(), /^(No history for this size yet; Tell me when free checks every minute\.|Not seen free in the last \d+ min of checks\.)$/);
  assert.match(await page.locator("#rent-panel .stock-row").innerText(), /^Checked at .*\. Stock changes by the minute\.\s*Check again$/);
  await h200.locator(".watch-go").click();
  await h200.locator(".watching").waitFor();
  assert.match(await h200.locator(".watching").innerText(), /^Telling you when one is free, while this page is open\./);
  // Shown in the bar on every page too, and still there after the page loads its state again.
  assert.match(await page.locator("#rent-bar").innerText(), /^Waiting for a 141 GB GPU to be free: checked every minute while this site is open in a tab/);
  await page.evaluate(() => load());
  assert.match(await page.locator("#rent-bar").innerText(), /^Waiting for a 141 GB GPU to be free/);
  assert.equal(await page.locator("#rent-panel .tier").nth(3).locator(".watching").count(), 1, "the size still says it is watched");
  runpod.state.stock["NVIDIA H200"] = { 1: "LOW" };
  await page.click("#rent-refresh");
  await page.waitForFunction(() => /A 141 GB \(H200 SXM\) is free at RunPod now, \$3\.59 an hour\./.test(document.querySelector("#notice")?.textContent ?? ""));
  assert.equal(await page.evaluate(() => localStorage.getItem("rentWatch")), null, "the watch ends once it has found one");
  assert.equal(await page.locator("#rent-panel .tier").nth(3).locator("input").isChecked(), true, "the size that came free is chosen");
  delete runpod.state.stock["NVIDIA H200"];
  await page.click("#rent-refresh");
  await page.waitForFunction(() => document.querySelectorAll("#rent-panel .tier")[3]?.classList.contains("off"));
  // Rent when available: the site watches RunPod with this page closed too,
  // rents the size within the price set, holds it, and tells.
  await page.locator("#rent-panel .tier").nth(3).locator(".rent-when").click();
  const rw = page.locator("#rent-panel .rent-when-form");
  await rw.waitFor();
  assert.equal(await rw.locator(".rw-price").inputValue(), "4.13", "the listed price and a margin");
  assert.equal(await rw.locator(".rw-disk").inputValue(), "50");
  await rw.locator(".rw-hold").fill("30");
  assert.match(await rw.locator(".rw-cost").innerText(), /^Once rented it runs while you are away for up to 30 minutes, at most \$2\.0\d,/);
  await rw.locator(".rw-go").click();
  await page.waitForFunction(() => /Watching RunPod for a 141 GB GPU: the site checks every minute, with this page closed too, and rents one at up to \$4\.13 an hour/.test(document.querySelector("#rent-bar")?.textContent ?? ""));
  assert.match(await page.locator("#notice").innerText(), /^Watching for a 141 GB GPU\. /);
  assert.equal(await page.locator("#rent-panel .watch-server-stop").count(), 1, "the size shows it is being watched for");
  // Loading the page's state again (a reload, leaving Settings) keeps it on show.
  await page.evaluate(() => load());
  assert.match(await page.locator("#rent-bar").innerText(), /^Watching RunPod for a 141 GB GPU/);
  assert.equal(await page.locator("#rent-panel .watch-server-stop").count(), 1, "the size still shows it is being watched for");
  // Free now: the site's minute check rents it, and the page tells.
  runpod.state.stock["NVIDIA H200"] = { 1: "LOW" };
  await server.checkWatches();
  assert.equal(runpod.state.created.at(-1).gpu.id, "NVIDIA H200");
  await page.evaluate(async () => {
    state.rental = await api.get("/api/rent");
    renderRental();
  });
  await page.waitForFunction(() => /^Your GPU is rented: .*H200.*\$3\.59 an hour, with a 50 GB disk; held for you for 30 minutes\. It is starting/.test(document.querySelector("#notice")?.textContent ?? ""));
  assert.ok(Number(await page.evaluate(() => localStorage.getItem("watchSeen"))) > 0, "told once");
  await page.request.post(`${base}/api/rent/delete`, { data: {} });
  delete runpod.state.stock["NVIDIA H200"];
  await page.evaluate(async () => {
    state.rental = await api.get("/api/rent");
    renderRental();
  });
  await page.click("#close-settings");
});

await step("a Vast.ai key adds its cards to the same list, each marked Vast.ai, and a Vast.ai row rents there", async () => {
  await openSettings();
  await page.fill("#vast-key", VAST_KEY);
  await page.click("#save-vast");
  await page.waitForFunction(() => /^A key is saved/.test(document.querySelector("#vast-status")?.textContent ?? ""));
  await page.waitForSelector("#rent-panel .tier.vast");
  const first = await page.locator("#rent-panel .tier.vast").first().innerText();
  assert.match(first, /24 GB GPU\s+RTX 4090, \$0\.35 an hour, Vast\.ai/);
  assert.match(first, /A Vast\.ai host in Norway, NO; it charges \$4\.10 a TB for downloads\./);
  assert.doesNotMatch(await page.locator("#rent-panel .tier:not(.vast)").first().innerText(), /Vast\.ai/, "RunPod's rows stay as they were");
  assert.match(await page.locator("#rent-panel").innerText(), /At Vast\.ai the disk is fixed when the machine is rented/);
  // The 80 GB card at Vast.ai: rented there, and the bar says where.
  await page.locator('#rent-panel input[value="80:vast"]').check();
  acceptDialogs = true;
  await page.click("#rent-go");
  await page.waitForFunction(() => /\(Vast\.ai\)/.test(document.querySelector("#rent-bar")?.textContent ?? ""));
  acceptDialogs = false;
  assert.equal(vast.state.created.at(-1).offerId, 1010);
  assert.match(await page.locator("#rent-bar").innerText(), /Rented GPU: H100 SXM 80 GB \(Vast\.ai\)/);
  await page.waitForSelector("#rent-panel .rent-card");
  assert.match(await page.locator("#rent-panel .rent-head").innerText(), /H100 SXM, 80 GB at Vast\.ai/);
  // While it starts, how far it has got: a bar, the stage, the time so far and the usual time.
  const boot = page.locator("#rent-panel [data-boot-slot]");
  await boot.locator(".boot").waitFor();
  assert.match(await boot.innerText(), /^\d+% · Vast\.ai sets up the host\. \d+ s so far; usually 5 to 20 minutes/);
  assert.equal(await boot.locator(".progress .fill").count(), 1);
  await page.evaluate(() => rentalTick());
  await page.waitForFunction(() => /The host fetches the machine image\./.test(document.querySelector("#rent-panel [data-boot-slot]")?.textContent ?? ""));
  assert.match(await boot.locator(".boot-steps").innerText(), /✓ Vast\.ai sets up the host\s+● the host fetches the machine image\s+○ the machine opens its secure address\s+○ Ollama and the agent start/);
  const pctBefore = Number((await boot.innerText()).match(/^(\d+)%/)[1]);
  await page.evaluate(() => rentalTick());
  await page.waitForFunction(() => /The machine opens its secure address\./.test(document.querySelector("#rent-panel [data-boot-slot]")?.textContent ?? ""));
  assert.ok(Number((await boot.innerText()).match(/^(\d+)%/)[1]) > pctBefore, "the bar moves on with the stage");
  acceptDialogs = true;
  await page.click("#rent-delete");
  await page.waitForSelector("#rent-panel .tier.vast");
  acceptDialogs = false;
  assert.equal(vast.state.destroyed.length, 1);
  // Without the key, RunPod's list alone again.
  await page.click("#clear-vast");
  await page.waitForFunction(() => /^No key saved/.test(document.querySelector("#vast-status")?.textContent ?? "") && document.querySelector("#rent-panel .tier") && !document.querySelector("#rent-panel .tier.vast"));
  await page.click("#close-settings");
});

await step("every card says what the model makes, and a search for pictures marks the text models that cannot", async () => {
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  assert.match(await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).locator(".pill.makes").innerText(), /Text only, no pictures/);
  assert.equal(await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).locator(".pill.reads").innerText(), "Reads code");
  await page.click(".tab[data-tab=images]");
  assert.match(await page.locator("#models .model", { hasText: "pony-realism-v23-sdxl" }).locator(".pill.makes").innerText(), /Makes images/);
  await page.click(".tab[data-tab=speech]");
  assert.match(await page.locator("#models .model", { hasText: "whisper.cpp" }).locator(".pill.makes").innerText(), /Transcribes speech/);
  await page.click(".tab[data-tab=vision]");
  assert.match(await page.locator("#models .model").first().locator(".pill.makes").innerText(), /understands images/);
  await page.fill("#trait", "pictures of a chat");
  await page.click("#trait-go");
  await page.waitForSelector("#found .model");
  const cannotCards = page.locator("#found .model", { has: page.locator(".pill.cannot") });
  assert.ok((await cannotCards.count()) > 0, "a picture search still turns up chat models, marked");
  assert.equal(await cannotCards.first().locator(".pill.cannot").innerText(), "Does not make images");
  assert.equal(await cannotCards.first().locator(".pill.makes").count(), 0, "one tag, not two");
  const imageCards = page.locator("#found .model", { has: page.locator(".pill.makes", { hasText: "Makes images" }) });
  if (await imageCards.count()) assert.equal(await imageCards.first().locator(".pill.cannot").count(), 0);
  await page.fill("#trait", "");
  await page.click("#trait-go");
  await page.waitForFunction(() => document.querySelector("#results").hidden);
});

await step("a model can be hidden from search and Browse, listed in Settings, and brought back", async () => {
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await page.waitForSelector("#steps .step");
  assert.equal(await page.locator("#hide-model").innerText(), "Hide this model");
  await page.click("#hide-model");
  await page.waitForFunction(() => document.querySelector("#modal").hidden);
  assert.match(await page.locator("#notice").innerText(), /hidden from search and Browse/);
  await page.waitForFunction(() => !document.querySelector('#models .model[data-id="TheDrummer/Cydonia-24B-v2-GGUF"]'));
  assert.match(await page.locator(".tab-blurb").innerText(), /1 hidden by you; show it/);
  assert.match(fs.readFileSync(envFile, "utf8"), /HIDDEN_MODELS=TheDrummer\/Cydonia-24B-v2-GGUF/);
  assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem("hidden:models"))), ["TheDrummer/Cydonia-24B-v2-GGUF"]);
  // A search skips it too, and says so.
  await page.fill("#trait", "cydonia");
  await page.click("#trait-go");
  await page.waitForSelector("#found-hint");
  await page.waitForFunction(() => /hidden by you/.test(document.querySelector("#found-hint").textContent));
  assert.equal(await page.locator('#found .model[data-id="TheDrummer/Cydonia-24B-v2-GGUF"]').count(), 0);
  await page.click("#toggle-hidden");
  await page.waitForSelector('#found .model[data-id="TheDrummer/Cydonia-24B-v2-GGUF"]');
  assert.match(await page.locator('#found .model[data-id="TheDrummer/Cydonia-24B-v2-GGUF"] .pill.hidden-by').innerText(), /Hidden by you/);
  await page.click("#toggle-hidden");
  await page.fill("#trait", "");
  await page.click("#trait-go");
  await page.waitForFunction(() => document.querySelector("#results").hidden);
  // Settings lists it, and Show again brings it back everywhere.
  await openSettings();
  await page.waitForSelector("#hidden-list li");
  assert.match(await page.locator("#hidden-list").innerText(), /Cydonia-24B-v2-GGUF/);
  await page.click('#hidden-list [data-unhide="TheDrummer/Cydonia-24B-v2-GGUF"]');
  await page.waitForFunction(() => document.querySelectorAll("#hidden-list li").length === 0);
  assert.match(await page.locator("#hidden-note").innerText(), /Nothing hidden/);
  await page.click("#close-settings");
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  await page.waitForSelector('#models .model[data-id="TheDrummer/Cydonia-24B-v2-GGUF"]');
  assert.doesNotMatch(fs.readFileSync(envFile, "utf8"), /HIDDEN_MODELS=\S/);
});

// ---- the hosted site, signed in ----------------------------------------------
// A second server in hosted mode with accounts. The session cookie is
// issued directly, standing in for Google's button; the rented machine is
// the same stand-in Ollama, which the page must now talk to itself.
const hostedHome = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-browser-hosted-"));
const hosted = createServer({ envFile: path.join(hostedHome, ".env"), scanFile: path.join(hostedHome, "scan.json"), voicesFile: path.join(hostedHome, "voices.json"), hubBase: stub.base, reviewer, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, hosted: true, refreshHours: 0, accountsDir: path.join(hostedHome, "accounts"), accountsSecret: "browser-test-secret-0123456789", googleClientId: "", runpodBase: runpod.base, runpodProxy: () => rentedOllama.url, runpodAgent: () => rentedAgent.url, runpodImageCheck: async () => true, runpodStatusTtl: 0, runpodBudget: { minute: 600, hour: 5000 }, idleWatch: false });
await new Promise((resolve) => hosted.listen(0, "127.0.0.1", resolve));
const hostedBase = `http://127.0.0.1:${hosted.address().port}`;
await hosted.refresh();
const visitor = await browser.newPage({ viewport: { width: 1280, height: 900 } });
visitor.on("pageerror", (e) => errors.push(`hosted: ${e.message}`));
visitor.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(`hosted: ${m.text()}`));
visitor.on("dialog", (d) => (acceptDialogs ? d.accept() : d.dismiss()));

await step("hosted: a visitor who is not signed in reaches Settings, where a key makes them a guest, and is offered a RunPod or Vast.ai key before a GPU", async () => {
  await visitor.goto(hostedBase);
  await visitor.waitForSelector("#trait");
  assert.equal(await visitor.locator("#open-settings").isVisible(), true, "Settings are open to visitors");
  // A key saved in Settings makes the visitor a guest; forgetting it ends the guest.
  await visitor.click("#open-settings");
  await visitor.waitForSelector("#settings:not([hidden])");
  await visitor.click("#sec-hf summary");
  await visitor.fill("#civitai-key", "0123456789abcdef0123456789abcdef");
  await visitor.click("#save-civitai");
  await visitor.waitForFunction(() => /You are a guest/.test(document.querySelector("#account-line")?.textContent ?? ""));
  assert.match(await visitor.locator("#civitai-status").innerText(), /saved/i);
  assert.equal(fs.readdirSync(path.join(hostedHome, "accounts")).filter((f) => f.startsWith("g")).length, 1);
  await visitor.keyboard.press("Escape");
  await visitor.waitForSelector("#settings", { state: "hidden" });
  acceptDialogs = true;
  await visitor.click("#account #sign-out");
  await visitor.waitForFunction(() => document.querySelector("#account").hidden);
  acceptDialogs = false;
  assert.equal(fs.readdirSync(path.join(hostedHome, "accounts")).filter((f) => f.startsWith("g")).length, 0);
  assert.equal(await visitor.locator("#sign-in").isVisible(), false, "no Sign in button until Google is set up; guests need none");
  assert.equal(await visitor.locator("#nav-privacy").isVisible(), true);
  await visitor.click("#nav-browse");
  await visitor.click(".tab[data-tab=chat]");
  await visitor.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await visitor.waitForSelector(".where");
  await visitor.click('.where-opt[data-where="rented"]');
  await visitor.waitForSelector(".rent-ask");
  assert.match(await visitor.locator(".rent-ask").innerText(), /takes a RunPod or Vast.ai API key[\s\S]*kept for 12 hours after your last use/);
  await visitor.click("#ask-yes");
  assert.equal(await visitor.locator("#ask-vast-key").isVisible(), true, "a Vast.ai key can be entered too");
  assert.equal(await visitor.locator("#ask-signin").count(), 0, "no Google button when Google is not set up");
  assert.equal(await visitor.locator("#steps .step .go").count(), 0, "no Run buttons for steps on a visitor's own computer");
  await visitor.keyboard.press("Escape");
});

await step("hosted: a guest enters a key in the model window, rents, and sees when the keys expire", async () => {
  await visitor.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await visitor.waitForSelector(".where");
  await visitor.click('.where-opt[data-where="rented"]');
  await visitor.waitForSelector("#ask-yes");
  await visitor.click("#ask-yes");
  await visitor.fill("#ask-key", RUNPOD_KEY);
  await visitor.click("#ask-save");
  await visitor.waitForSelector(".rent-offer #ask-size");
  assert.equal(await visitor.locator(".rent-offer #ask-size").inputValue(), "48");
  assert.match(await visitor.locator(".rent-faster").innerText(), /^Faster cards\. A100 PCIe \(80 GB\) makes clips about 2\.3 times faster for \$1\.64 an hour, about 1\.79 times the cost per clip\. Pick that size above if time matters more than price\.$/, "the bigger size whose card is meaningfully faster, with the cost per clip next to the A40 picked; the 24 GB card is faster but too small");
  assert.equal(await visitor.locator("#settings").isHidden(), true, "no Settings panel over the window");
  assert.match(await visitor.locator("#account").innerText(), /Guest, keys kept until/);
  assert.match(await visitor.locator("#account-line").innerText(), /You are a guest[\s\S]*12 hours after your last use/);
  assert.equal(await visitor.locator("#delete-account").innerText(), "Forget my keys now");
  assert.equal(await visitor.locator("#open-settings").isVisible(), true, "a guest reaches Settings for the rented machine");
  const guests = fs.readdirSync(path.join(hostedHome, "accounts")).filter((f) => f.startsWith("g"));
  assert.equal(guests.length, 1);
  await visitor.keyboard.press("Escape");
  // Forgetting the keys ends the guest.
  acceptDialogs = true;
  await visitor.click("#account #sign-out");
  await visitor.waitForFunction(() => document.querySelector("#account").hidden);
  acceptDialogs = false;
  assert.equal(fs.readdirSync(path.join(hostedHome, "accounts")).filter((f) => f.startsWith("g")).length, 0);
  assert.equal(await visitor.locator("#open-settings").isVisible(), true);
});

await step("hosted: signed in, Settings hold only the account's keys, and the privacy page answers", async () => {
  const user = hosted.accounts.findOrCreate({ email: "ana@example.com", name: "Ana" });
  await visitor.context().addCookies([{ name: "hf_session", value: hosted.accounts.issue(user.id), url: hostedBase }]);
  await visitor.reload();
  await visitor.waitForSelector("#account:not([hidden])");
  assert.match(await visitor.locator("#account").innerText(), /Ana/);
  assert.equal(await visitor.locator("#sign-in").isVisible(), false);
  assert.equal(await visitor.locator("#delete-account").innerText(), "Delete my account");
  await openSettings(visitor);
  await visitor.waitForSelector("#settings:not([hidden])");
  assert.equal(await visitor.locator("#token").isVisible(), true, "a Hugging Face token is kept with the account, for gated models on the rented GPU");
  assert.equal(await visitor.locator("#chat-server").isVisible(), false, "no hand-set chat server on the site");
  assert.equal(await visitor.locator("#image-server").isVisible(), false);
  assert.equal(await visitor.locator("#runpod-key").isVisible(), true);
  assert.equal(await visitor.locator("#claude-key").isVisible(), true);
  assert.match(await visitor.locator("#account-line").innerText(), /ana@example\.com/);
  await visitor.fill("#claude-key", "sk-ant-api03-browsertestkey0123456789");
  await visitor.click("#save-claude");
  await visitor.waitForFunction(() => /A key is saved/.test(document.querySelector("#claude-status").textContent));
  await visitor.fill("#runpod-key", RUNPOD_KEY);
  await visitor.click("#save-runpod");
  await visitor.waitForSelector("#rent-panel .tier");
  await visitor.click("#close-settings");
  const res = await visitor.request.get(`${hostedBase}/privacy.html`);
  assert.equal(res.status(), 200);
  assert.match(await res.text(), /does not pass through this site/);
});

await step("hosted: the model window rents the GPU, the download runs on it, and the chat goes straight from the browser to the machine", async () => {
  await visitor.click("#nav-browse");
  await visitor.click(".tab[data-tab=chat]");
  await visitor.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await visitor.waitForSelector(".where");
  await visitor.click('.where-opt[data-where="rented"]');
  await visitor.waitForSelector(".rent-offer #ask-size");
  assert.equal(await visitor.locator(".rent-offer #ask-size").inputValue(), "48");
  assert.equal(await visitor.locator("#ask-key").count(), 0, "a saved key is never asked for again");
  rentedOllama.state.down = false;
  acceptDialogs = true;
  await visitor.click("#ask-rent");
  await visitor.waitForSelector("#rent-bar:not([hidden])");
  acceptDialogs = false;
  const made = runpod.state.created.at(-1);
  assert.equal(made.env.OLLAMA_ORIGINS, hostedBase, "Ollama on the machine accepts this site's pages");
  await visitor.waitForFunction(() => document.querySelector("#settings").hidden, null, { timeout: 10000 });
  await visitor.waitForSelector("#steps .step .go");
  assert.equal(await visitor.locator(".where-opt.on").innerText(), "On a rented GPU");
  assert.equal(await visitor.locator("#modal-body .get-app").count(), 0, "no need for the app when the machine does the work");
  // Two polls bring the stand-in machine to RUNNING; the page's own poll would take longer.
  await visitor.request.get(`${hostedBase}/api/rent`);
  await visitor.request.get(`${hostedBase}/api/rent`);
  // This download is over in a blink: the default stop-when-done is tried
  // on the slower one below, and kept off here so the machine stays up.
  await visitor.evaluate(() => localStorage.setItem("stopAfterDownload", "0"));
  acceptDialogs = true;
  await visitor.click("#steps .step .go");
  // A running step says the work goes on without the window, with a way out and a way to stay, and a Refresh that reattaches.
  await visitor.waitForSelector(".bg-note");
  assert.equal(await visitor.locator("#steps .step .refresh-step").count(), 1, "a running step offers Refresh");
  assert.match(await visitor.locator(".bg-note").innerText(), /keeps going if you leave this window/);
  await visitor.click("#bg-stay");
  assert.equal(await visitor.locator(".bg-note").count(), 0);
  await visitor.waitForSelector("#steps .step.done", { timeout: 15000 });
  acceptDialogs = false;
  assert.ok(rentedOllama.state.pulls.some((p) => /Cydonia/.test(p)));
  // A running step carries a progress bar, full and labelled Done at the end.
  assert.equal(await visitor.locator("#steps .step .progress .fill").evaluate((el) => el.style.width), "100%");
  assert.equal(await visitor.locator("#steps .step .progress-text").innerText(), "Done");
  await visitor.waitForSelector("#chat-send");
  assert.match(await visitor.locator(".chat-tools").innerText(), /on the rented GPU/);
  // The chat goes to the machine's agent (image 28), base64-wrapped past the proxy's firewall, and on to Ollama there.
  const before = (rentedAgent.state.chats ?? []).length;
  const ollamaBefore = rentedOllama.state.chats.length;
  await visitor.fill("#chat-text", "hello machine");
  await visitor.click("#chat-send");
  await visitor.waitForFunction(() => /from the machine's agent/.test(document.querySelector("#messages")?.textContent ?? ""));
  assert.equal(rentedAgent.state.chats.length, before + 1, "the message reached the machine's agent");
  assert.equal(rentedAgent.state.chats.at(-1).messages.at(-1).content, "hello machine");
  assert.equal(rentedAgent.state.chats.at(-1).stream, true);
  assert.equal(rentedOllama.state.chats.length, ollamaBefore, "not straight to Ollama");
  // A machine rented for another address refuses the page: the message says which address, and the way out.
  await visitor.waitForFunction(() => !document.querySelector("#chat-send").disabled);
  rentedAgent.state.refuse = true;
  await visitor.fill("#chat-text", "hello again");
  await visitor.click("#chat-send");
  await visitor.waitForFunction(() => /HTTP 403/.test(document.querySelector("#messages")?.textContent ?? ""));
  assert.match(await visitor.locator("#messages .msg.assistant").last().innerText(), new RegExp(`The machine refused this page's address, ${hostedBase.replace(/[.]/g, "\\.")} \\(HTTP 403 from Ollama there\\)\\. A machine answers only the addresses it was rented for\\. It was rented before this address was allowed: replace the machine from the bar`));
  rentedAgent.state.refuse = false;
  // The proxy's firewall blocking the request (Cloudflare's page, HTTP 403) is told apart, with the files named.
  await visitor.waitForFunction(() => !document.querySelector("#chat-send").disabled);
  rentedAgent.state.block = true;
  await visitor.setInputFiles("#chat-files", [{ name: "crack.exe", mimeType: "application/octet-stream", buffer: Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0, 4, 0, 0, 0, 0xff, 0xff, 0, 0, 0x50, 0x45, 0, 0]) }]);
  await visitor.waitForFunction(() => document.querySelectorAll("#chat-chips .chip").length === 1);
  await visitor.fill("#chat-text", "what hwid does it want");
  await visitor.click("#chat-send");
  await visitor.waitForFunction(() => /Cloudflare/.test(document.querySelector("#messages")?.textContent ?? ""));
  assert.match(await visitor.locator("#messages .msg.assistant").last().innerText(), /^Something went wrong: The proxy in front of the machine \(a web firewall, Cloudflare's\) blocked this request before it reached the machine: HTTP 403, most likely over crack\.exe: a binary file's strings, or code, read like attack payloads to it, and the files go with every later message of the conversation\. Even carried by the machine's agent it was blocked; start a new chat without that file\.$/);
  rentedAgent.state.block = false;
  await visitor.waitForFunction(() => !document.querySelector("#chat-send").disabled);
  assert.ok(rentedAgent.state.origins.includes(hostedBase), "sent by the page itself, from the site's origin, to the machine's agent");
  // Improve goes to Claude with the account's saved key; the site relays that one request.
  await visitor.locator("#messages .improve-go").last().click();
  const improve = visitor.locator("#messages .improve-wrap").last();
  await improve.locator(".improve-request").fill("shorter");
  await improve.locator(".improve-by").selectOption("claude");
  await improve.locator(".improve-run").click();
  await visitor.waitForFunction(() => /word7 is not a word/.test([...document.querySelectorAll("#messages .improve-wrap .review-body")].at(-1)?.textContent ?? ""));
  assert.equal(reviewed.at(-1).mode, "edit");
  assert.equal(await visitor.locator("#chat-download").isVisible(), true);
  await visitor.keyboard.press("Escape");
});

await step("hosted: an image model is downloaded onto the rented GPU and pictures are made there, straight from the browser", async () => {
  await visitor.keyboard.press("Escape");
  await visitor.click("#nav-browse");
  await visitor.click(".tab[data-tab=images]");
  await visitor.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).locator(".name").click();
  await visitor.waitForSelector(".where");
  assert.equal(await visitor.locator(".where-opt.on").innerText(), "On a rented GPU", "the machine is there, so it is the default");
  assert.match(await visitor.locator("#modal-body").innerText(), /Runs on your rented GPU; your browser talks to the machine directly/);
  const titles = await visitor.$$eval("#steps .step .title", (els) => els.map((e) => e.textContent));
  assert.equal(titles.length, 1);
  assert.match(titles[0], /Download the model on the rented GPU/);
  // Stop-when-done is ticked by default under a download on the rented
  // machine; unticked once, that is remembered (and the scan needs the
  // machine up).
  await visitor.evaluate(() => localStorage.removeItem("stopAfterDownload"));
  rentedAgent.state.slowMs = 150;
  acceptDialogs = true;
  await visitor.click("#steps .step .go");
  await visitor.waitForSelector("#steps .step .stop-after input");
  assert.equal(await visitor.isChecked("#steps .step .stop-after input"), true, "ticked by default");
  await visitor.uncheck("#steps .step .stop-after input");
  assert.equal(await visitor.evaluate(() => localStorage.getItem("stopAfterDownload")), "0", "unticked once, remembered");
  rentedAgent.state.slowMs = undefined;
  await visitor.waitForSelector("#steps .step.done", { timeout: 15000 });
  acceptDialogs = false;
  assert.ok(rentedAgent.state.downloads.some((d) => /stable-diffusion-v1-5/.test(d.file)));
  await visitor.waitForSelector("#image-go");
  assert.match(await visitor.locator("#try .effort-title").innerText(), /Effort/);
  // A picture that fails leaves a Try again right under the log.
  await visitor.fill("#image-prompt", "fail please");
  await visitor.click("#image-go");
  await visitor.waitForSelector("#image-retry", { timeout: 20000 });
  assert.match(await visitor.locator("#image-log").innerText(), /the model choked/);
  await visitor.fill("#image-prompt", "a lighthouse at dusk");
  await visitor.fill("#image-negative", "blurry");
  await visitor.click("#image-retry");
  await visitor.waitForSelector("#image-out .image-card", { timeout: 20000 });
  assert.equal(await visitor.locator("#image-retry").count(), 0, "gone once a picture is made");
  const sent = rentedAgent.state.jobs.at(-1);
  assert.equal(sent.prompt, "a lighthouse at dusk");
  assert.equal(sent.negative, "blurry");
  assert.deepEqual([sent.steps, sent.width, sent.sampler], [20, 512, "euler_a"]);
  assert.ok(rentedAgent.state.origins.includes(hostedBase), "asked by the page itself");
  const img = visitor.locator("#image-out .image-card img");
  assert.match(await img.getAttribute("src"), /^data:image\/png;base64,iVBOR/);
  assert.match(await visitor.locator("#image-out .tools-row").innerText(), /Made on the rented GPU/);
  assert.match(await visitor.locator("#image-out a.button").getAttribute("download"), /^image-\d+\.png$/);
  assert.match(await visitor.locator("#image-log").innerText(), /Done in \d+ s/);
  // Improve offers the same model on the machine to paint over it, and the edit comes back as a second picture.
  await visitor.locator("#image-out .improve-go").click();
  const options = await visitor.locator("#image-out .improve-by option").allTextContents();
  assert.ok(options.some((o) => /on the rented GPU \(paints over it\)/.test(o)), options.join(" | "));
  await visitor.locator("#image-out .improve-request").fill("darker sky");
  await visitor.locator("#image-out .improve-by").selectOption({ index: options.findIndex((o) => /rented GPU/.test(o)) });
  await visitor.locator("#image-out .improve-run").click();
  await visitor.waitForFunction(() => document.querySelectorAll("#image-out .image-card").length === 2, null, { timeout: 20000 });
  const edit = rentedAgent.state.jobs.at(-1);
  assert.equal(edit.prompt, "a lighthouse at dusk, darker sky");
  assert.ok(edit.init.startsWith("iVBOR"), "the picture went back to the machine as the starting point");
  assert.equal(edit.strength, 0.55);
  assert.match(await visitor.locator("#image-out .image-card .chain").last().innerText(), /edited by stable-diffusion-v1-5-pruned-emaonly-Q8_0\.gguf \(darker sky\)/);
  await visitor.keyboard.press("Escape");
});

await step("hosted: the queue and a running log survive leaving the window, and a reply paints over the picture with the same seed at a fraction of the time", async () => {
  const openSd = async () => {
    await visitor.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).locator(".name").click();
    await visitor.waitForSelector("#image-go");
  };
  await openSd();
  // The queue is kept under the model. Held, it waits for Start all
  // instead of starting by itself.
  assert.equal(await visitor.locator("#queue").isHidden(), true);
  await visitor.check("#queue-hold");
  await visitor.fill("#image-prompt", "a red barn");
  await visitor.click("#queue-add");
  await visitor.fill("#image-prompt", "a blue barn");
  await visitor.click("#queue-add");
  assert.equal(await visitor.locator("#queue-list li").count(), 2);
  assert.equal(await visitor.locator("#image-go").isDisabled(), false, "held: nothing started");
  await visitor.keyboard.press("Escape");
  await openSd();
  await visitor.waitForSelector("#queue-list li");
  assert.equal(await visitor.locator("#queue-list li").count(), 2, "the queue is back after leaving the window");
  assert.match(await visitor.locator("#queue-list").innerText(), /a red barn[\s\S]*a blue barn/);
  assert.equal(await visitor.isChecked("#queue-hold"), true, "and so is the hold");
  assert.equal(await visitor.locator("#queue-go").innerText(), "Start all 2");
  assert.match(await visitor.locator("#queue-estimate").innerText(), /2 requests, about .* in all\. Held: they start with Start all\./);
  await visitor.click("#queue-clear");
  await visitor.uncheck("#queue-hold");
  assert.equal(await visitor.locator("#queue").isHidden(), true);
  // A picture under way when the window is left: opened again, the log is
  // back as it stood, the lines keep coming, and the picture lands there.
  rentedAgent.state.release = false;
  await visitor.fill("#image-prompt", "slow please");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Generating, 27%/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  await visitor.keyboard.press("Escape");
  await openSd();
  await visitor.waitForSelector("#image-log:not([hidden])");
  assert.match(await visitor.locator("#image-log").innerText(), /Asking the rented GPU[\s\S]*Generating, 27%/, "the log is back as it stood");
  assert.equal(await visitor.locator("#image-go").isDisabled(), true, "the buttons wait for it");
  rentedAgent.state.release = true;
  await visitor.waitForFunction(() => /Done in \d+ s/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  await visitor.waitForSelector("#image-out .image-card");
  assert.equal(await visitor.locator("#image-out .image-card").count(), 1, "the picture landed in the window opened again");
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled);
  const made = rentedAgent.state.jobs.at(-1);
  assert.ok(Number.isInteger(made.seed), "each request carries a seed of its own");
  // A reply, as to a person: the words are revised with the change in them,
  // and the same model paints over the picture with the same seed.
  await visitor.locator("#image-out .reply-go").click();
  await visitor.locator("#image-out .reply-text").fill("looks good but I asked for two barns, there is only one");
  await visitor.locator("#image-out .reply-run").click();
  await visitor.waitForFunction(() => document.querySelectorAll("#image-out .image-card").length === 2, null, { timeout: 20000 });
  const again = rentedAgent.state.jobs.at(-1);
  assert.equal(again.prompt, "slow please, two barns");
  assert.equal(again.seed, made.seed, "the same seed");
  assert.ok(/^(data:image\/png;base64,)?iVBOR/.test(again.init), "painted over the earlier picture");
  assert.equal(again.strength, 0.4);
  const log = await visitor.locator("#image-log").innerText();
  assert.match(log, /Reply to the earlier picture: "looks good but I asked for two barns, there is only one"/);
  assert.match(log, /From your words \(Claude: Claude wrote no Description line\): "slow please, two barns"/, "when Claude gives nothing usable, the log says why and the words are used");
  assert.match(log, /keeping about 60% of it: about 40% of the time of a fresh one/);
  assert.doesNotMatch(log, /the guess was/, "a picture painted over does not adjust the guess");
  // Kept under the model, the reply says what it answered, and a kept result can be replied to as well.
  await visitor.keyboard.press("Escape");
  await openSd();
  await visitor.waitForSelector("#kept .image-card");
  assert.match(await visitor.locator("#kept").innerText(), /In reply to an earlier picture \("looks good but I asked for two barns, there is only one"\)/);
  assert.ok((await visitor.locator("#kept .reply-go").count()) >= 2);
  await visitor.keyboard.press("Escape");
});

await step("hosted: a machine whose agent lost track of its model is restarted in place, or reset when it can be, and the picture asked again", async () => {
  await visitor.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).locator(".name").click();
  await visitor.waitForSelector("#image-go");
  // An older agent has no reset: RunPod restarts the machine in place, and
  // the page waits until the failed job's record is gone from it.
  rentedAgent.state.lostOnce = false;
  const actionsBefore = runpod.state.actions.length;
  await visitor.fill("#image-prompt", "a lost model, found");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Restarting it in place/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  // The line is written just before RunPod is asked.
  for (let i = 0; i < 40 && !runpod.state.actions.slice(actionsBefore).length; i++) await new Promise((r) => setTimeout(r, 250));
  assert.deepEqual(runpod.state.actions.slice(actionsBefore).map((a) => a.split(":")[1]), ["restart"]);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(await visitor.locator("#image-out .image-card").count(), 0, "still waiting: the old agent remembers the job");
  rentedAgent.state.jobs.length = 0;
  await visitor.waitForSelector("#image-out .image-card", { timeout: 20000 });
  assert.match(await visitor.locator("#image-log").innerText(), /Asking the rented GPU[\s\S]*Restarting it in place[\s\S]*The machine is back\.[\s\S]*Done in \d+ s/, "the whole log stays through the restart");
  assert.equal(rentedAgent.state.jobs.at(-1).prompt, "a lost model, found");
  // A newer agent drops the model on request, with no restart. This one is
  // also an older agent in one way: it sends the picture with the status.
  rentedAgent.state.unloadRoute = true;
  rentedAgent.state.lostOnce = false;
  rentedAgent.state.lean = false;
  const resultsBefore = rentedAgent.state.results ?? 0;
  await visitor.click("#image-go");
  // A new picture replaces the one shown; the log tells the reset from a restart.
  await visitor.waitForFunction(() => /loading it again[\s\S]*Done in \d+ s/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  assert.equal(rentedAgent.state.unloads, 1);
  assert.equal(runpod.state.actions.length, actionsBefore + 1, "no second restart");
  assert.doesNotMatch(await visitor.locator("#image-log").innerText(), /Restarting/);
  assert.equal(await visitor.locator("#image-out .image-card").count(), 2, "each result stays on show under the earlier ones");
  assert.equal(rentedAgent.state.results ?? 0, resultsBefore, "the picture came with the status, as an older agent sends it");
  assert.ok(resultsBefore > 0, "the earlier pictures were fetched as bytes, apart from the status");
  rentedAgent.state.lean = true;
  rentedAgent.state.unloadRoute = false;
  await visitor.keyboard.press("Escape");
});

await step("hosted: a machine busy on a clip is left alone: the still-there check waits for it, and a machine that stops anyway is reported with the reason", async () => {
  await openSettings(visitor);
  await visitor.waitForSelector("#rent-presence");
  // The machine report is on the Settings card too, where the machine is managed.
  await visitor.click("#rent-report");
  await visitor.waitForFunction(() => /Python 3\.12\.3, torch 2\.6\.0/.test(document.querySelector("#rent-report-out")?.textContent ?? ""), null, { timeout: 15000 });
  assert.equal(await visitor.locator("#rent-report-copy").isHidden(), false);
  await visitor.fill("#rent-presence", "0.1");
  await visitor.click("#rent-save-idle");
  await visitor.waitForFunction(() => /Saved/.test(document.querySelector("#notice")?.textContent ?? ""));
  await visitor.click("#close-settings");
  await visitor.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).locator(".name").click();
  await visitor.waitForSelector("#image-go");
  rentedAgent.state.release = false;
  await visitor.fill("#image-prompt", "slow please");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Generating, 27%/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  // The state of the request, refreshed every poll above the log, whether or not the log gains a line.
  await visitor.waitForFunction(() => /^Generating, 27% · (\d+ s|[\d.]+ min) in$/.test(document.querySelector("#image-status")?.textContent ?? ""), null, { timeout: 10000 });
  // Six seconds without a click would bring the check; the clip keeps it away.
  await new Promise((r) => setTimeout(r, 12000));
  // Left and opened again: the status line is back with the log.
  await visitor.keyboard.press("Escape");
  await visitor.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).locator(".name").click();
  await visitor.waitForSelector("#image-status:not([hidden])");
  assert.match(await visitor.locator("#image-status").innerText(), /^Generating, 27% · (\d+ s|[\d.]+ min) in$/);
  assert.equal(await visitor.locator("#presence").isHidden(), true, "no still-there check while the machine works on the clip");
  assert.equal(await visitor.locator("#image-out .image-card").count(), 0, "still generating");
  // Nothing gives up by the clock; the person can, beside the log: the
  // machine drops the job, which fails and can be asked again.
  assert.equal(await visitor.locator("#image-abort").innerText(), "Give up on this");
  rentedAgent.state.unloadRoute = true;
  await visitor.click("#image-abort");
  await visitor.waitForFunction(() => /Asked the machine to drop what it is working on[\s\S]*Could not make it: the machine's worker was reset from the page/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  await visitor.waitForSelector("#image-retry");
  assert.equal(await visitor.locator("#image-abort").count(), 0, "the way to give up goes with the run");
  rentedAgent.state.unloadRoute = false;
  await visitor.click("#image-retry");
  await visitor.waitForFunction(() => /Generating, 27%/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  // Added to the queue while the machine works: it waits, then starts by
  // itself when the request under way is done, with no click.
  await visitor.fill("#image-prompt", "a red barn");
  await visitor.click("#queue-add");
  assert.match(await visitor.locator("#queue-estimate").innerText(), /^1 request, about .* in all\. They start by themselves when the request under way finishes\./);
  assert.equal(await visitor.locator("#queue-go").isHidden(), true, "no Start all unless the queue is held");
  rentedAgent.state.release = true;
  await visitor.waitForSelector("#image-out .image-card", { timeout: 20000 });
  await visitor.waitForFunction(() => /Next from the queue\./.test(document.querySelector("#image-log")?.textContent ?? "") && document.querySelectorAll("#image-out .image-card").length === 2, null, { timeout: 20000 });
  assert.equal(rentedAgent.state.jobs.at(-1).prompt, "a red barn", "the queued request went by itself");
  assert.equal(await visitor.locator("#queue").isHidden(), true, "and left the queue");
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled);
  // Once the clip is made, the check comes as before.
  await visitor.waitForSelector("#presence:not([hidden])", { timeout: 20000 });
  await visitor.click("#presence-yes");
  // A machine that stops under a clip anyway (a Stop from elsewhere, RunPod
  // itself): the page says so within seconds instead of waiting to reconnect.
  rentedAgent.state.release = false;
  await visitor.fill("#image-prompt", "slow please, again");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Generating, 27%/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  rentedAgent.state.down = true;
  await visitor.request.post(`${hostedBase}/api/rent/stop`, { data: {} });
  await visitor.waitForFunction(() => /the machine stopped while generating/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 30000 });
  assert.match(await visitor.locator("#image-log").innerText(), /Start it from the bar and try again/);
  assert.equal(await visitor.locator("#image-retry").count(), 1);
  rentedAgent.state.down = false;
  rentedAgent.state.release = true;
  await visitor.request.post(`${hostedBase}/api/rent/start`, { data: {} });
  for (let i = 0; i < 4 && (await (await visitor.request.get(`${hostedBase}/api/rent`)).json()).status !== "RUNNING"; i++);
  await visitor.keyboard.press("Escape");
  await openSettings(visitor);
  await visitor.waitForSelector("#rent-presence");
  await visitor.fill("#rent-presence", "10");
  await visitor.click("#rent-save-idle");
  await visitor.waitForFunction(() => /Saved/.test(document.querySelector("#notice")?.textContent ?? ""));
  await visitor.click("#close-settings");
});

await step("hosted: clips are asked for by length and quality with a time guessed then learned, queued several at once, kept under the model and saved as they come, and the machine stopped after the last", async () => {
  const WAN = "Wan-AI/Wan2.2-TI2V-5B-Diffusers";
  rentedAgent.state.files.push({ repo: WAN, file: "model_index.json", gb: 10.2, engine: "diffusers" });
  await visitor.request.get(`${hostedBase}/api/rent`);
  await visitor.click("#nav-browse");
  await visitor.fill("#trait", "video generation");
  await visitor.click("#trait-go");
  await visitor.waitForSelector("#found .model");
  // An optional step not done (a reference part, say) stays out of the
  // way: hidden from the list, and the try box is there all the same.
  const withOptional = async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.plan.steps.push({ kind: "pull-image-repo", optional: true, done: false, title: "Add clips from reference pictures (62.0 GB more)", text: "Optional.", args: { repo: WAN, files: ["model_index.json"], gb: 62 } });
    await route.fulfill({ response: res, json: body });
  };
  await visitor.route(/\/api\/model\?id=Wan-AI/, withOptional);
  await visitor.locator("#found .model", { hasText: "Wan2.2-TI2V-5B-Diffusers" }).locator(".name").click();
  await visitor.waitForSelector("#video-seconds");
  assert.deepEqual(await visitor.$$eval("#steps .step", (els) => els.map((e) => [e.classList.contains("done"), e.hidden])), [[true, false], [false, true]], "the optional step is out of the list, and not in the way");
  await visitor.unroute(/\/api\/model\?id=Wan-AI/, withOptional);
  // A short clip is one shot; a long one, on a model that starts from a
  // picture, is pieces joined: chosen apart, each with its own lengths.
  assert.deepEqual(await visitor.$$eval("#clip-kind input", (els) => els.map((e) => [e.value, e.checked])), [["short", true], ["scene", false], ["long", false]]);
  assert.match(await visitor.locator(".clip-tabs").innerText(), /Short clip\s+1–5 s, one shot\s+Scene\s+up to 30 s, joined shots/);
  assert.equal(await visitor.locator(".scene-how").isHidden(), true, "a short clip has no way of shots to choose");

  assert.deepEqual(await visitor.$eval("#video-seconds", (e) => [e.value, e.min, e.max]), ["3", "1", "5"], "a short clip is 1 to 5 seconds");
  assert.equal(await visitor.locator("#seconds-help").innerText(), "1 to 5 s, one continuous shot.");
  await pickKind(visitor, "long");
  assert.deepEqual(await visitor.$eval("#video-seconds", (e) => [e.value, e.min, e.max]), ["30", "6", "30"], "a long clip is 6 to 30 seconds, 30 to begin with");
  assert.equal(await visitor.locator("#seconds-help").innerText(), "6 to 30 s, made from your words in pieces of up to 5 s, joined.");
  assert.equal(await visitor.locator(".clip-tab.active").innerText().then((t) => t.split("\n")[0]), "Scene", "the words in pieces are a way of making a scene");
  assert.match(await visitor.locator("#estimate").innerText(), /in all for a 30\.4-second clip made as 6 pieces of 5\.1 s/);
  await pickKind(visitor, "short");
  assert.deepEqual(await visitor.$eval("#video-seconds", (e) => [e.value, e.min, e.max]), ["3", "1", "5"], "back to the short clip's length");
  assert.deepEqual(await visitor.$$eval("#video-level input", (els) => els.map((e) => [e.value, e.checked])), [["low", false], ["medium", true], ["high", false]]);
  assert.match(await visitor.locator("#estimate").innerText(), /^About .* for a 3\.1-second clip at 1280 by 704, 49 frames, 30 steps \(a guess until the first clip is timed\)\./, "medium draws on the full canvas");
  assert.match(await visitor.locator("#video-level").innerText(), /Low\s+fast draft, smaller[\s\S]*Medium\s+full size[\s\S]*High\s+full size, more passes, words expanded/);
  assert.equal(await visitor.locator(".levels-note summary").innerText(), "What the levels change", "the explanation waits behind a click");
  await visitor.fill("#video-seconds", "5");
  await visitor.click("#video-level input[value=high]");
  assert.match(await visitor.locator("#estimate").innerText(), /5\.1-second clip at 1280 by 704, 81 frames, 50 steps/);
  // Claude suggests the description to use instead of the words typed,
  // at any quality; the person chooses to use it, and the avoid list comes along.
  await visitor.fill("#image-prompt", "jumping jacks in bare feet, do not zoom in");
  await visitor.click("#suggest-go");
  await visitor.waitForSelector("#suggest .suggest-text");
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).prompt, reviewed.at(-1).clip, reviewed.at(-1).image ?? null], ["suggest", "jumping jacks in bare feet, do not zoom in", true, null]);
  assert.match(await visitor.locator("#suggest").innerText(), /Claude suggests · Spelt out the motion[\s\S]*Avoid: socks, shoes, zooming in, closed eyes/);
  assert.match(await visitor.locator("#suggest .suggest-text").inputValue(), /^a woman in a bright gym doing jumping jacks in bare feet, feet apart as her hands meet overhead/);
  await visitor.click("#suggest-use");
  assert.match(await visitor.locator("#image-prompt").inputValue(), /^a woman in a bright gym doing jumping jacks/);
  assert.equal(await visitor.locator("#image-negative").inputValue(), "socks, shoes, zooming in, closed eyes");
  assert.equal(await visitor.locator("#suggest").isHidden(), true);
  await visitor.fill("#image-negative", "");
  // Two clips queued with different settings, saved to the computer as
  // they come, and the machine stopped once the last is made.
  const downloads = [];
  visitor.on("download", (d) => downloads.push(d.suggestedFilename()));
  await visitor.fill("#image-prompt", "waves at dusk");
  await visitor.check("#queue-hold");
  // At High the expansion shows first, to change; what is in the box goes, unreviewed.
  await visitor.click("#queue-add");
  await visitor.waitForSelector("#expand-text");
  assert.equal(await visitor.locator("#expand-text").inputValue(), "waves at dusk, in golden light, a slow pan");
  const reviewsBefore = reviewed.length;
  await visitor.fill("#expand-text", "waves at dusk, in golden light, a slow pan, and gulls");
  await visitor.click("#expand-send");
  assert.equal(await visitor.locator("#suggest").isHidden(), true);
  assert.equal(reviewed.length, reviewsBefore, "the edited text is not sent back to Claude");
  await visitor.fill("#video-seconds", "2");
  await visitor.click("#video-level input[value=low]");
  await visitor.fill("#image-prompt", "a long walk");
  await visitor.click("#queue-add");
  assert.equal(await visitor.locator("#queue-list li").count(), 2);
  assert.match(await visitor.locator("#queue-estimate").innerText(), /2 requests, about .* in all\. Held: they start with Start all\./);
  assert.equal(await visitor.locator("#queue-go").innerText(), "Start all 2");
  await visitor.check("#image-stop-after");
  // Letting the queue go starts it; the stop waits for the last.
  await visitor.uncheck("#queue-hold");
  await visitor.waitForFunction(() => /Stopped the rented GPU, as asked/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 30000 });
  const log = await visitor.locator("#image-log").innerText();
  assert.match(log, /1 of 2: waves at dusk[\s\S]*2 of 2: a long walk[\s\S]*All done: 2 made\./);
  assert.match(log, /Expanded description for "waves at dusk", with your changes: "waves at dusk, in golden light, a slow pan, and gulls"/, "the log shows what went, edits and all");
  assert.match(log, /the guess was .* and the next guess is adjusted/);
  assert.match(log, /Saved clip-[\w-]+\.mp4 to this computer/);
  const sent = rentedAgent.state.jobs.slice(-2);
  assert.deepEqual(sent.map((j) => [j.prompt, j.frames, j.fps, j.width, j.height, j.steps]), [["waves at dusk, in golden light, a slow pan, and gulls", 81, 16, 1280, 704, 50], ["a long walk", 33, 16, 832, 480, 20]], "the high clip goes with the expanded words as edited and 50 passes; the low one as typed");
  assert.match(sent[0].negative, /^blurry, low quality/, "nothing typed to avoid: the family's standard list at High");
  assert.equal(sent[1].negative, "", "and none at Low");
  assert.equal(await visitor.locator("#image-out .image-card video").count(), 2);
  for (let i = 0; i < 40 && downloads.length < 2; i++) await new Promise((r) => setTimeout(r, 250));
  assert.equal(downloads.length, 2, "both clips were saved to the computer as they came");
  assert.match(downloads[0], /^clip-[\w-]+\.mp4$/);
  assert.match(await visitor.locator("#estimate").innerText(), /adjusted from the last 2 clips made here/);
  assert.equal(runpod.state.actions.at(-1).split(":")[1], "stop");
  // A reply to a clip: no painting over with these models, so the same
  // model makes it again from the revised words with the same seed and settings.
  await visitor.uncheck("#image-stop-after");
  const firstClip = rentedAgent.state.jobs.at(-2);
  const firstCard = visitor.locator("#image-out .image-card").first();
  await firstCard.locator(".reply-go").click();
  await firstCard.locator(".reply-text").fill("slower camera pan");
  await firstCard.locator(".reply-run").click();
  await visitor.waitForFunction(() => document.querySelectorAll("#image-out .image-card").length === 3, null, { timeout: 20000 });
  const remade = rentedAgent.state.jobs.at(-1);
  assert.deepEqual([remade.prompt, remade.seed, remade.init ?? null, remade.frames, remade.width, remade.steps], ["waves at dusk, slower camera pan", firstClip.seed, null, 81, 1280, 50], "revised from the words asked, not the expansion, with the clip's own settings and seed");
  assert.match(await visitor.locator("#image-log").innerText(), /made again whole from the revised words with the same seed/);
  // The remake sits right under the clip it answers, and says so.
  const cards = visitor.locator("#image-out .image-card");
  assert.match(await cards.nth(0).locator(".caption").innerText(), /^waves at dusk · expanded by Claude and edited: waves at dusk, in golden light, a slow pan, and gulls · 5\.1 s at high quality/);
  assert.match(await cards.nth(1).locator(".caption").innerText(), /^In reply to an earlier clip \("slower camera pan"\) · waves at dusk, slower camera pan/);
  assert.match(await cards.nth(2).locator(".caption").innerText(), /^a long walk · 2\.1 s at low quality/);
  // A clip too big for the card: the size is remembered, the estimate warns
  // above it from then on, and Try again asks for the longest that fits.
  await visitor.fill("#video-seconds", "5");
  await visitor.click("#video-level input[value=high]");
  await visitor.fill("#image-prompt", "out of memory");
  await visitor.click("#image-go");
  // At High the expansion shows first; the words as typed are sent instead.
  await visitor.waitForSelector("#expand-mine");
  await visitor.click("#expand-mine");
  await visitor.waitForSelector("#image-retry", { timeout: 20000 });
  assert.match(await visitor.locator("#image-log").innerText(), /ran out of memory[\s\S]*A 4\.8-second clip at high quality should fit this machine; Try again below asks for that\. Low quality is a surer fit\./);
  assert.equal(await visitor.locator("#image-retry").innerText(), "Try again at 4.8 s");
  assert.match(await visitor.locator("#estimate").innerText(), /This machine ran out of memory at 5\.1 seconds at high quality \(81 frames at 1280 by 704\), so this is likely too big for it\. About 4\.8 seconds at high quality should fit; the same size was made here once, so it is on the edge\./, "the clip made earlier at this size is remembered, and the warning says so");
  assert.equal(await visitor.$eval("#estimate", (e) => e.classList.contains("warn")), true);
  await visitor.click("#image-retry");
  await visitor.waitForSelector("#expand-mine");
  await visitor.click("#expand-mine");
  await visitor.waitForSelector("#image-retry", { timeout: 20000 });
  assert.equal(rentedAgent.state.jobs.at(-1).frames, 77, "asked again at the length that fits");
  assert.match(await visitor.locator("#image-log").innerText(), /Sending your words as typed\./);
  assert.equal(await visitor.$eval("#video-seconds", (e) => e.value), "4.8");
  await visitor.fill("#video-seconds", "2");
  assert.doesNotMatch(await visitor.locator("#estimate").innerText(), /ran out of memory/, "under the limit, no warning");
  // Claude declining an expansion is said in the log, and the words go as they are.
  await visitor.fill("#video-seconds", "2");
  await visitor.click("#video-level input[value=high]");
  await visitor.fill("#image-prompt", "declined please");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Claude gave no expansion \(Claude declined to expand this one\.\); the words go as they are\./.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled, null, { timeout: 20000 });
  assert.equal(rentedAgent.state.jobs.at(-1).prompt, "declined please", "sent as typed");
  // Longer than one shot: the clip is made as pieces, each from the last
  // frame of the one before, then joined on the machine into one.
  await pickKind(visitor, "long");
  assert.equal(await visitor.$eval("#video-seconds", (e) => e.max), "30", "up to six shots' worth on a model that starts from a picture");
  await visitor.fill("#video-seconds", "12");
  await visitor.click("#video-level input[value=low]");
  assert.match(await visitor.locator("#estimate").innerText(), /in all for a 12\.2-second clip made as 3 pieces of 4\.1 s at 832 by 480, 65 frames each, 20 steps, each starting where the last ended, then joined \(a soft seam at each join\)/);
  const before = rentedAgent.state.jobs.length;
  await visitor.fill("#image-prompt", "a river in spring");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Joining the 3 pieces/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 30000 });
  await visitor.waitForFunction(() => /12\.2 s in 3 pieces/.test(document.querySelector("#image-out")?.textContent ?? ""), null, { timeout: 30000 });
  const pieces = rentedAgent.state.jobs.slice(before, before + 3);
  assert.deepEqual(pieces.map((j) => [j.prompt, j.frames, j.init ? j.init.slice(0, 22) : null, j.strength ?? null]), [["a river in spring", 65, null, null], ["a river in spring", 65, "data:image/png;base64,", 0.9], ["a river in spring", 65, "data:image/png;base64,", 0.9]], "the first from the words, the next two from the last frame before");
  assert.deepEqual(rentedAgent.state.joins.at(-1), pieces.map((j) => j.id), "joined in order");
  const pieceLog = await visitor.locator("#image-log").innerText();
  assert.match(pieceLog, /A 12\.2-second clip, made as 3 pieces of 4\.1 s[\s\S]*Piece 1 of 3\n[\s\S]*Piece 2 of 3, from the last frame of the one before[\s\S]*Piece 3 of 3[\s\S]*Joining the 3 pieces into one clip on the machine/);
  const joinedCard = visitor.locator("#image-out .image-card", { hasText: "12.2 s in 3 pieces" });
  assert.equal(await joinedCard.count(), 1);
  assert.match(await visitor.locator("#image-out .image-card", { hasText: "piece 2 of 3" }).locator(".caption").innerText(), /a river in spring · piece 2 of 3, 4\.1 s at low quality/);
  // A reply can continue the clip instead of changing it: the next clip
  // starts from the last frame, with the words for what happens next.
  await joinedCard.locator(".reply-go").click();
  assert.equal(await joinedCard.locator(".reply-go").innerText(), "Reply: fix a shot or continue it");
  await joinedCard.locator(".reply-mode input[value=continue]").check();
  assert.equal(await joinedCard.locator(".reply-run").innerText(), "Continue it");
  assert.match(await joinedCard.locator(".reply-text").getAttribute("placeholder"), /Say what happens next/);
  await joinedCard.locator(".reply-text").fill("ok, now the ice melts and the river runs again");
  await joinedCard.locator(".reply-run").click();
  await visitor.waitForFunction((n) => document.querySelectorAll("#image-out .image-card").length === n + 1, await visitor.locator("#image-out .image-card").count(), { timeout: 30000 });
  const next = rentedAgent.state.jobs.at(-1);
  assert.deepEqual([next.prompt, next.frames, next.init ? next.init.slice(0, 22) : null, next.strength], ["the ice melts and the river runs again, the scene going on", 65, "data:image/png;base64,", 0.9], "what happens next, written by Claude from the first description and the reply, from the joined clip's last frame, at the clip's own settings");
  assert.match(await visitor.locator("#image-log").innerText(), /Continuing the earlier clip: "ok, now the ice melts and the river runs again"\nClaude's next shot: "the ice melts and the river runs again, the scene going on"\. It starts from that clip's last frame\./);
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).prompt, reviewed.at(-1).request, reviewed.at(-1).image?.media_type ?? null], ["continue", "a river in spring", "ok, now the ice melts and the river runs again", "image/png"], "Claude was given the first description, what happens next, and the frame it starts from");
  assert.match(next.negative, /a different person, changed face, changed hair, changed clothes, changed background, studio backdrop/, "starting from a picture, the avoid list guards the person and the place");
  const cont = visitor.locator("#image-out .image-card", { hasText: "Continues an earlier clip" });
  assert.equal(await cont.count(), 1);
  assert.match(await cont.locator(".caption").innerText(), /^Continues an earlier clip \("ok, now the ice melts and the river runs again"\) · the ice melts and the river runs again, the scene going on · 4\.1 s at low quality/);
  // A fix to the pieced clip: only the piece the complaint touches is made
  // again, with the seed it had, from the last frame of the piece before;
  // the others are kept, and all are joined again, a kept one sent up
  // when the machine no longer has it. Claude reads which piece; the plan
  // shows first, to tick and change.
  await joinedCard.locator(".reply-mode input[value=change]").check();
  assert.equal(await joinedCard.locator(".reply-run").innerText(), "Fix it");
  assert.match(await joinedCard.locator(".reply-text").getAttribute("placeholder"), /Say what is wrong/);
  await joinedCard.locator(".reply-text").fill("the orange hat is missing from the second shot on");
  await joinedCard.locator(".reply-run").click();
  await joinedCard.locator(".fix .fix-shots li").nth(2).waitFor();
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).request, reviewed.at(-1).prompt, reviewed.at(-1).shots.map((s) => [s.index, s.seconds.toFixed(1), s.text])], ["fix", "the orange hat is missing from the second shot on", "a river in spring", [[1, "4.1", "a river in spring"], [2, "4.1", "a river in spring"], [3, "4.1", "a river in spring"]]], "Claude is given the pieces as they were made, with the request and the complaint");
  assert.match(await joinedCard.locator(".fix > p").first().innerText(), /^The fix, piece by piece\. Claude's reading: the hat was left out of shot 2\. A ticked piece is made again from the words in its row, with the same seed/);
  assert.deepEqual(await joinedCard.locator(".fix .fix-redo").evaluateAll((els) => els.map((e) => e.checked)), [false, true, false]);
  assert.equal(await joinedCard.locator(".fix .fix-carry").isChecked(), true, "the hat stays in frame: the pieces after follow");
  assert.deepEqual(await joinedCard.locator(".fix .fix-state").allInnerTexts(), ["kept", "made again", "made again, after the change"]);
  assert.match(await joinedCard.locator(".fix-total").innerText(), /^2 of 3 pieces made again \(8\.1 s of 12\.2\) at low quality, 832 by 480, 20 passes each, about [\s\S]*; the other 1 kept, then all joined again\./);
  await joinedCard.locator(".fix .fix-carry").uncheck();
  assert.deepEqual(await joinedCard.locator(".fix .fix-state").allInnerTexts(), ["kept", "made again", "kept"]);
  assert.match(await joinedCard.locator(".fix-total").innerText(), /^1 of 3 pieces made again \(4\.1 s of 12\.2\)/);
  assert.equal(await joinedCard.locator(".fix .fix-shots li").nth(1).locator(".shot-text").inputValue(), "a river in spring, his wife beside him in a big orange hat");
  // The third piece is gone from the machine: it goes up from the browser to be joined.
  rentedAgent.state.gone = new Set([pieces[2].id]);
  const fixBefore = rentedAgent.state.jobs.length;
  await joinedCard.locator(".fix-go").click();
  await visitor.waitForFunction(() => /Joining the 3 pieces into one clip on the machine \(1 of them sent up from this browser\)/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 30000 });
  await visitor.waitForFunction(() => /piece 2 made again for it, the rest kept/.test(document.querySelector("#image-out")?.textContent ?? ""), null, { timeout: 30000 });
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled, null, { timeout: 20000 });
  const remadePiece = rentedAgent.state.jobs[fixBefore];
  assert.deepEqual([remadePiece.prompt, remadePiece.seed, remadePiece.frames, remadePiece.init ? remadePiece.init.slice(0, 22) : null, remadePiece.strength], ["a river in spring, his wife beside him in a big orange hat", pieces[1].seed, 65, "data:image/png;base64,", 0.9], "one piece made again: Claude's words, the seed it had, from the last frame of the piece before");
  assert.deepEqual(rentedAgent.state.joins.at(-1), [pieces[0].id, remadePiece.id, "sent:fake mp4"], "the kept first piece by its job, the new second, and the third sent up from the browser");
  assert.match(await visitor.locator("#image-log").innerText(), /Fix to the earlier clip: "the orange hat is missing from the second shot on"\n1 of 3 pieces made again from revised words by Claude, each with the seed it had and starting from the last frame of the one before; the other 2 kept as they were; then all joined again:\n\s+Piece 1 \(4\.1 s\): kept\n\s+Piece 2 \(4\.1 s\): a river in spring, his wife beside him in a big orange hat\n\s+Piece 3 \(4\.1 s\): kept\nPiece 1 of 3: kept as it was\nPiece 2 of 3, made again, from the last frame of the one before\n[\s\S]*Piece 3 of 3: kept as it was/);
  const fixedCard = visitor.locator("#image-out .image-card", { hasText: "piece 2 made again for it" });
  assert.equal(await fixedCard.count(), 1);
  assert.match(await fixedCard.locator(".caption").innerText(), /^In reply to an earlier clip \("the orange hat is missing from the second shot on"\) · piece 2 made again for it, the rest kept · a river in spring · 12\.2 s in 3 pieces, low quality, 832 by 480, 20 steps/);
  assert.match(await visitor.locator("#image-out .image-card", { hasText: "piece 2 of 3, made again" }).locator(".caption").innerText(), /a river in spring, his wife beside him in a big orange hat · piece 2 of 3, made again, 4\.1 s at low quality/);
  rentedAgent.state.gone = null;
  // Claude naming no piece: the one the reply names is ticked instead, and the plan can be dropped.
  await fixedCard.locator(".reply-go").click();
  await fixedCard.locator(".reply-text").fill("no idea what went wrong, but the hat is missing in the last shot");
  await fixedCard.locator(".reply-run").click();
  await fixedCard.locator(".fix .fix-shots li").nth(2).waitFor();
  assert.match(await fixedCard.locator(".fix > p").first().innerText(), /^The fix, piece by piece\. Claude named no piece to make again \(I cannot tell which shot from this\.\); the piece your reply names is ticked\./);
  assert.deepEqual(await fixedCard.locator(".fix .fix-redo").evaluateAll((els) => els.map((e) => e.checked)), [false, false, true], "the last shot, from the words");
  const fixJobs = rentedAgent.state.jobs.length;
  // Left and opened again with the plan on show: it is there as it was, ticks and words, on the clip's card.
  await fixedCard.locator(".fix .shot-text").nth(0).fill("the first shot, reworded by hand");
  // Drawn afresh, as opening the window again draws it (the machine is
  // stopped here, so a real reopen would offer Start instead of the tool).
  await visitor.evaluate(() => renderTry(state.model, state.plan));
  await visitor.waitForSelector("#video-seconds");
  const refixed = visitor.locator(".image-card", { hasText: "piece 2 made again for it" }).first();
  await refixed.locator(".fix .fix-shots li").nth(2).waitFor();
  assert.deepEqual(await refixed.locator(".fix .fix-redo").evaluateAll((els) => els.map((e) => e.checked)), [true, false, true], "the ticks as left, the hand edit having ticked the first");
  assert.equal(await refixed.locator(".fix .shot-text").nth(0).inputValue(), "the first shot, reworded by hand");
  assert.equal(await refixed.locator(".reply").isHidden(), false, "the reply box is open as it was left");
  await refixed.locator(".fix-discard").click();
  assert.equal(await refixed.locator(".fix").count(), 0);
  // Discarded, it stays gone when the window is opened again.
  // Drawn afresh, as opening the window again draws it (the machine is
  // stopped here, so a real reopen would offer Start instead of the tool).
  await visitor.evaluate(() => renderTry(state.model, state.plan));
  await visitor.waitForSelector("#video-seconds");
  assert.equal(await visitor.locator(".image-card .fix").count(), 0);
  assert.equal(rentedAgent.state.jobs.length, fixJobs);
  // A scene: Claude lays the words out as shots, each with its own
  // description and length, shown first to change; each shot is made from
  // the last frame of the one before, then all are joined. It goes by way
  // of a preview, which can be read while the machine is busy with
  // something else, and from there into the queue.
  assert.match(await visitor.locator(".clip-tabs").innerText(), /Scene\s+up to 30 s, joined shots/);
  await pickKind(visitor, "short");
  await visitor.fill("#video-seconds", "3");
  rentedAgent.state.release = false;
  await visitor.fill("#image-prompt", "slow please");
  await visitor.click("#image-go");
  await visitor.waitForFunction(() => /Generating, 27%/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  const sceneBefore = rentedAgent.state.jobs.length;
  await pickKind(visitor, "scene");
  assert.deepEqual(await visitor.$$eval("#image-go, #queue-add, #scene-preview", (els) => els.map((e) => [e.id, e.hidden])), [["image-go", true], ["queue-add", true], ["scene-preview", false]], "a scene goes by way of the preview");
  assert.equal(await visitor.locator("#scene-preview").innerText(), "Preview Claude's scene setup");
  assert.equal(await visitor.locator("#scene-preview").isEnabled(), true, "the preview is there while the machine works");
  assert.deepEqual(await visitor.$eval("#video-seconds", (e) => [e.value, e.min, e.max]), ["30", "2", "30"]);
  assert.equal(await visitor.locator("#seconds-help").innerText(), "2 to 30 s in all. Claude splits it into shots of 1 to 5 s, which you check first.");
  assert.equal(await visitor.locator(".scene-how").isHidden(), false, "inside a scene: Claude's shots or the words in pieces");
  await visitor.fill("#video-seconds", "12");
  assert.match(await visitor.locator("#estimate").innerText(), /in all for a scene of about 12 seconds, made as shots Claude lays out \(guessed here as 3 of about 4\.1 s\) at 832 by 480, 20 steps, each starting where the last ended, then joined \(a soft seam at each cut\)/);
  await visitor.fill("#image-prompt", "a man on a trampoline does a front flip, falls on his face, then a backflip; the camera pans to his father applauding");
  await visitor.click("#scene-preview");
  await visitor.waitForSelector("#shots li");
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).seconds, reviewed.at(-1).minSeconds, reviewed.at(-1).maxSeconds, reviewed.at(-1).clip], ["scene", 12, 1, 5, true], "Claude is told the length and the model's shot range");
  assert.equal(await visitor.locator("#shots li").count(), 3);
  assert.deepEqual(await visitor.$$eval("#shots .shot-seconds", (els) => els.map((e) => e.value)), ["4", "3", "5"], "bold, bulleted and running-time lines are read all the same");
  assert.deepEqual(await visitor.$$eval("#shots .shot-avoid", (els) => els.map((e) => e.value)), ["a second person, a flip", "", "a second trampoline"], "each shot's own avoid list in its field, 'nothing' as empty");
  assert.match(await visitor.locator("#suggest").innerText(), /with its own avoid list on top of yours/);
  // Left and opened again: the preview is back as Claude laid it out, ready to change and send.
  const reviewsBeforeReopen = reviewed.length;
  await visitor.evaluate(() => renderTry(state.model, state.plan));
  await visitor.waitForSelector("#shots li");
  assert.deepEqual(await visitor.$$eval("#shots .shot-seconds", (els) => els.map((e) => e.value)), ["4", "3", "5"]);
  assert.deepEqual(await visitor.$$eval("#shots .shot-avoid", (els) => els.map((e) => e.value)), ["a second person, a flip", "", "a second trampoline"]);
  assert.equal(reviewed.length, reviewsBeforeReopen, "shown again from what was kept, not asked of Claude again");
  assert.match(await visitor.locator("#suggest").innerText(), /Claude's note: the father is in frame from the first shot\./);
  assert.match(await visitor.locator("#shots-total").innerText(), /^3 shots, 12\.2 s in all at low quality \(832 by 480, 20 passes each\), about [\s\S]*A lower quality above makes every shot quicker\./);
  assert.equal(await visitor.locator("#scene-go").isHidden(), true, "busy: the scene cannot be made now");
  assert.equal(await visitor.locator("#scene-queue").innerText(), "Add to queue (runs after the request under way)");
  // Changed by hand: one shot's words, another's length, a fourth added
  // then removed; nothing goes back to Claude.
  const sceneReviews = reviewed.length;
  // A line to Claude under one shot: that shot's words change, and Claude says what changed in a line.
  assert.deepEqual(await visitor.$$eval("#shots .shot-n", (els) => els.map((e) => e.textContent)), ["Shot 1", "Shot 2", "Shot 3"]);
  await visitor.fill("#shots li:nth-child(2) .shot-ask-text", "the arm should swing slowly");
  await visitor.press("#shots li:nth-child(2) .shot-ask-text", "Enter");
  await visitor.waitForFunction(() => /^Claude: /.test(document.querySelector("#shots li:nth-child(2) .shot-said")?.textContent ?? ""));
  assert.equal(await visitor.locator("#shots li:nth-child(2) .shot-said").innerText(), "Claude: the arm's motion is spelt out.");
  assert.match(await visitor.inputValue("#shots li:nth-child(2) .shot-text"), /lands flat on his face on the trampoline, the arm in one slow arc, sunny back garden$/);
  assert.equal(await visitor.inputValue("#shots li:nth-child(2) .shot-avoid"), "a stiff arm", "Claude's Avoid line goes into the shot's field");
  assert.equal(reviewed.at(-1).negative, "", "the shot's own list went along, empty for this one");
  await visitor.fill("#shots li:nth-child(1) .shot-avoid", "a second person, a flip, a dog");
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).request, reviewed.at(-1).seconds, reviewed.at(-1).clip], ["revise", "the arm should swing slowly", 3, true]);
  assert.equal(await visitor.inputValue("#shots li:nth-child(2) .shot-ask-text"), "", "the line is cleared once the change is made");
  await visitor.fill("#shots li:nth-child(2) .shot-text", "the same man in the grey T-shirt does a front flip and lands flat on his face on the trampoline, bare feet, sunny back garden");
  await visitor.fill("#shots li:nth-child(3) .shot-seconds", "4");
  // Shorter than Claude wrote it for: the row says the end may be cut, and Claude can fit it.
  assert.match(await visitor.locator("#shots li:nth-child(3) .shot-fit").innerText(), /^Written for 5 s; at 4 s the end may be cut\. Fit to 4 s$/);
  const shotBefore = await visitor.inputValue("#shots li:nth-child(3) .shot-text");
  await visitor.click("#shots li:nth-child(3) .shot-fit-go");
  await visitor.waitForFunction(() => /Left out to fit: the bow at the end/.test(document.querySelector("#shots li:nth-child(3)")?.textContent ?? ""));
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).fromSeconds, reviewed.at(-1).seconds, reviewed.at(-1).prompt], ["fit", 5, 4, shotBefore]);
  assert.equal(await visitor.inputValue("#shots li:nth-child(3) .shot-text"), `${shotBefore.split(",")[0]}, camera still`);
  await visitor.fill("#shots li:nth-child(3) .shot-text", shotBefore);
  await visitor.click("#shot-add");
  assert.equal(await visitor.locator("#shots li").count(), 4);
  await visitor.locator("#shots li:nth-child(4) .shot-remove").click();
  assert.match(await visitor.locator("#shots-total").innerText(), /^3 shots, 11\.2 s in all at low quality/);
  await visitor.click("#scene-queue");
  assert.equal(reviewed.length, sceneReviews + 2, "only the change and the fit asked for went to Claude; the edited shots are not sent back");
  assert.equal(await visitor.locator("#suggest").isHidden(), true);
  assert.equal(await visitor.locator("#queue-list li").count(), 1);
  assert.match(await visitor.locator("#queue-list").innerText(), /a man on a trampoline[\s\S]*11\.2 s as a scene of 3 shots at low quality, 832 by 480, 20 steps/);
  assert.match(await visitor.locator("#queue-estimate").innerText(), /They start by themselves when the request under way finishes/);
  // The clip under way finishes: the scene goes next, by itself.
  rentedAgent.state.release = true;
  await visitor.waitForFunction(() => /Joining the 3 pieces/.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 40000 });
  await visitor.waitForFunction(() => /11\.2 s as a scene of 3 shots/.test(document.querySelector("#image-out")?.textContent ?? ""), null, { timeout: 30000 });
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled, null, { timeout: 20000 });
  const shotJobs = rentedAgent.state.jobs.filter((j) => /grey T-shirt/.test(j.prompt));
  assert.ok(rentedAgent.state.jobs.length >= sceneBefore + 3, "three shot jobs after the clip that was under way");
  assert.deepEqual(shotJobs.map((j) => [j.prompt, j.frames, j.init ? j.init.slice(0, 22) : null]), [["a man in a grey T-shirt bounces on a trampoline in a sunny back garden, camera still", 65, null], ["the same man in the grey T-shirt does a front flip and lands flat on his face on the trampoline, bare feet, sunny back garden", 49, "data:image/png;base64,"], ["the man in the grey T-shirt does a backflip and lands on his feet on the trampoline; the camera pans to his elderly father applauding at the garden fence", 65, "data:image/png;base64,"]], "each shot goes with its own words and length, the later ones from the frame before");
  // Each shot's own list follows the request's; the later shots, starting from a frame, then get the start-picture guard.
  assert.match(shotJobs[0].negative, /^blurry, low quality, [^]*cluttered background, a second person, a flip, a dog$/, "the first shot's own avoid list, as edited, after the request's");
  assert.match(shotJobs[1].negative, /cluttered background, a stiff arm, a different person, changed face/, "the second shot's, from Claude's Avoid line");
  assert.match(shotJobs[2].negative, /cluttered background, a second trampoline, a different person, changed face/, "the third shot's");
  assert.match(await visitor.locator("#image-log").innerText(), /Shot 1 \(4\.1 s\): a man in a grey T-shirt[^\n]*\(avoiding a second person, a flip, a dog\)\n\s+Shot 2 \(3\.1 s\)[^\n]*\(avoiding a stiff arm\)/);
  assert.match(await visitor.locator("#image-log").innerText(), /Next from the queue\.\n[\s\S]*Scene of 11\.2 seconds in 3 shots, laid out by Claude, with your changes, each starting where the last ended, then joined:\n\s+Shot 1 \(4\.1 s\): a man in a grey T-shirt[\s\S]*Shot 1 of 3\n[\s\S]*Shot 2 of 3, from the last frame of the one before[\s\S]*Shot 3 of 3/);
  const sceneCard = visitor.locator("#image-out .image-card", { hasText: "as a scene of 3 shots" });
  assert.match(await sceneCard.locator(".caption").innerText(), /a scene of 3 shots laid out by Claude and edited: 1 \(4\.1 s\) a man in a grey T-shirt[\s\S]*2 \(3\.1 s\)[\s\S]*3 \(4\.1 s\)[\s\S]*11\.2 s as a scene of 3 shots, low quality, 832 by 480, 20 steps/);
  // No shot lines from Claude: the preview says so, and the words can go
  // as one clip, or as equal pieces when the length needs them.
  await visitor.fill("#video-seconds", "2");
  await visitor.fill("#image-prompt", "no shots please");
  await visitor.click("#scene-preview");
  await visitor.waitForSelector("#scene-go:not([hidden])");
  assert.match(await visitor.locator("#suggest").innerText(), /No shots from Claude \(Claude wrote no Shot lines\)\. Your words can go as one clip instead\.[\s\S]*Claude wrote, instead of shots: I cannot lay this one out as shots\./);
  assert.equal(await visitor.locator("#scene-queue").innerText(), "Add to queue", "free now: the scene can be made at once or queued");
  await visitor.click("#scene-go");
  await visitor.waitForFunction(() => /Claude laid out no shots \(Claude wrote no Shot lines\)\. Made as one clip from your words instead\./.test(document.querySelector("#image-log")?.textContent ?? ""), null, { timeout: 20000 });
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled, null, { timeout: 20000 });
  assert.deepEqual([rentedAgent.state.jobs.at(-1).prompt, rentedAgent.state.jobs.at(-1).frames], ["no shots please", 33]);
  // Discarded: nothing goes anywhere.
  await visitor.fill("#image-prompt", "a second thought");
  await visitor.click("#scene-preview");
  await visitor.waitForSelector("#scene-discard");
  const jobsBeforeDiscard = rentedAgent.state.jobs.length;
  await visitor.click("#scene-discard");
  assert.equal(await visitor.locator("#suggest").isHidden(), true);
  assert.equal(rentedAgent.state.jobs.length, jobsBeforeDiscard);
  assert.equal(await visitor.locator("#queue-list li").count(), 0);
  // A photo of the person: shown it, Claude writes no shots; told of it
  // instead, it lays the scene out with the person kept as in the picture.
  await visitor.setInputFiles("#video-start", { name: "her.png", mimeType: "image/png", buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64") });
  await visitor.fill("#video-seconds", "8");
  await visitor.fill("#image-prompt", "shy with the picture: she takes off her sweater and folds it");
  const shyBefore = reviewed.length;
  await visitor.click("#scene-preview");
  await visitor.waitForSelector("#shots li");
  assert.equal(reviewed.length - shyBefore, 2, "asked twice: with the photo, then with the photo described");
  assert.deepEqual([Boolean(reviewed.at(-2).image), reviewed.at(-2).pictureUnseen ?? false, reviewed.at(-1).image ?? null, reviewed.at(-1).pictureUnseen], [true, false, null, true]);
  assert.match(await visitor.locator("#suggest").innerText(), /With the photo in front of it, Claude wrote no shots\. Told of the photo instead of shown it, it laid these out; they keep the person and the place as they are in the picture\.[\s\S]*Claude's note: the person and place are taken as they are in the picture\./);
  assert.equal(await visitor.locator("#shots li").count(), 2);
  assert.match(await visitor.locator("#shots li:nth-child(1) .shot-text").inputValue(), /the picture's setting kept$/);
  await visitor.click("#scene-discard");
  await visitor.setInputFiles("#video-start", []);
  await pickKind(visitor, "short");
  await visitor.fill("#video-seconds", "3");
  await visitor.fill("#image-prompt", "");
  // Leaving the window loses nothing: the clips are kept under the model.
  await visitor.keyboard.press("Escape");
  await visitor.locator("#found .model", { hasText: "Wan2.2-TI2V-5B-Diffusers" }).locator(".name").click();
  // The machine is stopped, so the window offers to start it; the clips show all the same.
  await visitor.waitForSelector("#kept .image-card");
  assert.equal(await visitor.locator("#kept .image-card").count(), 17, `the two clips, the reply, the unexpanded one, the three pieces, the joined clip, the piece made again and the clip fixed with it, the continuation, the slow clip, the three shots, the joined scene and the clip made without shots; got: ${JSON.stringify(await visitor.$$eval("#kept .caption", (els) => els.map((e) => e.textContent.slice(0, 90))))}`);
  assert.match(await visitor.locator("#kept").innerText(), /Kept here[\s\S]*17 results made with this model[\s\S]*no shots please[\s\S]*as a scene of 3 shots[\s\S]*shot 3 of 3[\s\S]*shot 1 of 3[\s\S]*piece 2 made again for it, the rest kept[\s\S]*piece 2 of 3, made again[\s\S]*Continues an earlier clip[\s\S]*12\.2 s in 3 pieces[\s\S]*piece 3 of 3[\s\S]*piece 1 of 3[\s\S]*In reply to an earlier clip \("slower camera pan"\)[\s\S]*a long walk[\s\S]*2\.1 s at low quality[\s\S]*waves at dusk[\s\S]*5\.1 s at high quality/);
  await visitor.locator("#kept .kept-remove").first().click();
  await visitor.waitForFunction(() => document.querySelectorAll("#kept .image-card").length === 16);
  // Results from an earlier session wait under a folded bar; this
  // session's stay on show.
  const sessionWas = await visitor.evaluate(() => sessionStorage.getItem("hfSessionStart"));
  await visitor.evaluate(() => sessionStorage.setItem("hfSessionStart", String(Date.now() + 864e5)));
  await visitor.keyboard.press("Escape");
  await visitor.locator("#found .model", { hasText: "Wan2.2-TI2V-5B-Diffusers" }).locator(".name").click();
  await visitor.waitForSelector("#kept .kept-older");
  assert.match(await visitor.locator("#kept .kept-older summary").innerText(), /^Earlier sessions · 16 results, /);
  assert.equal(await visitor.locator("#kept .image-card").count(), 0, "folded away until asked for");
  await visitor.click("#kept .kept-older summary");
  await visitor.waitForFunction(() => document.querySelectorAll("#kept .kept-older .image-card").length === 16);
  await visitor.evaluate((v) => sessionStorage.setItem("hfSessionStart", v), sessionWas);
  await visitor.keyboard.press("Escape");
  // The machine stopped as asked; started again, and the clip model taken
  // off the stand-in machine, for what follows.
  rentedAgent.state.files = rentedAgent.state.files.filter((f) => f.repo !== WAN);
  rentedAgent.state.loaded = "second-state/stable-diffusion-v1-5-GGUF/stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf";
  await visitor.request.post(`${hostedBase}/api/rent/start`, { data: {} });
  for (let i = 0; i < 4 && (await (await visitor.request.get(`${hostedBase}/api/rent`)).json()).status !== "RUNNING"; i++);
});

await step("hosted: the bar opens one list of everything on the machine, with Open and Remove", async () => {
  // The poll refreshes the counts in the bar.
  await visitor.request.get(`${hostedBase}/api/rent`);
  await visitor.reload();
  await visitor.waitForSelector("#bar-models");
  await visitor.waitForFunction(() => /\d+ models? on it/.test(document.querySelector("#bar-models").textContent));
  // One entry per model: a model still coming shows as its download alone,
  // with what is on the disk so far, not as a model to open or remove yet.
  const SDXL = "stabilityai/stable-diffusion-xl-base-1.0";
  rentedAgent.state.slowMs = 150;
  rentedAgent.state.files.push({ repo: SDXL, file: "model_index.json", gb: 3.2, engine: "diffusers" });
  const coming = await (await visitor.request.post(`${hostedBase}/api/run`, { data: { kind: "pull-image-model", args: { repo: SDXL, file: "sd_xl_base_1.0.safetensors" }, where: "rented", model: SDXL } })).json();
  assert.ok(coming.id);
  await visitor.click("#bar-models");
  await visitor.waitForSelector("#gpu-runs li");
  // The machine's own report, to read or copy: what it runs, holds and how its failures went.
  await visitor.click("#gpu-report");
  await visitor.waitForFunction(() => /Agent 31, up 2 min/.test(document.querySelector("#gpu-report-out")?.textContent ?? ""), null, { timeout: 15000 });
  assert.match(await visitor.locator("#gpu-report-out").innerText(), /Python 3\.12\.3, torch 2\.6\.0 \(CUDA 12\.4\), diffusers 0\.41\.0, transformers 5\.5\.3, peft 0\.18\.0, av 15\.0\.0[\s\S]*Cards: Fake A40 48 GB[\s\S]*Disk: 41\.5 GB free of 50, 8\.5 GB in the machine's folders \(a quota; the size as the site said it\)[\s\S]*No failures on this machine\.[\s\S]*Journal \(tail\):/);
  assert.equal(await visitor.locator("#gpu-report-copy").isHidden(), false);
  assert.equal(await visitor.locator("#gpu-models li", { hasText: "stable-diffusion-xl-base-1.0" }).count(), 1, "one entry for a model still coming");
  assert.match(await visitor.locator("#gpu-runs li").innerText(), /3\.2 GB of it on the disk so far[\s\S]*downloading/);
  assert.equal(await visitor.locator(`#gpu-models li[data-kind="image"][data-repo="${SDXL}"]`).count(), 0, "not listed as a model yet");
  await visitor.keyboard.press("Escape");
  rentedAgent.state.slowMs = undefined;
  for (let i = 0; i < 200; i++) {
    const run = (await (await visitor.request.get(`${hostedBase}/api/runs`)).json()).runs.find((x) => x.id === coming.id);
    if (run && run.status !== "running") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  rentedAgent.state.files = rentedAgent.state.files.filter((f) => f.repo !== SDXL);
  await visitor.click("#bar-models");
  await visitor.waitForSelector("#gpu-models .gpu-list li");
  await visitor.click("#gpu-models-refresh");
  await visitor.waitForFunction(() => !document.querySelector("#gpu-runs"));
  const text = await visitor.locator("#gpu-models-body").innerText();
  assert.match(text, /Chat models[\s\S]*Cydonia[\s\S]*Image models[\s\S]*stable-diffusion-v1-5-pruned-emaonly-Q8_0\.gguf/);
  assert.match(text, /loaded in the GPU/);
  const chatRow = visitor.locator('#gpu-models li[data-kind="chat"]', { hasText: "Cydonia" });
  assert.match(await chatRow.innerText(), /TheDrummer\/Cydonia-24B-v2-GGUF/);
  assert.equal(await visitor.locator('#gpu-models li[data-kind="chat"]', { hasText: "llama3.2:3b" }).locator("[data-open]").count(), 0, "a model not from the Hub has no window to open");
  await chatRow.locator("[data-open]").click();
  await visitor.waitForSelector("#steps .step");
  assert.equal(await visitor.locator(".where-opt.on").innerText(), "On a rented GPU");
  assert.equal(await visitor.locator("#gpu-models").isVisible(), false);
  await visitor.keyboard.press("Escape");
  await visitor.click("#bar-models");
  await visitor.waitForSelector('#gpu-models li[data-kind="image"]');
  acceptDialogs = true;
  await visitor.locator('#gpu-models li[data-kind="image"] [data-remove]').click();
  await visitor.waitForFunction(() => !document.querySelector('#gpu-models li[data-kind="image"]'));
  acceptDialogs = false;
  assert.ok(rentedAgent.state.deleted.length > 0);
  await visitor.keyboard.press("Escape");
});

await step("hosted: a video model's LoRAs are found on Hugging Face, added to the machine, used for the next clip at the strength set, and still ticked when the window opens again", async () => {
  // The clip model on the machine again, for this step alone.
  const WAN_HERE = { repo: "Wan-AI/Wan2.2-TI2V-5B-Diffusers", file: "model_index.json", gb: 20.4, engine: "diffusers" };
  rentedAgent.state.files.push(WAN_HERE);
  await visitor.evaluate(() => openModel("Wan-AI/Wan2.2-TI2V-5B-Diffusers"));
  await visitor.waitForSelector("#loras").catch(async (err) => {
    throw new Error(`${err.message}\n${await visitor.locator("#modal-body").innerText().catch(() => "")}`.slice(0, 1500));
  });
  assert.match(await visitor.locator("#loras summary").innerText(), /LoRAs and fine-tunes\s+optional/);
  await visitor.click("#loras summary");
  await visitor.click("#lora-look");
  const hit = visitor.locator("#lora-found .lora-hit", { hasText: "Wan-TI2V-Motion-LoRA" });
  await hit.waitFor();
  assert.match(await hit.innerText(), /Hugging Face\s+LoRA[\s\S]*by motionlab · 900 downloads/);
  assert.match(await visitor.locator("#lora-found").innerText(), /Civitai has no listing for this model, so only Hugging Face was searched/);
  assert.equal(await visitor.isChecked("#lora-adult"), false, "adult results only when asked for");
  // A pasted link is read as one item; a link it cannot read is said plainly.
  await visitor.fill("#lora-url", "https://example.com/not-a-model");
  await visitor.click("#lora-url-go");
  await visitor.waitForFunction(() => /paste a PromptHero model page, a Civitai model page or a Hugging Face repository/.test(document.querySelector("#lora-linked")?.textContent ?? ""));
  await visitor.fill("#lora-url", "https://huggingface.co/motionlab/Wan-TI2V-Motion-LoRA");
  await visitor.press("#lora-url", "Enter");
  await visitor.locator("#lora-linked .lora-hit", { hasText: "Wan-TI2V-Motion-LoRA" }).waitFor();
  await hit.locator(".lora-pick").click();
  await hit.locator(".lora-get").waitFor();
  assert.match(await hit.locator(".lora-file").innerText(), /wan_motion_v1\.safetensors, 307 MB/);
  const jobs = rentedAgent.state.jobs.length;
  await hit.locator(".lora-get").click();
  await visitor.waitForFunction(() => /is on the machine and ticked/.test(document.querySelector("#notice")?.textContent ?? ""), null, { timeout: 20000 });
  assert.ok(rentedAgent.state.downloads.some((d) => d.addon && d.repo === "motionlab/Wan-TI2V-Motion-LoRA" && d.files[0] === "wan_motion_v1.safetensors"), "the machine fetched it");
  const row = visitor.locator(".lora-row", { hasText: "Wan-TI2V-Motion-LoRA" });
  assert.equal(await row.locator(".lora-on").isChecked(), true);
  await row.locator(".lora-strength").evaluate((r) => {
    r.value = "0.8";
    r.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.match(await visitor.locator("#loras-count").innerText(), /^1 LoRA on$/);
  // How its creator made the showcase: the card's strength, trigger word,
  // settings and example prompt; the prompt and the settings taken over.
  await row.locator(".lora-recipe").click();
  const recipe = row.locator(".lora-recipe-box");
  await recipe.locator(".lora-sample").waitFor();
  const recipeText = await recipe.innerText();
  assert.match(recipeText, /How motionlab made the clips that show it off/);
  assert.match(recipeText, /Strength: 0\.8 the creator's own word/);
  assert.match(recipeText, /Settings: 30 steps, guidance 1/);
  assert.match(recipeText, /Trigger words: mvmt/);
  assert.match(recipeText, /Works best at 0\.7 to 0\.9 strength; above 1\.0 limbs smear\./);
  assert.equal(await recipe.locator(".lora-sample video").getAttribute("src"), `${stub.base}/motionlab/Wan-TI2V-Motion-LoRA/resolve/main/samples/spin.mp4`);
  await recipe.locator(".lora-use-prompt").first().click();
  assert.equal(await visitor.inputValue("#image-prompt"), "mvmt, a dancer spins across a sunlit studio floor, slow dolly in");
  await recipe.locator(".lora-ask-claude").click();
  await visitor.waitForFunction(() => /Strength: 0\.8/.test(document.querySelector(".lora-claude-text")?.textContent ?? ""));
  assert.equal(reviewed.at(-1).mode, "lora");
  assert.deepEqual(reviewed.at(-1).lora.trigger, ["mvmt"]);
  await recipe.locator(".lora-use-settings").first().click();
  await row.locator(".lora-settings-pill").waitFor();
  assert.match(await row.locator(".lora-settings-pill").innerText(), /30 steps, guidance 1/);
  assert.equal(await row.locator(".lora-recipe-box").isVisible(), true, "the panel stays open through the redraw");
  assert.match(await visitor.locator("#estimate").innerText(), /30 steps[\s\S]*Steps and guidance follow what Wan-TI2V-Motion-LoRA's creator used \(30 steps, guidance 1\)/);
  // A few words of the person's own, fitted by Claude to the LoRA: the
  // description in the showcase's shape with the trigger word first, the
  // strength the creator recommends and the settings, all taken on "Use it".
  assert.equal(await visitor.locator("#suggest-go").innerText(), "Ask Claude to fit it to Wan-TI2V-Motion-LoRA");
  await visitor.fill("#image-prompt", "show this man eating an apple");
  await visitor.click("#suggest-go");
  await visitor.locator("#suggest .suggest-text").waitFor();
  const fitted = reviewed.at(-1);
  assert.equal(fitted.mode, "suggest");
  assert.deepEqual([fitted.loras.length, fitted.loras[0].name, fitted.loras[0].trigger, fitted.loras[0].strength, fitted.loras[0].recommended, fitted.loras[0].settings, fitted.loras[0].samples[0].prompt], [1, "Wan-TI2V-Motion-LoRA", ["mvmt"], 0.8, "0.8 (their words: strength: 0.8)", "30 steps, guidance 1", "mvmt, a dancer spins across a sunlit studio floor, slow dolly in"], "Claude was shown how the creator prompts for it");
  assert.ok(fitted.loras[0].tips.includes("Works best at 0.7 to 0.9 strength; above 1.0 limbs smear."));
  const suggestText = await visitor.locator("#suggest").innerText();
  assert.match(suggestText, /Claude suggests, fitted to Wan-TI2V-Motion-LoRA/);
  assert.match(suggestText, /Strength: Wan-TI2V-Motion-LoRA from 0\.80 to 0\.70/);
  assert.match(suggestText, /Settings: 30 steps, guidance 1 for clips with Wan-TI2V-Motion-LoRA/);
  assert.match(await visitor.inputValue("#suggest .suggest-text"), /^mvmt, the man as in the picture eating an apple in one continuous movement/);
  await visitor.click("#suggest-use");
  assert.match(await visitor.inputValue("#image-prompt"), /^mvmt, the man as in the picture eating an apple/);
  await visitor.waitForFunction(() => document.querySelector(".lora-row .lora-strength")?.value === "0.7");
  assert.match(await visitor.locator(".lora-row .lora-settings-pill").innerText(), /30 steps, guidance 1/);
  // Passes that barely change can be skipped: a switch under the levels, kept per model.
  assert.equal(await visitor.isChecked("#fast-passes"), false);
  await visitor.check("#fast-passes");
  assert.match(await visitor.locator("#estimate").innerText(), /Passes that barely change are skipped\./);
  // Two more under it, image 27's: fp8 weights (the machine has not said its card lacks the units) and compiled blocks.
  assert.equal(await visitor.isChecked("#fp8-weights"), false);
  assert.equal(await visitor.isDisabled("#fp8-weights"), false);
  await visitor.check("#fp8-weights");
  await visitor.check("#compiled-blocks");
  assert.match(await visitor.locator("#estimate").innerText(), /Passes that barely change are skipped\. The weights are fp8\. The blocks are compiled, so the first clip after a start or a LoRA change waits a minute or two more\./);
  // The next clip carries it, at the creator's steps and guidance.
  await visitor.fill("#image-prompt", "a kite over a field");
  await visitor.click("#image-go");
  for (let i = 0; i < 100 && rentedAgent.state.jobs.length === jobs; i++) await new Promise((r) => setTimeout(r, 100));
  const sent = rentedAgent.state.jobs.at(-1);
  assert.equal(sent.prompt.endsWith("a kite over a field"), true, sent.prompt);
  assert.deepEqual(sent.loras, [{ repo: "motionlab/Wan-TI2V-Motion-LoRA", file: "wan_motion_v1.safetensors", scale: 0.7 }], "at the strength Claude set");
  assert.equal(sent.finetune, undefined);
  assert.equal(sent.steps, 30, "the creator's steps");
  assert.equal(sent.cfg, 1, "the creator's guidance");
  assert.equal(sent.cache, 0.1, "the pass-skipping threshold");
  assert.deepEqual([sent.fp8, sent.compile], [true, true], "fp8 weights and compiled blocks go with the job");
  await visitor.waitForFunction(() => !document.querySelector("#image-go").disabled, null, { timeout: 30000 });
  // The window opened again shows the same: ticked, at 0.7.
  await visitor.evaluate(() => openModel("Wan-AI/Wan2.2-TI2V-5B-Diffusers"));
  await visitor.waitForSelector("#loras[open] .lora-row");
  const again = visitor.locator(".lora-row", { hasText: "Wan-TI2V-Motion-LoRA" });
  assert.equal(await again.locator(".lora-on").isChecked(), true);
  assert.deepEqual([await visitor.isChecked("#fast-passes"), await visitor.isChecked("#fp8-weights"), await visitor.isChecked("#compiled-blocks")], [true, true, true], "the speed switches are as they were left");
  assert.equal(await again.locator(".lora-strength").inputValue(), "0.7");
  assert.match(await again.locator(".lora-settings-pill").innerText(), /30 steps, guidance 1/, "the borrowed settings are kept too");
  await again.locator(".lora-drop-settings").click();
  await again.locator(".lora-settings-pill").waitFor({ state: "detached" });
  assert.doesNotMatch(await visitor.locator("#estimate").innerText(), /creator used/);
  // Unticked, the next clip goes without it.
  await again.locator(".lora-on").uncheck();
  assert.match(await visitor.locator("#loras-count").innerText(), /^optional$/);
  assert.equal(await visitor.isChecked("#fast-passes"), true, "the switch is kept per model");
  await visitor.uncheck("#fast-passes");
  // A scene: each shot ticks its own LoRAs at its own strength, starting
  // from the model's ticks (none now); Claude fits one shot's words to its
  // LoRA; only that shot's job carries it.
  await pickKind(visitor, "scene");
  await visitor.fill("#video-seconds", "8");
  await visitor.fill("#image-prompt", "a man skips rope, then drinks water, then eats an apple");
  await visitor.click("#scene-preview");
  await visitor.waitForSelector("#shots li");
  assert.match(await visitor.locator("#suggest").innerText(), /Each shot can carry its own LoRAs\./);
  assert.equal(await visitor.locator("#shots li .shot-lora").count(), 3, "one LoRA row per shot");
  assert.deepEqual(await visitor.$$eval("#shots .shot-lora-on", (els) => els.map((e) => e.checked)), [false, false, false], "from the model's ticks: none");
  // The LoRAs wait folded behind one line per shot, which says what is on.
  assert.deepEqual(await visitor.$$eval("#shots .shot-loras summary", (els) => els.map((e) => [e.textContent, e.parentElement.open])), [["Add a LoRA", false], ["Add a LoRA", false], ["Add a LoRA", false]]);
  const shot1 = visitor.locator("#shots li").nth(0);
  await shot1.locator(".shot-loras summary").click();
  await shot1.locator(".shot-lora-on").check();
  await shot1.locator(".shot-lora-strength").fill("0.6");
  await shot1.locator(".shot-fit-lora").click();
  await visitor.waitForFunction(() => /Fitted by Claude/.test(document.querySelector("#shots li .shot-lora-note")?.textContent ?? ""));
  assert.match(await shot1.locator(".shot-text").inputValue(), /^mvmt, /, "the shot's words in the LoRA's shape, trigger word first");
  assert.equal(await shot1.locator(".shot-lora-strength").inputValue(), "0.7", "the strength the creator recommends");
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).loras.length, reviewed.at(-1).loras[0].strength, reviewed.at(-1).seconds], ["suggest", 1, 0.6, 4]);
  assert.equal(await shot1.locator(".shot-loras summary").innerText(), "LoRAs: Wan-TI2V-Motion-LoRA 0.70");
  assert.equal(await shot1.locator(".shot-avoid").inputValue(), "a second person, a flip, a tangled rope", "the fit's Avoid line is the shot's own list now");
  assert.equal(reviewed.at(-1).negative, "a second person, a flip", "the shot's own list went to Claude, not the request's");
  // A line to Claude for all the shots: every row comes back changed, each keeping its LoRAs.
  await visitor.fill("#shots-ask", "make it dusk");
  await visitor.click("#shots-ask-go");
  await visitor.waitForFunction(() => /^Claude: /.test(document.querySelector("#shots-ask-said")?.textContent ?? ""));
  assert.equal(await visitor.locator("#shots-ask-said").innerText(), "Claude: every shot is now at dusk.");
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).request, reviewed.at(-1).shots.length, reviewed.at(-1).minSeconds, reviewed.at(-1).maxSeconds], ["revise-all", "make it dusk", 3, 1, 5]);
  assert.deepEqual(await visitor.$$eval("#shots .shot-text", (els) => els.map((e) => /, at dusk$/.test(e.value))), [true, true, true]);
  assert.match(await visitor.locator("#shots li").nth(0).locator(".shot-text").inputValue(), /^mvmt, /);
  assert.deepEqual(await visitor.$$eval("#shots .shot-lora-on", (els) => els.map((e) => e.checked)), [true, false, false], "each row's LoRAs kept by place");
  assert.deepEqual(reviewed.at(-1).shots.map((x) => x.negative), ["a second person, a flip, a tangled rope", "", "a second trampoline"], "every shot's avoid list goes along");
  assert.deepEqual(await visitor.$$eval("#shots .shot-avoid", (els) => els.map((e) => e.value)), ["a second person, a flip, a tangled rope, bright daylight", "bright daylight", "a second trampoline, bright daylight"], "and comes back as Claude revised it");
  assert.equal(await visitor.locator("#shots li").nth(0).locator(".shot-lora-strength").inputValue(), "0.7");
  assert.equal(await visitor.locator("#shots li").nth(0).locator(".shot-loras summary").innerText(), "LoRAs: Wan-TI2V-Motion-LoRA 0.70");
  const sceneJobs = rentedAgent.state.jobs.length;
  await visitor.click("#scene-go");
  for (let i = 0; i < 300 && rentedAgent.state.jobs.length < sceneJobs + 3; i++) await new Promise((r) => setTimeout(r, 100));
  const shotJobs = rentedAgent.state.jobs.slice(sceneJobs, sceneJobs + 3);
  assert.deepEqual(shotJobs.map((j) => j.loras ?? null), [[{ repo: "motionlab/Wan-TI2V-Motion-LoRA", file: "wan_motion_v1.safetensors", scale: 0.7 }], null, null], "only the first shot carries the LoRA");
  assert.match(shotJobs[0].prompt, /^mvmt, /);
  await visitor.waitForFunction(() => !document.querySelector("#image-go")?.disabled && !document.querySelector("#scene-preview")?.disabled, null, { timeout: 60000 });
  // A long clip at High: Claude's better description comes as the shots
  // it would make, all shown first, not one text cut into equal pieces.
  await pickKind(visitor, "long");
  await visitor.fill("#video-seconds", "8");
  await visitor.click("#video-level input[value=high]");
  await visitor.fill("#image-prompt", "a man eats an apple, throws the core away, then sits down in a chair");
  const heldBefore = await visitor.isChecked("#queue-hold");
  await visitor.check("#queue-hold");
  await visitor.click("#queue-add");
  await visitor.waitForSelector("#shots li");
  assert.equal(await visitor.locator("#expand-text").count(), 0, "no single expanded text");
  assert.deepEqual([reviewed.at(-1).mode, reviewed.at(-1).seconds, reviewed.at(-1).prompt], ["scene", 8, "a man eats an apple, throws the core away, then sits down in a chair"]);
  assert.equal(await visitor.locator("#shots li").count(), 3);
  assert.equal(await visitor.locator("#shots li .shot-ask-text").count(), 3, "a line to Claude under every shot");
  assert.equal(await visitor.locator("#shots li .shot-avoid").count(), 3, "and an avoid list on every shot");
  await visitor.click("#shots-send");
  assert.equal(await visitor.locator("#suggest").isHidden(), true);
  assert.match(await visitor.locator("#queue-list").innerText(), /a man eats an apple[\s\S]*as a scene of 3 shots at high quality/);
  await visitor.click("#queue-list .queue-remove");
  assert.equal(await visitor.locator("#queue-list li").count(), 0);
  if (!heldBefore) await visitor.uncheck("#queue-hold");
  await visitor.click("#video-level input[value=medium]");
  await pickKind(visitor, "short");
  await visitor.click("#close-modal");
  rentedAgent.state.files = rentedAgent.state.files.filter((f) => f !== WAN_HERE);
});

await step("hosted: deleting the account deletes the machine and signs out", async () => {
  await visitor.keyboard.press("Escape");
  const podId = (await (await visitor.request.get(`${hostedBase}/api/rent`)).json()).id;
  await openSettings(visitor);
  await visitor.waitForSelector("#delete-account");
  acceptDialogs = true;
  await visitor.click("#delete-account");
  await visitor.waitForFunction(() => document.querySelector("#account").hidden);
  acceptDialogs = false;
  assert.equal(runpod.state.pods[podId].status, "TERMINATED");
  assert.equal(await visitor.locator("#rent-bar").isVisible(), false);
  assert.equal(await visitor.locator("#open-settings").isVisible(), true, "Settings stay open to the visitor");
});

await step("no errors reached the console", () => {
  assert.deepEqual(errors, [], errors.join(" | "));
});

await browser.close();
server.close();
hosted.close();
stub.server.close();
runpod.server.close();
rentedOllama.server.close();
rentedAgent.server.close();
console.log(failed ? `\n${failed} step(s) failed` : "\nall browser steps passed");
process.exit(failed ? 1 : 0);

async function launch() {
  for (const opts of [{ channel: "chrome" }, { channel: "msedge" }, {}]) {
    try {
      return await chromium.launch({ headless: true, ...opts });
    } catch {
      // try the next browser
    }
  }
  throw new Error("No Chromium browser found. Install Chrome or run `npx playwright install chromium`.");
}
