import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categorize.js";
import { mask, readEnv, writeEnv } from "./envfile.js";
import { createHub } from "./hf.js";
import { chatServerMachine, describeMachine, hostedMachine } from "./machine.js";
import { PICKS } from "./picks.js";
import { buildPlan } from "./plans.js";
import { DATA_DIR, OUTPUT_DIR, UPLOAD_DIR, agentModels, agentModelList, clearOutputs, describeImageServer, detect, getRun, readTimings, recordTiming, cancelRun, removeAgentModel, removeFile, removeFolder, removeOllamaModel, ollamaUrl, pullImageOnAgent,
  pullImageFolderOnAgent,
  pullImageRepoOnAgent,
  pullAddonOnAgent,
  removeAgentAddon,
  agentAddons,
  agentHealth,
  agentTasks,
  agentTaskKey,
  attachAgentTask,
  listRuns,
  stepKey, pullOnChatServer, startCustomRun, startRun, stopImageServer, storage, which } from "./runners.js";
import { estimate, guessSizeGb, speedTier } from "./speed.js";
import { gatherVoices, headline, isFresh, readVoices, searchVoices, writeVoices } from "./voices.js";
import { createCivitai, createGithub, createHackerNews, createLemmy, createReddit, createYoutube, matchKnown } from "./sources.js";
import { cleanSummary, collectVoices, extractiveSummary, summarize, summarizerModel } from "./summarize.js";
import { rankModels } from "./find.js";
import { isAddon, kindOf, qualityScore } from "./quality.js";
import { settingsAdvice, wantedSettings } from "./settings.js";
import { refusalSignals } from "./refusals.js";
import { ReviewError, createReviewer } from "./review.js";
import { RentError, TIERS, createRental, tierFor, agentFetch } from "./rent.js";
import { VastError } from "./vast.js";
import { createLoraFinder } from "./loras.js";
import { createStock } from "./stock.js";
import { createPush } from "./push.js";
import { AuthError, GUEST_HOURS, createAccounts } from "./accounts.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
// The gathered voices index per file, re-read only when the file changes.
const VOICES_CACHE = new Map();
const RUNNER_NAMES = { ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".woff2": "font/woff2" };

// Keys the hosted site takes from the process environment rather than a file.
const HOSTED_ENV_KEYS = ["HF_TOKEN", "GITHUB_TOKEN", "YOUTUBE_API_KEY", "REDDIT_CLIENT_ID"];

// What a public copy of the site must not do: run programs on itself,
// download to its own disk, chat through itself or touch the disk it runs
// on. Those belong on the visitor's own computer, where HuggingFound does
// them, or on the GPU a signed-in person rents, which the browser talks to
// directly so that nothing said to a model passes through this server.
const NOT_HOSTED = new Set(["/api/scan", "/api/voices/gather", "/api/storage", "/api/image-server", "/api/unload", "/api/chat", "/api/upload", "/api/result"]);
// What a signed-in person may do on the hosted site: keep keys, rent a
// machine, have it download models, and follow those downloads.
const SIGNED_IN = new Set(["/api/settings", "/api/rent", "/api/run", "/api/remove", "/api/chat-server", "/api/account/delete"]);
// The keys a hosted account may keep; everything else is for the local app.
const ACCOUNT_KEYS = new Set(["RUNPOD_API_KEY", "VAST_API_KEY", "CIVITAI_TOKEN", "ANTHROPIC_API_KEY", "RUNPOD_IDLE_MINUTES", "RUNPOD_MAX_SPEND", "RUNPOD_PRESENCE_MINUTES", "HIDDEN_MODELS", "RUNPOD_REGISTRY_AUTH", "RUNPOD_SLOW_DCS", "RUNPOD_COMMUNITY", "HF_TOKEN"]);
// Models a person has hidden from search and Browse: ids, comma-separated.
const MODEL_ID_RE = /^[\w.-]+\/[\w.-]+$/;
const hiddenList = (raw) => String(raw ?? "").split(",").map((x) => x.trim()).filter((x) => MODEL_ID_RE.test(x));

export function createServer({ envFile, hubBase, fetchImpl = fetch, scanFile = path.join(DATA_DIR, "scan.json"), stockFile = path.join(DATA_DIR, "stock.json"), pushFile = path.join(DATA_DIR, "push-keys.json"), pushSend = null, voicesFile = path.join(DATA_DIR, "voices.json"), civitaiBase, redditAuthBase, redditApiBase, githubBase, hnBase, lemmyBase, youtubeBase, writtenSummaries = true, hosted = process.env.HUGGINGFOUND_HOSTED === "1", refreshHours = Number(process.env.HUGGINGFOUND_REFRESH_HOURS || 12), reviewer = null, devCode = process.env.REVIEW_DEV_CODE || "", reviewLimit = 120, doneStopDelayMs = 45e3, runpodBase, runpodProxy, runpodAgent, runpodImageCheck, runpodStatusTtl, runpodBudget = null, vastBase, vastDirect, vastTunnelCheck, idleWatch = true, accountsDir = path.join(DATA_DIR, "accounts"), accountsSecret = process.env.ACCOUNTS_SECRET || process.env.SESSION_SECRET || "", sessionSecret = process.env.SESSION_SECRET || process.env.ACCOUNTS_SECRET || "", googleClientId = process.env.GOOGLE_CLIENT_ID || "", googleJwks, siteOrigin = process.env.SITE_ORIGIN || "" } = {}) {
  // Calls to a rented machine's agent carry the secret it was started with.
  fetchImpl = agentFetch(fetchImpl);
  // A hosted copy does not know the visitor's computer; it describes a
  // typical laptop and leaves the running to HuggingFound on their machine.
  const machine = hosted ? hostedMachine() : describeMachine();
  if (hosted) writtenSummaries = false;
  const env = () => {
    const saved = readEnv(envFile);
    if (!hosted) return saved;
    for (const key of HOSTED_ENV_KEYS) if (process.env[key]) saved[key] = process.env[key];
    return saved;
  };
  // Accounts exist on the hosted site only: on a computer the app is its
  // owner's, and settings live in the .env file. Without a secret of its
  // own the site makes one up for this run, which serves guests but loses
  // every saved key at a restart; the blueprint sets a lasting one.
  if (hosted && !accountsSecret) console.error("ACCOUNTS_SECRET is not set: keys saved on this site will not survive a restart.");
  const secret = accountsSecret || (hosted ? crypto.randomBytes(32).toString("hex") : "");
  const accounts = hosted ? createAccounts({ dir: accountsDir, secret, sessionSecret: sessionSecret || secret, googleClientId, jwksUrl: googleJwks, fetchImpl }) : null;
  // One rental per settings store: the .env file on a computer, each
  // account on the hosted site. A rental owns the chat server setting while
  // its machine exists and stops the machine when idle.
  const rentals = new Map();
  // RunPod's stock of each size as seen over time, shared by every account.
  const stock = createStock({ file: stockFile });
  // Notifications to a person's browser with the tab closed.
  const push = createPush({ file: pushFile, sendImpl: pushSend });
  // A watch that rented a card, or ended, tells the account's browser.
  const tellWatch = (settings) => (e) => {
    const title = e.kind === "rented" ? "Your GPU is rented" : e.kind === "expired" ? "No GPU came free" : "The GPU watch ended";
    push.send(settings().RUNPOD_PUSH, { title, body: e.kind === "rented" ? `${e.text}. Open HuggingFound to use it.` : `${e.text}.`, kind: e.kind }).catch(() => {});
  };
  const rentalFor = (key, settings, save) => {
    if (!rentals.has(key)) rentals.set(key, createRental({ env: settings, save, fetchImpl, onTiers: stock.record, onWatch: tellWatch(settings), base: runpodBase, proxyUrl: runpodProxy, agentUrl: runpodAgent, ...(vastBase ? { vastBase } : {}), ...(vastDirect ? { vastDirect } : {}), ...(vastTunnelCheck ? { tunnelCheck: vastTunnelCheck } : {}), ...(runpodImageCheck ? { imageCheck: runpodImageCheck } : {}), ...(runpodStatusTtl != null ? { statusTtl: runpodStatusTtl } : {}), ...(runpodBudget ? { budget: runpodBudget } : {}) }));
    return rentals.get(key);
  };
  // Marks a run so that, when it is over, the person's machine stops unless
  // another of their downloads is still going. Asked for from the page while
  // the run goes; the flag can be taken back the same way, up to the stop
  // itself: the stop waits a little after the run, so that a queue which
  // starts the moment the model is ready (or anything else at work on the
  // machine by then) keeps it up, and so that the page can take the flag
  // back on seeing that queue.
  const stopWhenDone = (ctx, run, on = true) => {
    const rental = ctx.rental;
    if (!rental || !run?.finished) return;
    run.stopAfter = on;
    if (run.stopAfterWatched) return;
    run.stopAfterWatched = true;
    run.finished.then(async () => {
      if (!run.stopAfter) return;
      await new Promise((r) => setTimeout(r, doneStopDelayMs));
      if (!run.stopAfter) return;
      if (listRuns(ctx.user?.id ?? null).some((r) => r.status === "running" && r.id !== run.id)) return;
      if ((await rental.machineBusy().catch(() => null)) === true) return;
      await rental.stop({ reason: "done" }).catch(() => {});
    });
  };
  const localSettings = () => readEnv(envFile);
  const localSave = (updates) => writeEnv(envFile, updates);
  const rental = hosted ? null : rentalFor("local", localSettings, localSave);
  // Who is asking and where their settings are: the file on a computer, or
  // the signed-in person's account on the hosted site.
  const contextFor = (req) => {
    if (!hosted) return { user: null, settings: localSettings, save: localSave, rental };
    const user = accounts?.userFromRequest(req) ?? null;
    if (!user) return { user: null, settings: () => ({}), save: () => {}, rental: null };
    const settings = () => accounts.settings(user.id);
    const save = (updates) => accounts.saveSettings(user.id, updates);
    return { user, settings, save, rental: rentalFor(user.id, settings, save) };
  };
  // Chat models run through Ollama here, or on the chat server: the rented
  // machine, or an address typed into Settings on a computer. Fit and
  // speed for them follow whichever machine that is.
  const chatServer = (ctx) => ctx.settings().OLLAMA_SERVER || "";
  // The browser addresses a rented machine must accept, since the page
  // talks to it directly: on the hosted site, the site's configured address
  // and the one this request came through, each with and without "www" (a
  // visitor arrives by either, and Ollama answers 403 to any other); in the
  // app, its own address by name and by number.
  function pageOrigins(req) {
    const here = `${String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0]}://${req.headers.host}`;
    if (!hosted) return [...new Set([here, here.replace("127.0.0.1", "localhost"), here.replace("localhost", "127.0.0.1")])];
    const out = new Set();
    for (const o of [siteOrigin, here].filter(Boolean)) {
      out.add(o);
      const m = /^(https?:\/\/)(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)$/i.exec(o);
      if (m && !/^\d+\.\d+\.\d+\.\d+$/.test(m[2])) {
        out.add(`${m[1]}${m[2]}`);
        out.add(`${m[1]}www.${m[2]}`);
      }
    }
    return [...out];
  }
  // Image models go to the rented machine's agent, set and cleared with the chat server.
  const imageAgent = (ctx) => ctx.settings().GPU_AGENT || "";
  const rentedChat = (ctx) => Boolean(ctx.rental?.owns(chatServer(ctx)));
  const remoteFor = (runnerId, ctx) => (runnerId === "ollama" ? chatServer(ctx) : runnerId === "sd" || runnerId === "diffusers" ? imageAgent(ctx) : "");
  const machineFor = (runnerId, ctx) => (remoteFor(runnerId, ctx) ? chatServerMachine(remoteFor(runnerId, ctx), ctx.settings().OLLAMA_SERVER_GB) : machine);
  const hub = () => createHub({ fetchImpl, base: hubBase, token: env().HF_TOKEN });
  // The Hugging Face token for gated models: the person's own on the hosted
  // site (kept with their account), the settings file's in the app.
  const tokenFor = (ctx) => (hosted ? ctx.settings().HF_TOKEN || "" : env().HF_TOKEN || "");
  const civitaiTokenFor = (ctx) => (hosted ? ctx.settings().CIVITAI_TOKEN || "" : env().CIVITAI_TOKEN || "");
  // LoRAs and fine-tunes for a video model, from Hugging Face and Civitai.
  const loraFinder = createLoraFinder({ fetchImpl, ...(hubBase ? { hubBase } : {}), ...(civitaiBase ? { civitaiBase } : {}) });
  // A model published as pieces often has a twin in the folder the
  // diffusers library loads, named with -Diffusers. Looked up once.
  const twins = new Map();
  async function diffusersTwin(model, token) {
    if (model.runner?.id !== "diffusers" || (model.files ?? []).some((f) => f.name === "model_index.json")) return null;
    if (twins.has(model.id)) return twins.get(model.id);
    let found = null;
    for (const suffix of ["-Diffusers", "-diffusers"]) {
      try {
        const m = await hub().model(`${model.id}${suffix}`, { token });
        if (m && !m.gatedBlocked && (m.files ?? []).some((f) => f.name === "model_index.json")) {
          found = { id: m.id, name: m.name };
          break;
        }
      } catch {
        // no such repository
      }
    }
    twins.set(model.id, found);
    return found;
  }
  const hub_ = hub;
  const civitai = createCivitai({ fetchImpl, base: civitaiBase });
  const hn = createHackerNews({ fetchImpl, base: hnBase });
  const lemmy = createLemmy({ fetchImpl, base: lemmyBase });
  const github = () => createGithub({ fetchImpl, base: githubBase, token: env().GITHUB_TOKEN || "" });
  const youtube = () => createYoutube({ fetchImpl, base: youtubeBase, key: env().YOUTUBE_API_KEY || "" });
  let redditClient = { id: null, client: null };
  const reddit = () => {
    const id = env().REDDIT_CLIENT_ID || "";
    if (redditClient.id !== id) redditClient = { id, client: createReddit({ fetchImpl, clientId: id, authBase: redditAuthBase, apiBase: redditApiBase }) };
    return redditClient.client;
  };
  const details = new Map();
  // Claude checks what a local model produced, with the key from Settings
  // (or the environment). Tests hand in a stand-in.
  const claudeKey = () => env().ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || "";
  // What the hosted site shows a visitor it does not know: no adult models,
  // no video models and no LoRAs, in search, Browse, the outside sources or
  // a model window. Signing in opens all of it, and so does a guest's
  // Anthropic key. Your own copy of the site is all yours.
  const fullAccess = (ctx) => !hosted || Boolean(ctx.user && (!ctx.user.guest || ctx.settings().ANTHROPIC_API_KEY));
  const forVisitors = (m) => !m.adult && kindOf(m) !== "video";
  const VISITOR_ONLY = "Video models and LoRAs open once you sign in, or enter an Anthropic API key as a guest.";
  const claudeReady = () => Boolean(reviewer || claudeKey() || process.env.ANTHROPIC_AUTH_TOKEN);
  const checker = reviewer ?? createReviewer({ apiKey: claudeKey, outputDir: OUTPUT_DIR });
  // On the hosted site the server's key is the owner's: it answers only to
  // the dev code. Anyone else brings their own key with each check; it is
  // handed to Anthropic for that one call and never stored or logged here.
  const hits = new Map();
  const tooMany = (who, what, max) => {
    const now = Date.now();
    const key = `${what}:${who}`;
    const recent = (hits.get(key) ?? []).filter((t) => now - t < 3600e3);
    if (hits.size > 5000) hits.clear();
    if (recent.length >= max) {
      hits.set(key, recent);
      return true;
    }
    recent.push(now);
    hits.set(key, recent);
    return false;
  };
  const sameCode = (given) => {
    const a = crypto.createHash("sha256").update(String(given)).digest();
    const b = crypto.createHash("sha256").update(devCode).digest();
    return Boolean(devCode) && crypto.timingSafeEqual(a, b);
  };
  // Who pays for a hosted check: { apiKey } to use, or { status, error }.
  const hostedAccess = (req, ctx) => {
    const who = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
    const typed = String(req.headers["x-anthropic-key"] ?? "").trim();
    const own = typed || (ctx.user ? ctx.settings().ANTHROPIC_API_KEY || "" : "");
    const code = String(req.headers["x-dev-code"] ?? "").trim();
    if (own) {
      if (!/^sk-ant-[\w-]{20,300}$/.test(own)) return { status: 400, error: "That does not look like an Anthropic API key (they start with sk-ant-)." };
      if (tooMany(ctx.user?.id ?? who, "check", reviewLimit)) return { status: 429, error: "That is a lot of checks in an hour. Try again later." };
      // Which key this is, so a refusal can say so: one typed into the page
      // for this call, or the one saved with the account.
      return { apiKey: own, from: typed ? "typed" : "saved" };
    }
    if (code) {
      // Only wrong codes count toward the limit, so guessing stops after a few tries.
      if (!sameCode(code)) return tooMany(who, "code", 8) ? { status: 429, error: "Too many wrong codes from this address. Try again in an hour." } : { status: 401, error: "That dev code is not right." };
      if (!reviewer && !claudeKey()) return { status: 503, error: "The site has no Anthropic key configured for the dev code." };
      return { apiKey: "" };
    }
    return { status: 401, error: ctx.user ? "Save an Anthropic API key in Settings, or enter one above, to have Claude check this." : "Checks on this site need your own Anthropic API key (sign in to save one), or the site owner's dev code." };
  };
  let refreshing = null;
  let lastRefresh = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        // Only the page itself may call the API: the local addresses, or the
        // host the hosted site is served from.
        const origin = req.headers.origin;
        if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1") && !(hosted && sameHost(origin, req.headers.host))) {
          return send(res, 403, { error: "Forbidden" });
        }
        if (hosted && NOT_HOSTED.has(url.pathname)) {
          return send(res, 403, { error: "Not on the hosted site. Run HuggingFound on your own computer to download and try models." });
        }
        const ctx = contextFor(req);
        if (hosted && !ctx.user && (SIGNED_IN.has(url.pathname) || url.pathname.startsWith("/api/runs") || url.pathname.startsWith("/api/rent/"))) {
          return send(res, 401, { error: "Enter a RunPod key in a model's window, or sign in, to do this on the site; or run HuggingFound on your own computer." });
        }
        // A guest's keys live on while the guest is active.
        if (ctx.user?.guest && req.method === "POST") accounts.extend(ctx.user.id);
        return await api(req, res, url, ctx);
      }
      if (url.pathname.startsWith("/output/")) return serveFile(res, path.join(OUTPUT_DIR, path.basename(url.pathname)));
      return serveFile(res, path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname), PUBLIC);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  // The hosted site scans the Hub and gathers what people say by itself, on
  // a timer, since visitors cannot start either.
  if (hosted && refreshHours > 0) {
    const scan = readScan(scanFile, { meta: true });
    const age = scan?.at ? Date.now() - new Date(scan.at).getTime() : Infinity;
    const first = Math.max(5000, refreshHours * 3600e3 - age);
    setTimeout(() => {
      refresh();
      setInterval(refresh, refreshHours * 3600e3).unref();
    }, first).unref();
  }
  server.refresh = refresh;
  server.rental = rental;
  server.accounts = accounts;
  server.rentals = rentals;
  // Machines left from last time, on this computer or in any account: find
  // out what became of each, so a deleted one is forgotten, a running one
  // shows in its owner's banner, and the idle watch covers it.
  if (rental && localSettings().RUNPOD_POD_ID) rental.status({ probe: false }).catch(() => {});
  if (accounts) {
    // Accounts with a machine, or watching for one, are looked after from the start.
    for (const id of new Set([...accounts.withPods(), ...accounts.withWatch()])) {
      const settings = () => accounts.settings(id);
      rentalFor(id, settings, (updates) => accounts.saveSettings(id, updates)).status({ probe: false }).catch(() => {});
    }
  }
  server.checkIdle = () => Promise.all([...rentals.values()].map((r) => r.checkIdle().catch(() => false)));
  // Every watch, once a minute: a size that came free is rented for its account.
  server.checkWatches = () => Promise.all([...rentals.values()].map((r) => r.checkWatch().catch(() => null)));
  // A guest whose time is up: their machine is stopped while the key still
  // works, then the keys and the machine are forgotten.
  server.sweepGuests = async () => {
    const gone = [];
    for (const id of accounts?.expiredGuests() ?? []) {
      const settings = () => accounts.settings(id);
      const mine = rentalFor(id, settings, (updates) => accounts.saveSettings(id, updates));
      // The key goes with the guest, so nothing could ever stop or delete the
      // machine again: it is deleted now, before its disk bills for ever.
      if (settings().RUNPOD_POD_ID) await mine.remove().catch(() => mine.stop().catch(() => {}));
      rentals.delete(id);
      accounts.remove(id);
      gone.push(id);
    }
    return gone;
  };
  if (idleWatch) setInterval(() => server.checkWatches().then(server.checkIdle).then(server.sweepGuests).catch(() => {}), 60e3).unref();
  return server;

  // One pass: the scan, then the voices for every model in it.
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        await scanHub();
        const scan = readScan(scanFile) ?? { models: [] };
        const run = gatherAll(scan.models.map((m) => m.id));
        await run.finished;
        lastRefresh = new Date().toISOString();
      } catch (err) {
        console.error(`Refresh failed: ${err.message}`);
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  // The scan is shared by everyone, so its speed lines describe this
  // computer (or a typical laptop on the hosted site), not anyone's server.
  async function scanHub() {
    const previous = readScan(scanFile);
    const known = new Set((previous?.models ?? []).map((m) => m.id));
    const models = await hub().scan();
    const scan = { at: new Date().toISOString(), models: models.map((m) => ({ ...withSpeed(m), isNew: previous ? !known.has(m.id) : false })) };
    fs.mkdirSync(path.dirname(scanFile), { recursive: true });
    fs.writeFileSync(scanFile, JSON.stringify(scan));
    return scan;
  }

  // Gathers what people say about these models (and summarizes it) as a
  // cancellable run; models gathered this week are skipped.
  function gatherAll(ids) {
    const index = readVoices(voicesFile);
    const todo = ids.filter((id) => !isFresh(index[id]));
    const run = startCustomRun(`Gathering what people say about ${todo.length} model${todo.length === 1 ? "" : "s"} (${ids.length - todo.length} already gathered this week)`, async (emit, cancelled) => {
      let done = 0;
      const h = hub();
      const worker = async () => {
        for (;;) {
          const id = todo.shift();
          if (!id) return;
          index[id] = await gatherVoices(h, id);
          done++;
          if (done % 10 === 0 || done === ids.length) {
            writeVoices(index, voicesFile);
            emit(`${done} gathered`);
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      writeVoices(index, voicesFile);
      const withTalk = ids.filter((id) => (index[id]?.discussions?.length ?? 0) > 0).length;
      emit(`${ids.length} models covered; ${withTalk} have community discussions.`);
      await summarizeAll(ids, index, emit, cancelled);
    });
    return { ...run, todo: todo.length, total: ids.length };
  }

  async function api(req, res, url, ctx) {
    if (req.method === "GET" && url.pathname === "/api/state") {
      const saved = ctx.settings();
      const remote = chatServer(ctx);
      return send(res, 200, {
        machine,
        hosted,
        // Who is signed in on the hosted site, and whether anyone can.
        user: ctx.user ? { email: ctx.user.email, name: ctx.user.name, picture: ctx.user.picture, guest: ctx.user.guest, expiresAt: ctx.user.expiresAt ?? null } : null,
        // Whether video models, LoRAs and adult models are on show for this visitor.
        access: { full: fullAccess(ctx) },
        auth: hosted ? { google: accounts.googleClientId() || "", ready: accounts.googleConfigured(), guestHours: GUEST_HOURS } : null,
        refresh: hosted ? { hours: refreshHours, last: lastRefresh } : null,
        categories: CATEGORIES,
        // On the hosted site the runners are the rented machine's, if any.
        runners: hosted ? (remote ? await detect(fetchImpl, remote) : noRunners()) : await detect(fetchImpl, remote),
        token: saved.HF_TOKEN ? mask(saved.HF_TOKEN) : "",
        imageServer: saved.IMAGE_SERVER || "",
        // `direct` tells the page to talk to the machine itself, so what is
        // said to a model never passes through this server.
        chatServer: remote ? { url: remote, agent: imageAgent(ctx) || null, gpuGb: chatServerMachine(remote, saved.OLLAMA_SERVER_GB).gpuGb, comfortableGb: chatServerMachine(remote, saved.OLLAMA_SERVER_GB).comfortableGb, rented: rentedChat(ctx), direct: hosted } : null,
        // The site's own address, for the page to name when a machine rented for it refuses another.
        siteOrigin: hosted ? siteOrigin || "" : "",
        runpodKey: saved.RUNPOD_API_KEY ? mask(saved.RUNPOD_API_KEY) : "",
        vastKey: saved.VAST_API_KEY ? mask(saved.VAST_API_KEY) : "",
        civitaiToken: saved.CIVITAI_TOKEN ? mask(saved.CIVITAI_TOKEN) : "",
        registryAuth: saved.RUNPOD_REGISTRY_AUTH || "",
        rental: ctx.rental ? ctx.rental.cached() : hosted ? null : { rented: false },
        rentTiers: TIERS,
        // The two safeguards every rental has, for the page to say so before renting.
        idleMinutes: ctx.rental ? ctx.rental.idleMinutes() : 30,
        // Whether the idle time was set by hand; unset, it depends on the machine's price.
        idleSet: saved.RUNPOD_IDLE_MINUTES !== undefined && saved.RUNPOD_IDLE_MINUTES !== "",
        // Minutes without a click or key before the page asks whether anyone is there; short by default.
        presenceMinutes: Number(saved.RUNPOD_PRESENCE_MINUTES) > 0 ? Number(saved.RUNPOD_PRESENCE_MINUTES) : 30,
        maxSpend: ctx.rental ? ctx.rental.maxSpend() : 50,
        hidden: hiddenList(saved.HIDDEN_MODELS),
        stopOnQuit: !hosted && saved.RUNPOD_STOP_ON_QUIT !== "0",
        redditApp: saved.REDDIT_CLIENT_ID ? mask(saved.REDDIT_CLIENT_ID) : "",
        githubToken: saved.GITHUB_TOKEN ? mask(saved.GITHUB_TOKEN) : "",
        youtubeKey: saved.YOUTUBE_API_KEY ? mask(saved.YOUTUBE_API_KEY) : "",
        claudeKey: saved.ANTHROPIC_API_KEY ? mask(saved.ANTHROPIC_API_KEY) : "",
        claudeReady: hosted ? Boolean(saved.ANTHROPIC_API_KEY) : claudeReady(),
        // The hosted site checks with a visitor's own key (saved to their account or typed in), or the owner's dev code when one is set.
        claudeHosted: hosted ? { devCode: Boolean(devCode), saved: Boolean(saved.ANTHROPIC_API_KEY) } : null,
        envFile: tildify(envFile),
        scan: readScan(scanFile, { meta: true }),
        voices: voicesMeta(),
        summarizer: writtenSummaries ? await summarizerModel(fetchImpl) : null,
        picks: PICKS.map((p) => ({ ...p, ...speedOf({ runnerId: p.runner, sizeGb: p.gb, fileName: p.file, machine: machineFor(p.runner, ctx) }) })),
        speedTier: speedTier(machine),
      });
    }
    // Signing in and out of the hosted site, and deleting an account.
    if (req.method === "POST" && url.pathname === "/api/auth/google") {
      if (!accounts) return send(res, 503, { error: "Sign-in is not set up on this site." });
      const body = await json(req);
      try {
        const profile = await accounts.verifyGoogle(body.credential);
        const user = accounts.findOrCreate(profile);
        // A guest who signs in keeps their keys and machine.
        if (ctx.user?.guest) {
          accounts.adopt(ctx.user.id, user.id);
          rentals.delete(ctx.user.id);
          rentals.delete(user.id);
        }
        res.setHeader("Set-Cookie", accounts.cookie(accounts.issue(user.id)));
        return send(res, 200, { ok: true, user: { email: user.email, name: user.name, picture: user.picture } });
      } catch (err) {
        return send(res, err instanceof AuthError ? err.status : 500, { error: err.message });
      }
    }
    // A visitor enters a key without signing in: a guest is made for them,
    // kept for a while after each use. Signed in or a guest already, the
    // key simply lands in their settings.
    if (req.method === "POST" && url.pathname === "/api/guest") {
      if (!hosted) return send(res, 404, { error: "Not found" });
      const body = await json(req);
      const updates = {};
      for (const [key, pattern, what] of [["RUNPOD_API_KEY", /^[\w-]{20,200}$/, "a RunPod API key"], ["VAST_API_KEY", /^[\w-]{20,200}$/, "a Vast.ai API key"], ["ANTHROPIC_API_KEY", /^sk-ant-[\w-]{20,300}$/, "an Anthropic API key (they start with sk-ant-)"], ["HF_TOKEN", /^[\w-]{20,200}$/, "a Hugging Face token"], ["CIVITAI_TOKEN", /^[\w-]{20,200}$/, "a Civitai API key"]]) {
        if (key in body) {
          const value = String(body[key] ?? "").trim();
          if (!pattern.test(value)) return send(res, 400, { error: `That does not look like ${what}` });
          updates[key] = value;
        }
      }
      if (!Object.keys(updates).length) return send(res, 400, { error: "Nothing to save" });
      let user = ctx.user;
      if (!user) {
        user = accounts.guest();
        res.setHeader("Set-Cookie", accounts.cookie(accounts.issue(user.id)));
      }
      accounts.saveSettings(user.id, updates);
      return send(res, 200, { ok: true, guest: user.guest, expiresAt: user.guest ? accounts.extend(user.id) : null });
    }
    if (req.method === "POST" && url.pathname === "/api/auth/logout") {
      if (accounts) res.setHeader("Set-Cookie", accounts.clearCookie());
      return send(res, 200, { ok: true });
    }
    // Deleting an account deletes the rented machine too, and every key.
    if (req.method === "POST" && url.pathname === "/api/account/delete") {
      if (ctx.rental && ctx.settings().RUNPOD_POD_ID) await ctx.rental.remove().catch(() => {});
      rentals.delete(ctx.user.id);
      accounts.remove(ctx.user.id);
      res.setHeader("Set-Cookie", accounts.clearCookie());
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      if (hosted && !ctx.user) return send(res, 401, { error: "Enter a key as a guest, or sign in, before saving settings here." });
      const body = await json(req);
      const updates = {};
      if (hosted) {
        const stray = Object.keys(body).find((k) => !ACCOUNT_KEYS.has(k));
        if (stray) return send(res, 400, { error: `${stray} is a setting of the app on your own computer, not of this site.` });
      }
      if ("HF_TOKEN" in body) {
        if (typeof body.HF_TOKEN !== "string") return send(res, 400, { error: "HF_TOKEN must be a string" });
        updates.HF_TOKEN = body.HF_TOKEN.trim();
      }
      for (const [key, pattern, what] of [["GITHUB_TOKEN", /^[\w-]{20,255}$/, "a GitHub token"], ["YOUTUBE_API_KEY", /^[\w-]{20,80}$/, "a YouTube API key"], ["ANTHROPIC_API_KEY", /^sk-ant-[\w-]{20,300}$/, "an Anthropic API key (they start with sk-ant-)"], ["RUNPOD_API_KEY", /^[\w-]{20,200}$/, "a RunPod API key"], ["VAST_API_KEY", /^[\w-]{20,200}$/, "a Vast.ai API key"], ["CIVITAI_TOKEN", /^[\w-]{20,200}$/, "a Civitai API key"]]) {
        if (key in body) {
          if (typeof body[key] !== "string") return send(res, 400, { error: `${key} must be a string` });
          const value = body[key].trim();
          if (value && !pattern.test(value)) return send(res, 400, { error: `That does not look like ${what}` });
          updates[key] = value;
        }
      }
      if ("REDDIT_CLIENT_ID" in body) {
        if (typeof body.REDDIT_CLIENT_ID !== "string") return send(res, 400, { error: "REDDIT_CLIENT_ID must be a string" });
        const value = body.REDDIT_CLIENT_ID.trim();
        if (value && !/^[\w-]{10,40}$/.test(value)) return send(res, 400, { error: "That does not look like a Reddit app id" });
        updates.REDDIT_CLIENT_ID = value;
      }
      if ("OLLAMA_SERVER" in body) {
        if (typeof body.OLLAMA_SERVER !== "string") return send(res, 400, { error: "OLLAMA_SERVER must be a string" });
        const value = body.OLLAMA_SERVER.trim().replace(/\/+$/, "");
        if (value && !/^https?:\/\/[\w.\-:[\]]+(\/[\w./-]*)?$/.test(value)) return send(res, 400, { error: "The chat server must be an http or https address" });
        updates.OLLAMA_SERVER = value;
        const gb = Number(body.OLLAMA_SERVER_GB);
        if (value && !(gb >= 1 && gb <= 2000)) return send(res, 400, { error: "Say how much GPU memory the server has, in GB" });
        updates.OLLAMA_SERVER_GB = value ? String(Math.round(gb)) : "";
      }
      if ("RUNPOD_IDLE_MINUTES" in body) {
        const minutes = Number(body.RUNPOD_IDLE_MINUTES);
        if (!(Number.isInteger(minutes) && minutes >= 0 && minutes <= 1440)) return send(res, 400, { error: "The idle time must be a whole number of minutes, 0 to 1440; 0 never stops the machine" });
        updates.RUNPOD_IDLE_MINUTES = String(minutes);
      }
      if ("RUNPOD_PRESENCE_MINUTES" in body) {
        const minutes = Number(body.RUNPOD_PRESENCE_MINUTES);
        if (!(Number.isFinite(minutes) && minutes >= 0.1 && minutes <= 240)) return send(res, 400, { error: "The still-there check must be between 1 and 240 minutes" });
        updates.RUNPOD_PRESENCE_MINUTES = String(minutes);
      }
      if ("RUNPOD_MAX_SPEND" in body) {
        const dollars = Number(body.RUNPOD_MAX_SPEND);
        if (!(Number.isFinite(dollars) && dollars >= 0 && dollars <= 10000)) return send(res, 400, { error: "The spend cap must be a number of dollars, 0 to 10000; 0 removes the cap" });
        updates.RUNPOD_MAX_SPEND = String(Math.round(dollars * 100) / 100);
      }
      if ("RUNPOD_STOP_ON_QUIT" in body) updates.RUNPOD_STOP_ON_QUIT = body.RUNPOD_STOP_ON_QUIT ? "" : "0";
      // RunPod's Community Cloud asked as well as the Secure Cloud: on or off.
      if ("RUNPOD_COMMUNITY" in body) updates.RUNPOD_COMMUNITY = body.RUNPOD_COMMUNITY ? "1" : "";
      if ("RUNPOD_REGISTRY_AUTH" in body) {
        const value = String(body.RUNPOD_REGISTRY_AUTH ?? "").trim();
        if (value && !/^[\w-]{1,120}$/.test(value)) return send(res, 400, { error: "That does not look like a RunPod registry credential id" });
        updates.RUNPOD_REGISTRY_AUTH = value;
      }
      // Data centres to place the next rent away from, for a day each:
      // RunPod's ids, with the time each was noted ("EUR-IS-4@<ms>"), or
      // bare ids, taken as noted now; empty clears the list.
      if ("RUNPOD_SLOW_DCS" in body) {
        const items = String(body.RUNPOD_SLOW_DCS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        if (!items.every((s) => /^[A-Z]{2,3}-[A-Z]{2,4}-\d{1,2}(@\d{13})?$/.test(s))) return send(res, 400, { error: "Data centres are RunPod ids such as EUR-IS-4, comma-separated" });
        updates.RUNPOD_SLOW_DCS = items.map((s) => (s.includes("@") ? s : `${s}@${Date.now()}`)).join(",");
      }
      if ("HIDDEN_MODELS" in body) {
        const ids = Array.isArray(body.HIDDEN_MODELS) ? body.HIDDEN_MODELS : String(body.HIDDEN_MODELS ?? "").split(",");
        const clean = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
        if (clean.some((x) => !MODEL_ID_RE.test(x))) return send(res, 400, { error: "Hidden models must be repository ids like owner/name" });
        if (clean.length > 1000) return send(res, 400, { error: "That is more hidden models than can be kept" });
        updates.HIDDEN_MODELS = clean.join(",");
      }
      if ("IMAGE_SERVER" in body) {
        if (typeof body.IMAGE_SERVER !== "string") return send(res, 400, { error: "IMAGE_SERVER must be a string" });
        const value = body.IMAGE_SERVER.trim().replace(/\/+$/, "");
        if (value && !/^https?:\/\/[\w.\-:[\]]+(\/[\w./-]*)?$/.test(value)) return send(res, 400, { error: "IMAGE_SERVER must be an http or https address" });
        updates.IMAGE_SERVER = value;
      }
      if (!Object.keys(updates).length) return send(res, 400, { error: "Nothing to save" });
      ctx.save(updates);
      // A new token can change what the Hub is willing to show.
      details.clear();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/scan") {
      return send(res, 200, await scanHub());
    }
    // The front-page search: a plain description of what is wanted, answered
    // with models ranked by name, category and what people say, plus the
    // outside sources collapsed underneath.
    if (req.method === "GET" && url.pathname === "/api/find") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return send(res, 400, { error: "Say what you are looking for" });
      const started = Date.now();
      const index = readVoices(voicesFile);
      const scan = readScan(scanFile) ?? { models: [] };
      const full = fullAccess(ctx);
      const scanned = scan.models.map(withVoice).filter((m) => full || forVisitors(m));
      const known = [...new Set([...Object.keys(index), ...scan.models.map((m) => m.id)])];
      let hub = [];
      let hubError = null;
      const [hubResult, asked] = await Promise.all([
        hub_().search(q).then((models) => models.map((m) => withSpeed(m, ctx)).map(withVoice).filter((m) => full || forVisitors(m))).catch((err) => {
          hubError = err.message;
          return [];
        }),
        askSources(q, known, { civitai: true, reddit: true, github: true, hn: true, lemmy: true, youtube: true }),
      ]);
      hub = hubResult;
      if (!full && Array.isArray(asked.civitai)) asked.civitai = asked.civitai.filter((i) => !i.nsfw);
      const hideRefusing = url.searchParams.get("showRefusing") !== "1";
      const ranked = rankModels(q, { hub, scanned, picks: PICKS.map((p) => ({ ...p, ...speedOf({ runnerId: p.runner, sizeGb: p.gb, fileName: p.file, machine: machineFor(p.runner, ctx) }) })).filter((p) => full || forVisitors(p)), voices: index, hideRefusing });
      return send(res, 200, { q, ...ranked, models: ranked.models.slice(0, 60), hideRefusing, hubError, gathered: Object.keys(index).length, scanned: scan.models.length, took: Date.now() - started, ...asked });
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return send(res, 400, { error: "Say what you are looking for" });
      const models = await hub().search(q);
      return send(res, 200, { q, models: models.map((m) => withSpeed(m, ctx)).map(withVoice).filter((m) => fullAccess(ctx) || forVisitors(m)) });
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const scan = readScan(scanFile) ?? { at: null, models: [] };
      return send(res, 200, { ...scan, models: scan.models.map(withVoice).filter((m) => fullAccess(ctx) || forVisitors(m)) });
    }
    // Gathers what people say about every model in the scan (and any
    // search results the page asks for), a card and a discussion list each.
    if (req.method === "POST" && url.pathname === "/api/voices/gather") {
      const body = await json(req);
      const scan = readScan(scanFile) ?? { models: [] };
      const ids = [...new Set([...scan.models.map((m) => m.id), ...(Array.isArray(body.ids) ? body.ids.filter((id) => /^[\w.-]+\/[\w.-]+$/.test(String(id))) : [])])];
      const run = gatherAll(ids);
      return send(res, 200, { id: run.id, todo: run.todo, total: run.total });
    }
    // A download may be asked, while it runs, to stop the machine when it is
    // over: the money stops the moment the work does, whether or not the page
    // is still open.
    if (req.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/stop-after")) {
      const id = url.pathname.slice("/api/runs/".length, -"/stop-after".length);
      const run = getRun(id);
      if (!run || (hosted && run.owner !== ctx.user?.id)) return send(res, 404, { error: "No such run" });
      const body = await json(req).catch(() => ({}));
      stopWhenDone(ctx, run, body.on !== false);
      return send(res, 200, { ok: true, stopAfter: Boolean(run.stopAfter) });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/cancel")) {
      const id = url.pathname.slice("/api/runs/".length, -"/cancel".length);
      if (hosted && getRun(id)?.owner !== ctx.user?.id) return send(res, 404, { error: "No such run" });
      return cancelRun(id) ? send(res, 200, { ok: true }) : send(res, 404, { error: "No such run" });
    }
    // Which models people describe with these words.
    if (req.method === "GET" && url.pathname === "/api/voices/search") {
      const q = url.searchParams.get("q") ?? "";
      const index = readVoices(voicesFile);
      const known = [...new Set([...Object.keys(index), ...((readScan(scanFile)?.models ?? []).map((m) => m.id))])];
      // Every outside source is asked at once; one failing is reported, not fatal.
      const started = Date.now();
      const asked = await askSources(q, known, { civitai: true, reddit: true, github: true, hn: true, lemmy: true, youtube: true });
      const shown = fullAccess(ctx) ? null : new Set((readScan(scanFile)?.models ?? []).filter(forVisitors).map((m) => m.id));
      if (shown && Array.isArray(asked.civitai)) asked.civitai = asked.civitai.filter((i) => !i.nsfw);
      return send(res, 200, { q, hits: searchVoices(index, q).filter((h) => !shown || shown.has(h.id)).slice(0, 100), took: Date.now() - started, ...asked });
    }
    // Off-Hub voices for one model: its Civitai page and Reddit posts, cached for a week.
    if (req.method === "GET" && url.pathname === "/api/voices/web") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      const index = readVoices(voicesFile);
      const entry = index[id] ?? { at: null, card: "", discussions: [] };
      const wantImages = url.searchParams.get("images") === "1";
      let out;
      if (isFresh(entry.web) && entry.web.data.version === 2) {
        out = { id, ...entry.web.data, cached: true };
      } else {
        const started = Date.now();
        out = { id, ...(await askSourcesForModel(id, wantImages)), took: Date.now() - started };
        // Cache only when every source answered; an error is asked again next time.
        const errors = ["civitaiError", "redditError", "githubError", "hnError", "lemmyError", "youtubeError"].filter((k) => out[k]);
        if (!errors.length) {
          index[id] = { ...entry, web: { at: new Date().toISOString(), data: { ...out, version: 2 } } };
          writeVoices(index, voicesFile);
        }
      }
      out.redditConfigured = reddit().configured();
      out.youtubeConfigured = youtube().configured();
      return send(res, 200, out);
    }
    // The settings people suggest that HuggingFound has no control for, across
    // every gathered model, the most asked-for first: what to build next.
    if (req.method === "GET" && url.pathname === "/api/settings/wanted") {
      const index = readVoices(voicesFile);
      const kinds = new Map([...(readScan(scanFile)?.models ?? []), ...PICKS].map((m) => [m.id, kindOf(m)]));
      const entries = Object.entries(index).map(([id, e]) => ({ id, kind: kinds.get(id) ?? null, settings: e.summary?.settings ?? settingsAdvice(collectVoices(e, isFresh(e.web) ? e.web.data : null)) }));
      return send(res, 200, { models: entries.length, wanted: wantedSettings(entries) });
    }
    // The full picture for one model: card excerpt and discussions with their first comments.
    if (req.method === "GET" && url.pathname === "/api/voices") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      const index = readVoices(voicesFile);
      if (!isFresh(index[id])) {
        index[id] = await gatherVoices(hub(), id);
        writeVoices(index, voicesFile);
      }
      const entry = index[id];
      const h = hub();
      const threads = await Promise.all(entry.discussions.slice(0, 6).map((d) => h.discussion(id, d.num).catch(() => null)));
      const discussions = entry.discussions.map((d) => ({ ...d, url: `https://huggingface.co/${id}/discussions/${d.num}`, comments_text: threads.find((t) => t?.num === d.num)?.comments?.slice(0, 3) ?? [] }));
      // With the comments in hand the summary can be better than the one from titles alone.
      const withComments = { ...entry, name: id.split("/").pop(), discussions };
      const summary = await summarize(withComments, isFresh(entry.web) ? entry.web.data : null, { model: writtenSummaries ? await summarizerModel(fetchImpl) : null, fetchImpl });
      index[id] = { ...entry, summary };
      writeVoices(index, voicesFile);
      return send(res, 200, { id, card: entry.card, gatheredAt: entry.at, discussions, summary: cleanSummary(summary, kindFor(id)) });
    }
    if (req.method === "GET" && url.pathname === "/api/model") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      // Gated refusals are not cached: a token added later should get a fresh answer.
      const own = tokenFor(ctx);
      const model = details.get(id) ?? (await hub().model(id, { token: own }));
      // What a person's own token unlocked is not kept for everyone.
      if (!model.gatedBlocked && !(own && model.gated)) details.set(id, model);
      if (!fullAccess(ctx) && !forVisitors(model)) return send(res, 403, { error: model.adult ? "This model is for adults. Sign in, or enter an Anthropic API key as a guest, to open it here." : VISITOR_ONLY });
      // Curated picks name their runner and file outright, so a repository
      // the tag rules cannot place still gets a plan.
      const pick = PICKS.find((p) => p.id === id);
      if (pick && !model.gatedBlocked) model.runner = { id: pick.runner, name: RUNNER_NAMES[pick.runner], easy: true };
      // A chat or image model runs here or on the rented GPU; `where` is
      // the choice the page made, and the plan is built for that machine.
      // Without a choice the rented machine wins when there is one.
      const kind = model.runner?.id;
      const remote = remoteFor(kind, ctx);
      // The diffusers families run nowhere but a rented GPU.
      const gpuOnly = kind === "diffusers" || (isAddon(model.name) && (kind === "sd" || kind === "diffusers"));
      const where = gpuOnly ? "rented" : ["ollama", "sd"].includes(kind) ? (url.searchParams.get("where") || (remote ? "rented" : "local")) : "local";
      const useRemote = where === "rented" && remote;
      const planMachine = useRemote ? chatServerMachine(remote, ctx.settings().OLLAMA_SERVER_GB) : machine;
      const detected = useRemote && kind === "ollama" ? withRental(await detect(fetchImpl, remote), ctx) : useRemote && (kind === "sd" || kind === "diffusers") ? await withGpu(hosted ? noRunners() : await detect(fetchImpl), remote, ctx) : hosted ? noRunners() : await detect(fetchImpl);
      const plan = model.gatedBlocked
        ? { runnable: false, gated: true, reason: "This model is gated and the request was refused. Accept the licence on Hugging Face and add a token in Settings.", steps: [], link: `https://huggingface.co/${id}` }
        : buildPlan({ model, files: model.files, machine: planMachine, detected, hasToken: Boolean(own), preferredFile: pick?.file, timings: hosted ? {} : readTimings(), imageServer: hosted ? null : await remoteImageServer(), twin: await diffusersTwin(model, own) });
      // What the page needs to offer the other place: the size of GPU this
      // file wants, and whether a machine is rented already.
      const choice = ["ollama", "sd", "diffusers"].includes(kind) ? { where: useRemote || gpuOnly ? "rented" : "local", rented: Boolean(remote), tier: gpuOnly && plan.addon ? 24 : tierFor(plan.tierGb ?? plan.file?.gb ?? guessSizeGb({ id, runnerId: kind }))?.gb ?? null, hasRunpodKey: Boolean(ctx.settings().RUNPOD_API_KEY || ctx.settings().VAST_API_KEY), ...(gpuOnly ? { gpuOnly: true } : {}) } : null;
      // A step whose download is already going (started from this window
      // earlier, or from another tab) shows its progress instead of a button.
      const owner = ctx.user?.id ?? null;
      for (const step of plan.steps ?? []) {
        const active = listRuns(owner).find((r) => r.status === "running" && r.key === stepKey(step.kind, step.args ?? {}));
        if (active) {
          step.running = active.id;
          continue;
        }
        // The machine may have the download going although this server has
        // lost it (a restart, another tab): a run is attached to it, so the
        // window shows its progress rather than offering to start it again.
        const taskKey = agentTaskKey(step.kind, step.args ?? {});
        const onMachine = taskKey && (detected.gpu?.tasks ?? []).find((t) => t.status === "running" && t.key === taskKey);
        if (onMachine) {
          const run = attachAgentTask(detected.gpu.url, onMachine, `${step.title} (found going on the machine)`, fetchImpl, { owner, machine: machineAsk(ctx, detected.gpu.url) });
          run.key = stepKey(step.kind, step.args ?? {});
          run.model = id;
          run.title = step.title;
          step.running = run.id;
        }
      }
      return send(res, 200, { model, plan, choice });
    }
    // LoRAs and fine-tunes for a video model: what Hugging Face and Civitai
    // have for it, and a repository's files once one is picked.
    if (req.method === "GET" && url.pathname === "/api/loras") {
      if (!fullAccess(ctx)) return send(res, 403, { error: VISITOR_ONLY });
      const id = String(url.searchParams.get("id") ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      return send(res, 200, await loraFinder.find(id, { adult: url.searchParams.get("adult") === "1" }));
    }
    if (req.method === "GET" && url.pathname === "/api/loras/link") {
      if (!fullAccess(ctx)) return send(res, 403, { error: VISITOR_ONLY });
      const id = String(url.searchParams.get("base") ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      try {
        return send(res, 200, { item: await loraFinder.fromLink(id, String(url.searchParams.get("url") ?? "").slice(0, 500)) });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    // How a LoRA's creator made their showcase clips: notes, strength,
    // prompts and settings read off its Civitai version or its model card.
    if (req.method === "GET" && url.pathname === "/api/loras/recipe") {
      if (!fullAccess(ctx)) return send(res, 403, { error: VISITOR_ONLY });
      const base = String(url.searchParams.get("base") ?? "");
      const id = String(url.searchParams.get("id") ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(base) || !/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      const version = /^\d+$/.test(String(url.searchParams.get("version") ?? "")) ? url.searchParams.get("version") : null;
      try {
        return send(res, 200, await loraFinder.recipe(base, { id, version }, { adult: url.searchParams.get("adult") === "1" }));
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/loras/files") {
      if (!fullAccess(ctx)) return send(res, 403, { error: VISITOR_ONLY });
      const id = String(url.searchParams.get("id") ?? "");
      if (!/^[\w.-]+\/[\w.-]+$/.test(id) || id.startsWith("civitai/")) return send(res, 400, { error: "Bad repository" });
      try {
        return send(res, 200, { files: await loraFinder.hubFiles(id) });
      } catch (err) {
        return send(res, 502, { error: err.message });
      }
    }
    // Every download or run of this person's: what is going now, and what
    // finished in the last minutes, each with the model it was for.
    if (req.method === "GET" && url.pathname === "/api/runs") {
      return send(res, 200, { runs: listRuns(ctx.user?.id ?? null) });
    }
    if (req.method === "GET" && url.pathname === "/api/storage") {
      return send(res, 200, await storage(fetchImpl, chatServer(ctx)));
    }
    if (req.method === "POST" && url.pathname === "/api/remove") {
      const body = await json(req);
      // On the hosted site the only thing to remove is a model on the rented machine.
      if (hosted && !((body.kind === "ollama" && chatServer(ctx)) || (["gpu-file", "gpu-addon"].includes(body.kind) && imageAgent(ctx)))) return send(res, 403, { error: "Only models on your rented GPU can be removed from here." });
      try {
        if (body.kind === "file") removeFile(body.repo, body.file);
        else if (body.kind === "folder") removeFolder(body.repo);
        else if (body.kind === "ollama") await removeOllamaModel(body.name, fetchImpl, chatServer(ctx));
        else if (body.kind === "gpu-file") await removeAgentModel(body.repo, body.file, fetchImpl, imageAgent(ctx));
        else if (body.kind === "gpu-addon") await removeAgentAddon(body.repo, body.file, fetchImpl, imageAgent(ctx));
        else if (body.kind === "outputs") clearOutputs();
        else return send(res, 400, { error: "kind must be file, folder, ollama, gpu-file or outputs" });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      return send(res, 200, hosted ? { ok: true } : await storage(fetchImpl, chatServer(ctx)));
    }
    // Renting a GPU by the hour: what is on offer, what is rented, and
    // starting, stopping and deleting it.
    if (url.pathname === "/api/rent" || url.pathname.startsWith("/api/rent/")) {
      const action = url.pathname.slice("/api/rent".length).replace(/^\//, "");
      const mine = ctx.rental;
      try {
        if (req.method === "GET" && action === "options") {
          const tiers = mine.configured() ? await mine.tiers({ fresh: url.searchParams.get("fresh") === "1" }) : TIERS.map((t) => ({ ...t, gpu: null, pricePerHour: null, available: false }));
          // With each size, what the site has seen of its stock: how long it
          // has been sold out and how long it took to come back before.
          return send(res, 200, { configured: mine.configured(), providers: mine.providers(), community: mine.usesCommunity(), tiers, stock: stock.summaries(tiers.map((t) => t.gb)), checkedAt: Date.now() });
        }
        if (req.method === "GET" && action === "registries") return send(res, 200, { registries: mine.configured() ? await mine.registries() : [] });
        // The other HuggingFound machines on the RunPod account, each still
        // charging for its disk, and the way to be rid of them.
        if (req.method === "GET" && action === "others") return send(res, 200, { others: await mine.others() });
        if (req.method === "POST" && action === "others/delete") {
          const body = await json(req).catch(() => ({}));
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : null;
          return send(res, 200, { deleted: await mine.removeOthers(ids) });
        }
        // The account's pod bill for the week, GPU time apart from disks.
        if (req.method === "GET" && action === "spend") return send(res, 200, await mine.spend());
        // Everything on the machine right now: chat models (and which are
        // loaded) from Ollama, image models (and the loaded one) from the agent.
        if (req.method === "GET" && action === "models") return send(res, 200, { ...(await machineModels(ctx)), runs: listRuns(ctx.user?.id ?? null) });
        if (req.method === "GET" && action === "") {
          const status = await mine.status();
          const downloading = listRuns(ctx.user?.id ?? null).filter((r) => r.status === "running").length;
          return send(res, 200, downloading ? { ...status, downloading } : status);
        }
        if (req.method === "POST" && action === "") {
          const body = await json(req);
          // The browser talks to the machine itself (chat on the site, pictures
          // everywhere), so Ollama and the agent there must accept requests
          // from this page's address: the site's, or the app's own.
          const origins = pageOrigins(req);
          return send(res, 200, await mine.rent({ gb: body.gb, diskGb: body.diskGb ?? 50, origins, provider: body.provider === "vast" ? "vast" : "runpod" }));
        }
        // A message sent straight from the browser to the machine tells the
        // idle watch the machine is in use; nothing of the message comes here.
        if (req.method === "POST" && action === "touch") {
          mine.touch();
          return send(res, 200, { ok: true });
        }
        // A hidden model leaves the machine too: its chat model, its image
        // files and its add-on files, whichever of them are there.
        if (req.method === "POST" && action === "forget") {
          const body = await json(req);
          const id = String(body.id ?? "");
          if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
          const removed = [];
          const onMachine = await machineModels(ctx);
          const remote = chatServer(ctx);
          const agent = imageAgent(ctx);
          for (const m of onMachine.chat.filter((c) => c.id === id)) {
            try {
              await removeOllamaModel(m.name, fetchImpl, remote);
              removed.push(m.name);
            } catch {
              // gone already, or not answering
            }
          }
          for (const m of onMachine.images.filter((f) => f.repo === id)) {
            try {
              await removeAgentModel(m.repo, m.file, fetchImpl, agent);
              removed.push(`${m.repo}/${m.file}`);
            } catch {
              // gone already
            }
          }
          if (agent) {
            const addons = await agentAddons(agent, fetchImpl).catch(() => []);
            for (const key of addons.filter((k) => k.startsWith(`${id}/`))) {
              try {
                await removeAgentAddon(id, key.slice(id.length + 1), fetchImpl, agent);
                removed.push(key);
              } catch {
                // gone already
              }
            }
          }
          return send(res, 200, { removed });
        }
        if (req.method === "POST" && action === "stop") {
          const body = await json(req).catch(() => ({}));
          return send(res, 200, await mine.stop({ reason: body.reason === "away" ? `away:${Number(body.minutes) || ""}` : body.reason === "done" ? "done" : "" }));
        }
        if (req.method === "POST" && action === "start") return send(res, 200, await mine.start());
        // Rent a size the moment it is free: the site watches RunPod for it,
        // even with this page closed, and rents it at no more than the price set.
        if (req.method === "POST" && action === "watch") {
          const body = await json(req);
          const origins = pageOrigins(req);
          const out = mine.watchFor({ gb: body.gb, diskGb: body.diskGb, maxPricePerHour: body.maxPricePerHour, hours: body.hours, holdMinutes: body.holdMinutes, origins });
          // Checked straight away, not a minute from now.
          await mine.checkWatch().catch(() => null);
          return send(res, 200, { ...out, ...(await mine.status({ probe: false }).catch(() => ({}))) });
        }
        if (req.method === "POST" && action === "unwatch") return send(res, 200, mine.cancelWatch());
        // The same machine, restarted in place: its agent starts afresh, its disk and card stay.
        if (req.method === "POST" && action === "restart") return send(res, 200, await mine.restart());
        // A bigger disk for the same machine, when a model does not fit the one it has.
        if (req.method === "POST" && action === "grow") {
          const body = await json(req);
          return send(res, 200, await mine.grow(Number(body.diskGb)));
        }
        if (req.method === "POST" && action === "delete") return send(res, 200, await mine.remove());
        return send(res, 404, { error: "Not found" });
      } catch (err) {
        return send(res, err instanceof RentError || err instanceof VastError ? err.status : 500, { error: err.message, ...(err.noGpu ? { noGpu: true } : {}), ...(err.busy ? { busy: true } : {}) });
      }
    }
    // Whether the chat server answers, and what it holds.
    if (req.method === "GET" && url.pathname === "/api/chat-server") {
      const configured = chatServer(ctx);
      if (!configured) return send(res, 200, { configured: "", ok: false });
      try {
        const [version, tags] = await Promise.all([
          fetchImpl(`${configured}/api/version`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
          fetchImpl(`${configured}/api/tags`, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
        ]);
        return send(res, 200, { configured, ok: true, version: version.version ?? "", models: (tags.models ?? []).length });
      } catch (err) {
        return send(res, 200, { configured, ok: false, error: err.name === "TimeoutError" ? "no answer" : err.message });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/image-server") {
      const configured = env().IMAGE_SERVER;
      if (!configured) return send(res, 200, { configured: "", ok: false });
      try {
        return send(res, 200, { configured, ok: true, ...(await describeImageServer(configured, fetchImpl)) });
      } catch (err) {
        return send(res, 200, { configured, ok: false, error: err.message });
      }
    }
    if (req.method === "POST" && url.pathname === "/api/unload") {
      stopImageServer();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/run") {
      const body = await json(req);
      // What a run is for, so a list of runs can name the model and the plan
      // can find the step again.
      const tag = (run) => {
        run.key = stepKey(String(body.kind ?? ""), body.args ?? {});
        run.model = /^[\w.-]+\/[\w.-]+$/.test(String(body.model ?? "")) ? String(body.model) : null;
        run.title = String(body.title ?? "").slice(0, 200) || null;
        return run;
      };
      try {
        const args = { ...(body.args ?? {}) };
        const remote = chatServer(ctx);
        const agent = imageAgent(ctx);
        // The page says where a step belongs; a rented machine is the
        // default while there is one, this computer otherwise.
        const where = body.where || (remote || agent ? "rented" : "local");
        const agentKinds = ["pull-image-model", "pull-image-folder", "pull-image-repo", "pull-addon"];
        if (hosted && !(where === "rented" && ((remote && body.kind === "pull-model") || (agent && agentKinds.includes(body.kind))))) return send(res, 403, { error: "On this site the only step that runs is a download onto your rented GPU. Everything else runs in HuggingFound on your own computer." });
        if (where === "rented" && agentKinds.includes(body.kind)) {
          if (!agent) return send(res, 400, { error: "No GPU is rented. Rent one in Settings, or run the model on this computer." });
          // The same step started twice is one download.
          const going = listRuns(ctx.user?.id ?? null).find((r) => r.status === "running" && r.key === stepKey(String(body.kind ?? ""), args));
          if (going) {
            if (body.stopAfter) stopWhenDone(ctx, getRun(going.id));
            return send(res, 200, { id: going.id, attached: true });
          }
          // A machine that stopped (its idle timer, the daily cap, a Stop) is
          // started again by the step that needs it; the files on its disk
          // are kept, and the download goes on from them.
          const restarted = await restartForStep(ctx, agent);
          if (restarted instanceof Error) return send(res, restarted.status ?? 503, { error: restarted.message, ...(restarted.noGpu ? { noGpu: true } : {}) });
          const machine = machineAsk(ctx, agent);
          const release = ctx.rental?.hold() ?? (() => {});
          const owner = ctx.user?.id ?? null;
          const token = tokenFor(ctx);
          const run = body.kind === "pull-image-folder"
            ? pullImageFolderOnAgent(String(args.repo ?? ""), args.files, String(args.into ?? ""), fetchImpl, agent, { owner, token, machine, restarted })
            : body.kind === "pull-image-repo"
              ? pullImageRepoOnAgent(String(args.repo ?? ""), args.files, fetchImpl, agent, { owner, token, gb: Number(args.gb) || 0, machine, restarted })
            : body.kind === "pull-addon"
              ? pullAddonOnAgent(String(args.repo ?? ""), args.files, fetchImpl, agent, { owner, token, machine, restarted, sources: args.sources ?? null, civitaiToken: civitaiTokenFor(ctx) })
              : pullImageOnAgent(String(args.repo ?? ""), String(args.file ?? ""), fetchImpl, agent, { owner, token, machine, restarted });
          run.finished.then(release);
          if (body.stopAfter) stopWhenDone(ctx, run);
          return send(res, 200, { id: tag(run).id });
        }
        // The remote address comes from settings, never from the page.
        if (body.kind === "generate-image") {
          const imageRemote = env().IMAGE_SERVER;
          if (imageRemote) args.remote = imageRemote;
          else delete args.remote;
        }
        if (where === "rented" && !remote) return send(res, 400, { error: "No GPU is rented. Rent one in Settings, or run the model on this computer." });
        if (where === "rented" && ["install-ollama", "start-ollama", "create-model"].includes(body.kind)) return send(res, 400, { error: "Chat models run on the chat server from Settings; this step is for running them on this computer." });
        if (where === "rented" && body.kind === "pull-model") {
          // A download keeps a rented machine awake, and the model is loaded
          // into the GPU afterwards so the first message is not the slow one.
          const release = ctx.rental?.hold() ?? (() => {});
          const run = pullOnChatServer(String(args.name ?? ""), fetchImpl, remote, { owner: ctx.user?.id ?? null });
          run.finished.then((status) => {
            release();
            if (status === "done" && rentedChat(ctx) && !run.stopAfter) warm(String(args.name ?? ""), remote);
          });
          if (body.stopAfter) stopWhenDone(ctx, run);
          return send(res, 200, { id: tag(run).id });
        }
        const run = startRun(String(body.kind ?? ""), args, machine, { token: env().HF_TOKEN, fetchImpl, hubBase, owner: ctx.user?.id ?? null });
        return send(res, 200, { id: tag(run).id });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const run = getRun(url.pathname.slice("/api/runs/".length));
      // A run's log is its owner's; on the hosted site nobody else may follow it.
      if (!run || (hosted && run.owner !== ctx.user?.id)) return send(res, 404, { error: "No such run" });
      return stream(res, run);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await json(req);
      ctx.rental?.touch();
      // Effort travels as Ollama's own knobs: whether the model thinks first,
      // and a few numeric options; nothing else from the page reaches Ollama.
      const options = {};
      for (const key of ["num_predict", "num_ctx", "temperature", "top_p"]) if (Number.isFinite(body.options?.[key])) options[key] = body.options[key];
      // The page leaving or pressing Stop ends the reply at Ollama too, so a
      // reply nobody is reading does not hold the model for the next one.
      const gone = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) gone.abort();
      });
      const messages = Array.isArray(body.messages) ? body.messages.slice(-40) : [];
      const toOllama = JSON.stringify({ model: String(body.model ?? ""), messages, stream: true, ...(typeof body.think === "boolean" ? { think: body.think } : {}), ...(Object.keys(options).length ? { options } : {}) });
      const plain = () => fetchImpl(`${ollamaUrl(chatServer(ctx))}/api/chat`, { method: "POST", signal: gone.signal, headers: { "Content-Type": "application/json" }, body: toOllama });
      // On a rented machine the agent carries the chat from image 28, the
      // request base64-wrapped: the proxy in front of the machine's
      // addresses (Cloudflare, for RunPod's) blocks a plain one whose words
      // read like attack payloads to a web firewall, as a binary file's
      // strings do. An older agent has no such route and says 404.
      const rental = ctx.rental?.cached?.() ?? null;
      const viaAgent = Boolean(rental?.rented && rental.agent && ctx.rental.owns(chatServer(ctx)) && (rental.agentVersion == null || Number(rental.agentVersion) >= 28));
      let upstream = viaAgent ? await agentFetch(fetchImpl)(`${rental.agent}/chat`, { method: "POST", signal: gone.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ b64: Buffer.from(toOllama).toString("base64") }) }) : null;
      if (!upstream || upstream.status === 404 || upstream.status === 405) upstream = await plain();
      if (!upstream.ok) {
        // What a refusal means, said plainly: a web firewall's page is the
        // proxy blocking the request, most likely over an attached file,
        // which the message names from the fenced headings; a bare 403 is
        // Ollama refusing; anything else comes with Ollama's own words.
        const why = await upstream.text().catch(() => "");
        const files = [...new Set(messages.flatMap((m) => [...String(m.content ?? "").matchAll(/^### (.+?)(?: \(an executable[^)]*\))?$/gm)].map((x) => x[1])))];
        const blocked = upstream.status === 403 && /cloudflare|ray id|attention required|<html/i.test(why);
        const named = files.length ? `most likely over ${files.slice(0, 3).join(", ")}${files.length > 3 ? " and the others" : ""}: a binary file's strings, or code, read like attack payloads to it, and the files go with every later message of the conversation` : "most likely over something in the conversation that read like an attack payload to it";
        const error = blocked ? `The proxy in front of the machine (a web firewall, Cloudflare's) blocked this request before it reached the machine: HTTP 403, ${named}.${viaAgent ? " Even carried by the machine's agent it was blocked; start a new chat without that file." : " A machine on the current image carries chats past that filter: replace the machine from the bar. Until then, start a new chat without that file."}` : upstream.status === 403 ? "Ollama on the machine refused this request (HTTP 403), which it does to a page from an address the machine was not rented for; replace the machine from the bar." : `Ollama replied HTTP ${upstream.status}${why.trim() ? `: ${why.trim().slice(0, 300)}` : ""}. Is it running and is the model downloaded?`;
        return send(res, upstream.status === 403 ? 403 : 502, { error, status: upstream.status });
      }
      res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const reader = upstream.body.getReader();
      let tail = "";
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          break;
        }
        const { value, done } = chunk;
        if (done) break;
        res.write(value);
        tail = (tail + Buffer.from(value).toString()).slice(-4000);
      }
      // Ollama's last line carries how many tokens it produced and how long
      // that took; that is the measured speed for this model.
      const last = tail.trim().split("\n").pop();
      try {
        const stats = JSON.parse(last);
        if (stats.done && stats.eval_count && stats.eval_duration) {
          recordTiming(String(body.model), { kind: "chat", tokensPerSecond: stats.eval_count / (stats.eval_duration / 1e9), seconds: stats.eval_duration / 1e9 });
        }
      } catch {
        // not a stats line
      }
      return res.end();
    }
    // Asks Claude to check a chat answer or a generated picture. Nothing is
    // sent anywhere until the user clicks for it. The review streams back
    // as lines of JSON: text as it is written, then how it ended.
    // Web Push: the site's public key, and a browser's subscription kept with
    // the account, to tell it what became of its GPU watch with the tab closed.
    if (req.method === "GET" && url.pathname === "/api/push/key") return send(res, 200, { key: await push.publicKey() });
    if (req.method === "POST" && url.pathname === "/api/push/subscribe") {
      if (hosted && !ctx.user) return send(res, 403, { error: "Sign in or enter a key as a guest first." });
      const packed = push.pack((await json(req)).subscription);
      if (!packed) return send(res, 400, { error: "That is not a browser push subscription." });
      ctx.save({ RUNPOD_PUSH: packed });
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/review") {
      let use = {};
      if (hosted) {
        const access = hostedAccess(req, ctx);
        if (access.error) return send(res, access.status, { error: access.error });
        use = { apiKey: access.apiKey, from: access.from };
      } else if (!claudeReady()) {
        return send(res, 400, { error: "Add an Anthropic API key in Settings to have Claude check answers and pictures." });
      }
      // A picked picture travels in the body as base64, so this route takes more than the others.
      const body = await json(req, 8 * 1024 * 1024);
      // The hosted site has no pictures of its own to name.
      if (hosted) delete body.file;
      let started = false;
      const line = (obj) => {
        if (!started) {
          res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
          started = true;
        }
        res.write(`${JSON.stringify(obj)}\n`);
      };
      // Where Claude is, every few seconds from the second second on: the
      // page shows it, and the line is never quiet long enough for anything
      // between to give up on it while Claude thinks.
      const began = Date.now();
      let where = { phase: "waiting", thought: 0 };
      const beat = setInterval(() => {
        if (Date.now() - began >= 2000) line({ status: where.phase, thought: where.thought, seconds: Math.round((Date.now() - began) / 1000) });
      }, 3000);
      try {
        const result = await checker.review(body, (text) => line({ text }), use, (e) => (where = e));
        clearInterval(beat);
        line({ done: true, ...result });
      } catch (err) {
        clearInterval(beat);
        let message = err instanceof ReviewError ? err.message : `The check failed: ${err.message}`;
        // A refused key: which one was sent, since a key typed into the page
        // is used ahead of the one saved, and a stale one there looks like
        // the saved one failing.
        if (err instanceof ReviewError && err.status === 401 && use.from) message += use.from === "typed" ? " The key used was the one typed into the Check an answer panel, not the one saved in Settings; clear that field to use the saved key." : " The key used was the one saved in Settings.";
        if (!started) return send(res, err instanceof ReviewError ? err.status : 500, { error: message });
        line({ error: message });
      }
      return res.end();
    }
    if (req.method === "POST" && url.pathname === "/api/upload") {
      const name = String(req.headers["x-filename"] ?? "audio").replace(/[^\w.+-]/g, "_");
      const dest = path.join(UPLOAD_DIR, `${Date.now()}-${name}`);
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        req.pipe(out).on("finish", resolve).on("error", reject);
      });
      const wav = await ensureWav(dest);
      return send(res, 200, { path: wav });
    }
    if (req.method === "GET" && url.pathname === "/api/result") {
      const file = path.basename(url.searchParams.get("file") ?? "");
      const full = path.join(OUTPUT_DIR, file);
      if (!file || !fs.existsSync(full)) return send(res, 404, { error: "Not found" });
      return send(res, 200, { text: file.endsWith(".txt") ? fs.readFileSync(full, "utf8") : null, url: `/output/${file}` });
    }
    send(res, 404, { error: "Not found" });
  }

  // The models on the rented machine, named so the page can open each one's
  // window: an Ollama name like hf.co/owner/repo:Q4_K_M is the Hub
  // repository owner/repo; an image file is kept under its repository.
  async function machineModels(ctx) {
    const remote = chatServer(ctx);
    const agent = imageAgent(ctx);
    const out = { chat: [], images: [], chatOk: false, imagesOk: false, loaded: null };
    const ask = async (url, timeout = 4000) => {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    };
    if (remote) {
      try {
        const [tags, ps] = await Promise.all([ask(`${remote}/api/tags`), ask(`${remote}/api/ps`).catch(() => ({ models: [] }))]);
        const running = new Set((ps.models ?? []).map((m) => m.name));
        out.chat = (tags.models ?? []).map((m) => {
          const hub = /^hf\.co\/([\w.-]+\/[\w.-]+)(?::|$)/.exec(m.name);
          return { name: m.name, id: hub ? hub[1] : null, gb: Math.round(((m.size ?? 0) / 1024 ** 3) * 10) / 10, running: running.has(m.name) };
        });
        out.chatOk = true;
      } catch {
        // not answering
      }
    }
    if (agent) {
      try {
        const [list, health] = await Promise.all([ask(`${agent}/models`), ask(`${agent}/health`).catch(() => ({}))]);
        out.loaded = health.loaded ?? null;
        out.images = (list.models ?? []).map((m) => ({ repo: m.repo, file: m.file, id: m.repo, gb: Math.round((m.gb ?? 0) * 10) / 10, loaded: health.loaded === `${m.repo}/${m.file}` }));
        out.imagesOk = true;
      } catch {
        // not answering
      }
    }
    return out;
  }

  // How a download run asks after the machine it runs on, when the machine
  // is this account's rental: whether it still exists and whether it runs.
  function machineAsk(ctx, agent) {
    if (!ctx.rental?.owns(agent)) return null;
    return () => ctx.rental.status({ probe: false });
  }

  // Starts the rented machine again when a step needs it and it has stopped.
  // True when it was started, false when it was running already or is not
  // this account's rental, and the error when RunPod would not start it.
  async function restartForStep(ctx, agent) {
    if (!ctx.rental?.owns(agent)) return false;
    const status = await ctx.rental.status({ probe: false }).catch(() => null);
    if (!status?.rented || status.status !== "EXITED") return false;
    try {
      await ctx.rental.start();
      return true;
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }

  // What the rented machine's agent holds, for an image model's plan: the
  // files on its disk and whether it answers.
  // A used figure larger than the disk is a miscount (a machine on image
  // 21 counted its folders twice); the models' sizes stand in for it.
  function plausibleUsed(used, diskGb) {
    return used == null || (diskGb && used > diskGb * 1.05) ? null : used;
  }
  async function withGpu(detected, agent, ctx) {
    let files = [];
    const folders = {};
    let addons = [];
    let running = false;
    let health = null;
    let tasks = [];
    let usedGb = null;
    try {
      let models;
      [models, addons, health, tasks] = await Promise.all([agentModelList(agent, fetchImpl), agentAddons(agent, fetchImpl), agentHealth(agent, fetchImpl, { diskGb: ctx.rental?.owns(agent) ? ctx.rental.cached()?.diskGb ?? null : null }), agentTasks(agent, fetchImpl)]);
      files = models.map((m) => `${m.repo}/${m.file}`);
      // What the models on it weigh, for a disk whose free space the machine
      // cannot read (a quota on a larger pool): an older agent says nothing of it.
      usedGb = models.reduce((t, m) => t + (Number(m.gb) || 0), 0);
      // A diffusers folder's own files, where the agent lists them: the plan
      // tells a whole model from a download that stopped partway.
      for (const m of models) if (Array.isArray(m.files)) folders[m.repo] = m.files;
      running = true;
    } catch {
      // not up yet, or stopped
    }
    return { ...detected, gpu: { url: agent, running, files, folders, addons, tasks, version: Number(health?.version) || (running ? 1 : null), diskFreeGb: health?.diskFreeGb ?? null, diskTotalGb: health?.diskTotalGb ?? null, diskUsedGb: plausibleUsed(health?.diskUsedGb, ctx.rental?.owns(agent) ? ctx.rental.cached()?.diskGb : null) ?? usedGb, rented: ctx.rental?.owns(agent) ? ctx.rental.cached() : null } };
  }

  // When the chat server is the rented machine, the plan can say whether it
  // is starting or stopped rather than "check the tunnel".
  function withRental(detected, ctx) {
    if (!rentedChat(ctx)) return detected;
    return { ...detected, ollama: { ...detected.ollama, rented: ctx.rental.cached() } };
  }

  // Asks the chat server to load a model into memory and keep it there, so
  // the first message after a download answers at once. Best effort.
  async function warm(name, remote) {
    try {
      await fetchImpl(`${ollamaUrl(remote)}/api/generate`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: name, keep_alive: "1h" }), signal: AbortSignal.timeout(90000) });
    } catch {
      // the model loads on the first message instead
    }
  }

  // The remote image server from settings, with what it has loaded, or null.
  async function remoteImageServer() {
    const url = env().IMAGE_SERVER;
    if (!url) return null;
    try {
      return { url, ...(await describeImageServer(url, fetchImpl)) };
    } catch {
      return { url, model: null };
    }
  }

  // Asks the outside sources for a topic, in parallel, and tags each result
  // with the scanned models it names. Unconfigured sources say so.
  async function askSources(q, known, which) {
    const tag = (text) => matchKnown(text, known);
    const jobs = {
      civitai: () => civitai.search(q),
      reddit: () => reddit().search(q),
      github: () => github().search(q),
      hn: () => hn.search(q),
      lemmy: () => lemmy.search(q),
      youtube: () => youtube().search(q),
    };
    const configured = { civitai: true, reddit: reddit().configured(), github: true, hn: true, lemmy: true, youtube: youtube().configured() };
    const names = Object.keys(jobs).filter((k) => which[k]);
    const settled = await Promise.allSettled(names.map((k) => (configured[k] ? jobs[k]() : Promise.reject(new Error("not configured")))));
    const out = {};
    names.forEach((k, i) => {
      const r = settled[i];
      out[k] = r.status === "fulfilled" ? r.value.map((item) => ({ ...item, matched: tag(`${item.title ?? item.name ?? ""} ${item.excerpt ?? item.description ?? ""}`) })) : [];
      out[`${k}Error`] = r.status === "rejected" ? (configured[k] ? r.reason.message : "") : null;
      out[`${k}Configured`] = configured[k];
    });
    return out;
  }

  // The same sources asked about one model by name, plus the prompts people
  // post on Civitai under its best-matching page.
  async function askSourcesForModel(id, wantImages) {
    const out = { civitai: [], civitaiError: null, civitaiPrompts: [], reddit: [], redditError: null, github: [], githubError: null, hn: [], hnError: null, lemmy: [], lemmyError: null, youtube: [], youtubeError: null };
    const jobs = [
      ["civitai", wantImages ? civitai.forModel(id) : Promise.resolve([])],
      ["reddit", reddit().configured() ? reddit().forModel(id) : Promise.resolve([])],
      ["github", github().forModel(id)],
      ["hn", hn.forModel(id)],
      ["lemmy", lemmy.forModel(id)],
      ["youtube", youtube().configured() ? youtube().forModel(id) : Promise.resolve([])],
    ];
    const settled = await Promise.allSettled(jobs.map(([, p]) => p));
    jobs.forEach(([k], i) => {
      if (settled[i].status === "fulfilled") out[k] = settled[i].value;
      else out[`${k}Error`] = settled[i].reason.message;
    });
    const top = out.civitai[0];
    if (top?.versionIds?.length) {
      try {
        out.civitaiPrompts = await civitai.images(top.versionIds[0]);
      } catch (err) {
        out.civitaiError = err.message;
      }
    }
    return out;
  }

  function voicesMeta() {
    const index = readVoices(voicesFile);
    const ids = Object.keys(index);
    const latest = ids.map((id) => index[id].at).sort().pop() ?? null;
    return { count: ids.length, at: latest };
  }

  // The one line of what people say, for a listing card.
  function withVoice(m) {
    const entry = readVoicesCached()[m.id];
    const summary = cleanSummary(entry?.summary ?? null, kindOf(m));
    // The Hub's one-line description keeps its own field; `summary` is what people say.
    const blurb = typeof m.summary === "string" ? m.summary : (m.blurb ?? "");
    return { ...m, blurb, voice: entry ? headline(entry) : null, talked: entry ? entry.discussions.length : null, summary, refusals: entry ? refusalSignals({ ...entry, name: m.name, id: m.id }, summary) : null };
  }

  // Summaries for a list of gathered models: extractive lines for all of
  // them at once, then, when a chat model is installed, written ones in
  // scan order until done or stopped.
  async function summarizeAll(ids, index, emit, cancelled) {
    let extracted = 0;
    for (const id of ids) {
      const entry = index[id];
      if (!entry) continue;
      if (!entry.summary || entry.summary.at < entry.at) {
        entry.summary = { ...extractiveSummary({ ...entry, name: id.split("/").pop() }, isFresh(entry.web) ? entry.web.data : null), at: new Date().toISOString() };
        extracted++;
      } else if (!entry.summary.settings) {
        // A summary from before settings advice was read: add it, keep the lines.
        entry.summary.settings = settingsAdvice(collectVoices(entry, isFresh(entry.web) ? entry.web.data : null));
      }
    }
    writeVoices(index, voicesFile);
    emit(`Summary lines lifted from the text for ${extracted} model${extracted === 1 ? "" : "s"}.`);
    const model = writtenSummaries ? await summarizerModel(fetchImpl) : null;
    if (!model) {
      emit("No chat model is installed in Ollama, so the lines are lifted from the comments rather than written. Set up a chat model and gather again for written summaries.");
      return;
    }
    const todo = ids.filter((id) => index[id] && index[id].summary?.by !== model);
    emit(`Writing summaries with ${model} for ${todo.length} model${todo.length === 1 ? "" : "s"}; stop any time, what is done stays.`);
    let done = 0;
    for (const id of todo) {
      if (cancelled()) break;
      const entry = index[id];
      entry.summary = await summarize({ ...entry, name: id.split("/").pop() }, isFresh(entry.web) ? entry.web.data : null, { model, fetchImpl });
      done++;
      if (done % 5 === 0) {
        writeVoices(index, voicesFile);
        emit(`${done} of ${todo.length} written`);
      }
    }
    writeVoices(index, voicesFile);
    emit(`${done} summaries written by ${model}.`);
  }

  // What kind of model an id is (text, images, video, speech...), from the
  // scan or the curated picks; null when neither knows it.
  function kindFor(id) {
    const m = (readScan(scanFile)?.models ?? []).find((x) => x.id === id) ?? PICKS.find((x) => x.id === id);
    return m ? kindOf(m) : null;
  }

  function readVoicesCached() {
    let mtime = 0;
    try {
      mtime = fs.statSync(voicesFile).mtimeMs;
    } catch {
      return {};
    }
    const cached = VOICES_CACHE.get(voicesFile);
    if (!cached || cached.mtime !== mtime) {
      const index = readVoices(voicesFile);
      // Summaries written before settings advice was read get it here, in
      // memory, so cards show it before the next gathering writes it down.
      for (const entry of Object.values(index)) if (entry.summary && !entry.summary.settings) entry.summary.settings = settingsAdvice(collectVoices(entry, isFresh(entry.web) ? entry.web.data : null));
      VOICES_CACHE.set(voicesFile, { mtime, index });
    }
    return VOICES_CACHE.get(voicesFile).index;
  }

  // A rough speed line for a listing card, from the size guessed off the name.
  function withSpeed(m, ctx = null) {
    const quality = qualityScore(m);
    if (!m.runner?.easy) return { ...m, speed: "", quality };
    const sizeGb = guessSizeGb({ id: m.id, runnerId: m.runner.id });
    return { ...m, quality, ...(sizeGb ? speedOf({ runnerId: m.runner.id, sizeGb, fileName: m.name, machine: ctx ? machineFor(m.runner.id, ctx) : machine }) : { speed: "", speedWord: "" }) };
  }

  // whisper.cpp is happiest with 16 kHz wav. Other formats go through
  // ffmpeg when it is installed; otherwise whisper.cpp's own decoder gets
  // a go at the original file.
  async function ensureWav(file) {
    if (file.toLowerCase().endsWith(".wav") || !which("ffmpeg")) return file;
    const wav = `${file}.wav`;
    await new Promise((resolve, reject) => {
      execFile("ffmpeg", ["-y", "-i", file, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], (err) => (err ? reject(new Error("ffmpeg could not read this recording")) : resolve()));
    });
    return wav;
  }
}

// Whether a request's Origin names the host the page was served from.
function sameHost(origin, host) {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false;
  }
}

// The runner report for a computer that has nothing installed: what the
// hosted site shows, since it cannot see the visitor's machine.
function noRunners() {
  return { brew: false, winget: false, ffmpeg: false, ollama: { installed: false, running: false, models: [] }, whisper: { installed: false }, sd: { installed: false, server: false, loaded: null }, models: [] };
}

function readScan(file, { meta = false } = {}) {
  if (!fs.existsSync(file)) return null;
  try {
    const scan = JSON.parse(fs.readFileSync(file, "utf8"));
    return meta ? { at: scan.at, count: scan.models.length, newCount: scan.models.filter((m) => m.isNew).length } : scan;
  } catch {
    return null;
  }
}

function stream(res, run) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const write = (line) => res.write(`data: ${JSON.stringify(line === null ? { done: true, status: run.status, result: run.result ? path.basename(run.result) : null } : { line })}\n\n`);
  for (const line of run.lines) write(line);
  if (run.status !== "running") {
    write(null);
    return res.end();
  }
  const listener = (line) => {
    write(line);
    if (line === null) {
      run.listeners.delete(listener);
      res.end();
    }
  };
  run.listeners.add(listener);
  res.on("close", () => run.listeners.delete(listener));
}

// A card's speed: the sentence, and the one word shown in its place.
function speedOf(args) {
  const e = estimate(args);
  return { speed: e.text, speedWord: e.word ?? "" };
}

function serveFile(res, file, root) {
  if ((root && !file.startsWith(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": file.includes(`${path.sep}fonts${path.sep}`) ? "public, max-age=31536000, immutable" : "no-store" });
  fs.createReadStream(file).pipe(res);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function json(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > limit) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Bad JSON"));
      }
    });
    req.on("error", reject);
  });
}

function tildify(p) {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return home && p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
