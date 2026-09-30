import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./categorize.js";
import { mask, readEnv, writeEnv } from "./envfile.js";
import { createHub } from "./hf.js";
import { describeMachine } from "./machine.js";
import { PICKS } from "./picks.js";
import { buildPlan } from "./plans.js";
import { DATA_DIR, OLLAMA_URL, OUTPUT_DIR, UPLOAD_DIR, clearOutputs, describeImageServer, detect, getRun, readTimings, recordTiming, cancelRun, removeFile, removeFolder, removeOllamaModel, startCustomRun, startRun, stopImageServer, storage, which } from "./runners.js";
import { estimate, guessSizeGb, speedTier } from "./speed.js";
import { gatherVoices, headline, isFresh, readVoices, searchVoices, writeVoices } from "./voices.js";
import { createCivitai, createGithub, createHackerNews, createLemmy, createReddit, createYoutube, matchKnown } from "./sources.js";
import { extractiveSummary, summarize, summarizerModel } from "./summarize.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
// The gathered voices index per file, re-read only when the file changes.
const VOICES_CACHE = new Map();
const RUNNER_NAMES = { ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" };
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8" };

export function createServer({ envFile, hubBase, fetchImpl = fetch, scanFile = path.join(DATA_DIR, "scan.json"), voicesFile = path.join(DATA_DIR, "voices.json"), civitaiBase, redditAuthBase, redditApiBase, githubBase, hnBase, lemmyBase, youtubeBase, writtenSummaries = true } = {}) {
  const machine = describeMachine();
  const env = () => readEnv(envFile);
  const hub = () => createHub({ fetchImpl, base: hubBase, token: env().HF_TOKEN });
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

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) {
        const origin = req.headers.origin;
        if (origin && !origin.startsWith("http://localhost") && !origin.startsWith("http://127.0.0.1")) {
          return send(res, 403, { error: "Forbidden" });
        }
        return await api(req, res, url);
      }
      if (url.pathname.startsWith("/output/")) return serveFile(res, path.join(OUTPUT_DIR, path.basename(url.pathname)));
      return serveFile(res, path.join(PUBLIC, url.pathname === "/" ? "index.html" : url.pathname), PUBLIC);
    } catch (err) {
      send(res, 500, { error: err.message });
    }
  });

  async function api(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/state") {
      const saved = env();
      return send(res, 200, {
        machine,
        categories: CATEGORIES,
        runners: await detect(fetchImpl),
        token: saved.HF_TOKEN ? mask(saved.HF_TOKEN) : "",
        imageServer: saved.IMAGE_SERVER || "",
        redditApp: saved.REDDIT_CLIENT_ID ? mask(saved.REDDIT_CLIENT_ID) : "",
        githubToken: saved.GITHUB_TOKEN ? mask(saved.GITHUB_TOKEN) : "",
        youtubeKey: saved.YOUTUBE_API_KEY ? mask(saved.YOUTUBE_API_KEY) : "",
        envFile: tildify(envFile),
        scan: readScan(scanFile, { meta: true }),
        voices: voicesMeta(),
        picks: PICKS.map((p) => ({ ...p, speed: estimate({ runnerId: p.runner, sizeGb: p.gb, fileName: p.file, machine }).text })),
        speedTier: speedTier(machine),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/settings") {
      const body = await json(req);
      const updates = {};
      if ("HF_TOKEN" in body) {
        if (typeof body.HF_TOKEN !== "string") return send(res, 400, { error: "HF_TOKEN must be a string" });
        updates.HF_TOKEN = body.HF_TOKEN.trim();
      }
      for (const [key, pattern, what] of [["GITHUB_TOKEN", /^[\w-]{20,255}$/, "a GitHub token"], ["YOUTUBE_API_KEY", /^[\w-]{20,80}$/, "a YouTube API key"]]) {
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
      if ("IMAGE_SERVER" in body) {
        if (typeof body.IMAGE_SERVER !== "string") return send(res, 400, { error: "IMAGE_SERVER must be a string" });
        const value = body.IMAGE_SERVER.trim().replace(/\/+$/, "");
        if (value && !/^https?:\/\/[\w.\-:[\]]+(\/[\w./-]*)?$/.test(value)) return send(res, 400, { error: "IMAGE_SERVER must be an http or https address" });
        updates.IMAGE_SERVER = value;
      }
      if (!Object.keys(updates).length) return send(res, 400, { error: "Nothing to save" });
      writeEnv(envFile, updates);
      // A new token can change what the Hub is willing to show.
      details.clear();
      return send(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/scan") {
      const previous = readScan(scanFile);
      const known = new Set((previous?.models ?? []).map((m) => m.id));
      const models = await hub().scan();
      const scan = { at: new Date().toISOString(), models: models.map((m) => ({ ...withSpeed(m), isNew: previous ? !known.has(m.id) : false })) };
      fs.mkdirSync(path.dirname(scanFile), { recursive: true });
      fs.writeFileSync(scanFile, JSON.stringify(scan));
      return send(res, 200, scan);
    }
    if (req.method === "GET" && url.pathname === "/api/search") {
      const q = url.searchParams.get("q") ?? "";
      if (!q.trim()) return send(res, 400, { error: "Say what you are looking for" });
      const models = await hub().search(q);
      return send(res, 200, { q, models: models.map(withSpeed).map(withVoice) });
    }
    if (req.method === "GET" && url.pathname === "/api/models") {
      const scan = readScan(scanFile) ?? { at: null, models: [] };
      return send(res, 200, { ...scan, models: scan.models.map(withVoice) });
    }
    // Gathers what people say about every model in the scan (and any
    // search results the page asks for), a card and a discussion list each.
    if (req.method === "POST" && url.pathname === "/api/voices/gather") {
      const body = await json(req);
      const scan = readScan(scanFile) ?? { models: [] };
      const ids = [...new Set([...scan.models.map((m) => m.id), ...(Array.isArray(body.ids) ? body.ids.filter((id) => /^[\w.-]+\/[\w.-]+$/.test(String(id))) : [])])];
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
      return send(res, 200, { id: run.id, todo: todo.length, total: ids.length });
    }
    if (req.method === "POST" && url.pathname.startsWith("/api/runs/") && url.pathname.endsWith("/cancel")) {
      const id = url.pathname.slice("/api/runs/".length, -"/cancel".length);
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
      return send(res, 200, { q, hits: searchVoices(index, q).slice(0, 100), took: Date.now() - started, ...asked });
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
      return send(res, 200, { id, card: entry.card, gatheredAt: entry.at, discussions, summary });
    }
    if (req.method === "GET" && url.pathname === "/api/model") {
      const id = url.searchParams.get("id") ?? "";
      if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return send(res, 400, { error: "Bad model id" });
      // Gated refusals are not cached: a token added later should get a fresh answer.
      const model = details.get(id) ?? (await hub().model(id));
      if (!model.gatedBlocked) details.set(id, model);
      // Curated picks name their runner and file outright, so a repository
      // the tag rules cannot place still gets a plan.
      const pick = PICKS.find((p) => p.id === id);
      if (pick && !model.gatedBlocked) model.runner = { id: pick.runner, name: RUNNER_NAMES[pick.runner], easy: true };
      const plan = model.gatedBlocked
        ? { runnable: false, gated: true, reason: "This model is gated and the request was refused. Accept the licence on Hugging Face and add a token in Settings.", steps: [], link: `https://huggingface.co/${id}` }
        : buildPlan({ model, files: model.files, machine, detected: await detect(fetchImpl), hasToken: Boolean(env().HF_TOKEN), preferredFile: pick?.file, timings: readTimings(), imageServer: await remoteImageServer() });
      return send(res, 200, { model, plan });
    }
    if (req.method === "GET" && url.pathname === "/api/storage") {
      return send(res, 200, await storage(fetchImpl));
    }
    if (req.method === "POST" && url.pathname === "/api/remove") {
      const body = await json(req);
      try {
        if (body.kind === "file") removeFile(body.repo, body.file);
        else if (body.kind === "folder") removeFolder(body.repo);
        else if (body.kind === "ollama") await removeOllamaModel(body.name, fetchImpl);
        else if (body.kind === "outputs") clearOutputs();
        else return send(res, 400, { error: "kind must be file, folder, ollama or outputs" });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
      return send(res, 200, await storage(fetchImpl));
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
      try {
        const args = { ...(body.args ?? {}) };
        // The remote address comes from settings, never from the page.
        if (body.kind === "generate-image") {
          const remote = env().IMAGE_SERVER;
          if (remote) args.remote = remote;
          else delete args.remote;
        }
        const run = startRun(String(body.kind ?? ""), args, machine, { token: env().HF_TOKEN, fetchImpl, hubBase });
        return send(res, 200, { id: run.id });
      } catch (err) {
        return send(res, 400, { error: err.message });
      }
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/runs/")) {
      const run = getRun(url.pathname.slice("/api/runs/".length));
      if (!run) return send(res, 404, { error: "No such run" });
      return stream(res, run);
    }
    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await json(req);
      const upstream = await fetchImpl(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: String(body.model ?? ""), messages: Array.isArray(body.messages) ? body.messages.slice(-40) : [], stream: true }),
      });
      res.writeHead(upstream.ok ? 200 : upstream.status, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      const reader = upstream.body.getReader();
      let tail = "";
      for (;;) {
        const { value, done } = await reader.read();
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
    return { ...m, voice: entry ? headline(entry) : null, talked: entry ? entry.discussions.length : null, summary: entry?.summary ?? null };
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
        entry.summary = { ...extractiveSummary({ ...entry, name: id.split("/").pop() }), at: new Date().toISOString() };
        extracted++;
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

  function readVoicesCached() {
    let mtime = 0;
    try {
      mtime = fs.statSync(voicesFile).mtimeMs;
    } catch {
      return {};
    }
    const cached = VOICES_CACHE.get(voicesFile);
    if (!cached || cached.mtime !== mtime) VOICES_CACHE.set(voicesFile, { mtime, index: readVoices(voicesFile) });
    return VOICES_CACHE.get(voicesFile).index;
  }

  // A rough speed line for a listing card, from the size guessed off the name.
  function withSpeed(m) {
    if (!m.runner?.easy) return { ...m, speed: "" };
    const sizeGb = guessSizeGb({ id: m.id, runnerId: m.runner.id });
    return { ...m, speed: sizeGb ? estimate({ runnerId: m.runner.id, sizeGb, fileName: m.name, machine }).text : "" };
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

function serveFile(res, file, root) {
  if ((root && !file.startsWith(root)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function json(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) reject(new Error("Body too large"));
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
