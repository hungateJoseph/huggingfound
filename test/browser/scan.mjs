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
    onText("This has one problem.\n");
    await new Promise((r) => setTimeout(r, 150));
    onText("word7 is not a word.");
    return { declined: false, model: "claude-opus-5", note: "" };
  },
};
const server = createServer({ envFile, scanFile, hubBase: stub.base, fetchImpl, reviewer, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, writtenSummaries: false, runpodBase: runpod.base, runpodProxy: () => rentedOllama.url, runpodAgent: () => rentedAgent.url, runpodImageCheck: async () => true, runpodStatusTtl: 0, idleWatch: false });
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
  assert.deepEqual(videos.slice(0, 3), ["Wan2.2-T2V-A14B", "Wan2.2-TI2V-5B-Diffusers", "stable-video-diffusion-img2vid"], "the stronger video family first, the far more liked old one last, chat models after all three");
  assert.equal(await page.locator("#found-sort").inputValue(), "match");
  await page.selectOption("#found-sort", "likes");
  const byLikes = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(byLikes.slice(0, 2), ["stable-video-diffusion-img2vid", "Wan2.2-T2V-A14B"], "by users' opinion the liked one leads, and video models still come before the rest");
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
  await page.click("#open-settings");
  await page.waitForSelector("#settings:not([hidden])");
  assert.match(await page.locator("#runner-list").innerText(), /Ollama/);
  await page.fill("#token", "hf_browsertesttoken12345");
  await page.click("#save-token");
  await page.waitForSelector("#notice:not([hidden])");
  assert.match(await page.locator("#notice").innerText(), /Token saved/);
  assert.match(fs.readFileSync(envFile, "utf8"), /HF_TOKEN=hf_browsertesttoken12345/);
  await page.click("#open-settings");
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
  await page.click("#open-settings");
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
  await page.click("#open-settings");
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

  // A click beside the window used to close it and throw the conversation away.
  await page.mouse.click(8, 8);
  assert.equal(await page.locator("#modal").isVisible(), true, "the model window stays open");
  // Re-drawing the try box, as a finished step does, keeps the reply that is still streaming.
  await page.evaluate(() => renderTry(state.model, state.plan));
  await page.waitForSelector("#chat-live");
  assert.match(await page.locator("#chat-live").innerText(), /word\d+ /);
  assert.equal(await page.locator("#chat-send").isDisabled(), true, "still busy after the re-render");
  await page.waitForFunction(() => !document.querySelector("#chat-send").disabled, null, { timeout: 15000 });
  assert.equal(await page.locator("#chat-live").count(), 0);
  assert.match(await page.locator("#messages .msg").last().innerText(), /word0 .*word39 /s, "the whole reply landed in the transcript");
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
  await page.waitForSelector("#rent-panel .tier");
  assert.match(await page.locator("#runpod-status").innerText(), /A key is saved \(rpa_\*+cdef\)/);
  const tiers = await page.$$eval("#rent-panel .tier", (els) => els.map((e) => [e.querySelector("b").textContent, e.querySelector(".price").textContent, e.querySelector("input").disabled, e.querySelector("input").checked]));
  // The model window asked for 48 GB, so that size is chosen.
  assert.deepEqual(tiers, [
    ["24 GB GPU", "RTX 4090, $0.44 an hour", false, false],
    ["48 GB GPU", "A40, $0.40 an hour", false, true],
    ["80 GB GPU", "A100 PCIe, $1.64 an hour", false, false],
    ["141 GB GPU", "H200 SXM, none free right now", true, false],
  ]);
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(`RUNPOD_API_KEY=${RUNPOD_KEY}`));
  await page.click("#close-settings");
});

await step("renting from the model window preselects its size, and the bar shows the running cost", async () => {
  await page.waitForFunction(() => /No GPU is rented right now[\s\S]*A40 at \$0\.40 an hour/.test(document.querySelector(".rent-ask")?.textContent ?? ""), null, { timeout: 10000 });
  assert.match(await page.locator(".rent-ask").innerText(), /No GPU is rented right now[\s\S]*A40 at \$0\.40 an hour/, "with a key saved, the question becomes an offer");
  await page.click("#ask-rent");
  await page.waitForSelector("#rent-panel .tier");
  assert.equal(await page.locator('#rent-panel input[name="rent-tier"]:checked').inputValue(), "48");
  await page.fill("#rent-disk", "60");
  rentedOllama.state.down = true;
  acceptDialogs = true;
  await page.click("#rent-go");
  await page.waitForSelector("#rent-bar:not([hidden])");
  acceptDialogs = false;
  assert.match(await page.locator("#rent-bar").innerText(), /Rented GPU: NVIDIA A40 48 GB, starting, \$0\.40 an hour\./);
  assert.equal(runpod.state.created.length, 1);
  assert.deepEqual(runpod.state.created[0].mounts, { persistent: { size: 60, path: "/root/.ollama" } });
  assert.match(await page.locator("#rent-panel .rent-card").innerText(), /starting[\s\S]*Stops by itself after 30 minutes/);
  assert.equal(await page.locator("#chat-server").inputValue(), rentedOllama.url, "the chat server is the rented machine");
  assert.match(await page.locator("#chat-server-status").innerText(), /rented GPU; Ollama on it is not answering yet/);
  await page.click("#close-settings");
  // The model window now plans one step on the machine and says it is starting.
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

await step("stopping from the bar frees the chat server; starting and deleting work from Settings", async () => {
  acceptDialogs = true;
  await page.click("#bar-stop");
  await page.waitForFunction(() => /stopped/.test(document.querySelector("#rent-bar").textContent));
  acceptDialogs = false;
  assert.equal(await page.locator("#bar-start").count(), 1);
  assert.ok(runpod.state.actions.some((a) => a.endsWith(":stop")));
  await page.click("#open-settings");
  await page.waitForSelector("#rent-panel .rent-card");
  assert.match(await page.locator("#rent-panel .rent-card").innerText(), /Stopped: no hourly charge\. The 60 GB disk keeps its models/);
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
  await page.click("#open-settings");
  await page.waitForSelector("#rent-panel .rent-card");
  assert.equal(await page.locator("#chat-server").inputValue(), rentedOllama.url, "pointed back at it");
  acceptDialogs = true;
  await page.click("#rent-delete");
  await page.waitForFunction(() => document.querySelector("#rent-bar").hidden);
  acceptDialogs = false;
  await page.waitForSelector("#rent-panel .tier");
  assert.equal(await page.locator("#chat-server").inputValue(), "");
  const saved = fs.readFileSync(envFile, "utf8");
  assert.doesNotMatch(saved, /RUNPOD_POD_ID|OLLAMA_SERVER/);
  assert.match(saved, /RUNPOD_API_KEY=/, "the key stays");
  rentedOllama.state.down = false;
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
  await page.click("#open-settings");
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
const hosted = createServer({ envFile: path.join(hostedHome, ".env"), scanFile: path.join(hostedHome, "scan.json"), voicesFile: path.join(hostedHome, "voices.json"), hubBase: stub.base, reviewer, civitaiBase: dead, redditAuthBase: dead, redditApiBase: dead, githubBase: dead, hnBase: dead, lemmyBase: dead, youtubeBase: dead, hosted: true, refreshHours: 0, accountsDir: path.join(hostedHome, "accounts"), accountsSecret: "browser-test-secret-0123456789", googleClientId: "", runpodBase: runpod.base, runpodProxy: () => rentedOllama.url, runpodAgent: () => rentedAgent.url, runpodImageCheck: async () => true, runpodStatusTtl: 0, idleWatch: false });
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
  await visitor.waitForSelector("#rent-panel .tier");
  assert.equal(await visitor.locator('#rent-panel input[name="rent-tier"]:checked').inputValue(), "48");
  assert.match(await visitor.locator("#account").innerText(), /Guest, keys kept until/);
  assert.match(await visitor.locator("#account-line").innerText(), /You are a guest[\s\S]*12 hours after your last use/);
  assert.equal(await visitor.locator("#delete-account").innerText(), "Forget my keys now");
  assert.equal(await visitor.locator("#open-settings").isVisible(), true, "a guest reaches Settings for the rented machine");
  const guests = fs.readdirSync(path.join(hostedHome, "accounts")).filter((f) => f.startsWith("g"));
  assert.equal(guests.length, 1);
  await visitor.click("#close-settings");
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
  await visitor.click("#open-settings");
  await visitor.waitForSelector("#settings:not([hidden])");
  assert.equal(await visitor.locator("#token").isVisible(), false, "no Hugging Face token on the site");
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
  await visitor.waitForSelector("#ask-rent");
  await visitor.click("#ask-rent");
  await visitor.waitForSelector("#rent-panel .tier");
  assert.equal(await visitor.locator('#rent-panel input[name="rent-tier"]:checked').inputValue(), "48");
  rentedOllama.state.down = false;
  acceptDialogs = true;
  await visitor.click("#rent-go");
  await visitor.waitForSelector("#rent-bar:not([hidden])");
  acceptDialogs = false;
  const made = runpod.state.created.at(-1);
  assert.equal(made.env.OLLAMA_ORIGINS, hostedBase, "Ollama on the machine accepts this site's pages");
  await visitor.click("#close-settings");
  await visitor.waitForSelector("#steps .step .go");
  assert.equal(await visitor.locator(".where-opt.on").innerText(), "On a rented GPU");
  assert.equal(await visitor.locator("#modal-body .get-app").count(), 0, "no need for the app when the machine does the work");
  // Two polls bring the stand-in machine to RUNNING; the page's own poll would take longer.
  await visitor.request.get(`${hostedBase}/api/rent`);
  await visitor.request.get(`${hostedBase}/api/rent`);
  acceptDialogs = true;
  await visitor.click("#steps .step .go");
  await visitor.waitForSelector("#steps .step.done", { timeout: 15000 });
  acceptDialogs = false;
  assert.ok(rentedOllama.state.pulls.some((p) => /Cydonia/.test(p)));
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
  await visitor.fill("#image-prompt", "a lighthouse at dusk");
  await visitor.fill("#image-negative", "blurry");
  await visitor.click("#image-go");
  await visitor.waitForSelector("#image-out .image-card", { timeout: 20000 });
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
  await visitor.click("#open-settings");
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
