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

process.env.HUGGINGFOUND_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-browser-"));
const { createServer } = await import("../../src/server.js");

const stub = await startStubHub();
const envFile = path.join(process.env.HUGGINGFOUND_HOME, ".env");
const scanFile = path.join(process.env.HUGGINGFOUND_HOME, "scan.json");
const server = createServer({ envFile, scanFile, hubBase: stub.base });
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
    console.log(`FAIL ${name}\n     ${err.message.split("\n")[0]}`);
  }
}

await page.goto(base);
await page.waitForSelector("#picks .model");

await step("the page opens on the easy list with the curated picks", async () => {
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

await step("NSFW tabs, sorting and recency work on the scan", async () => {
  await page.click(".tab[data-tab=nsfw-writing]");
  let names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["Cydonia-24B-v2-GGUF"]);
  assert.match(await page.locator("#models .model .pill.adult").innerText(), /18\+/);
  await page.click(".tab[data-tab=nsfw-images]");
  names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["pony-realism-v23-sdxl"]);

  await page.click(".tab[data-tab=chat]");
  await page.selectOption("#sort", "likes");
  names = await page.$$eval("#models .model .name", (els) => els.map((e) => e.textContent));
  assert.equal(names[0], "Llama-3.2-3B-Instruct-GGUF", "most liked runnable chat model first");
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
  assert.match(await page.locator("#found-title").innerText(), /search: whisper/i);
  let names = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names, ["whisper.cpp"], "the runnable filter hides the Python-only one");
  await page.uncheck("#only-runnable");
  names = await page.$$eval("#found .model .name", (els) => els.map((e) => e.textContent));
  assert.deepEqual(names.sort(), ["whisper-large-v3", "whisper.cpp"]);
  await page.check("#only-runnable");
  await page.fill("#trait", "");
  await page.click("#trait-go");
  await page.waitForFunction(() => document.querySelector("#found-title").hidden && !document.querySelector("#found .model"));
});

await step("opening a model shows its plan with the install, start and pull steps", async () => {
  await page.click(".tab[data-tab=easy]");
  await page.locator("#models .model", { hasText: "Llama-3.2-3B-Instruct-GGUF" }).click();
  await page.waitForSelector("#steps .step");
  const titles = await page.$$eval("#steps .step .title", (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles, ["Install Ollama", "Start Ollama", "Download the model (2.0 GB)"]);
  assert.match(await page.locator("#modal-body .spec").innerText(), /Q4_K_M\.gguf/);
  assert.match(await page.locator("#modal-body .spec").innerText(), /Speed here[\s\S]*words a second/i);
  assert.match(await page.locator("#steps .step code").first().innerText(), /ollama/);
  assert.match(await page.locator("#try").innerText(), /Run the steps above/);
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
  await page.locator("#models .model", { hasText: "Llama-3.1-8B-Instruct" }).click();
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
  await page.locator("#models .model", { hasText: "Llama-3.1-8B-Instruct" }).click();
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
  await row.locator("button").click();
  await page.waitForFunction((n) => document.querySelectorAll("#storage-list li").length === n - 1, before);
  acceptDialogs = false;
  assert.equal(await row.count(), 0);
  assert.equal(fs.existsSync(dir), false);
  await page.click("#close-settings");
});

await step("a set-up model offers to remove itself from the model window", async () => {
  const { MODELS_DIR } = await import("../../src/runners.js");
  const dir = path.join(MODELS_DIR, "ggerganov", "whisper.cpp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ggml-base.en.bin"), Buffer.alloc(1024));
  await page.click(".tab[data-tab=speech]");
  await page.locator("#models .model", { hasText: "whisper.cpp" }).click();
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

await step("an image model offers Fast, Default and Max with Default chosen", async () => {
  const { MODELS_DIR } = await import("../../src/runners.js");
  const dir = path.join(MODELS_DIR, "second-state", "stable-diffusion-v1-5-GGUF");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf"), Buffer.alloc(1024));
  await page.click(".tab[data-tab=images]");
  await page.locator("#picks .model", { hasText: "stable-diffusion-v1-5-GGUF" }).click();
  await page.waitForSelector("#steps .step");
  const done = await page.$$eval("#steps .step", (els) => els.map((e) => e.classList.contains("done")));
  assert.equal(done[1], true, "the planted file counts as downloaded");
  if (done[0]) {
    await page.waitForSelector("#quality input");
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
  await page.waitForSelector("#scan-title:not([hidden])");
  assert.match(await page.locator("#scan-status").innerText(), /Last scan just now/);
});

await step("no errors reached the console", () => {
  assert.deepEqual(errors, [], errors.join(" | "));
});

await browser.close();
server.close();
stub.server.close();
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
