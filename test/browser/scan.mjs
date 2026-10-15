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

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-browser-"));
const { createServer } = await import("../../src/server.js");

const stub = await startStubHub();
// Renting a GPU is played by a stand-in RunPod, and the rented machine's
// Ollama by a stand-in that answers at the proxy address.
const runpod = await startStubRunpod();
const rentedOllama = await startStubOllama();
const rentedAgent = await startStubAgent();
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
    chatBodies.push(JSON.parse(init.body));
    const stream = new ReadableStream({
      async start(controller) {
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
    // A better description for what was typed: the motion spelt out, the unwanted moved to the avoid list.
    if (input.mode === "suggest") {
      onText(`Description: a woman in a bright gym doing jumping jacks in bare feet, feet apart as her hands meet overhead, then together as her arms come down; medium shot, camera still, whole body in frame.${input.image ? " She stays as she is in the picture." : ""}\nAvoid: socks, shoes, zooming in, closed eyes\nWhy: Spelt out the motion and moved what you did not want into the avoid list, since the model cannot read "not".`);
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
const server = createServer({ envFile, scanFile, hubBase: stub.base, fetchImpl, reviewer, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => rentedOllama.url, runpodAgent: () => rentedAgent.url, runpodImageCheck: async () => true, runpodStatusTtl: 0, runpodBudget: { minute: 600, hour: 5000 }, idleWatch: false });
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
  await page.click("#examples [data-example='coding help']");
  await page.waitForSelector("#found .model");
  assert.equal(await page.locator("#results").isVisible(), true);
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
  await page.waitForFunction(() => /word3 /.test(document.querySelector("#chat-live")?.textContent ?? ""));
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
  const kept = page.locator("#messages .improve-wrap", { hasText: "Checked earlier by Claude" });
  assert.equal(await kept.count(), 1);
  assert.match(await kept.locator(".review-body").innerText(), /This has one problem\.\nword7 is not a word\./, "the review is kept with the answer");

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

  // New chat starts over.
  await page.click("#chat-clear");
  await page.waitForFunction(() => document.querySelectorAll("#messages .msg").length === 0);
  assert.equal(await page.evaluate(() => localStorage.getItem("chat:qwen-test")), "[]");
  await page.keyboard.press("Escape");
  await page.unroute((u) => u.pathname === "/api/model" && u.searchParams.get("id") === id);
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
  await page.click("#close-settings");
});

await step("every card says what the model makes, and a search for pictures marks the text models that cannot", async () => {
  await page.click("#nav-browse");
  await page.click(".tab[data-tab=chat]");
  assert.match(await page.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).locator(".pill.makes").innerText(), /Text only, no pictures/);
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

await step("hosted: a visitor who is not signed in is offered sign-in before a GPU, and Settings stay hidden", async () => {
  await visitor.goto(hostedBase);
  await visitor.waitForSelector("#trait");
  assert.equal(await visitor.locator("#open-settings").isVisible(), false);
  assert.equal(await visitor.locator("#sign-in").isVisible(), false, "no Sign in button until Google is set up; guests need none");
  assert.equal(await visitor.locator("#nav-privacy").isVisible(), true);
  await visitor.click("#nav-browse");
  await visitor.click(".tab[data-tab=chat]");
  await visitor.locator("#models .model", { hasText: "Cydonia-24B-v2-GGUF" }).first().locator(".name").click();
  await visitor.waitForSelector(".where");
  await visitor.click('.where-opt[data-where="rented"]');
  await visitor.waitForSelector(".rent-ask");
  assert.match(await visitor.locator(".rent-ask").innerText(), /takes a RunPod API key[\s\S]*kept for 12 hours after your last use/);
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
  assert.equal(await visitor.locator("#open-settings").isVisible(), false);
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
  const before = rentedOllama.state.chats.length;
  await visitor.fill("#chat-text", "hello machine");
  await visitor.click("#chat-send");
  await visitor.waitForFunction(() => /from the server/.test(document.querySelector("#messages")?.textContent ?? ""));
  assert.equal(rentedOllama.state.chats.length, before + 1, "the message reached the machine");
  assert.equal(rentedOllama.state.chats.at(-1).messages.at(-1).content, "hello machine");
  assert.ok(rentedOllama.state.origins.includes(hostedBase), "sent by the page itself, from the site's origin");
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
  acceptDialogs = true;
  await visitor.click("#steps .step .go");
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
  // The queue is kept under the model.
  await visitor.fill("#image-prompt", "a red barn");
  await visitor.click("#queue-add");
  await visitor.fill("#image-prompt", "a blue barn");
  await visitor.click("#queue-add");
  assert.equal(await visitor.locator("#queue-list li").count(), 2);
  await visitor.keyboard.press("Escape");
  await openSd();
  await visitor.waitForSelector("#queue-list li");
  assert.equal(await visitor.locator("#queue-list li").count(), 2, "the queue is back after leaving the window");
  assert.match(await visitor.locator("#queue-list").innerText(), /a red barn[\s\S]*a blue barn/);
  await visitor.click("#queue-clear");
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
  rentedAgent.state.release = true;
  await visitor.waitForSelector("#image-out .image-card", { timeout: 20000 });
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
  await visitor.locator("#found .model", { hasText: "Wan2.2-TI2V-5B-Diffusers" }).locator(".name").click();
  await visitor.waitForSelector("#video-seconds");
  assert.deepEqual(await visitor.$eval("#video-seconds", (e) => [e.value, e.min, e.max]), ["3", "1", "30"], "one shot is 1 to 5 seconds; longer is made as pieces");
  assert.deepEqual(await visitor.$$eval("#video-level input", (els) => els.map((e) => [e.value, e.checked])), [["low", false], ["medium", true], ["high", false]]);
  assert.match(await visitor.locator("#estimate").innerText(), /^About .* for a 3\.1-second clip at 1280 by 704, 49 frames, 30 steps \(a guess until the first clip is timed\)\./, "medium draws on the full canvas");
  assert.match(await visitor.locator("#video-level").innerText(), /Low\s+a draft: a small canvas, 20 passes[\s\S]*Medium\s+the model's full canvas, 30 passes, its standard avoid list[\s\S]*High\s+the full canvas, 50 passes, the avoid list, and your words expanded first/);
  assert.match(await visitor.locator(".levels-note").innerText(), /A pass is one round of refinement[\s\S]*Claude turns your words into the detailed shot description/);
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
  assert.match(await visitor.locator("#queue-estimate").innerText(), /2 requests, about .* in all\./);
  assert.equal(await visitor.locator("#queue-go").innerText(), "Generate all 2");
  await visitor.check("#image-stop-after");
  await visitor.click("#queue-go");
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
  assert.equal(await joinedCard.locator(".reply-go").innerText(), "Reply: change or continue it");
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
  await visitor.fill("#video-seconds", "3");
  await visitor.fill("#image-prompt", "");
  // Leaving the window loses nothing: the clips are kept under the model.
  await visitor.keyboard.press("Escape");
  await visitor.locator("#found .model", { hasText: "Wan2.2-TI2V-5B-Diffusers" }).locator(".name").click();
  // The machine is stopped, so the window offers to start it; the clips show all the same.
  await visitor.waitForSelector("#kept .image-card");
  assert.equal(await visitor.locator("#kept .image-card").count(), 9, "the two clips, the reply, the unexpanded one, the three pieces, the joined clip and the continuation");
  assert.match(await visitor.locator("#kept").innerText(), /Kept here[\s\S]*9 results made with this model[\s\S]*Continues an earlier clip[\s\S]*12\.2 s in 3 pieces[\s\S]*piece 3 of 3[\s\S]*piece 1 of 3[\s\S]*In reply to an earlier clip \("slower camera pan"\)[\s\S]*a long walk[\s\S]*2\.1 s at low quality[\s\S]*waves at dusk[\s\S]*5\.1 s at high quality/);
  await visitor.locator("#kept .kept-remove").first().click();
  await visitor.waitForFunction(() => document.querySelectorAll("#kept .image-card").length === 8);
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
  await visitor.click("#bar-models");
  await visitor.waitForSelector("#gpu-models .gpu-list li");
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
  assert.equal(await visitor.locator("#open-settings").isVisible(), false);
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
