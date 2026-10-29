const $ = (sel) => document.querySelector(sel);

const state = {
  hidden: new Set(),
  showHidden: false,
  machine: null,
  categories: [],
  runners: null,
  picks: [],
  models: [],
  scanAt: null,
  tab: "easy",
  open: null,
  found: null,
};

const api = {
  get: (p) => fetch(p).then(check),
  post: (p, body) => fetch(p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then(check),
};

async function check(res) {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `HTTP ${res.status}`);
    err.body = body;
    throw err;
  }
  return body;
}

// ---- boot --------------------------------------------------------------------

async function load() {
  const s = await api.get("/api/state");
  Object.assign(state, { machine: s.machine, categories: s.categories, runners: s.runners, picks: s.picks, hosted: Boolean(s.hosted), refresh: s.refresh, user: s.user, auth: s.auth, access: s.access });
  document.body.dataset.hosted = s.hosted ? "1" : "";
  state.claudeHosted = s.claudeHosted;
  // A visitor the hosted site does not know is shown no video models: the example goes too.
  const videoExample = document.querySelector('#examples [data-example="video generation"]');
  if (videoExample) videoExample.hidden = !fullAccess();
  if (s.hosted) renderHostedCopy();
  if (s.hosted && !state.openChecker) setupChecker();
  renderAccount();
  renderDiskLine();
  if (s.hosted) {
    $("#env-note").textContent = s.user?.guest ? "Kept with your guest keys on this site, until they expire." : "Kept with your account on this site.";
    $("#runpod-key").nextElementSibling.textContent = "Make an account at runpod.io and add some credit, then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. It is kept encrypted with your keys here and sent only to RunPod.";
    $("#vast-key").nextElementSibling.textContent = "A second place to rent from: Vast.ai's GPUs are listed with RunPod's below, marked Vast.ai, and are often in stock when RunPod's are not. Make an account at vast.ai and add some credit, then on the Keys page (Account, Keys) create an API key; it has to rent and stop machines. It is kept encrypted with your keys here and sent only to Vast.ai.";
  } else {
    $("#env-path").textContent = s.envFile;
  }
  $("#token-current").textContent = s.token ? `A token is saved (${s.token}).` : "No token saved. Open models work without one.";
  state.imageServer = s.imageServer;
  $("#reddit-status").textContent = s.redditApp ? `An app id is saved (${s.redditApp}); Reddit is searched with it.` : "No app id saved; Reddit is skipped.";
  $("#github-status").textContent = s.githubToken ? `A token is saved (${s.githubToken}); thirty GitHub searches a minute.` : "No token; ten GitHub searches a minute.";
  $("#youtube-status").textContent = s.youtubeKey ? `A key is saved (${s.youtubeKey}); YouTube is searched with it.` : "No key; YouTube is skipped.";
  $("#claude-status").textContent = s.claudeKey ? `A key is saved (${s.claudeKey}); answers and pictures can be checked by Claude.` : s.claudeReady ? "A key from the environment is in use." : "No key; the Claude check is off.";
  state.claudeReady = Boolean(s.claudeReady);
  state.voices = s.voices;
  state.summarizer = s.summarizer;
  renderVoicesStatus();
  $("#image-server").value = s.imageServer;
  renderImageServerStatus();
  state.chatServer = s.chatServer;
  state.siteOrigin = s.siteOrigin || "";
  $("#chat-server").value = s.chatServer?.url ?? "";
  $("#chat-server-gb").value = s.chatServer?.gpuGb ?? "";
  renderChatServerStatus();
  // Models hidden by this person: the saved list plus this browser's own.
  state.hidden = new Set([...(s.hidden ?? []), ...localHidden()]);
  renderHiddenList();
  state.rental = s.rental;
  state.rentTiers = s.rentTiers ?? [];
  state.idleMinutes = s.idleMinutes ?? 30;
  state.idleSet = Boolean(s.idleSet);
  state.maxSpend = s.maxSpend ?? 50;
  state.presenceMinutes = s.presenceMinutes ?? 30;
  if (state.runpodKey !== s.runpodKey || state.vastKey !== (s.vastKey || "")) state.others = null;
  state.runpodKey = s.runpodKey;
  state.vastKey = s.vastKey || "";
  state.civitaiToken = s.civitaiToken || "";
  $("#civitai-status").textContent = s.civitaiToken ? `A key is saved (${s.civitaiToken}).` : "No key saved; LoRAs come from Hugging Face only.";
  $("#vast-status").textContent = s.vastKey ? `A key is saved (${s.vastKey}).` : s.rental?.rented && s.rental.provider === "vast" ? "No key saved, but a Vast.ai machine is still rented: enter the key of the account that rented it to stop or delete it." : "No key saved; only RunPod is used.";
  state.registryAuth = s.registryAuth || "";
  if (state.others == null) loadOthersState();
  state.stopOnQuit = s.stopOnQuit;
  $("#runpod-status").textContent = s.runpodKey ? `A key is saved (${s.runpodKey}).` : s.rental?.rented ? "No key saved, but a machine is still rented: enter the key of the account that rented it to stop or delete it." : state.hosted ? "No key saved; renting is off." : "No key saved; renting is off. The chat server above can still be set by hand.";
  state.runpodKey = s.runpodKey || "";
  renderRental();
  if ((s.runpodKey || s.vastKey) && !state.rentOptions) loadRentOptions();
  renderRunners();
  if (s.scan?.at) {
    const saved = await api.get("/api/models");
    state.models = saved.models;
    state.scanAt = saved.at;
  }
  renderScanStatus();
  renderTabs();
  render();
  renderHomeHint();
}

// The words that change when the site is a public copy rather than the app
// on this computer: nothing runs here, so the page points at the app.
function renderHostedCopy() {
  $("#browse .intro .lead").hidden = true;
  $("#only-runnable-text").textContent = "Only models that run with Ollama, whisper.cpp or stable-diffusion.cpp";
  $(".speed-note").textContent = "Speed lines are guesses for a laptop without a GPU; a GPU or Apple Silicon is several times faster.";
}

function renderScanStatus() {
  const el = $("#scan-status");
  if (state.hosted) {
    el.textContent = state.scanAt ? `Scanned ${relative(state.scanAt)}: ${state.models.length} models, refreshed every ${state.refresh?.hours ?? 12} hours.` : "The first scan is running; check back in a few minutes.";
    return;
  }
  if (!state.scanAt) {
    el.textContent = "No scan yet. The curated picks below work without one.";
    return;
  }
  const fresh = state.models.filter((m) => m.isNew).length;
  el.textContent = `Last scan ${relative(state.scanAt)}: ${state.models.length} models` + (fresh ? `, ${fresh} new since the scan before.` : ".");
}

function relative(iso) {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

// ---- scan ----------------------------------------------------------------

$("#scan").addEventListener("click", async () => {
  const btn = $("#scan");
  btn.disabled = true;
  btn.textContent = "Scanning";
  notice("");
  try {
    const scan = await api.post("/api/scan", {});
    state.models = scan.models;
    state.scanAt = scan.at;
    const fresh = scan.models.filter((m) => m.isNew).length;
    if (fresh) $("#only-new").checked = true;
    renderScanStatus();
    renderTabs();
    render();
  } catch (err) {
    notice(`The scan did not finish: ${err.message}. Check the connection and try again.`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan Hugging Face";
  }
});

function notice(text, kind = "info", action = null) {
  const el = $("#notice");
  el.hidden = !text;
  el.textContent = text;
  el.className = `notice ${kind}`;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "primary";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      el.hidden = true;
      action.run();
    });
    el.append(" ", btn);
  }
}

// Work on the rented GPU goes on without the window: a step's download runs
// on the machine, a picture is made there and kept until it is looked at.
// The window says so once, with the way out.
function backgroundNote(into, model, what) {
  if (!into || into.querySelector(".bg-note")) return;
  const note = document.createElement("div");
  note.className = "notice info bg-note";
  note.innerHTML = `<span>${esc(what)} on the rented GPU and keeps going if you leave this window. Look for other models meanwhile; the bar's Downloads button shows the progress${what.startsWith("The picture") || what.startsWith("The clip") ? ", and a note here tells you when it is ready" : ""}.</span> <span class="tools-row"><button class="ghost" id="bg-browse">Keep browsing</button><button class="ghost" id="bg-stay">Stay here</button></span>`;
  into.appendChild(note);
  note.querySelector("#bg-browse").addEventListener("click", () => {
    $("#modal").hidden = true;
    state.open = null;
    notice(`${model.id.split("/").pop()} is still going on the rented GPU. The bar's Downloads button shows its progress; open the model any time to see it.`, "ok");
  });
  note.querySelector("#bg-stay").addEventListener("click", () => note.remove());
}

// A picture or clip finished while its window was closed: a note offers to
// open the model, where it waits under Kept here.
function pictureReady(modelId, kind = "image") {
  notice(`Your ${kind === "video" ? "clip" : "picture"} from ${modelId.split("/").pop()} is ready and kept in this browser.`, "ok", { label: "Open it", run: () => openModel(modelId) });
}

// ---- lists ----------------------------------------------------------------

function renderTabs() {
  const tabs = $("#tabs");
  tabs.innerHTML = "";
  for (const c of state.categories) {
    if (c.browse === false) continue;
    const count = state.models.filter((m) => m.categories.includes(c.id)).length + state.picks.filter((p) => p.categories.includes(c.id)).length;
    const b = document.createElement("button");
    b.className = "tab" + (c.id === state.tab ? " on" : "");
    b.dataset.tab = c.id;
    b.innerHTML = `${esc(c.name)}<span class="count">${count}</span>`;
    b.addEventListener("click", () => {
      state.tab = c.id;
      renderTabs();
      render();
    });
    tabs.appendChild(b);
    // The same tab in the band's category line: lit when it is the one on show, with its count.
    const chip = document.querySelector(`#home-categories [data-cat="${c.id}"]`);
    if (chip) {
      chip.classList.toggle("on", c.id === state.tab);
      let n = chip.querySelector(".count");
      if (!n) chip.append((n = Object.assign(document.createElement("span"), { className: "count" })));
      n.textContent = count;
    }
  }
}

for (const id of ["#only-runnable", "#only-new", "#search", "#sort", "#since"]) $(id).addEventListener("input", render);

// The search: a plain description of what is wanted. The server ranks
// models by name, category and what people say, and asks the outside
// sources at the same time.
$("#trait-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#trait").value.trim();
  const btn = $("#trait-go");
  if (!q) {
    state.found = null;
    notice("");
    setMode(state.mode === "browse" ? "browse" : "home");
    render();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Searching";
  try {
    const result = await api.get(`/api/find?q=${encodeURIComponent(q)}${state.showRefusing ? "&showRefusing=1" : ""}`);
    state.found = { q, models: result.models, kind: result.kind ?? null, web: result, hubError: result.hubError, gathered: result.gathered, scanned: result.scanned, took: result.took, hiddenRefusing: result.hiddenRefusing, hideRefusing: result.hideRefusing };
    notice(result.hubError ? `Hugging Face did not answer (${result.hubError}); showing what is known locally.` : "", "warn");
    if (state.mode !== "browse") setMode("results");
  } catch (err) {
    notice(`The search did not finish: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
    render();
  }
});

for (const chip of document.querySelectorAll("#examples [data-example]")) {
  chip.addEventListener("click", () => {
    $("#trait").value = chip.dataset.example;
    $("#trait-form").requestSubmit();
  });
}

// Three views: the search page, its results, and everything else.
function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  $("#browse").hidden = mode !== "browse";
  $("#results").hidden = !(state.found && (mode === "results" || mode === "browse"));
  $("#nav-browse").classList.toggle("on", mode === "browse");
  renderTabs();
}
$("#found-sort").addEventListener("change", render);
$("#nav-browse").addEventListener("click", () => {
  setMode("browse");
  render();
});
$("#browse-all").addEventListener("click", () => $("#nav-browse").click());

// The categories as chips under the search box, for someone who does not
// know what to type: each opens Browse on that tab.
function renderHomeCategories() {
  const box = $("#home-categories");
  if (!box || box.childElementCount) return;
  const cats = (state.categories ?? []).filter((c) => c.browse !== false);
  box.innerHTML = cats.map((c) => `<button class="chip" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join("");
  for (const chip of box.querySelectorAll("[data-cat]")) {
    chip.addEventListener("click", () => {
      setMode("browse");
      render();
      document.querySelector(`.tab[data-tab="${chip.dataset.cat}"]`)?.click();
    });
  }
}

function renderHomeHint() {
  renderHomeCategories();
  const v = state.voices;
  const parts = [];
  if (!state.scanAt && !state.hosted) parts.push("No scan yet: results come from Hugging Face's search and the picks below.");
  if (!v?.count && !state.hosted) parts.push("Gather what people say, in Browse, to rank by reviews.");
  $("#home-hint").textContent = parts.join(" ");
  $("#home-hint").hidden = !parts.length;
}

// The picture in the hero: three searches played through in turn, for code,
// for pictures and for a clip. Someone who asks for less motion sees the
// first one finished and nothing moves.
// Each scene: the search, three free models (one too big for a laptop, with
// the GPU rental as the way to run it), the one picked, what runs, what came out.
const DEMO_SCENES = [
  {
    q: "fix the failing tests in my python project",
    results: [["Qwen2.5-Coder-7B-Instruct", "ok", "Runs on your laptop", "4.7 GB"], ["Qwen3-Coder-30B-A3B", "big", "Too big for a laptop. Rent a GPU here, $0.20 an hour", "18 GB"], ["DeepSeek-Coder-V2-Lite", "ok", "Runs on your laptop", "8.9 GB"]],
    pick: 1,
    label: "Running on a rented GPU",
    out: '<code>test_export.py</code>: two failures found and patched; 14 tests pass.',
    check: "Free model, GPU by the hour. It stops itself when you are done.",
  },
  {
    q: (set) => `brighten these photos of ${set.of}`,
    results: [["Qwen-Image-Edit", "big", "Too big for a laptop. Rent a GPU here, $0.20 an hour", "20 GB"], ["FLUX.1-Kontext", "big", "Too big for a laptop. Rent a GPU here, $0.20 an hour", "23 GB"], ["SDXL-Lightning", "ok", "Runs on your laptop, four steps", "6.9 GB"]],
    pick: 0,
    label: "Editing the photos on a rented GPU",
    out: (set) => `${tilesHtml(set)}Four photos done in 20 seconds, for under a cent.`,
    check: "Nothing to install, nothing to pay for the model.",
  },
  {
    q: (set) => `a ten second clip of ${set.of}`,
    results: [["Wan2.2-TI2V-5B", "big", "Too big for a laptop. Rent a GPU here, $0.20 an hour", "20 GB"], ["LTX-2", "big", "Too big for a laptop. Rent a GPU here; with sound", "40 GB"], ["MiniMax-H3", "big", "Too big for a laptop. Rent a GPU here; long scenes in shots", "60 GB"]],
    pick: 0,
    label: "Rendering shot 2 of 3 on a rented GPU",
    out: (set) => `${tilesHtml(set)}Three shots joined, with sound.`,
    check: "The GPU stops itself when you are done.",
  },
];
// The photos the demo shows being edited or filmed: six sets of four, public
// domain, in public/demo (CREDITS.txt names the makers), taken in turn.
const DEMO_SETS = [
  { name: "birds", of: "robins in the garden" },
  { name: "coast", of: "the coast at sunset" },
  { name: "dogs", of: "the dogs at play" },
  { name: "forest", of: "the forest walk" },
  { name: "lake", of: "the mountain lake" },
  { name: "winter", of: "the first snow" },
];
const tilesHtml = (set) => `<span class="demo-tiles">${[1, 2, 3, 4].map((n) => `<img src="demo/${set.name}-${n}.jpg" alt="" width="256" height="256" loading="eager" decoding="async">`).join("")}</span>`;
function startDemo() {
  const demo = $("#demo");
  if (!demo) return;
  const typed = demo.querySelector(".demo-typed");
  const pct = demo.querySelector(".demo-pct");
  const fill = demo.querySelector(".demo-track i");
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const timers = [];
  const at = (ms, fn) => timers.push(setTimeout(fn, ms));
  let setN = 0;
  const show = (scene) => {
    const set = DEMO_SETS[setN % DEMO_SETS.length];
    if (typeof scene.q === "function") setN += 1;
    demo.querySelector(".demo-results").innerHTML = scene.results.map(([name, where, says, size], i) => `<li class="${i === scene.pick ? "pick" : ""}"><span class="demo-name">${esc(name)}</span><span class="demo-where ${where}">${esc(says)}</span><span class="demo-size">${esc(size)}</span></li>`).join("");
    demo.querySelector(".demo-label").textContent = scene.label;
    demo.querySelector(".demo-out").innerHTML = typeof scene.out === "function" ? scene.out(set) : scene.out;
    demo.querySelector(".demo-check-text").textContent = scene.check;
    return typeof scene.q === "function" ? scene.q(set) : scene.q;
  };
  if (still) {
    typed.textContent = show(DEMO_SCENES[0]);
    demo.classList.add("typed", "found", "picked", "running", "done", "checked");
    fill.style.width = "100%";
    pct.textContent = "100%";
    return;
  }
  let n = 0;
  const cycle = () => {
    for (const t of timers.splice(0)) clearTimeout(t);
    const scene = DEMO_SCENES[n % DEMO_SCENES.length];
    n += 1;
    demo.className = "demo";
    typed.textContent = "";
    fill.style.width = "0%";
    pct.textContent = "0%";
    const words = show(scene);
    // Typed a letter at a time, found, downloaded, run, checked.
    for (let i = 1; i <= words.length; i++) at(300 + i * 45, () => { typed.textContent = words.slice(0, i); });
    const typedAt = 300 + words.length * 45 + 250;
    at(typedAt, () => demo.classList.add("typed"));
    at(typedAt + 500, () => demo.classList.add("found"));
    // The person picks the big one; the GPU rental is what makes that possible.
    at(typedAt + 1700, () => demo.classList.add("picked"));
    at(typedAt + 2500, () => {
      demo.classList.add("running");
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 3200);
        const eased = 1 - Math.pow(1 - k, 2);
        fill.style.width = `${(eased * 100).toFixed(1)}%`;
        pct.textContent = `${Math.round(eased * 100)}%`;
        if (k < 1 && demo.classList.contains("running")) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    at(typedAt + 5900, () => demo.classList.add("done"));
    at(typedAt + 7400, () => demo.classList.add("checked"));
    at(typedAt + 11600, () => demo.classList.add("fade"));
    at(typedAt + 12300, cycle);
  };
  cycle();
  // Nothing plays in a tab nobody is looking at; it starts over when they return.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { for (const t of timers.splice(0)) clearTimeout(t); demo.classList.add("fade"); }
    else cycle();
  });
}
startDemo();

function renderVoicesStatus() {
  const v = state.voices;
  $("#get-summarizer").hidden = Boolean(state.summarizer) || !state.runners?.ollama?.installed;
  const writer = state.summarizer ? `${state.summarizer} writes the lines.` : "Without a chat model in Ollama, the lines are lifted from the comments.";
  $("#voices-status").textContent = v?.count
    ? `Gathered for ${v.count} model${v.count === 1 ? "" : "s"} (last ${relative(v.at)}). ${writer}`
    : `Sums up each model's card and discussions in a line on its card. ${writer}`;
}

$("#gather-voices").addEventListener("click", async () => {
  const btn = $("#gather-voices");
  btn.disabled = true;
  btn.textContent = "Gathering";
  const log = $("#voices-log");
  log.hidden = false;
  log.textContent = "";
  try {
    const ids = (state.found?.models ?? []).map((m) => m.id);
    const { id } = await api.post("/api/voices/gather", { ids });
    const stop = $("#stop-voices");
    stop.hidden = false;
    stop.onclick = () => api.post(`/api/runs/${id}/cancel`, {}).catch(() => {});
    await follow(id, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    });
    await load();
    if (state.scanAt) {
      const saved = await api.get("/api/models");
      state.models = saved.models;
    }
    render();
  } catch (err) {
    notice(`Gathering stopped: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Gather what people say";
    $("#stop-voices").hidden = true;
  }
});

function sortModels(list) {
  const by = $("#sort").value;
  const days = Number($("#since").value);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  const kept = cutoff ? list.filter((m) => m.createdAt && new Date(m.createdAt).getTime() >= cutoff) : list.slice();
  if (by === "likes") kept.sort((a, b) => b.likes - a.likes);
  // Size and family first, then what people think, for the strongest models of a kind.
  else if (by === "capable") kept.sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0) || b.likes - a.likes);
  else if (by === "downloads") kept.sort((a, b) => b.downloads - a.downloads);
  else if (by === "newest") kept.sort((a, b) => new Date(b.createdAt ?? 0) - new Date(a.createdAt ?? 0));
  return kept;
}

function render() {
  const cat = state.categories.find((c) => c.id === state.tab);
  const q = $("#search").value.trim().toLowerCase();
  const onlyRunnable = $("#only-runnable").checked;
  const onlyNew = $("#only-new").checked;

  let blurb = document.querySelector(".tab-blurb");
  if (!blurb) {
    blurb = document.createElement("p");
    blurb.className = "tab-blurb";
    $("#tabs").after(blurb);
  }
  blurb.textContent = cat?.blurb ?? "";

  const shown = (m) => state.showHidden || !state.hidden.has(m.id);
  const keep = (m) => shown(m) && (!onlyRunnable || m.runner?.easy) && (!q || m.id.toLowerCase().includes(q) || (m.voice?.text ?? "").toLowerCase().includes(q));

  // Search results come in the server's order: models that make what was
  // asked for first, then relevance, then how capable each is likely to be.
  // The Order control can put capability or users' opinion first instead;
  // a model that makes the wrong kind of thing stays below the ones that fit.
  const foundSort = $("#found-sort").value;
  // When the search asks for a kind of output (video, say) that no runnable
  // model makes, the models that do make it are shown anyway, with what
  // they need, rather than an empty page.
  const fitting = (state.found?.models ?? []).filter((m) => m.fits && state.found.kind);
  const keepFitting = fitting.length > 0 && !fitting.some((m) => m.runner?.easy);
  const found = state.found ? state.found.models.filter((m) => shown(m) && (!onlyRunnable || m.runner?.easy || (keepFitting && m.fits))) : [];
  if (foundSort === "capable") found.sort((a, b) => Number(b.fits ?? true) - Number(a.fits ?? true) || (b.quality ?? 0) - (a.quality ?? 0) || b.score - a.score);
  else if (foundSort === "likes") found.sort((a, b) => Number(b.fits ?? true) - Number(a.fits ?? true) || (b.likes ?? 0) - (a.likes ?? 0) || b.score - a.score);
  const foundHidden = state.found ? state.found.models.filter((m) => state.hidden.has(m.id)).length : 0;
  const wants = state.found ? wantsFrom(state.found.q) : null;
  $("#found").innerHTML = found.map((m) => modelCard(m, wants)).join("");
  $("#results").hidden = !(state.found && (state.mode === "results" || state.mode === "browse"));
  if (state.found) {
    const f = state.found;
    $("#found-title").textContent = `${found.length} model${found.length === 1 ? "" : "s"} for "${f.q}"`;
    // Only what can be acted on: hidden models and the way to see them.
    const bits = [];
    if (f.hiddenRefusing) bits.push(`<a href="#" id="toggle-refusing">${f.hideRefusing ? `${f.hiddenRefusing} hidden: users report refusals` : "hide models users report as refusing"}</a>`);
    if (foundHidden) bits.push(`<a href="#" id="toggle-hidden">${state.showHidden ? `hide the ${foundHidden} you hid` : `${foundHidden} hidden by you`}</a>`);
    if (!f.gathered && !state.hosted) bits.push("gather what people say in Browse to rank by reviews");
    $("#found-hint").innerHTML = bits.join(" · ");
    $("#found-hint").hidden = !bits.length;
    $("#toggle-refusing")?.addEventListener("click", (e) => {
      e.preventDefault();
      state.showRefusing = !state.showRefusing;
      $("#trait-form").requestSubmit();
    });
    $("#toggle-hidden")?.addEventListener("click", (e) => {
      e.preventDefault();
      state.showHidden = !state.showHidden;
      render();
    });
    $("#found-empty").hidden = found.length > 0;
    $("#found-empty").textContent = f.models.length ? "Every match needs a Python setup; untick the runnable filter in Browse to see them." : `Nothing matches "${f.q}". Try other words, or Browse the categories.`;
  }
  renderWebFound(state.found?.web ?? null);
  renderHomeHint();

  const picks = onlyNew || Number($("#since").value) ? [] : state.picks.filter((p) => shown(p) && p.categories.includes(state.tab) && (!q || p.id.toLowerCase().includes(q)));
  $("#picks").innerHTML = picks.map(pickCard).join("");
  $("#picks-title").hidden = picks.length === 0;

  const models = sortModels(state.models.filter((m) => m.categories.includes(state.tab) && keep(m) && (!onlyNew || m.isNew)));
  $("#models").innerHTML = models.map((m) => modelCard(m)).join("");
  $("#scan-title").hidden = models.length === 0;
  // How many of this tab the person has hidden, with a way to see them.
  const tabHidden = [...state.models, ...state.picks].filter((m) => m.categories.includes(state.tab) && state.hidden.has(m.id)).length;
  if (tabHidden) {
    const link = document.createElement("a");
    link.href = "#";
    link.id = "toggle-hidden-browse";
    link.textContent = state.showHidden ? ` Hide the ${tabHidden} you hid again.` : ` ${tabHidden} hidden by you; show ${tabHidden === 1 ? "it" : "them"}.`;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      state.showHidden = !state.showHidden;
      render();
    });
    blurb.appendChild(link);
  }

  const empty = $("#empty");
  if (!picks.length && !models.length) {
    empty.hidden = false;
    empty.textContent = state.models.length ? "Nothing matches these filters." : "Run a scan to see what is trending on Hugging Face in this category.";
  } else {
    empty.hidden = true;
  }

  for (const card of document.querySelectorAll(".model")) {
    const open = (e) => {
      if (e.target.closest(".expanded") || e.target.closest("[data-more]")) return;
      openModel(card.dataset.id);
    };
    card.addEventListener("click", open);
    card.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && e.target === card) {
        e.preventDefault();
        openModel(card.dataset.id);
      }
    });
  }
  wireMore(document);
}

// Civitai models and Reddit posts from a "what people say" search.
function renderWebFound(web) {
  const box = $("#web-found");
  box.hidden = !web;
  if (!web) return;
  $("#civitai-note").textContent = web.civitaiError ? `Civitai did not answer: ${web.civitaiError}` : web.civitai.length ? "Image models on Civitai for these words. A chip opens the copy from the scan, or searches the Hub for the name." : "Nothing on Civitai for these words.";
  $("#civitai-found").innerHTML = web.civitai.map((m, i) => `<div class="civ">
    <div class="name"><a href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.name)}</a> <span class="pill">${esc(m.type)}</span>${m.nsfw ? ' <span class="pill adult">18+</span>' : ""}</div>
    <div class="stats">${fmt(m.thumbsUp)} thumbs up, ${fmt(m.thumbsDown)} down, ${fmt(m.comments)} comments, ${fmt(m.downloads)} downloads${m.creator ? `, by ${esc(m.creator)}` : ""}</div>
    ${m.description ? `<div class="desc">${esc(m.description)}</div>` : ""}
    <div class="chips">${m.matched.map((id) => `<button class="chip" data-open="${esc(id)}">${esc(id.split("/").pop())}</button>`).join("")}<button class="chip" data-hub="${esc(m.name)}">Search the Hub for it</button></div>
  </div>`).join("");
  const postList = (items, who) => items.map((p) => `<li>
    <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
    <div class="who">${esc(who(p))}${p.created ? `, ${relative(p.created)}` : p.published ? `, ${relative(p.published)}` : ""}</div>
    ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}
    ${p.matched?.length ? `<div class="chips">${p.matched.map((id) => `<button class="chip" data-open="${esc(id)}">${esc(id.split("/").pop())}</button>`).join("")}</div>` : ""}
  </li>`).join("");
  const note = (name, list, err, configured, filled, empty, setup) => (configured === false ? setup : err ? `${name} did not answer: ${err}` : list.length ? filled : empty);
  $("#github-note").textContent = note("GitHub", web.github, web.githubError, true, "Issues and pull requests on llama.cpp, Ollama, ComfyUI and related projects.", "No GitHub issues mention these words.");
  $("#github-found").innerHTML = postList(web.github, (p) => `${p.repo}, ${p.kind}, ${p.state}, ${fmt(p.comments)} comments`);
  $("#hn-note").textContent = note("Hacker News", web.hn, web.hnError, true, "Stories and comments on Hacker News.", "Nothing on Hacker News for these words.");
  $("#hn-found").innerHTML = postList(web.hn, (p) => `${p.kind}, ${fmt(p.points)} points, ${fmt(p.comments)} comments`);
  $("#lemmy-note").textContent = note("Lemmy", web.lemmy, web.lemmyError, true, "Posts from Lemmy communities such as localllama, fosai and stable_diffusion.", "No Lemmy posts for these words.");
  $("#lemmy-found").innerHTML = postList(web.lemmy, (p) => `${p.community}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  $("#youtube-note").textContent = note("YouTube", web.youtube, web.youtubeError, web.youtubeConfigured, "Videos about these words.", "No videos for these words.", "YouTube needs a free API key in Settings before videos can be searched.");
  $("#youtube-found").innerHTML = postList(web.youtube, (v) => `${v.channel}${v.views != null ? `, ${fmt(v.views)} views` : ""}`);
  $("#reddit-note").textContent = note("Reddit", web.reddit, web.redditError, web.redditConfigured, "Posts from r/LocalLLaMA, r/StableDiffusion and related communities.", "No Reddit posts for these words in the past year.", "Reddit needs a free app id in Settings before it can be searched.");
  $("#reddit-found").innerHTML = postList(web.reddit, (p) => `r/${p.subreddit}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  const count = ["civitai", "reddit", "github", "hn", "lemmy", "youtube"].reduce((t, k) => t + (web[k]?.length ?? 0), 0);
  $("#web-found-summary").textContent = count ? `Also mentioned elsewhere: ${count} on Civitai, GitHub, Hacker News, Lemmy, YouTube and Reddit` : "Also mentioned elsewhere: nothing for these words";
  for (const chip of box.querySelectorAll("button[data-open]")) chip.addEventListener("click", () => openModel(chip.dataset.open));
  for (const chip of box.querySelectorAll("button[data-hub]")) {
    chip.addEventListener("click", () => {
      $("#trait").value = chip.dataset.hub;
      $("#trait-form").requestSubmit();
    });
  }
}

function fit(gb, runner) {
  if (!gb) return { level: "unknown", text: "Size after scan" };
  // Chat models are judged against the rented GPU when one is set, and
  // image models too once the machine has its image agent.
  if ((runner === "ollama" && state.chatServer) || ((runner === "sd" || runner === "diffusers") && state.chatServer?.agent)) {
    const room = state.chatServer.comfortableGb;
    if (gb <= room * 0.8) return { level: "good", text: `Fits the server's GPU, ${gb.toFixed(1)} GB` };
    if (gb <= room) return { level: "tight", text: `Tight on the server's GPU, ${gb.toFixed(1)} GB` };
    return { level: "no", text: `Too big for the server, ${gb.toFixed(1)} GB` };
  }
  const room = state.machine.comfortableGb;
  if (state.hosted) {
    if (gb <= room * 0.6) return { level: "good", text: `Runs on a 16 GB laptop, ${gb.toFixed(1)} GB` };
    if (gb <= room) return { level: "tight", text: `Needs 16 GB with apps closed, ${gb.toFixed(1)} GB` };
    return { level: "no", text: `Needs 32 GB or a big GPU, ${gb.toFixed(1)} GB` };
  }
  if (gb <= room * 0.6) return { level: "good", text: `Fits easily, ${gb.toFixed(1)} GB` };
  if (gb <= room) return { level: "tight", text: `Fits, close other apps, ${gb.toFixed(1)} GB` };
  return { level: "no", text: `Too big, ${gb.toFixed(1)} GB` };
}

function pickCard(p) {
  const f = fit(p.gb, p.runner);
  const makes = makesOf(p);
  return `<div class="model" role="button" tabindex="0" data-id="${esc(p.id)}">
    <div class="name" title="${esc(p.id.split("/").pop())}">${esc(p.id.split("/").pop())}</div>
    <div class="summary">${esc(p.why)}</div>
    ${p.speed ? `<div class="speed" title="${esc(p.speed)}">${esc(p.speedWord || p.speed)}</div>` : ""}
    <div class="meta"><span class="pill makes">${esc(makes.text)}</span>${readsTag(p)}<span class="pill ${f.level}">${esc(f.text)}</span>${p.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}${state.hidden.has(p.id) ? '<span class="pill hidden-by">Hidden by you</span>' : ""}</div>
  </div>`;
}

// ---- what a model makes --------------------------------------------------------
// Every card says what comes out of the model, so a search for pictures is
// not answered by a chat model that can only describe them. `fits(want)`
// says whether the model can make what a search asked for.
function makesOf(m) {
  const pipeline = String(m.pipeline ?? "");
  const cats = m.categories ?? [];
  const runner = m.runner?.id ?? m.runner ?? "";
  let kind;
  // An add-on makes nothing by itself; it is applied to an image model.
  if (/\b(lora|loras|lycoris|vae|ip[-_]?adapter|adapter|controlnet|embeddings?|textual[-_ ]inversion)\b/i.test(String(m.id ?? "").split("/").pop() ?? "")) kind = "addon";
  else if (/video/.test(pipeline)) kind = "video";
  else if (cats.includes("images") || cats.includes("nsfw-images") || runner === "sd" || /^(text-to-image|image-to-image|image-editing|inpainting|unconditional-image-generation)$/.test(pipeline)) kind = "images";
  else if (cats.includes("speech") || runner === "whisper" || pipeline === "automatic-speech-recognition") kind = "speech";
  else if (pipeline === "text-to-speech" || pipeline === "text-to-audio") kind = "audio";
  else if (cats.includes("vision") || pipeline === "image-text-to-text") kind = "vision";
  else if (runner === "ollama" || pipeline === "text-generation" || cats.some((c) => ["chat", "coding", "math", "nsfw-writing"].includes(c))) kind = "text";
  else kind = "other";
  const text = { addon: "Add-on for image models", video: "Makes video", images: "Makes images", speech: "Transcribes speech", audio: "Makes sound", vision: "Text, understands images", text: "Text only, no pictures", other: pipeline ? pipeline.replace(/-/g, " ") : "Other" }[kind];
  return { kind, text, fits: (want) => (want === "images" ? kind === "images" : want === "video" ? kind === "video" : true) };
}

// What a model reads when files go with a message: every chat model reads
// code; one trained on code says so; one trained on disassembly or
// decompilation reads an executable's header and strings (and any
// disassembly pasted in) for what can be learned without running it.
const CODE_NAME_RE = /\b(code|coder|codellama|starcoder|starcoder2|deepseek-coder|codegemma|codestral|devstral|codeqwen|granite-code|wizardcoder|magicoder|opencoder|yi-coder|phind|codeshell|codefuse|aixcoder|codet5|santacoder|replit-code|stable-code|qwen2\.5-coder|qwen3-coder|seed-coder)\b/i;
const BINARY_RE = /decompil|disassembl|reverse[- ]?engineer|binary (analysis|code|lifting|similarity|function)|\b(asm|assembly|x86|x86-64|arm64|aarch64) (code|instructions?|to)\b|\bghidra\b|\bida ?pro\b|malware (analysis|detection)|\bbinar(y|ies)\b.*\b(llm|model)\b|llm4decompile|llm4binary|\bnova\b.*\bbinar|\bbint5\b|\bslade\b|\bbinllm/i;
function readsOf(m) {
  const kind = makesOf(m).kind;
  if (!["text", "vision"].includes(kind)) return null;
  const name = String(m.id ?? "").split("/").pop() ?? "";
  const tags = (m.tags ?? []).map(String);
  const cats = m.categories ?? [];
  const words = [m.id, ...tags, typeof m.summary === "string" ? m.summary : `${m.summary?.short ?? ""} ${m.summary?.long ?? ""}`, m.why].filter(Boolean).join(" ");
  if (BINARY_RE.test(words) || tags.some((t) => /decompil|disassembl|reverse-engineering|binary-analysis|malware/i.test(t))) return { level: "binaries", text: "Reads code and binaries", title: "Trained on disassembly or decompilation. Attach an executable to a message and it reads the file's header and the readable strings inside it, and any disassembly you paste; nothing is run." };
  if (cats.includes("coding") || CODE_NAME_RE.test(name) || tags.some((t) => /^(code|coding|code-generation|programming)$/i.test(t))) return { level: "code", text: "Trained on code", title: "Trained on code: attach code files to a message and it reads them, and it writes code. An executable attached is read as its header and strings." };
  return { level: "any", text: "Reads code", title: "Any chat model reads code files attached to a message; this one was not trained for code in particular." };
}
function readsTag(m) {
  const r = readsOf(m);
  return r ? `<span class="pill reads ${r.level}" title="${esc(r.title)}">${esc(r.text)}</span>` : "";
}

// What a search is after, when its words say so.
function wantsFrom(q) {
  if (/\b(videos?|animations?|animate|clips?|film|movie|img2vid|text-to-video|t2v)\b/i.test(q)) return "video";
  if (/\b(images?|pictures?|photos?|photographs?|art|artwork|draw|drawing|illustrations?|anime|wallpapers?|renders?|paintings?|portraits?|logos?|sketch|txt2img|text-to-image)\b/i.test(q)) return "images";
  return null;
}

function modelCard(m, wants = null) {
  const makes = makesOf(m);
  // One tag for what it makes; when the search wanted something else, the tag says so instead.
  const makesTag = wants && !makes.fits(wants) ? `<span class="pill cannot">Does not make ${wants}</span>` : `<span class="pill makes">${esc(makes.text)}</span>`;
  // A model that needs a Python setup says so; the runnable ones need no tag.
  const python = m.runner && !m.runner.easy ? `<span class="pill">${esc(m.runner.name)}</span>` : "";
  return `<div class="model" role="button" tabindex="0" data-id="${esc(m.id)}">
    <div class="name" title="${esc(m.name)}">${esc(m.name)}</div>
    ${saidHtml(m)}
    ${m.speed ? `<div class="speed" title="${esc(m.speed)}">${esc(m.speedWord || m.speed)}</div>` : ""}
    <div class="meta">
      ${makesTag}
      ${readsTag(m)}
      ${state.hidden.has(m.id) ? '<span class="pill hidden-by">Hidden by you</span>' : ""}
      ${m.isNew ? '<span class="pill new">New</span>' : ""}
      ${m.adult ? '<span class="pill adult">18+</span>' : ""}
      ${m.refusals?.refuses ? `<span class="pill no" title="${esc(m.refusals.example ?? "")}">Users report refusals</span>` : ""}
      ${m.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}
      ${m.gated ? '<span class="pill gated">Gated</span>' : ""}
      ${python}
      <span>${fmt(m.downloads)} downloads</span>
      <span>${fmt(m.likes)} likes</span>
    </div>
  </div>`;
}

// The one or two summary lines on a card, with a More button that opens the
// rest in place.
// What users say about a model, in a line or two; the author's own card
// text stays in the model window, where it belongs.
const userLines = (lines) => (lines ?? []).filter((l) => !/^Author:/.test(l));
function saidHtml(m) {
  const lines = userLines(m.summary?.short).slice(0, 2);
  if (!lines.length) return m.voiceMatch && m.voiceMatch.from === "discussion" ? `<div class="voice match">A discussion titled: ${esc(m.voiceMatch.text)}</div>` : "";
  const rest = userLines(m.summary?.long).filter((l) => !lines.includes(l));
  return `<div class="said">${lines.map(lineHtml).join("")}${rest.length || m.talked ? `<button class="ghost more" data-more="${esc(m.id)}">More</button>` : ""}<div class="expanded" hidden></div></div>`;
}

// "In HuggingFound:" lines say which preset or box carries the settings
// people suggest; "Not here yet:" lines name the ones HuggingFound cannot set.
const LINE_KINDS = { Users: "", Author: "author", "In HuggingFound": "setting", "Not here yet": "missing" };
function lineHtml(line) {
  const m = /^(Users|Author|In HuggingFound|Not here yet):\s*(.*)$/.exec(line);
  if (!m) return `<div class="line"><b>Users</b><span>${esc(line)}</span></div>`;
  return `<div class="line ${LINE_KINDS[m[1]]}"><b>${m[1]}</b><span>${esc(m[2])}</span></div>`;
}

function wireMore(root) {
  for (const btn of root.querySelectorAll("button[data-more]")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest(".model");
      const box = card.querySelector(".expanded");
      const m = [...state.models, ...(state.found?.models ?? []), ...state.picks].find((x) => x.id === btn.dataset.more);
      if (!box.hidden) {
        box.hidden = true;
        btn.textContent = "More";
        return;
      }
      // Only the lines not already on the card.
      const shown = userLines(m?.summary?.short).slice(0, 2);
      const rest = userLines(m?.summary?.long).filter((l) => !shown.includes(l));
      box.innerHTML = `${rest.map(lineHtml).join("") || "<span class=\"muted small\">Nothing more gathered.</span>"}<div class="by">${m?.talked ? `From ${m.talked} discussion${m.talked === 1 ? "" : "s"}. ` : ""}<a href="#" data-open-model="${esc(m?.id ?? "")}">Open the model for every source</a></div>`;
      box.hidden = false;
      btn.textContent = "Less";
      box.querySelector("[data-open-model]")?.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        openModel(m.id);
      });
    });
  }
}

function fmt(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(0)}k`;
  return String(n);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---- model window -----------------------------------------------------------

// Where the page last chose to run each chat model: "local" or "rented".
const whereFor = new Map();
function modelUrl(id) {
  const where = whereFor.get(id);
  return `/api/model?id=${encodeURIComponent(id)}${where ? `&where=${where}` : ""}`;
}

async function openModel(id) {
  const modal = $("#modal");
  modal.hidden = false;
  $("#modal-title").textContent = id.split("/").pop();
  $("#modal-sub").textContent = "Looking up files and sizes";
  $("#modal-body").innerHTML = "";
  state.open = id;
  renderHideButton(id);
  try {
    const { model, plan, choice } = await api.get(modelUrl(id));
    if (state.open !== id) return;
    renderModel(model, plan, choice);
  } catch (err) {
    $("#modal-sub").textContent = "";
    $("#modal-body").innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

function renderModel(model, plan, choice = null) {
  state.plan = plan;
  state.model = model;
  state.choice = choice;
  if (choice) whereFor.set(model.id, choice.where);
  const sub = [model.author, model.summary, model.gated ? "gated" : ""].filter(Boolean).join(" · ");
  $("#modal-sub").innerHTML = `${esc(sub)} · <a href="${esc(model.url)}" target="_blank" rel="noopener">Open on Hugging Face</a>`;
  renderHideButton(model.id);
  const body = $("#modal-body");
  const parts = [];
  // A visitor the site does not know is told here, at the point of using a model, what signing in opens.
  if (state.hosted && !fullAccess()) parts.push(`<p class="muted small visitor-note">Sign in, or add an Anthropic key as a guest, for video models and LoRAs.</p>`);

  if (!plan.runnable) {
    parts.push(`<div class="notice ${plan.gated || plan.needsGpu ? "info" : "warn"}">${esc(plan.reason)}${plan.link ? ` <a href="${esc(plan.link)}" target="_blank" rel="noopener">${plan.gated || plan.addon || plan.needsGpu ? "Open the model page" : "Search for a GGUF version"}</a>` : ""}</div>`);
    if (plan.gated) parts.push(`<div class="actions"><button class="ghost" id="open-settings-from-model">Add a Hugging Face token in Settings</button></div>`);
    // A model that runs only on a rented GPU leads straight to renting one.
    if (plan.needsGpu && choice) {
      state.rentAsk = model.id;
      // The disk this model wants, for the rental made from here.
      state.rentDiskWant = plan.diskGb ?? null;
      parts.push(rentAskHtml(choice, plan));
    }
    // A machine from before this feature is replaced from here.
    if (plan.staleMachine) parts.push(`<div class="actions"><button class="primary" id="replace-from-model">Replace the machine</button></div>`);
    // A disk too small for the model grows from here; RunPod never shrinks one.
    if (plan.needsDisk && plan.growTo) parts.push(plan.replaceForDisk ? `<div class="actions"><button class="primary" id="replace-for-disk">Replace it with a ${plan.growTo} GB disk</button></div>` : `<div class="actions"><button class="primary" id="grow-from-model">Grow the disk to ${plan.growTo} GB</button> <small class="muted">About ${money(DISK_STOPPED_PER_GB_MONTH / 30 * (plan.growTo - (plan.diskGb || 0)))} a day more while the machine is stopped, half that while it runs.</small></div>`);
    if (plan.twin) parts.push(`<div class="actions"><button class="primary" id="open-twin">Open ${esc(plan.twin.name)}</button></div>`);
    // What was made with the model before stays on show, with the machine
    // stopped or gone or the model not runnable here any more.
    parts.push(`<div id="kept"></div>`);
    body.innerHTML = parts.join("");
    renderKept(body, model.id);
    body.querySelector("#open-settings-from-model")?.addEventListener("click", () => ($("#settings").hidden = false));
    body.querySelector("#open-twin")?.addEventListener("click", () => openModel(plan.twin.id));
    body.querySelector("#replace-from-model")?.addEventListener("click", () => {
      state.rentFrom = model.id;
      replaceMachine();
    });
    body.querySelector("#replace-for-disk")?.addEventListener("click", () => {
      state.rentFrom = model.id;
      replaceMachine({ diskGb: plan.growTo });
    });
    body.querySelector("#grow-from-model")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = "Growing the disk";
      try {
        state.rental = await api.post("/api/rent/grow", { diskGb: plan.growTo });
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Grow the disk to ${plan.growTo} GB`;
        notice(`Could not grow the disk: ${err.message}`, "bad");
        return;
      }
      notice(`The disk is now ${plan.growTo} GB; the machine may restart for it, and its models stay. Run the download again and it goes on from the files already there.`, "ok");
      await load();
      openModel(model.id);
    });
    if (plan.needsGpu && choice) wireRentAsk(body, model, choice);
    return;
  }

  // The window in screens, one at a time: Fit (how big, whether it fits,
  // how fast), Set up (the steps), Use (the try box) and What people say.
  // "All at once" shows the lot in a column, as before, and is remembered.
  const onSite = state.hosted && !plan.remote;
  const onMachine = plan.remote && (plan.runner === "ollama" || plan.tryWith?.agent);
  const ready = plan.steps.every((s) => s.done || s.optional);
  const running = plan.steps.some((s) => s.running);
  const hasTry = !onSite;
  const panes = [["fit", "Fit"], ["setup", onSite ? "How to run it" : "Set up"], ...(hasTry ? [["use", "Use"]] : []), ["say", "What people say"]];
  parts.push(`<nav class="panes-nav" id="panes-nav" aria-label="Parts of this window">${panes.map(([id, name], i) => `<button class="pane-tab" data-pane="${id}">${i < 3 && id !== "say" ? `<span class="pane-n">${i + 1}</span>` : ""}${esc(name)}</button>`).join("")}<button class="ghost pane-all" id="pane-all">${panesAll() ? "One at a time" : "All at once"}</button></nav>`);

  // Fit: the size, the fit and the speed, each in a few words, and where to run it.
  const fitLine = fitSentence(plan, choice);
  const sizeText = plan.file.gb ? `${plan.file.gb.toFixed(plan.file.gb < 1 ? 2 : 1)} GB` : plan.file.folder ? `${plan.file.parts.length} files` : plan.file.repo ? `${plan.file.files.length} files` : "";
  const fileText = plan.file.folder ? `${plan.file.parts.length} parts, merged into one file` : plan.file.repo ? `${plan.file.files.length} files, loaded as a folder` : plan.file.name;
  const speedText = plan.measured ? esc(plan.measured) : `<span title="${esc(plan.speed?.text ?? "")}">${esc(plan.speed?.word || plan.speed?.text || "")}</span>`;
  const fitPane = [];
  if (choice) fitPane.push(whereHtml(choice));
  if (choice && state.rentAsk === model.id && choice.where === "local") fitPane.push(rentAskHtml(choice, plan));
  fitPane.push(`<div class="fit-card">
    <div class="fit-size">${esc(sizeText)}</div>
    <div class="fit-body">
      <p class="fit-line ${plan.fit.level}">${esc(fitLine)}</p>
      <p class="fit-speed"><span class="pill makes">${esc(makesOf(model).text)}</span><span class="fit-word">${speedText}</span></p>
      <p class="muted small fit-file" title="${esc(fileText)}">${esc(fileText)}</p>
    </div>
  </div>`);
  if (onMachine) fitPane.push(`<p class="muted small">Runs on your rented GPU; your browser talks to the machine directly and nothing passes through ${state.hosted ? "this site" : "the app"}.</p>`);
  if (plan.fit.level === "no") fitPane.push(`<div class="notice warn">${state.hosted ? "Larger than a typical laptop has to spare." : "Larger than this computer has to spare; it may load slowly or not at all."}${choice && !choice.rented ? " A rented GPU holds it: pick On a rented GPU above." : choice ? " Pick On a rented GPU above." : ""}</div>`);
  fitPane.push(`<div class="actions pane-actions"><button class="primary" id="pane-next" data-pane="${ready && hasTry ? "use" : "setup"}">${ready && hasTry ? "Use it" : onSite ? "How to run it" : running ? "See the set-up" : "Set it up"}</button><button class="ghost" data-pane="say">What people say</button></div>`);
  parts.push(`<section class="pane" data-pane="fit">${fitPane.join("")}</section>`);

  // Set up: one step on show at a time: the first one not done, with the
  // done ones as a line each above it. Later steps wait until it is done,
  // and an optional one is offered where it is used (the clip window's
  // reference pictures), shown here only while it runs.
  const setupPane = [];
  const current = plan.steps.findIndex((s) => !s.done && !s.optional);
  // On the site nothing runs, so the steps are instructions and all of them show; in the app one is on show at a time.
  const waiting = (s, i) => !onSite && !s.running && (s.optional || (current >= 0 && i > current));
  const later = plan.steps.filter((s, i) => waiting(s, i) && !s.optional).length;
  const stepsHtml = `<ol class="steps${onSite ? " manual" : ""}" id="steps">${plan.steps.map((s, i) => stepHtml(s, i, waiting(s, i))).join("")}${later ? `<li class="steps-later muted small">Then ${later} more step${later === 1 ? "" : "s"}, shown when this one is done.</li>` : ""}</ol>`;
  if (onSite) {
    // Two ways: HuggingFound downloads it onto a GPU rented by the hour, or the person does it by hand.
    setupPane.push(`<div class="setup-ways">
      ${choice && !choice.gpuOnly ? `<button class="way" id="way-rented"><b>Let HuggingFound download it</b><span class="pill good">Recommended</span><span class="muted">Onto a GPU rented by the hour. It is ready in a few minutes and you use it right here.</span></button>` : ""}
      <details class="way manual">
        <summary><b>Download it yourself</b><span class="muted">From Hugging Face, to run with ${esc(plan.runner === "ollama" ? "Ollama" : "the runner named below")} on your computer.</span></summary>
        ${stepsHtml}
        <details class="get-app hosted-only"><summary>Or let HuggingFound on your computer do these steps with one click.</summary><code>git clone https://github.com/hungateJoseph/huggingfound.git
cd huggingfound
npm install
npm start</code></details>
      </details>
    </div>`);
  } else {
    setupPane.push(stepsHtml);
  }
  queueMicrotask(() => {
    for (const [i, s] of plan.steps.entries()) if (s.running && $(`#steps .step[data-index="${i}"]`)) followStep(model, plan, i, s.running);
  });
  if (hasTry && ready) setupPane.push(`<div class="actions pane-actions"><button class="primary" data-pane="use">Use it</button></div>`);
  parts.push(`<section class="pane" data-pane="setup">${setupPane.join("")}</section>`);

  if (hasTry) parts.push(`<section class="pane" data-pane="use"><div class="try" id="try"></div></section>`);
  parts.push(`<section class="pane" data-pane="say"><div class="voices" id="voices"><h3>What people say</h3><p class="muted small">Reading the model card and the community discussions</p></div></section>`);
  body.innerHTML = parts.join("");
  loadVoices(model).catch((err) => {
    const box = $("#voices");
    if (box) box.innerHTML = `<h3>What people say</h3><p class="muted small">Could not read the discussions: ${esc(err.message)}</p>`;
  });

  for (const btn of body.querySelectorAll(".go")) {
    btn.addEventListener("click", () => runStep(model, plan, Number(btn.dataset.index)));
  }
  for (const btn of body.querySelectorAll("[data-where]")) btn.addEventListener("click", () => chooseWhere(model.id, btn.dataset.where));
  body.querySelector("#way-rented")?.addEventListener("click", () => {
    state.pane.set(model.id, "fit");
    chooseWhere(model.id, "rented");
  });
  for (const btn of body.querySelectorAll("[data-pane]:not(.pane)")) btn.addEventListener("click", () => showPane(model.id, btn.dataset.pane, true));
  $("#pane-all").addEventListener("click", () => {
    setPanesAll(!panesAll());
    renderModel(model, plan, choice);
  });
  wireRentAsk(body, model, choice);
  renderTry(model, plan);
  // Which screen: a step running or just finished keeps Set up, a model
  // ready to use opens on Use, and a model opened for the first time on Fit.
  const was = state.pane.get(model.id);
  showPane(model.id, was === "setup" && ready && hasTry && !running ? "use" : was ?? (running ? "setup" : ready && hasTry ? "use" : "fit"));
}

// The screen on show for each model this session, and the all-at-once
// choice kept in this browser.
state.pane = new Map();
function panesAll() {
  try {
    return localStorage.getItem("hf:window") === "all";
  } catch {
    return false;
  }
}
function setPanesAll(all) {
  try {
    if (all) localStorage.setItem("hf:window", "all");
    else localStorage.removeItem("hf:window");
  } catch {}
}
function showPane(id, name, asked = false) {
  const body = $("#modal-body");
  if (!body.querySelector(`.pane[data-pane="${name}"]`)) name = "fit";
  state.pane.set(id, name);
  body.classList.toggle("staged", !panesAll());
  for (const pane of body.querySelectorAll(".pane")) pane.classList.toggle("on", pane.dataset.pane === name);
  for (const tab of body.querySelectorAll(".pane-tab")) tab.classList.toggle("on", tab.dataset.pane === name);
  if (!asked) return;
  if (panesAll()) body.querySelector(`.pane[data-pane="${name}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  else $("#modal").scrollTop = 0;
}

// How big it is and whether it fits, in one sentence for this machine.
function fitSentence(plan, choice) {
  const level = plan.fit.level;
  if (level === "unknown") return "Size known after a scan.";
  if (plan.remote) return { good: "Fits your rented GPU.", tight: "Fits your rented GPU, just.", no: "Too big for your rented GPU." }[level];
  if (state.hosted) return { good: "Runs on a 16 GB laptop.", tight: "Runs on a 16 GB laptop with other apps closed.", no: "Needs 32 GB of memory or a big GPU." }[level];
  const here = /mac/i.test(state.machine?.os ?? "") ? "this Mac" : "this computer";
  return { good: `Fits ${here} with room to spare.`, tight: `Fits ${here} if other apps are closed.`, no: `Too big for ${here}.` }[level];
}

// ---- where a chat model runs -------------------------------------------------

function whereHtml(choice) {
  if (choice.gpuOnly) return "";
  const here = state.hosted ? "your computer" : "this computer";
  // While the questions that lead to a machine are showing, the GPU button is the chosen one.
  const rented = choice.where === "rented" || state.rentAsk === state.open;
  return `<div class="where" role="group" aria-label="Where to run it">
    <button class="where-opt ${rented ? "" : "on"}" data-where="local">On ${here}</button>
    <button class="where-opt ${rented ? "on" : ""}" data-where="rented">On a rented GPU${choice.rented ? "" : ", by the hour"}</button>
  </div>`;
}

// Picking a place re-plans the model for it. Asking for a GPU when none is
// rented opens the questions that lead to one.
function chooseWhere(id, where) {
  const choice = state.choice;
  if (where === "rented" && !choice?.rented) {
    state.rentAsk = id;
    whereFor.set(id, "local");
  } else {
    state.rentAsk = null;
    whereFor.set(id, where);
  }
  openModel(id);
}

function rentAskHtml(choice, plan) {
  const back = choice.gpuOnly ? "" : `<button class="ghost" data-where="local">Run it on my computer instead</button>`;
  const wanted = (state.rentTiers ?? []).find((t) => t.gb === choice.tier);
  const size = choice.tier ? `This ${plan.file?.gb ? `${plan.file.gb.toFixed(1)} GB ` : ""}${plan.file?.repo ? "model" : "file"} wants ${wanted?.count > 1 ? `${wanted.count} cards of ${wanted.gb / wanted.count} GB in one machine` : `a ${choice.tier} GB card`}.` : "This file is bigger than any size on offer.";
  // A machine that exists but is stopped (it stops itself when idle) is
  // started again, not replaced.
  const r = state.rental;
  if (r?.rented) {
    const [word] = rentalPhase(r);
    const fits = !choice.tier || !r.gb || r.gb >= choice.tier;
    // A machine from before a feature is known by the version its agent
    // last reported; replacing it deletes it first, then rents afresh.
    const older = r.agentVersion != null && r.agentCurrent != null && r.agentVersion < r.agentCurrent;
    const olderNote = older ? ` It runs an older HuggingFound image (version ${r.agentVersion} of ${r.agentCurrent}); replacing it gets the current one, and its models are fetched again.` : "";
    const replace = `<button class="${older ? "primary" : "ghost"}" id="ask-replace">Replace the machine</button>`;
    if (r.status === "EXITED" || r.status === "ERROR") {
      return `<div class="rent-ask"><p><b>Your rented GPU (${esc(r.gpu || "GPU")}${r.gb ? `, ${r.gb} GB` : ""}) is stopped.</b> It stopped itself after sitting idle; its models are still on its disk. Starting it takes a minute or two.${fits ? "" : ` ${esc(size)} It may be tight on this card.`}${olderNote}</p><div class="actions">${older ? `${replace}<button class="ghost" id="ask-start">Start it anyway</button>` : `<button class="primary" id="ask-start">Start it</button>${replace}`}${back}</div></div>`;
    }
    return `<div class="rent-ask"><p><b>Your rented GPU is ${esc(word)}.</b> This window switches to it as soon as it answers.${olderNote}</p><div data-boot-slot>${bootHtml(r)}</div><div class="actions">${replace}${back}</div></div>`;
  }
  if (state.hosted && !state.user) {
    const hours = state.auth?.guestHours ?? 12;
    return `<div class="rent-ask">
      <p><b>Renting a GPU takes a RunPod or Vast.ai API key.</b> ${esc(size)} RunPod and Vast.ai rent GPUs by the hour; with your key this site starts a machine for you, runs the model on it and stops it when you are done. You can enter a key as a guest: it and the machine are kept for ${hours} hours after your last use, then the machine is stopped and the key forgotten.${state.auth?.google ? " Sign in with Google to keep them for good." : ""}</p>
      <div class="actions"><button class="primary" id="ask-yes">Enter a key as a guest</button>${state.auth?.google ? `<button class="ghost" id="ask-signin">Sign in with Google</button>` : ""}<button class="ghost" id="ask-no">I have no key yet</button>${back}</div>
      <div id="ask-yes-box" hidden>
        <label class="field"><span>RunPod API key</span><input type="password" id="ask-key" autocomplete="off" placeholder="rpa_..."><small class="muted">Sent only to RunPod.</small></label>
        <label class="field"><span>Vast.ai API key</span><input type="password" id="ask-vast-key" autocomplete="off" placeholder="Vast.ai key"><small class="muted">Sent only to Vast.ai. One key is enough; with both, every free card from both is listed.</small></label>
        <small class="muted">Kept encrypted on this site for ${hours} hours after your last use. Nothing you say to the model passes through this site.</small>
        <div class="actions"><button class="primary" id="ask-save">Save the key</button></div>
      </div>
      <div id="ask-no-box" hidden>
        <p class="muted small">It takes about two minutes. RunPod: make an account at <a href="https://www.runpod.io" target="_blank" rel="noopener">runpod.io</a>, add some credit (ten dollars goes a long way), then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. Vast.ai: make an account at <a href="https://cloud.vast.ai" target="_blank" rel="noopener">cloud.vast.ai</a>, add credit, then under Account, API Keys, create a key. Come back and click "Enter a key as a guest". A 24 GB card costs about half a dollar an hour and a 48 GB one under a dollar.</p>
      </div>
    </div>`;
  }
  if (choice.hasRunpodKey) {
    // With a key saved, renting is one choice and one button here; the
    // key never comes up again while it is saved.
    // Every free card, RunPod's and Vast.ai's, in one list.
    const options = state.rentOptions ?? [];
    const free = rentRows(options).filter((t) => t.available && t.pricePerHour != null);
    const pick = free.find((t) => t.key === state.rentWantKey && t.gb === choice.tier) ?? free.find((t) => t.gb === choice.tier) ?? free.find((t) => t.gb > (choice.tier ?? 0)) ?? free[0] ?? null;
    const sizes = free.length
      ? `<label class="field"><span>Size</span><select id="ask-size">${free.map((t) => `<option value="${t.key}" ${pick && t.key === pick.key ? "selected" : ""}>${t.count > 1 ? `${t.count} × ${t.gb / t.count} GB` : `${t.gb} GB`}, ${esc(t.gpu.name)}, ${money(t.pricePerHour)} an hour${placeTag(t)}${t.gb === choice.tier ? " (recommended)" : ""}</option>`).join("")}</select></label>`
      : state.rentOptionsError
        ? `<p class="muted small">${placesText()} ${state.runpodKey && state.vastKey ? "are" : "is"} not answering about sizes: ${esc(state.rentOptionsError)}</p>`
        : options.length ? `<p class="muted small">No card is free at ${placesText()} right now; it changes by the minute. Try again shortly.</p>` : `<p class="muted small">Asking ${placesText()} for sizes and prices</p>`;
    // The size the model wants is sold out everywhere: how long, and a watch for it.
    const wantedOut = options.find((t) => t.gb === choice.tier && !(state.runpodKey && t.available) && (t.gpu || t.vast) && !t.vast?.available);
    const outHtml = wantedOut ? `<div class="notice warn sold-out"><p>The ${wantedOut.count > 1 ? `${wantedOut.count} × ${wantedOut.gb / wantedOut.count} GB` : `${wantedOut.gb} GB`} size this model wants is sold out at ${placesText()} right now. ${state.runpodKey ? esc(stockText(wantedOut)) : ""}</p><p class="tools-row">${rentWhenFreeHtml(wantedOut)}${state.rental?.watch?.gb === wantedOut.gb ? "" : watchHtml(wantedOut)}<button class="ghost" id="ask-check">Check again</button></p></div>` : "";
    // A bigger card than the model needs can be worth it for speed: the
    // ones meaningfully faster than the pick, with what a clip costs there.
    const faster = pick ? fasterRows(pick, free) : [];
    const fasterHtml = faster.length ? `<p class="muted small rent-faster"><b>Faster cards.</b> ${faster.map((f) => `${esc(f.gpu.name)} (${f.count > 1 ? `${f.count} × ${f.gb / f.count} GB` : `${f.gb} GB`}${f.provider === "vast" ? ", Vast.ai" : ""}) makes clips about ${f.times} times faster for ${money(f.pricePerHour)} an hour${f.costRatio <= 1.05 ? ", about the same per clip" : f.costRatio < 1.3 ? ", a little more per clip" : `, about ${f.costRatio} times the cost per clip`}`).join("; ")}. Pick that size above if time matters more than price.</p>` : "";
    return `<div class="rent-ask rent-offer">
      <p><b>Rent a GPU for this.</b> ${esc(size)} ${placesText().replace(" and ", " or ")} bills your account by the hour while it runs; it stops itself after sitting idle, and the bar at the top can stop or delete it any time.</p>
      ${outHtml}
      ${sizes}
      ${fasterHtml}
      <div class="actions"><button class="primary" id="ask-rent" ${pick ? "" : "disabled"}>${pick ? `Rent it, ${money(pick.pricePerHour)} an hour` : "Rent it"}</button><button class="ghost" id="ask-sizes">Disk size and other settings</button>${back}</div>
      <p class="muted small" id="ask-rent-note"></p>
    </div>`;
  }
  return `<div class="rent-ask">
    <p><b>Do you have a RunPod API key?</b> RunPod rents GPUs by the hour; with a key HuggingFound starts a machine for you, runs the model on it and stops it when you are done. ${esc(size)}</p>
    <div class="actions"><button class="primary" id="ask-yes">Yes, I have one</button><button class="ghost" id="ask-no">No, not yet</button>${back}</div>
    <div id="ask-yes-box" hidden>
      <label class="field"><span>RunPod API key</span><input type="password" id="ask-key" autocomplete="off" placeholder="rpa_..."><small class="muted">Kept ${state.hosted ? "with your account, encrypted" : "in the settings file on this computer"} and sent only to RunPod.</small></label>
      <div class="actions"><button class="primary" id="ask-save">Save the key</button></div>
    </div>
    <div id="ask-no-box" hidden>
      <p class="muted small">It takes about two minutes: make an account at <a href="https://www.runpod.io" target="_blank" rel="noopener">runpod.io</a>, add some credit (ten dollars goes a long way), then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. Come back and click "Yes, I have one". A 24 GB card costs about half a dollar an hour and a 48 GB one under a dollar.</p>
    </div>
  </div>`;
}

function wireRentAsk(body, model, choice) {
  wireWatch(body);
  paintBoot();
  body.querySelector("#ask-check")?.addEventListener("click", (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = "Checking";
    loadRentOptions({ fresh: true, quiet: true });
  });
  body.querySelector("#ask-signin")?.addEventListener("click", openSignIn);
  body.querySelector("#ask-start")?.addEventListener("click", () => rentAction("start", null));
  body.querySelector("#ask-replace")?.addEventListener("click", () => {
    state.rentFrom = model.id;
    replaceMachine();
  });
  if (body.querySelector(".rent-offer") && state.rentOptions == null && !state.rentOptionsLoading) loadRentOptions();
  // Under the offer: what one picture or clip would cost at the chosen size.
  const sayPerQuery = () => {
    const note = body.querySelector("#ask-rent-note");
    const offer = rentRow(body.querySelector("#ask-size")?.value);
    if (note && offer) note.textContent = perQueryText(offer.pricePerHour).trim();
    // The button's price is the chosen size's, not the first one's.
    const btn = body.querySelector("#ask-rent");
    if (btn && offer && !btn.disabled) btn.textContent = `Rent it, ${money(offer.pricePerHour)} an hour`;
  };
  sayPerQuery();
  body.querySelector("#ask-size")?.addEventListener("change", sayPerQuery);
  body.querySelector("#ask-sizes")?.addEventListener("click", () => {
    const row = rentRow(body.querySelector("#ask-size")?.value);
    state.rentWant = row?.gb || choice.tier;
    state.rentWantKey = row?.key ?? null;
    state.rentFrom = model.id;
    if (state.rentDiskWant) state.rentDisk = Math.max(Number(state.rentDisk ?? 50), state.rentDiskWant);
    $("#settings").hidden = false;
    $("#sec-rent").open = true;
    renderRental();
    $("#rent").scrollIntoView({ block: "start" });
  });
  body.querySelector("#ask-rent")?.addEventListener("click", async () => {
    const offer = rentRow(body.querySelector("#ask-size")?.value);
    if (!offer?.gpu) return;
    const gb = offer.gb;
    state.rentWantKey = offer.key;
    // The disk is at least what this model wants, with room to spare.
    const diskGb = Math.max(Number(state.rentDisk ?? 50), Number(state.rentDiskWant ?? 0));
    if (!confirm(`Rent a ${offer.gpu.name}${offer.count > 1 ? ` × ${offer.count}` : ""} (${gb} GB) at ${placeOf(offer)} for ${money(offer.pricePerHour)} an hour, with a ${diskGb} GB disk?\n\n${perQueryText(offer.pricePerHour)}${safeguardText(offer.pricePerHour)}`)) return;
    if (!(await guardOthers())) return;
    const btn = body.querySelector("#ask-rent");
    const note = body.querySelector("#ask-rent-note");
    btn.disabled = true;
    btn.textContent = "Renting";
    try {
      state.rental = await api.post("/api/rent", { gb, diskGb, provider: offer.provider });
    } catch (err) {
      note.textContent = `Could not rent it: ${err.message}`;
      btn.disabled = false;
      btn.textContent = `Rent it, ${money(offer.pricePerHour)} an hour`;
      // Stock moved under the offer: the sizes are fetched again and the window redrawn.
      state.rentOptions = null;
      loadRentOptions({ fresh: true });
      return;
    }
    state.rentFrom = null;
    notice(`A ${gb} GB GPU is being rented; ${model.id.split("/").pop()} now runs on it. It usually answers within a few minutes.`, "ok");
    await load();
    whereFor.set(model.id, "rented");
    state.rentAsk = null;
    openModel(model.id);
  });
  body.querySelector("#ask-yes")?.addEventListener("click", () => {
    body.querySelector("#ask-yes-box").hidden = false;
    body.querySelector("#ask-no-box").hidden = true;
    body.querySelector("#ask-key").focus();
  });
  body.querySelector("#ask-no")?.addEventListener("click", () => {
    body.querySelector("#ask-no-box").hidden = false;
    body.querySelector("#ask-yes-box").hidden = true;
  });
  body.querySelector("#ask-save")?.addEventListener("click", async () => {
    const value = body.querySelector("#ask-key").value.trim();
    const vast = body.querySelector("#ask-vast-key")?.value.trim() ?? "";
    if (!value && !vast) {
      body.querySelector("#ask-key").focus();
      return;
    }
    const asGuest = state.hosted && !state.user;
    try {
      await api.post(asGuest ? "/api/guest" : "/api/settings", { ...(value ? { RUNPOD_API_KEY: value } : {}), ...(vast ? { VAST_API_KEY: vast } : {}) });
    } catch (err) {
      alert(err.message);
      return;
    }
    // The key entry gives way to the one-time rental, right here.
    state.rentOptions = null;
    state.rentWant = choice.tier;
    state.rentWantKey = null;
    state.rentFrom = model.id;
    await load();
    if (state.open) openModel(state.open);
    loadRentOptions();
    notice(asGuest ? `The key is saved for ${state.auth?.guestHours ?? 12} hours after your last use.` : `The ${value && vast ? "RunPod and Vast.ai keys are" : vast ? "Vast.ai key is" : "RunPod key is"} saved.`, "ok");
  });
}

async function loadVoices(model) {
  const v = await api.get(`/api/voices?id=${encodeURIComponent(model.id)}`);
  const box = $("#voices");
  if (!box || state.open !== model.id) return;
  const card = v.card ? `<details ${v.card.length < 400 ? "open" : ""}><summary>What the author's model card says</summary><p class="card-text">${esc(v.card)}</p></details>` : `<p class="muted small">This repository has no model card text.</p>`;
  const threads = v.discussions.length
    ? `<ul>${v.discussions.slice(0, 12).map((d) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a> <span class="who">${d.comments} comment${d.comments === 1 ? "" : "s"}${d.status === "closed" ? ", closed" : ""}</span>${(d.comments_text ?? []).map((c) => `<p>${esc(c.author ? c.author + ": " : "")}${esc(c.text)}</p>`).join("")}</li>`).join("")}</ul>`
    : `<p class="muted small">No community discussions on this repository yet.</p>`;
  // What users say, as one list under one label; the author's words stay in
  // the sources, and settings advice goes to the try box, where it is used.
  const lines = v.summary?.long ?? [];
  const reviews = lines.filter((l) => !/^(Author|In HuggingFound|Not here yet):/.test(l)).map((l) => l.replace(/^Users:\s*/, ""));
  state.advice.set(model.id, lines.filter((l) => /^(In HuggingFound|Not here yet):/.test(l)));
  renderAdvice($("#try"), model.id);
  const first = reviews.slice(0, 3);
  const rest = reviews.slice(3);
  const item = (l) => `<li>${esc(l)}</li>`;
  const summary = reviews.length ? `<div class="reviews"><b class="reviews-label">User reviews</b><ul>${first.map(item).join("")}</ul>${rest.length ? `<details class="more-said"><summary>${rest.length} more</summary><ul>${rest.map(item).join("")}</ul></details>` : ""}</div>` : `<p class="muted small">No user reviews yet.</p>`;
  box.innerHTML = `<h3>What people say</h3>${summary}<details><summary>Sources on Hugging Face</summary>${card}${threads}<p class="muted small">From the community tab on Hugging Face; these are other users' words, not a review.</p></details><details open><summary>Elsewhere</summary><div class="web" id="voices-web"><p class="muted small">Looking on Civitai, GitHub, Hacker News, Lemmy, YouTube and Reddit</p></div></details>`;
  const isImage = state.plan?.runner === "sd" || (model.categories ?? []).includes("images");
  const web = await api.get(`/api/voices/web?id=${encodeURIComponent(model.id)}${isImage ? "&images=1" : ""}`);
  const webBox = $("#voices-web");
  if (!webBox || state.open !== model.id) return;
  const civ = web.civitai.length
    ? `<h4>On Civitai</h4><p class="muted small">Pages whose name matches this model; merges and re-uploads share names, so check the link.</p>` + web.civitai.map((c) => `<div class="civ"><div class="name"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>${c.nsfw ? ' <span class="pill adult">18+</span>' : ""}</div><div class="stats">${fmt(c.thumbsUp)} thumbs up, ${fmt(c.thumbsDown)} down, ${fmt(c.comments)} comments, ${fmt(c.downloads)} downloads${c.creator ? `, by ${esc(c.creator)}` : ""}</div>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ""}</div>`).join("")
    : "";
  const prompts = web.civitaiPrompts?.length
    ? `<h4>What people make with it on Civitai</h4><p class="muted small">The most liked pictures posted under the matching page, with the prompts their makers used.</p><ul class="posts">${web.civitaiPrompts.slice(0, 6).map((i) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.prompt)}</a><div class="who">${fmt(i.reactions)} reactions, ${fmt(i.comments)} comments${i.user ? `, by ${esc(i.user)}` : ""}${i.nsfw ? ", 18+" : ""}</div></li>`).join("")}</ul>`
    : "";
  const section = (title, items, err, configured, who) => (configured === false || err || !items.length
    ? ""
    : `<h4>On ${esc(title)}</h4><ul class="posts">${items.slice(0, 8).map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="who">${esc(who(p))}</div>${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}</li>`).join("")}</ul>`);
  const gh = section("GitHub", web.github ?? [], web.githubError, true, (p) => `${p.repo}, ${p.kind}, ${p.state}, ${fmt(p.comments)} comments`);
  const hn = section("Hacker News", web.hn ?? [], web.hnError, true, (p) => `${p.kind}, ${fmt(p.points)} points, ${fmt(p.comments)} comments`);
  const lem = section("Lemmy", web.lemmy ?? [], web.lemmyError, true, (p) => `${p.community}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  const yt = section("YouTube", web.youtube ?? [], web.youtubeError, web.youtubeConfigured, (v) => `${v.channel}${v.views != null ? `, ${fmt(v.views)} views` : ""}`);
  const red = section("Reddit", web.reddit ?? [], web.redditError, web.redditConfigured, (p) => `r/${p.subreddit}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  const found = civ + prompts + gh + hn + lem + yt + red;
  // Nothing found elsewhere: the fold goes, rather than a list of places that had nothing.
  webBox.innerHTML = found;
  webBox.closest("details").hidden = !found;
}

// Settings people suggest for a model, shown in its try box once there is
// one: "In HuggingFound" lines say where the setting goes here, "Not here
// yet" lines name the ones HuggingFound cannot set.
state.advice = new Map();
function renderAdvice(box, id) {
  if (!box || !id || state.open !== id) return;
  box.querySelector(".advice")?.remove();
  const lines = state.advice.get(id) ?? [];
  if (!lines.length) return;
  const el = document.createElement("div");
  el.className = "advice";
  el.innerHTML = lines.map((l) => {
    const m = /^(In HuggingFound|Not here yet):\s*(.*)$/.exec(l);
    return `<p class="small ${m[1] === "Not here yet" ? "muted" : ""}"><b>${m[1] === "Not here yet" ? "Not here yet" : "Tip"}</b> ${esc(m[2])}</p>`;
  }).join("");
  const after = box.querySelector(".instructions") ?? box.querySelector("h3") ?? box.querySelector(".try-head");
  if (after) after.after(el);
  else box.prepend(el);
}

function stepHtml(s, i, hidden = false) {
  return `<li class="step ${s.done ? "done" : ""}${s.optional ? " optional" : ""}" data-index="${i}" ${hidden ? "hidden" : ""}>
    <span class="num">${s.done ? "✓" : i + 1}</span>
    <div>
      <div class="title">${esc(s.title)}</div>
      <div class="text">${esc(s.text)}</div>
      ${s.command ? `<code>${esc(s.command)}</code>` : ""}
    </div>
    ${state.hosted && !state.plan?.remote ? "" : `<span class="step-buttons"><button class="go ${s.done ? "ghost" : "primary"}" data-index="${i}" ${s.done || s.running ? "disabled" : ""}>${s.done ? "Done" : s.running ? "Running" : "Run this step"}</button>${s.running ? `<button class="ghost refresh-step" title="Reopen this window and pick the running step up again">Refresh</button>` : ""}</span>`}
  </li>`;
}

// Shows a running step's log in its box and follows it to the end,
// whether the run was just started or found already going.
async function followStep(model, plan, index, id) {
  const step = plan.steps[index];
  const li = $(`#steps .step[data-index="${index}"]`);
  if (!li) return;
  const btn = li.querySelector(".go");
  btn.disabled = true;
  btn.textContent = "Running";
  li.classList.add("running");
  li.classList.remove("failed");
  // Refresh: the window reopens and reattaches to whatever is running.
  if (!li.querySelector(".refresh-step")) {
    const refresh = document.createElement("button");
    refresh.className = "ghost refresh-step";
    refresh.title = "Reopen this window and pick the running step up again";
    refresh.textContent = "Refresh";
    if (btn.parentElement.classList.contains("step-buttons")) btn.parentElement.appendChild(refresh);
    else btn.after(refresh);
  }
  li.querySelector(".refresh-step").onclick = () => openModel(model.id);
  // On the rented machine: end the bill the moment the download is over.
  // Ticked unless it was unticked before, since a download left to itself
  // is easily forgotten; a queue waiting for the model, or anything else
  // at work on the machine a minute after, keeps it up all the same.
  if (plan.remote && state.rental?.rented && !li.querySelector(".stop-after")) {
    const tick = document.createElement("label");
    tick.className = "check stop-after";
    tick.title = "The machine stops a minute after this download finishes, unless another of yours is still going, a queue is waiting for the model, or a request is under way by then; its models stay on its disk. Your choice here is remembered.";
    tick.innerHTML = `<input type="checkbox" ${stopAfterDownloadWanted() ? "checked" : ""}> Stop the GPU when this finishes${state.rental.costPerHour ? ` (${money(state.rental.costPerHour)} an hour)` : ""}`;
    (li.querySelector(".step-buttons") ?? btn.parentElement).appendChild(tick);
    if (stopAfterDownloadWanted()) api.post(`/api/runs/${id}/stop-after`, { on: true }).catch(() => {});
    tick.querySelector("input").addEventListener("change", (e) => {
      try {
        localStorage.setItem("stopAfterDownload", e.target.checked ? "1" : "0");
      } catch {
        // no storage
      }
      api.post(`/api/runs/${id}/stop-after`, { on: e.target.checked }).catch((err) => notice(`Could not set that: ${err.message}`, "bad"));
    });
  }
  let log = li.querySelector(".log");
  if (!log) {
    log = document.createElement("pre");
    log.className = "log";
    li.appendChild(log);
  }
  log.textContent = "";
  const bar = stepProgress(li, log);
  try {
    const result = await follow(id, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
      bar.line(line);
    });
    bar.finish(result.status);
    li.classList.remove("running");
    const stopWanted = Boolean(li.querySelector(".stop-after input")?.checked);
    li.querySelector(".stop-after")?.remove();
    if (result.status === "done") {
      step.done = true;
      // Requests wait under this model: they start now that it is here,
      // so the stop asked for is taken back; the queue's own box ends the bill.
      const waiting = plan.remote && stopWanted ? queueItems(model.id).length : 0;
      if (waiting) {
        api.post(`/api/runs/${id}/stop-after`, { on: false }).catch(() => {});
        log.textContent += `The machine stays up: ${waiting} request${waiting === 1 ? " waits" : "s wait"} in this model's queue and start${waiting === 1 ? "s" : ""} now. Tick "Stop the rented GPU when everything asked for here is made" under the queue to end the bill after them.\n`;
      }
      li.classList.add("done");
      li.querySelector(".num").textContent = "✓";
      btn.textContent = "Done";
      btn.className = "go ghost";
      // Re-check the machine so later steps and the try box see the new state.
      const fresh = await api.get(modelUrl(model.id));
      if (state.open === model.id) {
        for (const [i, s] of fresh.plan.steps.entries()) if (s.done) plan.steps[i].done = true;
        for (const [i, s] of plan.steps.entries()) {
          const el = $(`#steps .step[data-index="${i}"]`);
          if (s.done && el && !el.classList.contains("done")) {
            el.classList.add("done");
            el.querySelector(".num").textContent = "✓";
            const b = el.querySelector(".go");
            b.textContent = "Done";
            b.className = "go ghost";
            b.disabled = true;
          }
        }
        // The next step comes on show now that this one is done.
        const next = plan.steps.findIndex((s) => !s.done && !s.optional);
        if (next >= 0) $(`#steps .step[data-index="${next}"]`)?.removeAttribute("hidden");
        const still = plan.steps.filter((s, i) => !s.done && !s.optional && i > next).length;
        const later = $("#steps .steps-later");
        if (later) {
          if (next < 0 || !still) later.remove();
          else later.textContent = `Then ${still} more step${still === 1 ? "" : "s"}, shown when this one is done.`;
        }
        renderTry(model, plan);
      }
    } else {
      li.classList.add("failed");
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  } catch (err) {
    bar.finish("failed");
    li.classList.remove("running");
    li.classList.add("failed");
    log.textContent += `Lost the step: ${err.message}\n`;
    btn.disabled = false;
    btn.textContent = "Try again";
  }
}

// A progress bar over a step's log. Real when the log reports a percentage;
// while a new machine starts there is nothing to measure, so it advances
// on a guess (a fresh machine pulls a large image and takes a few minutes)
// and never claims to be done until the log says the machine is up.
const MACHINE_START_GUESS_S = 240;
function stepProgress(li, log) {
  let el = li.querySelector(".progress-wrap");
  if (!el) {
    el = document.createElement("div");
    el.className = "progress-wrap";
    el.innerHTML = `<div class="progress"><div class="fill"></div></div><div class="progress-text muted small"></div>`;
    li.insertBefore(el, log);
  }
  el.hidden = false;
  const fill = el.querySelector(".fill");
  const text = el.querySelector(".progress-text");
  const bar = el.querySelector(".progress");
  let timer = null;
  const set = (pct, words, mode = "") => {
    bar.className = `progress ${mode}`;
    fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    text.textContent = words;
  };
  const stopGuess = () => {
    clearInterval(timer);
    timer = null;
  };
  const startGuess = () => {
    if (timer) return;
    // A machine already running for a while is nearly there.
    const began = Date.now() - (state.rental?.uptimeSeconds ? state.rental.uptimeSeconds * 1000 : 0);
    const tick = () => {
      const elapsed = (Date.now() - began) / 1000;
      const pct = Math.min(92, (elapsed / MACHINE_START_GUESS_S) * 92);
      const left = Math.max(0, MACHINE_START_GUESS_S - elapsed);
      set(pct, left > 0 ? `Machine starting, about ${Math.ceil(left / 60)} min left (a guess; a new machine pulls a large image)` : "Machine starting, taking longer than usual", "guess");
    };
    tick();
    timer = setInterval(tick, 1000);
  };
  set(0, "Starting");
  // A download of many files: which one is on, out of how many, stays in
  // front of the percentage, and the bar runs over the whole set.
  let files = null;
  const lead = () => (files ? `File ${files.n} of ${files.of}` : "");
  return {
    line(line) {
      const file = /\bfile (\d+) of (\d+)(?::\s*(.*))?/i.exec(line);
      const pct = /(\d{1,3})% of ([\d.]+ GB)(?: \(([^)]+)\))?/.exec(line);
      if (file) {
        stopGuess();
        files = { n: Number(file[1]), of: Number(file[2]) };
        set(((files.n - 1) / files.of) * 100, `${lead()}${file[3] ? `: ${file[3]}` : ""}`, "busy");
        text.innerHTML = `<b class="progress-files">${esc(lead())}</b>${file[3] ? ` ${esc(file[3])}` : ""}`;
      } else if (pct) {
        stopGuess();
        const within = Number(pct[1]);
        set(files ? ((files.n - 1 + within / 100) / files.of) * 100 : within, `${pct[1]}% of ${pct[2]}${pct[3] ? `, ${pct[3]}` : ""}`);
        if (files) text.innerHTML = `<b class="progress-files">${esc(lead())}</b> ${esc(`${pct[1]}% of ${pct[2]}${pct[3] ? `, ${pct[3]}` : ""}`)}`;
      } else if (/Waiting for (the machine|Ollama on the machine) to start/.test(line)) startGuess();
      else if (/The machine is up\./.test(line)) {
        stopGuess();
        set(100, "Machine up; the download starts");
      } else if (/merging|Merging|Copying|Registering|already here/i.test(line)) {
        stopGuess();
        set(100, line, "busy");
      }
    },
    finish(status) {
      stopGuess();
      if (status === "done") set(100, "Done");
      else set(100, "Failed", "failed");
    },
  };
}

async function runStep(model, plan, index) {
  const step = plan.steps[index];
  const li = $(`#steps .step[data-index="${index}"]`);
  const btn = li.querySelector(".go");
  const before = plan.steps.slice(0, index).filter((s) => !s.done);
  if (before.length && !confirm(`Step ${index + 1} needs the earlier steps first. Run "${before[0].title}" now?`)) return;
  if (before.length) return runStep(model, plan, plan.steps.indexOf(before[0]));

  const what = step.command ? `HuggingFound will run:\n\n${step.command}\n\nContinue?` : `Run "${step.title}" now?`;
  if (!confirm(what)) return;
  // A step offered elsewhere (the reference part, from the clip window)
  // shows here while it runs, with its log.
  li.hidden = false;
  li.scrollIntoView?.({ behavior: "smooth", block: "center" });

  btn.disabled = true;
  btn.textContent = "Running";
  li.classList.add("running");
  let id;
  try {
    ({ id } = await api.post("/api/run", { kind: step.kind, args: step.args ?? {}, where: state.choice?.where ?? (plan.remote ? "rented" : "local"), model: model.id, title: step.title }));
  } catch (err) {
    li.classList.remove("running");
    li.classList.add("failed");
    let log = li.querySelector(".log");
    if (!log) {
      log = document.createElement("pre");
      log.className = "log";
      li.appendChild(log);
    }
    log.textContent += `Could not start: ${err.message}\n`;
    btn.disabled = false;
    btn.textContent = "Try again";
    return;
  }
  backgroundNote(li.parentElement?.parentElement ?? li, model, "The download runs");
  await followStep(model, plan, index, id);
}

function follow(id, onLine) {
  return new Promise((resolve, reject) => {
    const es = new EventSource(`/api/runs/${id}`);
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (data.done) {
        es.close();
        resolve(data);
      } else {
        onLine(data.line);
      }
    };
    es.onerror = () => {
      es.close();
      reject(new Error("Lost the connection to the running step"));
    };
  });
}

// ---- trying the model -----------------------------------------------------

function renderTry(model, plan) {
  const box = $("#try");
  if (!box) return;
  // An optional step (the reference part) is never in the way of trying the model.
  const ready = plan.steps.every((s) => s.done || s.optional);
  if (!ready) {
    const left = plan.steps.filter((s) => !s.done && !s.optional).length;
    // What was made with the model before stays on show here, whatever
    // the machine is doing now.
    box.innerHTML = `<p class="muted small">${left === plan.steps.length ? "Run the set-up steps and a try box appears here." : `${left} step${left === 1 ? "" : "s"} left before you can try it.`}</p><div id="kept"></div>`;
    renderKept(box, model.id);
    return;
  }
  if (plan.tryWith.kind === "chat") renderChat(box, plan.tryWith.model);
  if (plan.tryWith.kind === "image" || plan.tryWith.kind === "video") renderImage(box, plan.tryWith);
  if (plan.tryWith.kind === "transcribe") renderTranscribe(box, plan.tryWith);
  renderRemove(box, model, plan);
  renderAdvice(box, model.id);
}

// Models are gigabytes each; once tried, one click takes them off the disk.
function renderRemove(box, model, plan) {
  if (!plan.remove?.length) return;
  const head = box.querySelector("h3");
  const wrap = document.createElement("div");
  wrap.className = "try-head";
  head.replaceWith(wrap);
  wrap.appendChild(head);
  const btn = document.createElement("button");
  btn.className = "ghost remove";
  btn.id = "remove-model";
  btn.textContent = `Remove from ${plan.remote ? "the rented GPU" : "this computer"} (${plan.file.gb ? plan.file.gb.toFixed(1) + " GB" : "frees the download"})`;
  wrap.appendChild(btn);
  btn.addEventListener("click", async () => {
    if (!confirm(`Delete ${model.name} from ${plan.remote ? "the rented GPU" : "this computer"}? ${plan.remote ? "It frees that disk; the model" : "The runner stays installed; the model"} can be downloaded again any time.`)) return;
    btn.disabled = true;
    btn.textContent = "Removing";
    try {
      for (const item of plan.remove) await api.post("/api/remove", item);
      if (!state.hosted && !$("#local-body").hidden) renderStorage(["local"]).catch(() => {});
      const fresh = await api.get(modelUrl(model.id));
      if (state.open === model.id) {
        renderModel(fresh.model, fresh.plan, fresh.choice);
        notice(`${model.name} was removed from ${plan.remote ? "the rented GPU" : "this computer"}.`, "ok");
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Remove from this computer";
      alert(`Could not remove it: ${err.message}`);
    }
  });
}

// Everything on disk, rendered into the main page's section and the Settings
// list from one scan. Removing something rescans, so the free space is right.
async function renderStorage(targets = ["local", "settings"]) {
  const st = await api.get("/api/storage");
  state.storage = st;
  // Which repository a row belongs to, so a click can open it ready to use.
  const repoOfOllama = (name) => {
    const hf = /^hf\.co\/([^/:]+\/[^/:]+)/.exec(name);
    if (hf) return hf[1];
    const local = name.split(":")[0].toLowerCase();
    return st.files.find((f) => f.repo.split("/").pop().toLowerCase().replace(/-gguf$/, "") === local)?.repo ?? null;
  };
  const rows = [
    ...st.files.map((f) => ({ what: `${f.repo}/${f.file}`, gb: f.gb, open: f.repo, body: { kind: "file", repo: f.repo, file: f.file } })),
    ...st.ollama.map((m) => ({ what: `${m.name} (${st.ollamaRemote ? "on the chat server" : "Ollama"})`, gb: m.gb, open: repoOfOllama(m.name), body: { kind: "ollama", name: m.name } })),
  ];
  if (st.outputs > 0.001) rows.push({ what: "Generated pictures, transcripts and uploaded recordings", gb: st.outputs, body: { kind: "outputs" }, label: "Clear" });
  const summary = rows.length ? `${st.totalGb.toFixed(1)} GB in ${st.files.length + st.ollama.length} model${st.files.length + st.ollama.length === 1 ? "" : "s"}. Click a model to use it. Removing one keeps the runner; the model can be downloaded again later.` : "No models downloaded yet.";
  const list = rows.map((r, i) => `<li class="${r.open ? "openable" : ""}">${r.open ? `<button class="what link" data-open="${i}" title="Open ${esc(r.open)}">${esc(r.what)}</button>` : `<span class="what">${esc(r.what)}</span>`}<span class="size">${r.gb.toFixed(2)} GB</span><span class="row-actions">${r.open ? `<button class="primary use" data-open="${i}">Use</button>` : ""}<button class="ghost" data-remove="${i}">${r.label ?? "Remove"}</button></span></li>`).join("");
  const disk = st.disk.freeGb != null
    ? `<b>${st.disk.freeGb.toFixed(1)} GB free</b> of ${st.disk.totalGb.toFixed(0)} GB on this drive; models use ${st.totalGb.toFixed(1)} GB.<span class="bar"><i class="models" style="width:${Math.min(100, (st.totalGb / st.disk.totalGb) * 100).toFixed(2)}%"></i><i style="width:${Math.max(0, Math.min(100, ((st.disk.totalGb - st.disk.freeGb - st.totalGb) / st.disk.totalGb) * 100)).toFixed(2)}%"></i></span>`
    : "";
  renderDiskLine();

  const places = [];
  if (targets.includes("local")) {
    $("#local-body").hidden = false;
    $("#local-summary").textContent = summary;
    $("#disk-line").innerHTML = disk;
    $("#local-list").innerHTML = list;
    places.push($("#local-list"));
  }
  if (targets.includes("settings")) {
    $("#storage-total").textContent = summary;
    $("#storage-list").innerHTML = list;
    places.push($("#storage-list"));
  }
  for (const place of places) {
    for (const btn of place.querySelectorAll("button[data-open]")) {
      btn.addEventListener("click", () => {
        $("#settings").hidden = true;
        openModel(rows[Number(btn.dataset.open)].open);
      });
    }
    for (const btn of place.querySelectorAll("button[data-remove]")) {
      btn.addEventListener("click", async () => {
        const row = rows[Number(btn.dataset.remove)];
        const question = row.body.kind === "outputs" ? "Delete all generated pictures, transcripts and uploaded recordings?" : `Delete ${row.what} from this computer?`;
        if (!confirm(question)) return;
        btn.disabled = true;
        try {
          await api.post("/api/remove", row.body);
          // Refresh wherever the list is showing; the front-page section stays put until scanned.
          await renderStorage($("#local-body").hidden ? ["settings"] : ["local", "settings"]);
          if (state.open) openModel(state.open);
        } catch (err) {
          btn.disabled = false;
          alert(`Could not remove it: ${err.message}`);
        }
      });
    }
  }
}

// The free-space figure in the header follows the last scan.
function renderDiskLine() {
  const st = state.storage;
  const m = state.machine;
  if (state.hosted) {
    $("#machine-line").textContent = state.chatServer ? `Fit and speed are for your rented GPU (${state.chatServer.gpuGb} GB); speech models for a typical 16 GB laptop.` : "Fit and speed are for a typical 16 GB laptop.";
    return;
  }
  const free = st?.disk?.freeGb != null ? ` ${st.disk.freeGb.toFixed(0)} GB free on disk.` : "";
  const server = state.chatServer ? ` Chat models run on a server with a ${state.chatServer.gpuGb} GB GPU.` : "";
  $("#machine-line").textContent = `${m.os}, ${m.ramGb} GB memory, ${m.gpu}. Room for models up to about ${m.comfortableGb} GB.${free}${server}`;
}

$("#scan-local").addEventListener("click", async () => {
  const btn = $("#scan-local");
  btn.disabled = true;
  btn.textContent = "Scanning";
  try {
    await renderStorage();
  } catch (err) {
    notice(`Could not scan this computer: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Scan again";
  }
});

// ---- Claude's check ---------------------------------------------------------
// Small open models make mistakes a stronger model catches. A click sends
// one answer (with the question) or one picture (with its description) to
// Claude through the user's own Anthropic key, and the review streams in.

// Adds the "Ask Claude" button after `anchor`, with the box its review goes in.
// `payload()` builds the request when clicked; `saved` is an earlier review to show again.
function addCheck(anchor, { label, sent, payload, saved = "", onDone = null, after = null }) {
  const wrap = document.createElement("div");
  wrap.className = "check";
  wrap.innerHTML = `<button class="ghost check-go">${esc(label)}</button><div class="review" hidden><div class="review-head">Claude's check</div><div class="review-body"></div><div class="review-foot muted small"></div></div>`;
  anchor.after(wrap);
  const btn = wrap.querySelector(".check-go");
  const box = wrap.querySelector(".review");
  const body = wrap.querySelector(".review-body");
  const foot = wrap.querySelector(".review-foot");
  const scroller = wrap.closest(".messages");
  const show = (text, note) => {
    box.hidden = false;
    body.textContent = text;
    foot.textContent = note;
    btn.textContent = "Ask Claude again";
  };
  if (saved) show(saved, "Checked earlier by Claude.");
  btn.addEventListener("click", async () => {
    const creds = state.hosted ? hostedCredentials() ?? (state.claudeHosted?.saved ? {} : null) : {};
    if (state.hosted && !creds) {
      box.hidden = false;
      body.textContent = "";
      foot.innerHTML = `This needs an Anthropic API key: ${state.user ? "save one in Settings" : "sign in and save one in Settings"}, or enter one in the "Check an answer" panel${state.claudeHosted?.devCode ? ", or the dev code there" : ""}. Nothing is sent until you click.`;
      return;
    }
    if (!state.hosted && !state.claudeReady) {
      box.hidden = false;
      body.textContent = "";
      foot.innerHTML = `This needs an Anthropic API key. Nothing is sent until you click; then ${esc(sent)} go to Anthropic. <button class="ghost check-settings">Add a key in Settings</button>`;
      foot.querySelector(".check-settings").addEventListener("click", () => $("#open-settings").click());
      return;
    }
    btn.disabled = true;
    btn.textContent = "Claude is checking";
    box.hidden = false;
    body.textContent = "";
    foot.textContent = `Sent to Anthropic: ${sent}.`;
    let text = "";
    try {
      const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify(await payload()) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let end = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(plainOllamaError(j.error));
          if (j.text) {
            const stick = scroller ? nearBottom(scroller) : false;
            text += j.text;
            body.textContent = text;
            if (stick) scroller.scrollTop = scroller.scrollHeight;
          }
          if (j.done) end = j;
        }
      }
      if (end?.declined) {
        text = "";
        body.textContent = "";
        foot.textContent = end.note || "Claude declined to review this.";
      } else {
        foot.textContent = `Checked by ${end?.model ?? "Claude"}. ${end?.note ? end.note + " " : ""}Sent to Anthropic: ${sent}.`;
        if (text) {
          onDone?.(text);
          after?.(text, foot);
        }
      }
    } catch (err) {
      body.textContent = text;
      foot.textContent = `The check did not finish: ${err.message}`;
    } finally {
      btn.disabled = false;
      btn.textContent = "Ask Claude again";
    }
  });
  return wrap;
}

// On the hosted site a check is paid for by the visitor's own key, or by
// the owner's dev code. The key lives in this tab only; the code is kept
// in this browser. Returns the headers to send, or null when there are none.
function hostedCredentials() {
  const read = (store, name) => {
    try {
      return store.getItem(name) || "";
    } catch {
      return "";
    }
  };
  const write = (store, name, value) => {
    try {
      if (value) store.setItem(name, value);
      else store.removeItem(name);
    } catch {
      // no storage
    }
  };
  const key = $("#checker-key").value.trim();
  const code = $("#checker-code").value.trim();
  write(sessionStorage, "claude:key", key);
  write(localStorage, "claude:code", code);
  if (key) return { "X-Anthropic-Key": key };
  if (code) return { "X-Dev-Code": code };
  return read(sessionStorage, "claude:key") ? { "X-Anthropic-Key": read(sessionStorage, "claude:key") } : null;
}

// The hosted site runs no models, so the answer or picture to check is
// pasted or picked by the visitor.
function setupChecker() {
  try {
    $("#checker-key").value = sessionStorage.getItem("claude:key") || "";
    $("#checker-code").value = localStorage.getItem("claude:code") || "";
  } catch {
    // no storage
  }
  $("#checker-code-box").hidden = !state.claudeHosted?.devCode;
  if ($("#checker-code").value) $("#checker-code-box").open = true;
  const kind = () => document.querySelector("input[name=checker-kind]:checked").value;
  for (const radio of document.querySelectorAll("input[name=checker-kind]")) {
    radio.addEventListener("change", () => {
      $("#checker-text").hidden = kind() !== "text";
      $("#checker-image").hidden = kind() !== "image";
    });
  }
  const readPicture = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
  addCheck($("#checker-anchor"), {
    label: "Ask Claude to check this",
    sent: "what you entered here",
    payload: async () => {
      const model = $("#checker-model").value.trim();
      if (kind() === "text") {
        const answer = $("#checker-answer").value;
        if (!answer.trim()) throw new Error("Paste the model's answer first.");
        return { kind: "text", model, question: $("#checker-question").value, answer };
      }
      const file = $("#checker-file").files[0];
      if (!file) throw new Error("Pick the picture first.");
      if (file.size > 5 * 1024 * 1024) throw new Error("That picture is larger than 5 MB.");
      return { kind: "image", model, image: { media_type: file.type, data: await readPicture(file) }, prompt: $("#checker-prompt").value, negative: $("#checker-negative").value };
    },
  });
  const open = (model = "") => {
    if (model) $("#checker-model").value = model;
    $("#checker").hidden = false;
  };
  $("#open-checker").addEventListener("click", () => open());
  $("#close-checker").addEventListener("click", () => ($("#checker").hidden = true));
  state.openChecker = open;
}

// Conversations outlive the window. Closing it, re-drawing the try box after
// a step, or reloading the page brings the transcript back, and a reply that
// is still streaming keeps going and lands in the transcript.
const chats = new Map();
function chatFor(modelName) {
  let chat = chats.get(modelName);
  if (!chat) {
    let saved = [];
    try {
      saved = JSON.parse(localStorage.getItem(`chat:${modelName}`) || "[]");
    } catch {
      // no storage or a broken entry
    }
    chat = { messages: Array.isArray(saved) ? saved.filter((m) => m && m.role !== "system" && typeof m.content === "string") : [], reply: null, busy: false };
    // Claude's work on an answer that was still going when the page closed
    // cannot pick up again: it is kept as it stood, and said to be cut short.
    for (const m of chat.messages) {
      for (const job of Object.values(m.code ?? {})) if (job?.status === "running") Object.assign(job, { status: "failed", why: "the page was closed before Claude finished" });
      if (m.improve?.status === "running") Object.assign(m.improve, { status: "failed", foot: "The page was closed before this finished." });
    }
    chats.set(modelName, chat);
  }
  return chat;
}
function saveChat(modelName, chat) {
  const kept = chat.messages.filter((m) => m.role !== "system").slice(-200);
  try {
    localStorage.setItem(`chat:${modelName}`, JSON.stringify(kept));
  } catch {
    // Too much for the browser's store, most likely the files: kept by
    // name alone, so the conversation still reads; or no storage at all.
    try {
      localStorage.setItem(`chat:${modelName}`, JSON.stringify(kept.map((m) => (m.files?.length ? { ...m, files: m.files.map(({ name, size }) => ({ name, size })) } : m))));
    } catch {
      // no storage
    }
  }
}

// ---- files for a chat model ------------------------------------------------
// Code or text files go with a message, each under its name in a fenced
// block, so a coding model reads the project it is asked about. Binary
// files, build output and the like are left out; the message is capped so
// it still fits a window a model can hold.
const MAX_FILES = 60;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES_CHARS = 600 * 1000;
const SKIP_DIRS = /(^|\/)(node_modules|\.git|\.hg|\.svn|dist|build|out|target|coverage|\.next|\.nuxt|\.cache|\.venv|venv|env|__pycache__|\.idea|\.vscode|vendor|Pods|DerivedData)\//;
// Pictures, sound, archives, documents, fonts and model weights are left
// out; executables and other binaries are read, not run: their header and
// the readable strings inside them go to the model.
const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|icns|svgz?|mp[34]|m4[av]|wav|flac|ogg|webm|mov|avi|mkv|zip|gz|bz2|xz|7z|rar|tar|tgz|pdf|docx?|xlsx?|pptx?|ttf|otf|woff2?|eot|safetensors|gguf|ckpt|pt|pth|onnx|sqlite|db|lock|DS_Store)$/i;
const EXEC_EXT = /\.(exe|dll|sys|so(\.\d+)*|dylib|bin|elf|o|a|lib|class|pyc|pyo|wasm|dex|apk|ipa|efi|com|msi|out|dat)$/i;
const MAX_BINARY_BYTES = 64 * 1024 * 1024;
const ELF_MACHINES = { 3: "x86", 62: "x86-64", 40: "ARM", 183: "ARM64", 243: "RISC-V", 8: "MIPS", 20: "PowerPC", 21: "PowerPC64", 22: "s390" };
const PE_MACHINES = { 0x14c: "x86", 0x8664: "x86-64", 0x1c0: "ARM", 0xaa64: "ARM64", 0x200: "Itanium" };
function binaryDigest(bytes) {
  const b = bytes;
  const u16 = (i) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const u32 = (i) => ((b[i] ?? 0) | ((b[i + 1] ?? 0) << 8) | ((b[i + 2] ?? 0) << 16) | ((b[i + 3] ?? 0) << 24)) >>> 0;
  const starts = (...xs) => xs.every((x, i) => b[i] === x);
  let format = "not a known executable format";
  if (starts(0x7f, 0x45, 0x4c, 0x46)) {
    const type = { 1: "relocatable object", 2: "executable", 3: "shared library", 4: "core dump" }[u16(16)] ?? `type ${u16(16)}`;
    format = `ELF ${b[4] === 2 ? 64 : 32}-bit ${type}, ${ELF_MACHINES[u16(18)] ?? `machine ${u16(18)}`}, ${b[5] === 2 ? "big" : "little"}-endian`;
  } else if (starts(0x4d, 0x5a)) {
    const pe = u32(60);
    if (pe + 26 < b.length && b[pe] === 0x50 && b[pe + 1] === 0x45) format = `Windows PE${u16(pe + 24) === 0x20b ? "32+" : ""} ${u16(pe + 22) & 0x2000 ? "DLL" : "executable"}, ${PE_MACHINES[u16(pe + 4)] ?? `machine 0x${u16(pe + 4).toString(16)}`}, ${u16(pe + 6)} sections`;
    else format = "DOS MZ executable";
  } else if (starts(0xcf, 0xfa, 0xed, 0xfe) || starts(0xce, 0xfa, 0xed, 0xfe)) format = `Mach-O ${b[0] === 0xcf ? 64 : 32}-bit`;
  else if (starts(0xca, 0xfe, 0xba, 0xbe)) format = u32(4) < 0x100000 && b[7] <= 0x20 ? "Mach-O universal binary" : "Java class file";
  else if (starts(0x00, 0x61, 0x73, 0x6d)) format = "WebAssembly module";
  else if (starts(0x64, 0x65, 0x78, 0x0a)) format = "Android DEX";
  else if (starts(0x50, 0x4b)) format = "ZIP archive (a JAR, APK or wheel, say)";
  const dump = [];
  for (let i = 0; i < Math.min(b.length, 128); i += 16) dump.push(`${i.toString(16).padStart(8, "0")}  ${Array.from(b.slice(i, i + 16), (x) => x.toString(16).padStart(2, "0")).join(" ")}  ${Array.from(b.slice(i, i + 16), (x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : ".")).join("")}`);
  // Every readable run, once each; then the ones worth a model's reading
  // (paths, names, messages, keys) within a budget a model's window holds,
  // in the order they appear.
  const seen = new Set();
  const all = [];
  let run = "";
  for (let i = 0; i <= b.length; i++) {
    const c = b[i];
    if (i < b.length && c >= 32 && c < 127) {
      run += String.fromCharCode(c);
      continue;
    }
    if (run.length >= 6 && !seen.has(run)) {
      seen.add(run);
      all.push(run);
    }
    run = "";
  }
  const scored = all.map((text, at) => ({ text, at, score: stringScore(text) })).filter((x) => x.score > 0);
  scored.sort((x, y) => y.score - x.score || x.at - y.at);
  const kept = [];
  let chars = 0;
  for (const x of scored) {
    if (chars + x.text.length > MAX_STRINGS_CHARS) continue;
    chars += x.text.length + 1;
    kept.push(x);
  }
  kept.sort((x, y) => x.at - y.at);
  return `Executable or binary file, not run: read as its header and the readable strings inside it.\nFormat: ${format}\nSize: ${b.length} bytes\nFirst bytes:\n${dump.join("\n")}\nStrings (${kept.length} kept of ${all.length} distinct${kept.length < all.length ? ": the ones that read as words, names, paths, addresses, keys and messages; the rest look like data" : ""}):\n${kept.map((x) => x.text).join("\n")}`;
}
// How much a string from a binary is worth reading: nothing for letter
// salad and symbol soup; more for paths, addresses, registry keys, file
// names, API names, format strings, messages with words in them, and
// anything about hardware, licences, keys and identity.
const MAX_STRINGS_CHARS = 40000;
function stringScore(s) {
  const alnum = (s.match(/[A-Za-z0-9]/g) ?? []).length;
  if (alnum / s.length < 0.55) return 0;
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  const vowels = (s.match(/[aeiouAEIOU]/g) ?? []).length;
  if (letters >= 10 && vowels / letters < 0.24) return 0;
  if (/^[A-Za-z0-9+/=_-]{32,}$/.test(s) && !/\s/.test(s) && !/[\\/.]/.test(s)) return 0;
  // Letters and digits mixed in one run, no separators: a hash, a key, a code.
  if (/^[A-Za-z0-9]{12,}$/.test(s) && /\d/.test(s) && /[A-Za-z]/.test(s)) return 0;
  let score = 1;
  if (/[\\/]|https?:|www\.|\.(dll|exe|sys|so|dylib|ini|cfg|conf|json|xml|txt|log|dat|db|pdb|key|pem|lic)\b|HKEY_|SOFTWARE\\|CurrentVersion/i.test(s)) score += 3;
  if (/^_?[A-Za-z][a-z0-9]*(?:[A-Z][a-z0-9]+){1,}[AWEx]{0,2}$/.test(s) || /^[a-z_]+(?:_[a-z0-9]+)+$/.test(s)) score += 2;
  if (/hwid|hardware|serial|machine|guid|uuid|licen[cs]e|activation|expire|trial|register|token|auth|login|password|volume|bios|motherboard|wmi|Win32_|cpuid|mac ?address|fingerprint|identif/i.test(s)) score += 4;
  if (/\s/.test(s) && vowels >= 3) score += 2;
  if (/%[sdxulc]|\{\d\}|\{\}/.test(s)) score += 1;
  if (s.length > 240) score -= 1;
  return score;
}
// A token count near enough to plan a window by: words and runs of
// symbols each cost about a token, so a binary's strings, which are
// mostly symbols and letter salad, count far more than prose would.
function tokensOf(text) {
  const t = String(text ?? "");
  return Math.ceil(0.85 * (t.match(/[A-Za-z]{1,6}|\d{1,3}|[^\sA-Za-z\d]/g) ?? []).length + t.length / 50);
}
function sizeText(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}
async function readAttachments(list, folder) {
  const files = [];
  const skipped = [];
  let chars = 0;
  for (const file of Array.from(list ?? [])) {
    const name = file.webkitRelativePath || file.name;
    if (folder && SKIP_DIRS.test(name)) continue;
    if (folder && /(^|\/)\./.test(name) && !/\.(env\.example|gitignore|editorconfig|prettierrc|eslintrc)/.test(name)) continue;
    if (MEDIA_EXT.test(name)) {
      if (!folder) skipped.push(`${name} is not a text file`);
      continue;
    }
    if (files.length >= MAX_FILES) {
      skipped.push(`${name}: at most ${MAX_FILES} files at once`);
      continue;
    }
    // An executable (by its name, or by the bytes a text file never has)
    // is read as a digest: header and strings, nothing run.
    let text;
    let binary = false;
    if (EXEC_EXT.test(name) || (file.size <= MAX_FILE_BYTES && /\u0000/.test((text = await file.text()).slice(0, 8192)))) {
      if (folder && !EXEC_EXT.test(name)) continue;
      if (file.size > MAX_BINARY_BYTES) {
        skipped.push(`${name} is ${sizeText(file.size)}, more than ${sizeText(MAX_BINARY_BYTES)}`);
        continue;
      }
      text = binaryDigest(new Uint8Array(await file.arrayBuffer()));
      binary = true;
    } else if (file.size > MAX_FILE_BYTES) {
      skipped.push(`${name} is ${sizeText(file.size)}, more than ${sizeText(MAX_FILE_BYTES)}`);
      continue;
    }
    if (chars + text.length > MAX_FILES_CHARS) {
      skipped.push(`${name}: the files together would pass ${sizeText(MAX_FILES_CHARS)} of text`);
      continue;
    }
    chars += text.length;
    files.push({ name, size: file.size, text, ...(binary ? { binary: true } : {}) });
  }
  return { files, skipped };
}
function withFiles(text, files) {
  const blocks = files.map((f) => {
    const body = typeof f.text === "string" ? f.text : "(the contents were not kept)";
    const fence = "`".repeat(Math.max(3, (body.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 0)));
    return `### ${f.name}${f.binary ? " (an executable, read as its header and strings; not run)" : ""}\n${fence}${f.binary ? "text" : ((f.name.match(/\.(\w+)$/) ?? [])[1] ?? "")}\n${body}\n${fence}`;
  });
  return `Files attached (${files.length}):\n\n${blocks.join("\n\n")}\n\n${text}`;
}
// The window Ollama should hold for this request: nothing when its usual
// 4096 tokens do, otherwise the conversation and the answer's room, in
// steps of 4096 so the model is not reloaded for every message.
function contextFor(messages, answerTokens) {
  const tokens = messages.reduce((n, m) => n + tokensOf(m.content), 0) + 64;
  if (tokens + Math.min(answerTokens, 2048) <= 4096) return null;
  return Math.min(131072, Math.ceil(((tokens + answerTokens) * 1.15) / 4096) * 4096);
}
// A user bubble's files, folded under its words.
function showFiles(el, files) {
  const row = document.createElement("div");
  row.className = "msg-files";
  for (const f of files) {
    const d = document.createElement("details");
    d.className = "msg-file";
    const sm = document.createElement("summary");
    sm.textContent = `${f.name} · ${sizeText(f.size)}${f.binary ? " · read as header and strings" : ""}`;
    d.append(sm);
    const pre = document.createElement("pre");
    pre.textContent = typeof f.text === "string" ? f.text : "(the contents were not kept in this browser)";
    d.append(pre);
    row.append(d);
  }
  el.append(row);
}

// Scrolls a box to its end only when the reader was already there, so
// scrolling up through earlier messages is not undone by every new token.
function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

// ---- effort ---------------------------------------------------------------
// Every model can be asked to work harder or faster. For a chat model,
// thorough turns on its thinking pass (when it has one) and asks it to check
// its work; quick turns thinking off and keeps the answer short. Image
// models spend more steps; speech models search wider. The choice is kept
// per kind in this browser.
const CHAT_EFFORTS = {
  quick: { label: "Quick", hint: "no thinking, short answer", think: false, options: { num_predict: 1200 } },
  standard: { label: "Standard", hint: "the model's defaults", cap: 24576 },
  thorough: { label: "Thorough", hint: "thinks first, checks its work; slower and better", think: true, cap: 49152, system: "Take your time. Think the problem through step by step, consider what could go wrong, and check your work before you answer. Be thorough and precise." },
};
const OTHER_EFFORTS = {
  quick: { label: "Quick", hint: "fastest" },
  standard: { label: "Standard", hint: "the usual pass" },
  thorough: { label: "Thorough", hint: "slower, hears more" },
};
function savedEffort(kind) {
  try {
    const v = localStorage.getItem(`effort:${kind}`);
    return ["quick", "standard", "thorough"].includes(v) ? v : "standard";
  } catch {
    return "standard";
  }
}
function effortHtml(kind, table, note) {
  const current = savedEffort(kind);
  return `<div class="effort" data-kind="${kind}"><span class="effort-title">Effort</span>${Object.entries(table).map(([k, e]) => `<label class="${k === current ? "on" : ""}"><input type="radio" name="effort-${kind}" value="${k}" ${k === current ? "checked" : ""}> <b>${e.label}</b> <span class="muted">${esc(e.hint)}</span></label>`).join("")}${note ? `<small class="muted">${esc(note)}</small>` : ""}</div>`;
}
function wireEffort(box, kind) {
  const el = box.querySelector(`.effort[data-kind="${kind}"]`);
  if (!el) return;
  for (const input of el.querySelectorAll("input")) {
    input.addEventListener("change", () => {
      try {
        localStorage.setItem(`effort:${kind}`, input.value);
      } catch {
        // no storage
      }
      for (const label of el.querySelectorAll("label")) label.classList.toggle("on", label.contains(input));
    });
  }
}
function chosenEffort(box, kind) {
  return box.querySelector(`input[name="effort-${kind}"]:checked`)?.value ?? "standard";
}

function renderChat(box, modelName) {
  const chat = chatFor(modelName);
  box.dataset.model = modelName;
  let savedSystem = "";
  try {
    savedSystem = localStorage.getItem(`system:${modelName}`) || "";
  } catch {
    // no storage
  }
  box.innerHTML = `<h3>Try it</h3>
    <details class="instructions" ${savedSystem ? "open" : ""}>
      <summary>Instructions for the model</summary>
      <textarea id="chat-system" rows="2" placeholder="Who the model is and how it should answer, for example: You are a terse assistant that answers in plain English.">${esc(savedSystem)}</textarea>
      <small class="muted">Sent before every conversation as the system message; models follow this far more than a request typed into the chat. It sets a persona and rules, and it cannot change what a model was trained to refuse.</small>
    </details>
    ${effortHtml("chat", CHAT_EFFORTS, "")}
    ${claudeAvailable() ? `<label class="check handoff" title="Before your message goes to the model, Claude reads it and names the parts this model is likely to get wrong. The model writes the rest, says what it leaves to Claude, and leaves marked stubs; Claude can then write those parts from the button under the answer."><input type="checkbox" id="chat-handoff" ${handoffOn() ? "checked" : ""}> Hand the hard parts to Claude <small class="muted">for coding requests: the model writes what it can, Claude the rest</small></label>` : ""}
    <div class="chat">
      <div class="chat-tools"><span class="muted small">${chat.messages.length ? "The conversation is kept in this browser until you start a new one." : `Ask anything; the answer comes from ${esc(modelName)} on ${state.plan?.remote ? "the rented GPU" : "this computer"}.`}</span><span class="tools-row"><button class="ghost" id="chat-download" ${chat.messages.length ? "" : "hidden"}>Download</button><button class="ghost" id="chat-clear">New chat</button></span></div>
      <div class="messages" id="messages"></div>
      <div class="chat-progress" id="chat-progress" ${chat.busy ? "" : "hidden"}><div class="progress"><div class="fill"></div></div><div class="chat-progress-row"><span class="progress-text muted small"></span><button class="ghost" id="chat-stop">Stop</button></div><div class="chat-held" hidden></div></div>
      <div class="chat-attach"><button class="ghost" id="chat-attach-files" title="Code or text files the model reads with your message">Attach files</button><button class="ghost" id="chat-attach-folder" title="Every code and text file under a folder, leaving out node_modules, .git, build output and anything binary">Attach a folder</button><input type="file" id="chat-files" multiple hidden><input type="file" id="chat-folder" webkitdirectory multiple hidden><span class="chat-chips" id="chat-chips"></span></div>
      <div class="chat-input">
        <textarea id="chat-text" placeholder="Type a message" rows="2"></textarea>
        <button class="primary" id="chat-send" ${chat.busy ? "disabled" : ""}>Send</button>
      </div>
    </div>`;
  const list = $("#messages");
  const questionFor = (m) => {
    const at = chat.messages.indexOf(m);
    return chat.messages.slice(0, at).reverse().find((x) => x.role === "user")?.content ?? "";
  };
  // Each finished answer has one control: Claude checks it or revises it,
  // or another model revises it; the question is the user turn before it.
  const checkFor = (el, m) => {
    codeTools(el, m);
    if (m.chain?.length) {
      const chain = document.createElement("div");
      chain.className = "chain";
      chain.textContent = chainText(modelName, m.chain);
      el.after(chain);
      el = chain;
    }
    addImprove(el, {
      kind: "text",
      current: modelName,
      check: {
        sent: "your question and this answer",
        saved: m.review ?? "",
        payload: () => ({ kind: "text", model: modelName, question: questionFor(m), answer: m.content, system: chat.messages[0]?.role === "system" ? chat.messages[0].content : "" }),
        onDone: (text) => {
          m.review = text;
          saveChat(modelName, chat);
        },
      },
      context: () => ({ question: questionFor(m), answer: m.content, system: chat.messages[0]?.role === "system" ? chat.messages[0].content : "" }),
      memo: m,
      persist: () => saveChat(modelName, chat),
      onUse: (text, by, request) => {
        const revised = { role: "assistant", content: text, chain: [...(m.chain ?? []), { by, request }] };
        chat.messages.push(revised);
        saveChat(modelName, chat);
        const shown = addMsg("assistant", text);
        checkFor(shown, revised);
        list.scrollTop = list.scrollHeight;
      },
    });
  };
  for (const m of chat.messages) {
    if (m.role === "system") continue;
    const el = addMsg(m.role, m.content);
    if (m.role === "user" && m.files?.length) showFiles(el, m.files);
    if (m.role === "user" && m.handoff) showHandoff(el, m);
    if (m.role === "assistant" && (m.thinking || m.note)) {
      el.textContent = "";
      if (m.thinking) el.append(thinkingFold(m.thinking, false));
      const body = document.createElement("div");
      renderRich(body, m.content);
      el.append(...body.childNodes);
      if (m.note) {
        const n = document.createElement("p");
        n.className = "msg-note muted small";
        n.textContent = m.note;
        el.append(n);
      }
    }
    if (m.role === "assistant") checkFor(el, m);
  }
  if (chat.busy) {
    const out = addMsg("assistant", chat.reply ?? "");
    out.id = "chat-live";
    // A reply still coming shows as it stands: its thinking folded above it.
    if (chat.thinking) {
      out.textContent = "";
      out.append(thinkingFold(chat.thinking, !chat.reply));
      if (chat.reply) out.append(document.createTextNode(chat.reply));
    }
    if (!chat.reply && !chat.thinking) out.classList.add("pending");
  }
  list.scrollTop = list.scrollHeight;
  const messages = chat.messages;
  const mine = () => $("#try")?.dataset.model === modelName;
  const paint = (text, pending = false, thinking = "") => {
    const el = $("#chat-live");
    if (!el) return;
    const stick = nearBottom(el.parentElement);
    el.textContent = "";
    if (thinking) el.append(thinkingFold(thinking, !text));
    if (text) el.append(document.createTextNode(text));
    // Empty while the model thinks: the bubble keeps saying so.
    el.classList.toggle("pending", pending || (!text && !thinking));
    if (stick) el.parentElement.scrollTop = el.parentElement.scrollHeight;
  };
  // Painted at most a few times a second: a long think is thousands of
  // pieces, and drawing each would bog the page down.
  let paintTimer = null;
  let paintArgs = null;
  const paintSoon = (text, thinking) => {
    paintArgs = [text, false, thinking];
    if (paintTimer) return;
    paintTimer = setTimeout(() => {
      paintTimer = null;
      paint(...paintArgs);
    }, 200);
  };
  // The finished answer: its thinking folded above it, its pictures shown,
  // and a note when it stopped at the length limit.
  const paintFinal = (el, m) => {
    clearTimeout(paintTimer);
    paintTimer = null;
    el.textContent = "";
    el.classList.remove("pending");
    if (m.content) markMade();
    const body = document.createElement("div");
    renderRich(body, m.content);
    if (m.thinking) el.append(thinkingFold(m.thinking, false));
    el.append(...body.childNodes);
    if (m.note) {
      const n = document.createElement("p");
      n.className = "msg-note muted small";
      n.textContent = m.note;
      el.append(n);
    }
  };
  const send = async () => {
    if (chat.busy) return;
    const typed = $("#chat-text").value.trim();
    const files = chat.pending ?? [];
    if (!typed && !files.length) return;
    const text = typed || "Please read the attached files.";
    // A model that writes cannot draw; asking it for a picture gets an
    // apology and a description. Say so first, with the way to a model that can.
    if (!chat.pictureOk && asksForPicture(text) && ["text", "vision"].includes(makesOf(state.model ?? {}).kind)) {
      $("#messages").querySelector(".picture-note")?.remove();
      const note = document.createElement("div");
      note.className = "picture-note notice warn";
      note.innerHTML = `<b>${esc(modelName.split("/").pop())} writes text only.</b> It cannot make a picture; at most it describes one. <span class="tools-row"><button class="primary" id="note-images">Find an image model</button><button class="ghost" id="note-send">Send anyway</button><button class="ghost" id="note-dismiss">Never mind</button></span>`;
      $("#messages").appendChild(note);
      $("#messages").scrollTop = $("#messages").scrollHeight;
      note.querySelector("#note-images").addEventListener("click", () => {
        $("#modal").hidden = true;
        state.open = null;
        $("#nav-browse").click();
        document.querySelector('.tab[data-tab="images"]')?.click();
      });
      note.querySelector("#note-send").addEventListener("click", () => {
        chat.pictureOk = true;
        note.remove();
        send();
      });
      note.querySelector("#note-dismiss").addEventListener("click", () => note.remove());
      return;
    }
    $("#chat-text").value = "";
    chat.draft = "";
    const system = $("#chat-system").value.trim();
    try {
      localStorage.setItem(`system:${modelName}`, system);
    } catch {
      // no storage
    }
    if (system && messages[0]?.role !== "system") messages.unshift({ role: "system", content: system });
    else if (system) messages[0].content = system;
    else if (messages[0]?.role === "system") messages.shift();
    // The files go with the words, each under its name in a fenced block;
    // the bubble shows the words and the files folded under them.
    const userMsg = { role: "user", content: text, ...(files.length ? { files } : {}) };
    const asked = files.length ? withFiles(text, files) : text;
    chat.pending = [];
    drawChips();
    messages.push(userMsg);
    saveChat(modelName, chat);
    const userEl = addMsg("user", text);
    if (files.length) showFiles(userEl, files);
    $("#chat-download").hidden = false;
    const out = addMsg("assistant", "");
    out.id = "chat-live";
    out.classList.add("pending");
    chat.busy = true;
    state.chatBusy = (state.chatBusy ?? 0) + 1;
    chat.reply = "";
    chat.thinking = "";
    $("#chat-send").disabled = true;
    let reply = "";
    let thinking = "";
    // Stop ends the reply here; the machine is told by the dropped line.
    const ctl = new AbortController();
    chat.abort = () => ctl.abort();
    const effortName = chosenEffort(box, "chat");
    const meter = chatMeter(modelName, effortName);
    let done = null;
    try {
      meter.start();
      // The effort shapes this one request: a care instruction joins the
      // system message, thinking is turned on or off, the length capped.
      const effort = CHAT_EFFORTS[effortName] ?? CHAT_EFFORTS.standard;
      // Handing the hard parts to Claude: Claude names them first, and the
      // model is asked to write the rest and leave marked stubs for them.
      if ($("#chat-handoff")?.checked && claudeAvailable()) {
        meter.note("Claude is reading the request for the parts to leave to it");
        const plan = await claudeText({ kind: "code", mode: "handoff-plan", question: asked, model: modelName }, null, (st) => meter.note(st.status === "thinking" ? "Claude is reading the request for the parts to leave to it (thinking)" : "Claude is reading the request for the parts to leave to it"));
        const parts = parseHandoffParts(plan.text);
        userMsg.sent = handoffPrompt(asked, parts);
        userMsg.handoff = { parts, why: plan.text ? "" : plan.why };
        saveChat(modelName, chat);
        showHandoff(userEl, userMsg);
        meter.note("");
      }
      const sent = messages.map(({ role, content, sent: asSent, files: withF }) => ({ role, content: asSent ?? (withF?.length ? withFiles(content, withF) : content) }));
      if (effort.system) {
        if (sent[0]?.role === "system") sent[0] = { role: "system", content: `${sent[0].content}\n\n${effort.system}` };
        else sent.unshift({ role: "system", content: effort.system });
      }
      const body = { model: modelName, messages: sent };
      if (typeof effort.think === "boolean") body.think = effort.think;
      // Every reply has an end: a model thinking in circles stops at the cap
      // instead of holding the machine for hours.
      if (effort.options || effort.cap) body.options = { ...(effort.cap ? { num_predict: effort.cap } : {}), ...(effort.options ?? {}) };
      // A conversation longer than Ollama's usual window of 4096 tokens,
      // files attached or not, would have its start cut off in silence:
      // the window is set to hold it all, and the answer after it.
      const room = contextFor(sent, body.options?.num_predict ?? 2048);
      if (room) body.options = { ...(body.options ?? {}), num_ctx: room };
      // One request to the model, its words streamed into the bubble as they come.
      const run = async (reqBody) => {
        let res = await chatRequest(reqBody, ctl.signal);
        let why = res.ok ? "" : await res.text().catch(() => "");
        // A model without a thinking pass refuses the knob; ask again without it.
        if (!res.ok && "think" in reqBody && /think/i.test(why)) {
          delete reqBody.think;
          res = await chatRequest(reqBody, ctl.signal);
          why = res.ok ? "" : await res.text().catch(() => "");
        }
        if (!res.ok) {
          let explained = "";
          try {
            explained = String(JSON.parse(why)?.error ?? "");
          } catch {
            explained = "";
          }
          throw new Error(res.status === 403 && (chatDirect() || chatViaAgent()) ? refusedByMachine(why, messages.flatMap((m) => m.files ?? [])) : explained || `Ollama replied HTTP ${res.status}. Is it running and is the model downloaded?`);
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        let finished = null;
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            const j = JSON.parse(line);
            if (j.error) throw new Error(plainOllamaError(j.error));
            // The model's thinking comes apart from its answer: shown as it
            // comes, folded, so a long think is seen to be going on.
            const th = j.message?.thinking ?? "";
            const piece = j.message?.content ?? "";
            if (th) thinking += th;
            if (piece) reply += piece;
            if (th || piece) meter.token(piece ? "answer" : "thinking");
            if (j.done) finished = j;
            chat.reply = reply;
            chat.thinking = thinking;
            paintSoon(reply, thinking);
          }
        }
        return finished;
      };
      done = await run(body);
      // Thinking, and then no answer: the budget spent on it, the model
      // closing its thinking and stopping, or the stream ending without
      // a last line. Asked again at once to answer from its notes, with
      // thinking off, so the work is not lost; the thinking stays folded
      // above the answer.
      const silence = (d) => (d?.done_reason === "length" ? "length" : d ? "stop" : "cut");
      const first = silence(done);
      let fromNotes = "";
      if (!reply.trim() && thinking.trim()) {
        fromNotes = first;
        meter.note(first === "length" ? "It thought for the whole limit; asking it to answer from its notes" : "It thought but gave no answer; asking it to answer from its notes");
        const notes = thinking.trim().split(/\s+/).slice(-3000).join(" ");
        done = await run({ ...body, think: false, messages: [...sent, { role: "assistant", content: `My notes so far, before answering:\n${notes}` }, { role: "user", content: "Stop thinking and answer now, directly and completely, from your notes above. Where something is unknown, say what you would check next." }] });
        meter.note("");
      }
      const said = { role: "assistant", content: reply, ...(thinking ? { thinking } : {}) };
      // Stopped at the cap, or with nothing said: said, with the way on.
      const cap = body.options?.num_predict ?? "";
      const thought = { length: `It thought for the whole length limit (${cap} tokens) without starting the answer`, stop: `It finished thinking (about ${thinking.trim().split(/\s+/).length.toLocaleString()} words) and stopped without an answer`, cut: "Its reply ended during the thinking, before any answer" }[fromNotes];
      if (reply.trim()) {
        if (done?.done_reason === "length") said.note = `It stopped at the length limit of ${cap || "the model's"} tokens; ask it to go on.`;
        else if (fromNotes) said.note = `${thought}, so it was asked again to answer from its notes, with thinking off.`;
      } else if (fromNotes) said.note = `${thought}, was asked to answer from its notes with thinking off, and ${silence(done) === "length" ? "ran out again" : silence(done) === "cut" ? "its reply ended again" : "still said nothing"}. Ask at Quick, or narrow the question.`;
      else if (!done) said.note = thinking.trim() ? "Its reply ended during the thinking, before any answer. Ask again." : "The reply ended before the model said anything. Ask again; if it happens twice, stop and start the machine from the bar.";
      else if (done.done_reason === "length") said.note = `It reached the length limit (${cap} tokens) without saying anything. Ask at Quick, or narrow the question.`;
      else said.note = "The model ended its turn without saying anything. Ask again, or ask at Quick.";
      messages.push(said);
      saveChat(modelName, chat);
      meter.finish(done?.eval_count);
      const live = $("#chat-live");
      if (live && mine()) {
        const stick = nearBottom(live.parentElement);
        // The finished answer shows its pictures; while it streamed it was plain text.
        paintFinal(live, said);
        if (reply.trim()) checkFor(live, said);
        if (stick) live.parentElement.scrollTop = live.parentElement.scrollHeight;
      }
    } catch (err) {
      const stopped = ctl.signal.aborted;
      meter.finish(null, stopped ? "stopped" : "failed");
      paint(`${reply}${reply ? "\n\n" : ""}${stopped ? "Stopped." : `Something went wrong: ${err.message}`}`, false, thinking);
      if (reply) {
        messages.push({ role: "assistant", content: reply, ...(thinking ? { thinking } : {}) });
        saveChat(modelName, chat);
      }
    } finally {
      chat.busy = false;
      chat.abort = null;
      state.chatBusy--;
      chat.reply = null;
      chat.thinking = null;
      $("#chat-live")?.removeAttribute("id");
      if (mine()) $("#chat-send").disabled = false;
    }
  };
  wireEffort(box, "chat");
  $("#chat-handoff")?.addEventListener("change", (e) => {
    try {
      localStorage.setItem("handoff:chat", e.target.checked ? "1" : "");
    } catch {
      // no storage: the switch lasts as long as the window
    }
  });
  // Claude on a code answer: a check that fixes it, and, when the model
  // handed parts off, those parts written to fit. Each result can join the
  // conversation as Claude's version.
  function codeTools(el, m) {
    if (!claudeAvailable() || m.role !== "assistant" || !hasCode(m.content)) return;
    const asked = chat.messages.slice(0, chat.messages.indexOf(m)).reverse().find((x) => x.role === "user");
    const handed = /HANDOFF TO CLAUDE/i.test(m.content) || Boolean(asked?.handoff);
    const row = document.createElement("div");
    row.className = "code-tools";
    row.innerHTML = `<button class="ghost code-fix">Claude: check and fix the code</button>${handed ? `<button class="ghost code-finish">Claude: write the parts handed to it</button>` : ""}<div class="code-result" hidden><div class="code-head"></div><div class="code-progress" hidden><div class="progress"><div class="fill"></div></div><div class="progress-text muted small"></div></div><div class="code-body"></div><div class="code-foot muted small"></div></div>`;
    el.after(row);
    // This window's row is the one a running job draws into; a window
    // opened again takes over, and the job goes on drawing there.
    codeRows.set(m, row);
    const last = m.code?.lastMode;
    if (last && m.code[last]) drawCodeJob(m, last);
    row.querySelector(".code-fix").addEventListener("click", () => runCodeJob(m, "fix", asked));
    row.querySelector(".code-finish")?.addEventListener("click", () => runCodeJob(m, "finish", asked));
  }
  // Draws a code job from what is kept on the answer: its progress while it
  // runs, what Claude found or wrote, and the button to add its version.
  function drawCodeJob(m, mode) {
    const row = codeRows.get(m);
    const job = m.code?.[mode];
    if (!row?.isConnected || !job) return;
    const out = row.querySelector(".code-result");
    const head = out.querySelector(".code-head");
    const bar = out.querySelector(".code-progress");
    const body = out.querySelector(".code-body");
    const foot = out.querySelector(".code-foot");
    const running = job.status === "running";
    for (const b of row.querySelectorAll(":scope > button")) b.disabled = running;
    out.hidden = false;
    const fix = mode === "fix";
    head.textContent = running ? (fix ? "Claude is checking the code" : "Claude is writing the parts handed to it") : job.status === "failed" ? (fix ? "Claude's check" : "Claude's parts") : fix ? "Claude checked the code" : "Claude wrote the parts handed to it";
    const sep = fix ? "=== Corrected ===" : "=== Finished ===";
    const [lead, rest] = String(job.text ?? "").split(sep);
    body.textContent = (lead ?? "").trim();
    bar.hidden = !running;
    if (running) {
      const secs = Math.round((Date.now() - job.started) / 1000);
      const expect = Math.max(400, m.content.length * 1.1);
      const pct = Math.min(97, Math.round(((rest?.length ?? 0) / expect) * 100));
      bar.querySelector(".fill").style.width = `${job.text ? (rest == null ? 2 : pct) : 0}%`;
      bar.querySelector(".progress-text").textContent = !job.text ? (job.phase === "thinking" ? `Claude is thinking it through · ${secs} s` : `Waiting for Claude to start · ${secs} s`) : rest == null ? `Writing what it found · ${secs} s` : `Writing the ${fix ? "corrected" : "finished"} code · ${rest.split("\n").length} lines · about ${pct}% · ${secs} s`;
      foot.textContent = "Sent to Anthropic: your request and this answer.";
      return;
    }
    foot.textContent = "";
    if (job.status === "failed") {
      foot.textContent = `This did not finish: ${job.why}.`;
      return;
    }
    if (!rest?.trim()) {
      foot.textContent = "Claude gave no code with it.";
      return;
    }
    const add = useButton(job.added ? "Added below" : fix ? "Add the corrected version to the chat" : "Add the finished program to the chat", () => {
      const done = { role: "assistant", content: rest.trim(), chain: [...(m.chain ?? []), { by: "Claude", request: fix ? "checked and fixed the code" : "wrote the parts handed to it" }] };
      chat.messages.push(done);
      job.added = true;
      saveChat(modelName, chat);
      const shown = addMsg("assistant", done.content);
      checkFor(shown, done);
      list.scrollTop = list.scrollHeight;
      add.disabled = true;
      add.textContent = "Added below";
    });
    add.disabled = Boolean(job.added);
    foot.append(add);
  }
  async function runCodeJob(m, mode, asked) {
    m.code ??= {};
    const job = (m.code[mode] = { status: "running", text: "", phase: "waiting", started: Date.now() });
    m.code.lastMode = mode;
    drawCodeJob(m, mode);
    // The clock in the progress line moves while Claude says nothing.
    const tick = setInterval(() => drawCodeJob(m, mode), 1000);
    const got = await claudeText({ kind: "code", mode, model: modelName, question: asked?.content ?? "", answer: m.content }, (sofar) => {
      job.text = sofar;
      drawCodeJob(m, mode);
    }, (st) => {
      job.phase = st.status;
    });
    clearInterval(tick);
    Object.assign(job, got.text ? { status: "done", text: got.text } : { status: "failed", why: got.why });
    saveChat(modelName, chat);
    drawCodeJob(m, mode);
  }
  $("#chat-send").addEventListener("click", send);
  // Files for the model to read: chosen one by one or as a folder, shown
  // as chips until the message goes, with how much of the window they take.
  const drawChips = () => {
    const out = $("#chat-chips");
    if (!out) return;
    const files = chat.pending ?? [];
    out.innerHTML = files.map((f, i) => `<span class="chip" title="${esc(f.name)}${f.binary ? ", an executable read as its header and strings, not run" : ""}">${esc(f.name.split("/").pop())} <small>${esc(sizeText(f.size))}${f.binary ? ", binary" : ""}</small><button type="button" class="chip-off" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join("");
    if (files.length) {
      const tokens = files.reduce((n, f) => n + tokensOf(f.text), 0);
      const note = document.createElement("span");
      note.className = `muted small chip-note${tokens > 24000 ? " warn" : ""}`;
      note.textContent = `${files.length} file${files.length === 1 ? "" : "s"}, about ${tokens.toLocaleString()} tokens${tokens > 24000 ? "; more than most models hold at once, so the model may miss parts" : ""}`;
      out.appendChild(note);
    }
    for (const b of out.querySelectorAll(".chip-off")) b.addEventListener("click", () => {
      chat.pending.splice(Number(b.dataset.i), 1);
      drawChips();
    });
  };
  const takeFiles = async (list, folder) => {
    const { files, skipped } = await readAttachments(list, folder);
    chat.pending = [...(chat.pending ?? []), ...files].slice(0, MAX_FILES);
    drawChips();
    if (skipped.length) notice(`${skipped.length} file${skipped.length === 1 ? "" : "s"} left out: ${skipped.slice(0, 3).join("; ")}${skipped.length > 3 ? "; …" : ""}`, "warn");
    $("#chat-text")?.focus();
  };
  $("#chat-attach-files")?.addEventListener("click", () => $("#chat-files").click());
  $("#chat-attach-folder")?.addEventListener("click", () => $("#chat-folder").click());
  $("#chat-files")?.addEventListener("change", (e) => takeFiles(e.target.files, false).then(() => (e.target.value = "")));
  $("#chat-folder")?.addEventListener("change", (e) => takeFiles(e.target.files, true).then(() => (e.target.value = "")));
  drawChips();
  $("#chat-stop").addEventListener("click", () => chat.abort?.());
  $("#chat-download").addEventListener("click", () => {
    const lines = [`# ${modelName}`, ""];
    for (const m of chat.messages) {
      if (m.role === "system") lines.push(`_Instructions: ${m.content}_`, "");
      else lines.push(`**${m.role === "user" ? "You" : m.chain?.length ? chainText(modelName, m.chain) : modelName}:**${m.files?.length ? ` _(with ${m.files.map((f) => f.name).join(", ")})_` : ""}`, "", m.content, "");
    }
    saveText(`${modelName.replace(/[^\w.-]+/g, "-")}-conversation.md`, lines.join("\n"));
  });
  $("#chat-clear").addEventListener("click", () => {
    if (chat.busy) return;
    chat.messages.length = 0;
    chat.pending = [];
    saveChat(modelName, chat);
    renderChat(box, modelName);
    renderRemove(box, state.model, state.plan);
  });
  // What is being typed stays with the conversation while the window is away.
  $("#chat-text").value = chat.draft ?? "";
  $("#chat-text").addEventListener("input", (e) => (chat.draft = e.target.value));
  $("#chat-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

// The window row each answer's Claude work draws into, newest window first.
const codeRows = new WeakMap();

// Handing the hard parts of a coding request to Claude. Claude names them
// (Part lines); the model is asked to write the rest, say what it leaves,
// and leave a stub for each, marked so that Claude can find and write it.
function handoffOn() {
  try {
    return localStorage.getItem("handoff:chat") === "1";
  } catch {
    return false;
  }
}
function parseHandoffParts(text) {
  const parts = [];
  for (const raw of String(text ?? "").split("\n")) {
    const m = raw.replace(/[*_`]+/g, "").trim().match(/^(?:[-\u2022]\s*)?part\s*:\s*(.+)$/i);
    if (!m || /^none\.?$/i.test(m[1].trim())) continue;
    const [name, what = "", why = ""] = m[1].split("|").map((x) => x.trim());
    if (name) parts.push({ name, what, why });
  }
  return parts.slice(0, 4);
}
function handoffPrompt(text, parts) {
  const named = parts.length ? `Claude suggests leaving these to it:\n${parts.map((p) => `- ${p.name}${p.what ? `: ${p.what}` : ""}`).join("\n")}\nAlso leave any other part you are not confident you can get right.` : "Leave to Claude any part you are not confident you can get right.";
  return `${text}

---
How to do this: write every part you can do well, complete and runnable. Claude, a larger model, will write the hardest parts afterwards, so leave those to it instead of guessing.
${named}
For each part you leave to Claude:
1. Begin your answer by saying in a sentence or two which parts you are leaving to Claude and why.
2. In the code, write a stub with the exact name, parameters and return value that the rest of your code calls. Its body is a comment that starts with "HANDOFF TO CLAUDE: <the part's name>", followed by a method description: what it must do, its inputs and outputs, the edge cases, and how your code uses it.
3. Call the stub from your code as if it already worked, so that the program runs once Claude fills it in.`;
}
// Under a request sent this way: what Claude named, and the words the model got.
function showHandoff(el, m) {
  el.parentElement?.querySelector(`.handoff-note[data-for="${CSS.escape(String(m.content).slice(0, 40))}"]`)?.remove();
  const d = document.createElement("details");
  d.className = "handoff-note muted small";
  d.dataset.for = String(m.content).slice(0, 40);
  const parts = m.handoff?.parts ?? [];
  const summary = document.createElement("summary");
  summary.textContent = parts.length ? `Claude named the parts to leave to it: ${parts.map((p) => p.name).join(", ")}` : m.handoff?.why ? `Claude could not read the request (${m.handoff.why}); the model was asked to leave what it is unsure of` : "Claude found nothing this model should leave to it; the model may still leave what it is unsure of";
  const body = document.createElement("div");
  body.className = "handoff-body";
  body.textContent = `${parts.map((p) => `${p.name}: ${p.what}${p.why ? ` (${p.why})` : ""}`).join("\n")}${parts.length ? "\n\n" : ""}What the model was sent:\n${m.sent ?? m.content}`;
  d.append(summary, body);
  el.after(d);
}
const hasCode = (text) => /```|HANDOFF TO CLAUDE/i.test(String(text ?? ""));

// A reply's thinking, folded above its answer: the summary says how much,
// and opening it shows the text (the last part of it while it streams).
// Whether it is open is remembered for the next one.
function thinkingFold(text, live) {
  const d = document.createElement("details");
  d.className = "thinking";
  d.open = Boolean(state.showThinking);
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const summary = document.createElement("summary");
  summary.textContent = `${live ? "Thinking" : "Thought it through"} · about ${words.toLocaleString()} words`;
  const body = document.createElement("div");
  body.className = "thinking-text";
  body.textContent = live && text.length > 8000 ? `…${text.slice(-8000)}` : text;
  d.append(summary, body);
  d.addEventListener("toggle", () => (state.showThinking = d.open));
  if (live) requestAnimationFrame(() => (body.scrollTop = body.scrollHeight));
  return d;
}

// How far along a reply is. A model does not say how long its answer will
// be, so the share is a guess from this model's own past replies at this
// effort (the length it used, learned as it goes), with a first guess
// before there are any; the rate and the count are exact. Waiting with no
// first word is said too, with the way to free a machine held up by an
// earlier reply.
const CHAT_EXPECT = { quick: 350, standard: 2500, thorough: 6000 };
function chatMeter(model, effort) {
  const key = `chatTokens:${model}:${effort}`;
  let expected = 0;
  try {
    expected = Number(localStorage.getItem(key)) || 0;
  } catch {
    expected = 0;
  }
  const learned = expected > 0;
  if (!learned) expected = CHAT_EXPECT[effort] ?? 2500;
  let started = 0;
  let first = 0;
  let tokens = 0;
  let thought = 0;
  let phase = "thinking";
  let timer = null;
  let note = "";
  const draw = () => {
    const box = $("#chat-progress");
    if (!box) return;
    box.hidden = false;
    const now = performance.now();
    const text = box.querySelector(".progress-text");
    const fill = box.querySelector(".fill");
    const held = box.querySelector(".chat-held");
    if (!tokens) {
      const waited = (now - started) / 1000;
      fill.style.width = "0%";
      text.textContent = note ? `${note}, ${Math.round(waited)} s` : waited < 3 ? "Sending" : `Waiting for the model to start, ${Math.round(waited)} s`;
      if (!note && waited > 30 && held.hidden) chatHeld(held);
      return;
    }
    held.hidden = true;
    const secs = (now - first) / 1000;
    const rate = secs > 0.5 ? tokens / secs : 0;
    const over = tokens >= expected;
    const pct = over ? 97 : Math.min(97, Math.round((tokens / expected) * 100));
    fill.style.width = `${pct}%`;
    const left = !over && rate ? (expected - tokens) / rate : null;
    const what = phase === "thinking" ? "Thinking" : `Writing the answer${thought ? ` after ${thought.toLocaleString()} tokens of thinking` : ""}`;
    text.textContent = `${what} · ${tokens.toLocaleString()} tokens${rate ? `, ${Math.round(rate)} a second` : ""} · about ${pct}%${left != null ? `, ${shortDuration(left)} left` : ", longer than its replies usually run"}${learned ? "" : " (a first guess; it learns this model's lengths)"}`;
  };
  return {
    start() {
      started = performance.now();
      draw();
      timer = setInterval(draw, 500);
    },
    // Something before the model starts (Claude reading the request): said
    // in the row, and the wait for the model counted from its end.
    note(text) {
      note = text;
      if (!text) started = performance.now();
      draw();
    },
    token(kind) {
      if (!tokens) first = performance.now();
      tokens++;
      if (kind === "thinking") thought++;
      phase = kind;
    },
    finish(count, how = "done") {
      clearInterval(timer);
      const n = Number(count) || tokens;
      if (how === "done" && n > 0) {
        try {
          localStorage.setItem(key, String(learned ? Math.round(expected * 0.6 + n * 0.4) : n));
        } catch {
          // no storage: the first guess stays
        }
      }
      const box = $("#chat-progress");
      if (box) box.hidden = true;
    },
  };
}
// The model has not started: on a rented machine that is almost always an
// earlier reply still going there (the page that asked for it left, or it
// thinks at length), since Ollama answers one request at a time.
function chatHeld(held) {
  const r = state.rental;
  const rented = Boolean(r?.rented);
  const canFree = rented && r.agent && Number(r.agentVersion) >= 23;
  held.hidden = false;
  held.innerHTML = `<p class="muted small">${rented ? "The model has not started on this yet. The machine is most likely still busy with an earlier reply, one left running or a long think: it answers one request at a time. A model loading for the first time also takes a minute." : "The model has not started on this yet: it may be loading, or busy with an earlier reply."}</p>${canFree ? `<button class="ghost" id="chat-free">Free the machine</button>` : rented ? `<p class="muted small">To clear it, Stop and then Start the machine from the bar; its models stay.</p>` : ""}`;
  held.querySelector("#chat-free")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Freeing the machine";
    const res = await fetch(`${r.agent}/ollama/restart`, { method: "POST", headers: agentHeaders() }).catch(() => null);
    held.innerHTML = `<p class="muted small">${res?.ok ? "Freed: the machine's chat server was restarted and every reply on it dropped, this one too. Send your message again." : `Could not free it (${res ? `HTTP ${res.status}` : "no answer"}). Stop and then Start the machine from the bar.`}</p>`;
  });
}

// On the hosted site the browser talks to the rented GPU itself, so what is
// said to the model never passes through the site; on a computer the app's
// own server relays to Ollama.
// Ollama's own errors, in the words of what to do about them.
function plainOllamaError(text) {
  const m = /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/i.exec(String(text));
  if (m) return `This conversation comes to about ${Number(m[1]).toLocaleString()} tokens and the model holds ${Number(m[2]).toLocaleString()} at most. That is the model's own limit, and the window is already set as large as it goes, so the conversation has to get smaller: start a new chat with fewer or smaller files, or ask a model with a longer context (the model's card says how long).`;
  return String(text);
}
function chatDirect() {
  return Boolean(state.hosted && state.chatServer?.direct && state.chatServer.url);
}
// From image 28 the machine's agent carries the chat to Ollama, the
// request base64-wrapped: the proxy in front of a machine's addresses
// (Cloudflare, for RunPod's) blocks a plain request whose words look like
// attack code to a web firewall, as a binary file's strings do.
const CHAT_VIA_AGENT = 28;
function chatViaAgent() {
  // The rental's agent even when the site holds no chat address for the
  // machine. The agent's version is known once the machine has been
  // asked; until then the agent is tried, and an older image says 404.
  if (!state.hosted) return "";
  const agent = state.chatServer?.agent || (state.rental?.rented ? state.rental.agent : "") || "";
  const v = state.rental?.agentVersion;
  return agent && (v == null || Number(v) >= CHAT_VIA_AGENT) ? agent : "";
}
// On the hosted site a chat has to reach the machine itself; without an
// address for it the site's own route would only say so in a bare line.
function noChatRoute() {
  const r = state.rental;
  if (!r?.rented) return "No machine is rented, and the hosted site runs no models itself. Rent a GPU from the model's window, or run HuggingFound on your own computer.";
  return `The site has no address for the chat server on your machine (${r.id ?? "?"}, ${r.status ?? "status unknown"}${r.ready === false ? ", Ollama not answering the site's check" : ""}). Reload the page; if this stays, stop and start the machine from the bar, which saves its addresses again, or replace it.`;
}
function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
// What a 403 on the way to the machine means, from its body: a web
// firewall's page (Cloudflare's) means the request never reached the
// machine, most likely over an attached file's contents; anything else
// is Ollama refusing a page from an address it was not rented for.
function refusedByMachine(why = "", files = []) {
  if (/cloudflare|ray id|attention required|<html/i.test(why)) {
    const named = files.length ? `most likely over ${files.slice(0, 3).map((f) => f.name).join(", ")}${files.length > 3 ? " and the others" : ""}: a binary file's strings, or code, read like attack payloads to it, and the files go with every later message of the conversation` : "most likely over something in the conversation that read like an attack payload to it";
    return `The proxy in front of the machine (a web firewall, Cloudflare's) blocked this request before it reached the machine: HTTP 403, ${named}.${chatViaAgent() ? " Even carried by the machine's agent it was blocked; start a new chat without that file." : " A machine on the current image carries chats past that filter: replace the machine from the bar. Until then, start a new chat without that file."}`;
  }
  const site = state.siteOrigin && state.siteOrigin !== location.origin ? state.siteOrigin : "";
  return `The machine refused this page's address, ${location.origin} (HTTP 403 from Ollama there). A machine answers only the addresses it was rented for.${site ? ` This site's own address is ${site}: open it there and try again, or` : " It was rented before this address was allowed:"} replace the machine from the bar, and the new one accepts this address too.`;
}
function chatRequest(body, signal = null) {
  const direct = chatDirect();
  // The site is told only that the machine is in use, so it is not stopped as idle mid-conversation.
  if (direct) api.post("/api/rent/touch", {}).catch(() => {});
  const plain = () => fetch(direct ? `${state.chatServer.url}/api/chat` : "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), ...(signal ? { signal } : {}) });
  const agent = chatViaAgent();
  if (!agent && state.hosted && !direct) return Promise.reject(new Error(noChatRoute()));
  if (!agent) return plain();
  // An agent from before image 28 has no chat route: the plain way then.
  // A reply the browser could not read at all (the agent down, or the
  // proxy in front of it answering with a page of its own) is tried the
  // plain way too, when there is one; otherwise it is said for what it is.
  return fetch(`${agent}/chat`, { method: "POST", headers: { "Content-Type": "application/json", ...agentHeaders() }, body: JSON.stringify({ b64: base64Utf8(JSON.stringify({ ...body, stream: true })) }), ...(signal ? { signal } : {}) })
    .then((res) => (res.status === 404 || res.status === 405 ? plain() : res))
    .catch((err) => {
      if (signal?.aborted) throw err;
      if (direct) return plain().catch(() => Promise.reject(new Error(machineUnreachable(err))));
      throw new Error(machineUnreachable(err));
    });
}
function machineUnreachable(err) {
  return `The browser could not reach the machine (${err?.message || "no answer"}). Either the agent on it is not answering, or the proxy in front of the machine answered with a page of its own that the browser may not read: an outage, a block, or its limit of 100 seconds without a word. Open the Machine report from the bar; if the agent is not answering, stop and start the machine there.`;
}

// Hands the browser a file to save: a conversation, a transcript.
function saveText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "Made by A, revised by Claude (shorter), edited by B (darker sky)".
function chainText(first, chain) {
  return [`Made by ${first}`, ...chain.map((c) => `${c.verb ?? "revised"} by ${c.by}${c.request ? ` (${c.request})` : ""}`)].join(", ");
}

// Whether video models, LoRAs and adult models are on show: always on your
// own copy; on the hosted site once signed in, or a guest with an Anthropic
// key. The server decides and filters; the page only hides what it offers.
function fullAccess() {
  return !state.hosted || Boolean(state.access?.full);
}

// Whether Claude can be asked right now: a key in Settings, a saved key on
// the account, or one typed into the hosted checker.
function claudeAvailable() {
  if (!state.hosted) return Boolean(state.claudeReady);
  return Boolean(state.claudeHosted?.saved) || Boolean(hostedCredentials());
}

// ---- improving an output ------------------------------------------------------
// An answer or a picture can be handed on with a request for a change: to
// Claude, or to another model HuggingFound runs. Claude revises text itself
// and, for a picture, writes the edit for an image model that paints over
// it; another chat model revises text; another image model repaints. The
// chain of hands is kept with the result. This is how a model that cannot
// do something passes its work to one that can.

function textHelpers(current) {
  const out = [];
  if (claudeAvailable()) out.push({ id: "claude", label: "Claude (revises the answer)" });
  for (const m of state.runners?.ollama?.models ?? []) if (m !== current) out.push({ id: `model:${m}`, label: `${m}, another model on ${state.plan?.remote ? "the rented GPU" : "this computer"}` });
  return out;
}

// Image models downloaded here, for repainting a picture (img2img). Only
// this computer has them; a rented GPU runs chat models.
function downloadedImageModels() {
  if (state.hosted) return [];
  const sd = new Set([...(state.models ?? []), ...(state.picks ?? [])].filter((m) => (m.runner?.id ?? m.runner) === "sd").map((m) => m.id));
  return (state.runners?.models ?? [])
    .map((key) => {
      const parts = key.split("/");
      return { repo: parts.slice(0, 2).join("/"), file: parts.slice(2).join("/") };
    })
    .filter((f) => sd.has(f.repo) && /\.(safetensors|gguf|ckpt)$/i.test(f.file) && !f.file.includes("/"));
}

function imageHelpers(context = {}) {
  const out = [];
  if (claudeAvailable()) out.push({ id: "claude", label: "Claude (looks at it and writes the edit for an image model)" });
  if (context.agent) out.push({ id: `agent:${context.repo}|${context.modelFile}`, label: `${context.modelFile} on the rented GPU (paints over it)` });
  else for (const f of downloadedImageModels()) out.push({ id: `image:${f.repo}|${f.file}`, label: `${f.file} (paints over it)` });
  return out;
}

// Adds one control after `anchor`: "Improve or check". Its first choice is
// Claude checking the output (pointing out mistakes, changing nothing); the
// others revise it. `context()` gives what a helper needs; `check` holds
// what the check sends and what to do with it; `onUse(text, by, request)`
// takes a revised answer; `onImage(file, by, request)` an edited picture.
// `memo` (a chat answer) keeps what this control is doing and has done, so
// a window opened again shows it as it stands, still moving while it runs;
// `persist` saves the conversation once it has finished.
const improveDraws = new WeakMap();
function addImprove(anchor, { kind, current, context, check = null, onUse = null, onImage = null, memo = null, persist = () => {} }) {
  const helpers = kind === "text" ? textHelpers(current) : imageHelpers(context());
  if (check && claudeAvailable()) helpers.unshift({ id: "claude-check", label: kind === "text" ? "Claude checks it (points out mistakes, changes nothing)" : "Claude checks it (how well it matches, what to ask for instead)" });
  const wrap = document.createElement("div");
  wrap.className = "improve-wrap";
  const choices = helpers.length ? helpers.map((h) => `<option value="${esc(h.id)}">${esc(h.label)}</option>`).join("") : `<option value="">${state.hosted ? "Sign in and save an Anthropic key, or download another model, to have someone look at this" : kind === "text" ? "Add an Anthropic key in Settings, or download a second chat model, to have someone look at this" : "Add an Anthropic key in Settings, or download an image model, to have someone look at this"}</option>`;
  wrap.innerHTML = `<button class="ghost improve-go">${check ? "Improve or check" : "Improve this"}</button>
    <div class="improve" hidden>
      <div class="row"><label class="muted small">Done by</label><select class="improve-by" ${helpers.length ? "" : "disabled"}>${choices}</select><button class="primary improve-run" ${helpers.length ? "" : "disabled"}>Go</button></div>
      <textarea class="improve-request" rows="2" placeholder="${kind === "text" ? "What should change? For example: make it shorter, fix the loop, answer in French" : "What should change? For example: make the sky darker, remove the second person, turn it into a watercolour"}"></textarea>
    </div>
    <div class="review" hidden><div class="review-head"></div><div class="review-body"></div><div class="review-foot muted small"></div></div>`;
  anchor.after(wrap);
  const form = wrap.querySelector(".improve");
  const btn = wrap.querySelector(".improve-go");
  const box = wrap.querySelector(".review");
  const head = wrap.querySelector(".review-head");
  const body = wrap.querySelector(".review-body");
  const foot = wrap.querySelector(".review-foot");
  const select = wrap.querySelector(".improve-by");
  const request = wrap.querySelector(".improve-request");
  const scroller = wrap.closest(".messages");
  // For a check the request is optional: what to pay attention to.
  const syncPlaceholder = () => {
    if (select.value === "claude-check") request.placeholder = "Anything to look at in particular? (optional)";
  };
  select.addEventListener("change", syncPlaceholder);
  syncPlaceholder();
  // Drawn from what the answer keeps: the newest window is the one drawn.
  const runBtn = wrap.querySelector(".improve-run");
  const drawKept = () => {
    const st = memo?.improve;
    if (!st || !wrap.isConnected) return;
    box.hidden = false;
    head.textContent = st.head;
    body.textContent = st.body;
    foot.textContent = st.foot;
    runBtn.disabled = st.status === "running";
    if (st.status === "done" && st.useText && onUse) foot.prepend(useButton("Use this as the answer", () => onUse(st.useText, st.useBy, st.request)));
  };
  if (memo) improveDraws.set(memo, drawKept);
  if (memo?.improve) drawKept();
  else if (check?.saved) {
    box.hidden = false;
    head.textContent = "Claude's check";
    body.textContent = check.saved;
    foot.textContent = "Checked earlier by Claude.";
  }
  btn.addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (!form.hidden) request.focus();
  });
  wrap.querySelector(".improve-run").addEventListener("click", async () => {
    const ask = request.value.trim();
    const by = select.value;
    if (!by || (by !== "claude-check" && !ask)) {
      request.focus();
      return;
    }
    const run = wrap.querySelector(".improve-run");
    run.disabled = true;
    box.hidden = false;
    body.textContent = "";
    foot.innerHTML = "";
    // What this run writes here is copied onto the answer as it goes, and
    // into a window opened again meanwhile.
    const st = memo ? (memo.improve = { status: "running", by, request: ask, head: "", body: "", foot: "" }) : null;
    const sync = () => {
      if (!st) return;
      Object.assign(st, { head: head.textContent, body: body.textContent, foot: foot.textContent });
      const draw = improveDraws.get(memo);
      if (draw && draw !== drawKept) draw();
    };
    const syncing = st ? setInterval(sync, 300) : null;
    try {
      if (by === "claude-check") await checkWithClaude({ ...check, focus: ask, head, body, foot, scroller });
      else if (by === "claude") await improveWithClaude({ kind, request: ask, context: context(), head, body, foot, onUse, onImage });
      else if (by.startsWith("model:")) await improveWithModel({ model: by.slice(6), request: ask, context: context(), head, body, foot, onUse });
      else if (by.startsWith("image:") || by.startsWith("agent:")) {
        const [repo, file] = by.slice(6).split("|");
        await repaint({ repo, file, request: ask, context: context(), prompt: `${context().prompt}, ${ask}`, negative: context().negative, strength: 0.55, head, body, foot, onImage });
      }
    } catch (err) {
      foot.textContent = `This did not finish: ${err.message}`;
      if (st) st.failed = true;
    } finally {
      run.disabled = false;
      if (st) {
        clearInterval(syncing);
        sync();
        st.status = st.failed ? "failed" : "done";
        delete st.failed;
        // A revision can be taken as the answer from a window opened later too.
        if (st.status === "done" && kind === "text" && by !== "claude-check" && body.textContent.trim()) Object.assign(st, { useText: body.textContent.trim(), useBy: by === "claude" ? "Claude" : by.slice(6) });
        persist();
        const draw = improveDraws.get(memo);
        if (draw && draw !== drawKept) draw();
      }
    }
  });
  return wrap;
}

// Reads a streamed NDJSON reply line by line.
async function readLines(res, onLine) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) if (line.trim()) onLine(JSON.parse(line));
  }
}

function useButton(label, onClick) {
  const b = document.createElement("button");
  b.className = "ghost";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// Claude's check: the output goes to Claude with the person's own key, and
// the review streams in. Nothing is sent until the person asks.
async function checkWithClaude({ sent, payload, focus = "", onDone = null, after = null, head, body, foot, scroller = null }) {
  const creds = state.hosted ? hostedCredentials() ?? (state.claudeHosted?.saved ? {} : null) : {};
  if (state.hosted && !creds) throw new Error(`This needs an Anthropic API key: ${state.user ? "save one in Settings" : "sign in and save one in Settings"}, or enter one in the Check an answer panel.`);
  head.textContent = "Claude's check";
  foot.textContent = `Sent to Anthropic: ${sent}.`;
  const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify({ ...(await payload()), ...(focus ? { focus } : {}) }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  let text = "";
  let end = null;
  await readLines(res, (j) => {
    if (j.error) throw new Error(j.error);
    if (j.text) {
      const stick = scroller ? nearBottom(scroller) : false;
      text += j.text;
      body.textContent = text;
      if (stick) scroller.scrollTop = scroller.scrollHeight;
    }
    if (j.done) end = j;
  });
  if (end?.declined) {
    body.textContent = "";
    foot.textContent = end.note || "Claude declined to review this.";
    return;
  }
  foot.textContent = `Checked by ${end?.model ?? "Claude"}. ${end?.note ? end.note + " " : ""}Sent to Anthropic: ${sent}.`;
  if (text) {
    onDone?.(text);
    after?.(text, foot);
  }
}

async function improveWithClaude({ kind, request, context, head, body, foot, onUse, onImage }) {
  const creds = state.hosted ? hostedCredentials() ?? {} : {};
  head.textContent = kind === "text" ? "Claude's revision" : "Claude's edit, for an image model";
  foot.textContent = `Sent to Anthropic: ${kind === "text" ? "your question, the answer and your request" : "the picture, its description and your request"}.`;
  const payload = kind === "text" ? { kind: "text", mode: "edit", request, model: context.model, question: context.question, answer: context.answer, system: context.system } : { kind: "image", mode: "edit", request, model: context.model, file: context.file, prompt: context.prompt, negative: context.negative };
  const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  let text = "";
  let end = null;
  await readLines(res, (j) => {
    if (j.error) throw new Error(j.error);
    if (j.text) {
      text += j.text;
      body.textContent = text;
    }
    if (j.done) end = j;
  });
  if (end?.declined) {
    body.textContent = "";
    foot.textContent = end.note || "Claude declined.";
    return;
  }
  foot.textContent = `By ${end?.model ?? "Claude"}. ${end?.note ?? ""}`.trim();
  if (kind === "text" && onUse && text.trim()) {
    foot.prepend(useButton("Use this as the answer", () => onUse(text.trim(), "Claude", request)));
    return;
  }
  if (kind === "image") {
    const description = /^Description:\s*(.+)$/m.exec(text)?.[1]?.trim();
    const avoid = /^Avoid:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
    const keep = Number(/^Keep:\s*(\d+)/m.exec(text)?.[1]);
    if (!description) return;
    const strength = Number.isFinite(keep) ? Math.min(0.9, Math.max(0.1, 1 - keep / 100)) : 0.55;
    const models = context.agent ? [{ repo: context.repo, file: context.modelFile }] : downloadedImageModels();
    for (const f of models) {
      foot.prepend(useButton(`Edit with ${f.file}${context.agent ? " on the rented GPU" : ""}`, () => repaint({ repo: f.repo, file: f.file, request, context, prompt: description, negative: avoid, strength, head, body, foot, onImage, planned: true })));
    }
    foot.prepend(useButton("Use this description for a new picture", () => {
      if ($("#image-prompt")) $("#image-prompt").value = description;
      if ($("#image-negative") && avoid) $("#image-negative").value = avoid;
      $("#image-prompt")?.focus();
    }));
    if (!models.length) foot.append(" No image model is downloaded here to do the edit; the description above works for a new picture.");
  }
}

// Another chat model revises the answer: the same chat call, with the
// first model's answer and the request laid out for it.
async function improveWithModel({ model, request, context, head, body, foot, onUse }) {
  head.textContent = `${model}'s revision`;
  foot.textContent = `${model} is working`;
  const messages = [
    { role: "system", content: "You revise answers written by another assistant. The user shows their original request, the answer they got, and what should change. Make that change, keep everything else, and reply with only the revised answer, complete and ready to use in place of the old one. No preamble or commentary." },
    { role: "user", content: `My request was:\n\n${context.question || "(not kept)"}\n\nThe answer I got:\n\n${context.answer}\n\nChange this: ${request}\n\nReply with only the revised answer.` },
  ];
  const res = await chatRequest({ model, messages });
  if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}. Is ${model} downloaded?`);
  let text = "";
  await readLines(res, (j) => {
    if (j.error) throw new Error(j.error);
    text += j.message?.content ?? "";
    body.textContent = text;
  });
  foot.textContent = `By ${model}.`;
  if (onUse && text.trim()) foot.prepend(useButton("Use this as the answer", () => onUse(text.trim(), model, request)));
}

// An image model paints over the picture from a description (img2img),
// on this computer, and the result lands under the original.
async function repaint({ repo, file, request, context, prompt, negative, strength, head, body, foot, onImage, planned = false }) {
  head.textContent = `Edited by ${file}`;
  body.textContent = "";
  const log = document.createElement("pre");
  log.className = "log";
  body.appendChild(log);
  foot.textContent = planned ? `Painting over the picture from Claude's description, keeping about ${Math.round((1 - strength) * 100)}% of it.` : "Painting over the picture.";
  if (context.agent) {
    const image = await agentPicture(context.agent, { repo, file, prompt, negative, quality: state.plan?.qualities?.default, init: context.data, strength }, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    });
    foot.textContent = `By ${file}, on the rented GPU.`;
    onImage?.(null, file, request, { prompt, negative, planned, data: image });
    return;
  }
  const { id } = await api.post("/api/run", { kind: "edit-image", args: { repo, file, init: context.file, prompt, negative, strength, quality: "default" } });
  const result = await follow(id, (line) => {
    log.textContent += line + "\n";
    log.scrollTop = log.scrollHeight;
  });
  if (result.status !== "done" || !result.result) throw new Error("the edit did not finish");
  foot.textContent = `By ${file}.`;
  onImage?.(result.result, file, request, { prompt, negative, planned });
}

// Whether a message asks for a picture rather than words.
function asksForPicture(text) {
  return /\b(generate|create|make|draw|paint|render|show|give|send|produce|design|sketch)\b[^.?!]{0,40}\b(image|images|picture|pictures|photo|photos|photograph|drawing|painting|illustration|artwork|logo|wallpaper|portrait|selfie|meme|icon)\b/i.test(text) || /\b(image|picture|photo) of\b/i.test(text) || /\b(draw|paint|sketch) (me|a|an|the)\b/i.test(text);
}

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (role === "assistant") renderRich(el, text);
  else el.textContent = text;
  $("#messages").appendChild(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el;
}

// A model's answer may carry pictures: a Markdown image, or a bare address
// ending in an image type. Those show as the picture itself, with the
// alt text as its caption; everything else stays plain text. Only the
// browser fetches the picture, from wherever the model pointed.
const IMAGE_MD = /!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const IMAGE_URL = /https?:\/\/[^\s<>"')]+?\.(?:png|jpe?g|webp|gif)(?:\?[^\s<>"')]*)?/gi;
function renderRich(el, text) {
  el.textContent = "";
  const pieces = [];
  let last = 0;
  for (const m of String(text).matchAll(IMAGE_MD)) {
    pieces.push({ text: text.slice(last, m.index) });
    pieces.push({ url: m[2], alt: m[1] });
    last = m.index + m[0].length;
  }
  pieces.push({ text: text.slice(last) });
  for (const piece of pieces) {
    if (piece.url) {
      el.appendChild(pictureLink(piece.url, piece.alt));
      continue;
    }
    let from = 0;
    for (const m of piece.text.matchAll(IMAGE_URL)) {
      el.appendChild(document.createTextNode(piece.text.slice(from, m.index)));
      el.appendChild(pictureLink(m[0], ""));
      from = m.index + m[0].length;
    }
    el.appendChild(document.createTextNode(piece.text.slice(from)));
  }
}

function pictureLink(url, alt) {
  const a = document.createElement("a");
  a.className = "msg-image";
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  const img = document.createElement("img");
  img.src = url;
  img.alt = alt;
  img.loading = "lazy";
  img.referrerPolicy = "no-referrer";
  // A picture that will not load falls back to the address it came from.
  img.addEventListener("error", () => {
    a.textContent = url;
  });
  a.appendChild(img);
  if (alt) {
    const cap = document.createElement("span");
    cap.className = "caption";
    cap.textContent = alt;
    a.appendChild(cap);
  }
  return a;
}

function qualityLabel(q, info, fast) {
  const names = { fast: "Fast", default: "Default", max: "Max" };
  // On the rented GPU each preset says what it costs: the measured time
  // here if there is one, else the preset's guess, at the machine's price.
  const repo = state.plan?.tryWith?.repo;
  const measured = repo ? tookSeconds(repo, q) : null;
  const seconds = measured ?? info.seconds;
  const price = state.plan?.remote && state.rental?.rented ? state.rental.costPerHour : null;
  const cost = price && seconds ? `, about ${esc(shortDuration(seconds))} and ${money((price * seconds) / 3600)} of machine time${measured ? " (measured)" : ""}` : seconds ? `, about ${esc(shortDuration(seconds))}` : "";
  // The diffusers presets say what they make in their own words.
  if (info.text) return `<b>${names[q]}</b> <span class="muted">${esc(info.text)}, ${info.steps} steps${cost}</span>`;
  const what = fast ? `${info.steps} steps` : q === "default" ? `${info.steps} steps, the standard settings` : q === "fast" ? `${info.steps} steps, sharper sampler` : `${info.steps} steps, for the most detail`;
  return `<b>${names[q]}</b> <span class="muted">${what}${cost}</span>`;
}

function shortDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0).replace(/\.0$/, "")} min`;
}

function renderImage(box, t) {
  const plan = state.plan;
  let saved = "default";
  let level = "medium";
  try {
    saved = localStorage.getItem("imageQuality") || "default";
    level = localStorage.getItem("videoLevel") || "medium";
  } catch {
    // no storage
  }
  const video = t.kind === "video";
  // A clip is asked for by length and quality; a picture by preset.
  const spec = video && plan?.video ? plan.video : null;
  // Beyond what the model makes in one shot, a clip is made as pieces,
  // each from the last frame of the one before, when the model can start
  // from a picture; up to a minute.
  const longMax = spec ? (t.startPicture ? Math.min(60, spec.maxSeconds * 6) : spec.maxSeconds) : 0;
  // Two kinds of clip, chosen apart: a short one, which is one shot, and a
  // long one, which is pieces joined. The kind and the length asked for
  // each are kept.
  const canLong = Boolean(spec) && longMax > spec.maxSeconds;
  // A scene: Claude lays a sequence of events out as shots, each with its
  // own description and length, made as pieces are.
  const canScene = canLong && claudeAvailable();
  const sceneMin = spec ? Math.min(longMax, spec.minSeconds * 2) : 0;
  let clipKind = "short";
  let longSeconds = 30;
  let sceneSeconds = 30;
  try {
    const k = localStorage.getItem("clipKind");
    if (canLong && k === "long") clipKind = "long";
    if (k === "scene") clipKind = canScene ? "scene" : canLong ? "long" : "short";

    longSeconds = Number(localStorage.getItem(`longSeconds:${t.repo}`)) || 30;
    sceneSeconds = Number(localStorage.getItem(`sceneSeconds:${t.repo}`)) || 30;
  } catch {
    // no storage
  }
  if (spec) {
    longSeconds = Math.min(longMax, Math.max(spec.maxSeconds + 1, Math.round(longSeconds)));
    sceneSeconds = Math.min(longMax, Math.max(sceneMin, Math.round(sceneSeconds)));
  }
  let shortSeconds = spec?.defaultSeconds ?? 0;
  const lengthRange = (kind) => (kind === "scene" ? { min: sceneMin, max: longMax, value: sceneSeconds } : kind === "long" ? { min: spec.maxSeconds + 1, max: longMax, value: longSeconds } : { min: spec.minSeconds, max: spec.maxSeconds, value: shortSeconds });
  const lengthHelp = (kind) => (kind === "scene" ? `${sceneMin} to ${longMax} s in all. Claude splits it into shots of ${spec.minSeconds} to ${spec.maxSeconds} s, which you check first.` : kind === "long" ? `${spec.maxSeconds + 1} to ${longMax} s, made from your words in pieces of up to ${spec.maxSeconds} s, joined.` : `${spec.minSeconds} to ${spec.maxSeconds} s, one continuous shot${spec.sound ? " with sound" : ""}.`);
  const qualities = plan?.qualities ?? {};
  const options = Object.entries(qualities).map(([q, info]) => `<label><input type="radio" name="quality" value="${q}" ${q === saved ? "checked" : ""}> ${qualityLabel(q, info, plan.fast)}</label>`).join("");
  const remote = t.remote ? `<div class="notice info">Pictures are made by the image server at ${esc(t.remote)} with the model it has loaded. Change this in Settings.</div>` : "";
  const loaded = plan?.keepsLoaded && !t.remote && !t.agent ? `<p class="muted small loaded-note"><span>After the first picture the model stays loaded in memory for a quarter of an hour, so the next ones skip the loading time.</span><button class="ghost" id="unload-model">Unload now</button></p>` : "";
  const style = plan?.style ? `<p class="muted small style-note"><b>${plan.style.kind === "anime" ? "Anime model." : "Realistic model."}</b> ${esc(plan.style.text)}</p>` : "";
  const addon = t.engine === "addon";
  const bases = addon ? t.bases ?? [] : [];
  const variants = addon ? t.variants ?? [] : [];
  const videoLora = addon && t.addonKind === "video-lora";
  const baseName = videoLora ? String(t.base ?? "").split("/").pop() : "";
  const scale0 = videoLora ? String(t.strength ?? 1) : t.addonKind === "lora" ? "0.8" : "0.6";
  const addonHtml = addon ? `<div class="addon-setup">
      ${bases.length ? `<label class="field"><span>${videoLora ? "Applied to" : "Base model on the rented GPU"}</span><select id="addon-base">${bases.map((b, i) => `<option value="${i}">${esc(b.label)}${videoLora ? " · on the rented GPU" : b.xl ? " · SDXL" : " · SD 1.5"}</option>`).join("")}</select></label>` : `<div class="notice warn">${videoLora ? `${esc(baseName)} is not on the rented GPU yet. Open ${esc(baseName)}, download it on the rented GPU, then come back here: this LoRA is applied to it.` : "No base model is on the rented GPU yet. Open a Stable Diffusion 1.5 or SDXL model from the Easy to set up list, download it on the rented GPU, then come back here."}</div>`}
      <label class="field"><span>Variant</span><select id="addon-variant">${variants.map((v, i) => `<option value="${i}">${esc(v.label)}${v.gb ? `, ${v.gb.toFixed(2)} GB` : ""}</option>`).join("")}</select>${videoLora ? "" : `<small class="muted">Pick the variant made for the base's family: SD 1.5 variants for SD 1.5 bases, SDXL for SDXL.</small>`}</label>
      ${t.addonKind === "ip-adapter" ? `<label class="field"><span>Reference picture</span><input type="file" id="addon-ref" accept="image/*"><small class="muted">${variants.some((v) => v.faceid) ? "A clear photo of the face to keep." : "The picture whose subject or style to carry over."}</small></label>` : ""}
      <label class="field"><span>Strength <output id="addon-scale-out">${scale0}</output></span><input type="range" id="addon-scale" min="0.1" max="1.5" step="0.05" value="${scale0}"><small class="muted">${videoLora ? "How strongly the LoRA's effect is applied: 1 is as trained, lower is subtler, above 1 can distort." : "How strongly the add-on steers the result: lower is subtler, higher can distort."}</small></label>
      ${videoLora && t.triggerPrompt ? `<p class="muted small">The words this LoRA was trained on are filled in below; add to them.</p>` : ""}
    </div>` : "";
  const save = autosaveSettings();
  const what = video ? "clip" : "picture";
  const settingsHtml = spec ? `<div class="clip-settings">
      ${canLong ? `<div class="clip-tabs" role="tablist">
        <button type="button" role="tab" class="clip-tab" data-kind="short"><b>Short clip</b><span>${spec.minSeconds}–${spec.maxSeconds} s, one shot</span></button>
        <button type="button" role="tab" class="clip-tab" data-kind="scene"><b>Scene</b><span>up to ${longMax} s, joined shots</span></button>
      </div>
      <div class="scene-how" id="clip-kind">
        <input type="radio" name="clipKind" value="short" ${clipKind === "short" ? "checked" : ""} hidden>
        ${canScene ? `<label><input type="radio" name="clipKind" value="scene" ${clipKind === "scene" ? "checked" : ""}> Claude lays out the shots</label>` : ""}
        <label ${canScene ? "" : "hidden"}><input type="radio" name="clipKind" value="long" ${clipKind === "long" ? "checked" : ""}> My words, in pieces</label>
      </div>` : ""}
      <label class="field seconds"><span>Length in seconds</span><input type="number" id="video-seconds" min="${lengthRange(clipKind).min}" max="${lengthRange(clipKind).max}" step="1" value="${lengthRange(clipKind).value}"><small class="muted" id="seconds-help">${lengthHelp(clipKind)}</small></label>
      <div class="effort-title">Quality</div>
      <div class="quality" id="video-level">${["low", "medium", "high"].map((l) => `<label><input type="radio" name="level" value="${l}" ${l === level ? "checked" : ""}> <b>${l[0].toUpperCase() + l.slice(1)}</b> <span class="muted">${esc(spec.levels[l].text)}</span></label>`).join("")}</div>
      <details class="levels-note muted small"><summary>What the levels change</summary>Low draws smaller with fewer passes. Medium and High draw at the model's full size; High adds passes${claudeAvailable() ? " and has Claude expand your words first" : ""}.</details>
      ${video && t.engine === "diffusers" && t.agent ? `<div class="speed-switches">
        <label class="check small fast-passes"><input type="checkbox" id="fast-passes" ${fastPasses(t.repo) ? "checked" : ""}> Skip passes that barely change <span class="muted">about a third quicker at any level; fine detail softens a little. ${cacheMachineTooOld() ? "Needs a machine on the current image." : "Off for the keeper if it shows."}</span></label>
        <label class="check small fp8-weights"><input type="checkbox" id="fp8-weights" ${fp8Weights(t.repo) ? "checked" : ""} ${state.rental?.fp8 === false ? "disabled" : ""}> fp8 weights <span class="muted">the passes' arithmetic on the card's fp8 units: about a quarter quicker, more with the blocks compiled; a touch less precise. ${state.rental?.fp8 === false ? `This card (${esc(state.rental?.gpu ?? "")}) has no fp8 units; L40S, RTX 4090 and 5090, H100, H200 and B200 do.` : speedMachineTooOld() ? "Needs a machine on the current image." : "The model is loaded again when this changes."}</span></label>
        <label class="check small compiled-blocks"><input type="checkbox" id="compiled-blocks" ${compiledBlocks(t.repo) ? "checked" : ""}> Compile the blocks <span class="muted">10 to 25 percent quicker from the second clip; the first after a start, and after a LoRA change, waits a minute or two for the compiler. ${speedMachineTooOld() ? "Needs a machine on the current image." : ""}</span></label>
      </div>` : ""}
      <p class="muted small estimate" id="estimate"></p>
    </div>` : `<div class="effort-title">Effort</div>
    <div class="quality" id="quality">${options}</div>`;
  box.innerHTML = `<h3>Try it</h3>
    ${remote}
    ${style}
    ${addonHtml}
    ${settingsHtml}
    ${video && t.startPicture ? `<label class="field"><span>Starting picture${t.startPicture === "required" ? "" : " (optional)"}</span><input type="file" id="video-start" accept="image/*"><small class="muted">The clip begins from it.</small></label>` : ""}
    ${video && t.references === true ? `<label class="field"><span>Reference pictures (optional, up to 9)</span><input type="file" id="video-refs" accept="image/*" multiple><small class="muted">Photos of the people and things to show. Used instead of the starting picture.</small></label>` : video && t.references === false ? `<p class="muted small ref-note"><span>Optional: clips from several photos at once need ${t.referenceGb ? `${t.referenceGb.toFixed(0)} GB` : "an extra part"} more on the machine${t.referenceGrowTo ? `, more than its disk has free` : ""}.</span> ${t.referenceGrowTo ? (state.rental?.provider === "vast" ? `<button class="ghost" id="replace-for-refs">Replace the machine with a ${t.referenceGrowTo} GB disk</button>` : `<button class="ghost" id="grow-for-refs">Grow the disk to ${t.referenceGrowTo} GB</button>`) : `<button class="ghost" id="get-refs">Add it</button>`}</p>` : ""}
    ${video && t.lastPicture ? `<label class="field"><span>Last picture</span><select id="video-last"><option value="same" ${t.lastPicture === "same" ? "selected" : ""}>the same picture: the clip ends where it began</option><option value="none" ${t.lastPicture === "none" ? "selected" : ""}>none: the clip ends where the model takes it</option><option value="file">another picture</option></select><input type="file" id="video-last-file" accept="image/*" hidden><small class="muted">${t.lastPicture === "same" ? "This LoRA was trained to come back to its starting frame, a full orbit; keep the same picture unless you want it to end elsewhere." : "The model can be given a frame to end on."}</small></label>` : ""}
    <div class="prompt-input">
      <textarea id="image-prompt" rows="2" placeholder="${video ? "Describe a short clip, for example: waves rolling onto a beach at dusk, slow camera pan" : "Describe a picture, for example: a lighthouse at dusk, oil painting"}"></textarea>
      <span class="go-buttons"><button class="primary" id="image-go">${video ? "Generate a clip" : "Generate"}</button>${t.agent ? `<button class="ghost" id="queue-add" title="Starts as soon as the machine is free of the request under way, then the next after it; each is kept here and saved as it finishes">Add to queue</button>` : ""}${canScene ? `<button class="primary" id="scene-preview" hidden title="Claude lays the scene out as shots and shows them here, to read and change; nothing goes to the machine until you say so. This works while the machine is busy with something else">Preview Claude's scene setup</button>` : ""}</span>
    </div>
    ${t.agent && claudeAvailable() ? `<p class="tools-row suggest-row"><button class="ghost" id="suggest-go" title="Claude reads what you typed, and the starting picture if there is one, and writes the description these models follow best; with a LoRA ticked, in the shape its creator prompts for it, with the strength and settings they call for; you choose whether to use it">${esc(suggestLabel(t))}</button></p>
    <div class="suggest" id="suggest" hidden></div>` : ""}
    <label class="field avoid">
      <span>Avoid</span>
      <input type="text" id="image-negative" placeholder="anime, cartoon, drawing, blurry, extra fingers">
      <small class="muted">Models can't read "no" in the description, so list unwanted things here.</small>
    </label>
    ${video && t.engine === "diffusers" && t.agent && fullAccess() ? `<details class="loras" id="loras" ${loraSummary(t).on ? "open" : ""}><summary>LoRAs and fine-tunes <span class="muted small" id="loras-count">${esc(loraSummary(t).text)}</span></summary><div id="loras-body"></div></details>` : ""}
    ${t.agent ? `<div class="queue" id="queue" hidden>
      <p class="muted small"><b>Queue.</b> Runs one after another by itself; each result is kept here.</p>
      <ol id="queue-list"></ol>
      <p class="tools-row"><button class="primary" id="queue-go" hidden>Start all</button><button class="ghost" id="queue-clear">Clear the queue</button></p>
      <p class="muted small" id="queue-estimate"></p>
    </div>
    <label class="check queue-hold" title="Held, requests added to the queue wait there until Start all; otherwise each starts as soon as the machine is free"><input type="checkbox" id="queue-hold" ${queueHeld() ? "checked" : ""}> Hold the queue: collect requests and start them by hand</label>` : ""}
    ${loaded}
    ${t.agent ? `<label class="check autosave" title="Finished results are kept in this browser whatever happens; this also saves each one to your computer as it comes, so a finished clip is never lost to a stopped machine or a closed page"><input type="checkbox" id="autosave" ${save.on ? "checked" : ""}> Also save each ${what} to this computer, up to <input type="number" id="autosave-mb" min="1" max="5000" step="1" value="${save.maxMb}"> MB</label>` : ""}
    ${t.agent ? `<label class="check stop-after" title="The machine stops once everything asked for here is made or has failed; its models stay on its disk and Start brings it back"><input type="checkbox" id="image-stop-after"> Stop the rented GPU when everything asked for here is made${state.rental?.costPerHour ? ` (${money(state.rental.costPerHour)} an hour)` : ""}</label>` : ""}
    <div class="status-line muted small" id="image-status" hidden></div>
    <pre class="log" id="image-log" data-repo="${esc(t.repo)}" hidden></pre>
    <div id="image-out"></div>
    <div id="kept"></div>`;
  box.querySelector("#unload-model")?.addEventListener("click", async () => {
    await api.post("/api/unload", {});
    notice("The image model was unloaded from memory.", "ok");
  });
  box.querySelector("#addon-scale")?.addEventListener("input", (e) => (box.querySelector("#addon-scale-out").value = e.target.value));
  box.querySelector("#video-last")?.addEventListener("change", (e) => {
    const file = box.querySelector("#video-last-file");
    if (file) file.hidden = e.target.value !== "file";
  });
  if (videoLora && t.triggerPrompt && !box.querySelector("#image-prompt").value.trim()) box.querySelector("#image-prompt").value = t.triggerPrompt;
  // Claude suggests a better description for what was typed, with the
  // starting picture in front of it when there is one: the words these
  // models follow, the unwanted moved to the avoid list, the motion spelt
  // out. The person reads it and chooses to use it or not.
  box.querySelector("#suggest-go")?.addEventListener("click", async () => {
    const btn = box.querySelector("#suggest-go");
    const out = box.querySelector("#suggest");
    const typed = $("#image-prompt").value.trim();
    if (!typed) {
      $("#image-prompt").focus();
      return;
    }
    btn.disabled = true;
    out.hidden = false;
    out.innerHTML = `<p class="muted small">Claude is reading what you typed${box.querySelector("#video-start")?.files[0] ? " and the starting picture" : ""}</p>`;
    let image = null;
    const file = box.querySelector("#video-start")?.files[0] ?? null;
    if (file && file.size <= 5 * 1048576) {
      try {
        image = { media_type: file.type || "image/png", data: (await readAsDataUrl(file)).split(",")[1] };
      } catch {
        image = null;
      }
    }
    const now = video && spec ? chosen() : null;
    // With LoRAs ticked, Claude is shown how their creators prompt for them.
    const loras = video ? await loraContext(t) : [];
    if (loras.length) out.innerHTML = `<p class="muted small">Claude is reading what you typed${file ? ", the starting picture" : ""} and how ${loras.map((l) => l.name).join(" and ")} ${loras.length > 1 ? "are" : "is"} prompted for</p>`;
    const got = await claudeText({ kind: "prompt", mode: "suggest", clip: video, model: t.repo, prompt: typed, negative: $("#image-negative").value.trim(), ...(now && now.kind !== "scene" && now.q?.frames ? { seconds: clipSeconds(now.q) } : {}), ...(image ? { image } : {}), ...(loras.length ? { loras } : {}) });
    btn.disabled = false;
    const description = /^Description:\s*(.+)$/m.exec(got.text)?.[1]?.trim();
    if (!got.text || !description) {
      out.innerHTML = `<p class="muted small">No suggestion: ${esc(got.why || "Claude wrote no Description line")}.</p>`;
      return;
    }
    const avoid = (/^Avoid:\s*(.+)$/m.exec(got.text)?.[1] ?? "").trim();
    const avoidText = /^(nothing|none|-)\.?$/i.test(avoid) ? "" : avoid;
    const why = (/^Why:\s*([\s\S]+)$/m.exec(got.text)?.[1] ?? "").trim();
    const changes = loras.length ? suggestedLoraChanges(got.text, loras) : { strengths: [], settings: null };
    showSuggestion({ description, avoidText, why, strengths: changes.strengths, settings: changes.settings, loraKey: loras[0]?.key ?? null, loraNames: loras.map((l) => l.name) });
  });
  // Claude's suggestion, kept until it is used or set aside, so the window
  // can be left and opened again with it still there.
  function showSuggestion(sug) {
    const out = (box.isConnected ? box : liveBox())?.querySelector("#suggest");
    const keptRec = (state.runs ??= {})[t.repo] ??= { lines: [], active: false, failed: [] };
    if (!out) {
      keptRec.suggestion = sug;
      return;
    }
    const kept = (state.runs ??= {})[t.repo] ??= { lines: [], active: false, failed: [] };
    kept.suggestion = sug;
    const { description, avoidText, why, strengths = [], settings = null, loraNames = [] } = sug;
    out.hidden = false;
    out.innerHTML = `<p class="muted small"><b>Claude suggests${loraNames.length ? `, fitted to ${esc(loraNames.join(" and "))}` : ""}</b>${why ? ` · ${esc(why)}` : ""}</p>
      <textarea class="suggest-text" rows="${loraNames.length ? 7 : 4}">${esc(description)}</textarea>
      ${avoidText ? `<p class="muted small">Avoid: <span class="suggest-avoid">${esc(avoidText)}</span></p>` : ""}
      ${strengths.length ? `<p class="muted small suggest-strength">Strength: ${strengths.map((x) => `${esc(x.name)} from ${x.from.toFixed(2)} to ${x.to.toFixed(2)}`).join("; ")}</p>` : ""}
      ${settings ? `<p class="muted small suggest-settings">Settings: ${esc(settingsLabel(settings))} for clips with ${esc(loraNames[0] ?? "it")}</p>` : ""}
      <p class="tools-row"><button class="primary" id="suggest-use">Use it</button><button class="ghost" id="suggest-keep">Keep mine</button></p>`;
    out.querySelector(".suggest-text").addEventListener("input", (e) => (sug.description = e.target.value));
    out.querySelector("#suggest-use").addEventListener("click", () => {
      $("#image-prompt").value = out.querySelector(".suggest-text").value.trim();
      if (avoidText) $("#image-negative").value = avoidText;
      // The strength and settings go onto the LoRAs' own rows, and stay with them.
      if (strengths.length || settings) {
        const nb = loraBook(t.repo);
        for (const x of strengths) {
          if (!nb.items[x.key]) continue;
          nb.items[x.key].scale = x.to;
          if (x.key in nb.on) nb.on[x.key] = x.to;
        }
        if (settings && sug.loraKey && nb.items[sug.loraKey]) nb.items[sug.loraKey].settings = { ...settings, from: "Claude" };
        saveLoraBook(t.repo, nb);
        const live = box.isConnected ? box : liveBox();
        if (live?.querySelector("#loras")) wireLoras(live, t, () => {
          refreshEstimate();
          const sb = live.querySelector("#suggest-go");
          if (sb) sb.textContent = suggestLabel(t);
        });
        refreshEstimate();
      }
      out.hidden = true;
      delete kept.suggestion;
      $("#image-prompt").focus();
    });
    out.querySelector("#suggest-keep").addEventListener("click", () => {
      out.hidden = true;
      delete kept.suggestion;
    });
  }
  const saveAutosave = () => rememberAutosave({ on: box.querySelector("#autosave").checked, maxMb: Number(box.querySelector("#autosave-mb").value) || 150 });
  box.querySelector("#autosave")?.addEventListener("change", saveAutosave);
  box.querySelector("#autosave-mb")?.addEventListener("change", saveAutosave);
  const price = state.plan?.remote && state.rental?.rented ? state.rental.costPerHour : null;
  // What is asked for right now: the preset for a picture, the length and
  // quality for a clip, with the time guessed from them and the clips made
  // here before.
  const chosen = () => {
    if (!spec) {
      const quality = box.querySelector("input[name=quality]:checked")?.value ?? "default";
      const q = qualities[quality];
      return { quality, q, text: q?.text ? `${quality}, ${q.text}` : quality, estimate: null };
    }
    const lvl = box.querySelector("input[name=level]:checked")?.value ?? "medium";
    const kind = canLong ? box.querySelector("input[name=clipKind]:checked")?.value ?? "short" : "short";
    const range = lengthRange(kind);
    const asked = Math.min(range.max, Math.max(range.min, Number(box.querySelector("#video-seconds")?.value) || range.value));
    // Longer than one shot: equal pieces, each within the model's length.
    // A scene's shots are Claude's to lay out; until then the guess is
    // equal pieces of the model's length.
    const scene = kind === "scene";
    const pieces = scene ? Math.max(2, Math.ceil(asked / spec.maxSeconds)) : asked > spec.maxSeconds ? Math.ceil(asked / spec.maxSeconds) : 1;
    const seconds = asked / pieces;
    const each = clipEstimate(spec, lvl, seconds, t.repo);
    const q = { steps: each.level.steps, width: each.level.width, height: each.level.height, frames: each.frames, fps: spec.fps, cfg: spec.cfg, ...(each.level.expand && !scene ? { expand: true } : {}) };
    // The steps and guidance a ticked LoRA's creator used, when chosen
    // under LoRAs: a turbo LoRA wants its few steps and no guidance.
    const follow = t.engine === "diffusers" && t.agent ? loraSettings(t) : null;
    if (follow?.steps) q.steps = follow.steps;
    if (follow?.cfg != null) q.cfg = follow.cfg;
    // Passes skipped when they would barely change anything: quicker, a little softer.
    if (video && fastPasses(t.repo) && !cacheMachineTooOld()) q.cache = CACHE_THRESHOLD;
    // fp8 weights on a card that has the units for them, and compiled blocks (image 27).
    if (video && fp8Weights(t.repo) && !speedMachineTooOld() && state.rental?.fp8 !== false) q.fp8 = true;
    if (video && compiledBlocks(t.repo) && !speedMachineTooOld()) q.compile = true;
    const stepScale = (q.steps / each.level.steps) * (q.cache ? CACHE_TIME : 1) * (q.fp8 ? FP8_TIME : 1) * (q.compile ? COMPILE_TIME : 1);
    const eachText = `${(each.frames / spec.fps).toFixed(1)} s at ${lvl} quality, ${each.level.width} by ${each.level.height}, ${each.frames} frames, ${q.steps} steps`;
    const estimate = pieces > 1 || stepScale !== 1 ? { ...each, seconds: each.seconds * pieces * stepScale } : each;
    const text = scene ? `about ${asked} s as a scene of shots laid out by Claude, at ${lvl} quality, ${each.level.width} by ${each.level.height}, ${q.steps} steps` : pieces > 1 ? `${((each.frames * pieces) / spec.fps).toFixed(1)} s as ${pieces} pieces of ${eachText}` : eachText;
    return { kind, asked, level: lvl, seconds, pieces, q, eachText, text, estimate, each, follow };
  };
  const refreshEstimate = () => {
    const el = box.querySelector("#estimate");
    if (!el || !spec) return;
    const c = chosen();
    const est = c.estimate;
    const load = loadSeconds(t.repo);
    const each = c.each ?? est;
    const shape = c.kind === "scene" ? `a scene of about ${c.asked} seconds, made as shots Claude lays out (guessed here as ${c.pieces} of about ${(each.frames / spec.fps).toFixed(1)} s) at ${each.level.width} by ${each.level.height}, ${c.q.steps} steps, each starting where the last ended, then joined (a soft seam at each cut)` : c.pieces > 1 ? `a ${((each.frames * c.pieces) / spec.fps).toFixed(1)}-second clip made as ${c.pieces} pieces of ${(each.frames / spec.fps).toFixed(1)} s at ${each.level.width} by ${each.level.height}, ${each.frames} frames each, ${c.q.steps} steps, each starting where the last ended, then joined (a soft seam at each join)` : `a ${(each.frames / spec.fps).toFixed(1)}-second clip at ${each.level.width} by ${each.level.height}, ${each.frames} frames, ${c.q.steps} steps`;
    el.textContent = `About ${shortDuration(est.seconds)}${price ? ` and ${money((price * est.seconds) / 3600)} of machine time` : ""}${c.pieces > 1 ? " in all" : ""} for ${shape}${est.n ? ` (adjusted from the last ${est.n} clip${est.n === 1 ? "" : "s"} made here)` : " (a guess until the first clip is timed)"}.${load ? ` The first clip after a start adds about ${shortDuration(load)} to load the model.` : ""}${c.follow ? ` Steps and guidance follow what ${c.follow.name}'s creator used (${settingsLabel(c.follow)}), as chosen under LoRAs.` : ""}${c.q.cache ? " Passes that barely change are skipped." : ""}${c.q.fp8 ? " The weights are fp8." : ""}${c.q.compile ? " The blocks are compiled, so the first clip after a start or a LoRA change waits a minute or two more." : ""}`;
    // Above what this machine has run out of memory at: said before asking.
    const limit = memoryLimit(t.repo);
    const over = limit && each.frames * each.level.width * each.level.height >= limit.load;
    el.classList.toggle("warn", Boolean(over));
    if (over) el.textContent += ` ${tooBigText(limit, c.level, c.seconds)}`;
  };
  // The longest clip at a level that stays under the machine's known limit.
  const fitsUnder = (limit, level, seconds) => {
    const lv = spec.levels[level] ?? spec.levels.medium;
    const least = framesFor(spec.minSeconds, spec);
    for (let f = framesFor(seconds, spec) - spec.frameStep; f >= least; f -= spec.frameStep) {
      if (f * lv.width * lv.height < limit.load) return Math.round((f / spec.fps) * 10) / 10;
    }
    return null;
  };
  const tooBigText = (limit, level, seconds) => {
    const shorter = fitsUnder(limit, level, seconds);
    const fit = fitLoad(t.repo);
    const known = !fit ? "." : fit.load >= limit.load ? "; the same size was made here once, so it is on the edge." : `; ${fit.text} is known to.`;
    return `This machine ran out of memory at ${limit.text}, so this is likely too big for it. ${shorter ? `About ${shorter} seconds at ${level} quality should fit` : "A lower quality should fit"}${known}`;
  };
  box.querySelector("#video-seconds")?.addEventListener("input", () => {
    const kind = canLong ? box.querySelector("input[name=clipKind]:checked")?.value ?? "short" : "short";
    const n = Number(box.querySelector("#video-seconds").value);
    if (n) {
      if (kind === "long" || kind === "scene") {
        if (kind === "long") longSeconds = n;
        else sceneSeconds = n;
        try {
          localStorage.setItem(`${kind}Seconds:${t.repo}`, String(n));
        } catch {
          // no storage
        }
      } else shortSeconds = n;
    }
    refreshEstimate();
  });
  // Switching kinds moves the length box to that kind's range and the
  // length last asked for in it.
  for (const r of box.querySelectorAll("input[name=clipKind]")) r.addEventListener("change", () => {
    try {
      localStorage.setItem("clipKind", r.value);
    } catch {
      // no storage
    }
    const range = lengthRange(r.value);
    const sec = box.querySelector("#video-seconds");
    sec.min = String(range.min);
    sec.max = String(range.max);
    sec.value = String(range.value);
    box.querySelector("#seconds-help").textContent = lengthHelp(r.value);
    placeholderFor(r.value);
    syncTabs();
    showKindButtons();
    refreshEstimate();
  });
  // The two tabs choose between a short clip and a scene; inside the
  // scene, Claude's shots or the words as typed in pieces, as last chosen.
  function syncTabs() {
    const kind = box.querySelector("input[name=clipKind]:checked")?.value ?? "short";
    for (const tab of box.querySelectorAll(".clip-tab")) {
      const on = (tab.dataset.kind === "short") === (kind === "short");
      tab.classList.toggle("active", on);
      tab.setAttribute("aria-selected", String(on));
    }
    const how = box.querySelector(".scene-how");
    if (how) how.hidden = kind === "short" || !canScene;
  }
  for (const tab of box.querySelectorAll(".clip-tab")) tab.addEventListener("click", () => {
    const kind = box.querySelector("input[name=clipKind]:checked")?.value ?? "short";
    if ((tab.dataset.kind === "short") === (kind === "short")) return;
    let next = "short";
    if (tab.dataset.kind === "scene") {
      let last = null;
      try {
        last = localStorage.getItem("sceneHow");
      } catch {
        // no storage
      }
      next = canScene && last !== "long" ? "scene" : "long";
    }
    const radio = box.querySelector(`input[name=clipKind][value=${next}]`);
    if (!radio) return;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
  });
  for (const r of box.querySelectorAll(".scene-how input[name=clipKind]")) r.addEventListener("change", () => {
    if (r.value === "short") return;
    try {
      localStorage.setItem("sceneHow", r.value);
    } catch {
      // no storage
    }
  });
  if (canLong) syncTabs();
  // Each tab asks for its own kind of words.
  function placeholderFor(kind) {
    const input = box.querySelector("#image-prompt");
    if (input) input.placeholder = kind === "short" ? "Describe one moment, for example: waves rolling onto a beach at dusk, slow camera pan" : "Describe what happens, in order, for example: she walks to the window, opens it, then turns and smiles";
  }
  if (canLong) placeholderFor(clipKind);
  // A scene goes by way of the preview: Generate and Add to queue make
  // way for it, and come back for the other kinds.
  function showKindButtons() {
    const scene = canScene && box.querySelector("input[name=clipKind]:checked")?.value === "scene";
    const go = box.querySelector("#image-go");
    if (go) go.hidden = scene;
    const add = box.querySelector("#queue-add");
    if (add) add.hidden = scene;
    const pv = box.querySelector("#scene-preview");
    if (pv) pv.hidden = !scene;
  }
  showKindButtons();
  box.querySelector("#scene-preview")?.addEventListener("click", async () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    const item = makeItem(prompt);
    if (!item.scene) return;
    previewScene(item);
  });
  async function previewScene(item, given = null) {
    const btn = box.querySelector("#scene-preview");
    if (btn) btn.disabled = true;
    let r;
    try {
      r = await withScene(item, { how: "choose", given });
    } finally {
      if (btn) btn.disabled = false;
    }
    if (!r.choice) return;
    // Made now when the machine is free; otherwise it goes next.
    if (r.choice === "run" && !rec.active) return run([item], { intro: r.notes });
    item.notes = r.notes;
    queue.push(item);
    $("#image-prompt").value = "";
    $("#image-prompt").dispatchEvent(new Event("input"));
    renderQueue();
    drain();
  }
  // Opened again: a scene preview or a suggestion left on show is back as
  // it was, once the rest of the window is set up.
  queueMicrotask(() => {
    const kept = state.runs?.[t.repo];
    if (!box.isConnected || !kept) return;
    // The words being typed, as they were left.
    const words = box.querySelector("#image-prompt");
    const avoid = box.querySelector("#image-negative");
    if (kept.draft && words && !words.value) words.value = kept.draft.prompt ?? "";
    if (kept.draft && avoid && !avoid.value) avoid.value = kept.draft.negative ?? "";
    const keepDraft = () => (kept.draft = { prompt: words?.value ?? "", negative: avoid?.value ?? "" });
    words?.addEventListener("input", keepDraft);
    avoid?.addEventListener("input", keepDraft);
    kept.redrawScene = () => {
      if (box.isConnected && kept.scenePending) previewScene(kept.scenePending.item, kept.scenePending);
    };
    if (kept.scenePending) previewScene(kept.scenePending.item, kept.scenePending);
    else if (kept.sceneWorking) {
      const el = box.querySelector("#suggest");
      if (el) {
        el.hidden = false;
        el.innerHTML = `<p class="muted small">Claude is laying the scene out as shots; they show here first, to change before anything is sent.</p>`;
      }
    } else if (kept.suggestion) showSuggestion(kept.suggestion);
  });
  for (const r of box.querySelectorAll("input[name=level]")) r.addEventListener("change", () => {
    try {
      localStorage.setItem("videoLevel", r.value);
    } catch {
      // no storage
    }
    refreshEstimate();
  });
  refreshEstimate();
  // What is going on with this model, kept apart from the window: the log
  // lines and whether requests are running. A window left and opened again
  // shows the work as it stands and the lines go on landing in it.
  const rec = ((state.runs ??= {})[t.repo] ??= { lines: [], active: false, failed: [] });
  // Results shown in this window, above the kept ones.
  rec.shown = new Set();
  // The window as it stands now: this box while it is on show, or the one
  // drawn in its place for the same model; nothing once the model is closed.
  const liveBox = () => {
    let found = null;
    for (const log of document.querySelectorAll("#image-log")) if (log.dataset.repo === t.repo && log.isConnected) found = log.parentElement;
    return found;
  };
  const setBusy = (b, on) => {
    const go = b.querySelector("#image-go");
    if (go) go.disabled = on;
    const qGo = b.querySelector("#queue-go");
    if (qGo) qGo.disabled = on;
    // A scene preview on show: while the machine works, the way on is the
    // queue; free again, the scene can be made now.
    const sceneGo = b.querySelector("#scene-go");
    if (sceneGo) sceneGo.hidden = on;
    const sceneQueue = b.querySelector("#scene-queue");
    if (sceneQueue) {
      sceneQueue.textContent = `Add to queue${on ? " (runs after the request under way)" : ""}`;
      sceneQueue.className = on ? "primary" : "ghost";
    }
    // While the machine works: the way to stop it there by hand, which
    // fails the request so it can be asked again. Nothing stops by itself.
    let abort = b.querySelector("#image-abort");
    if (on && !abort && t.agent) {
      abort = document.createElement("p");
      abort.className = "tools-row abort-row";
      abort.innerHTML = `<button class="ghost" id="image-abort" title="Stops the machine's worker on what it is doing; the request fails and can be asked again. The machine itself stays up.">Give up on this</button>`;
      b.querySelector("#image-log").after(abort);
      abort.querySelector("button").addEventListener("click", async () => {
        abort.querySelector("button").disabled = true;
        const res = await fetch(`${t.agent}/unload`, { method: "POST", headers: agentHeaders() }).catch(() => null);
        const line = res?.ok ? "Asked the machine to drop what it is working on; the request fails and can be asked again." : res?.status === 404 ? "This machine's image has no way to drop a job; Stop and Start it from the bar." : `The machine could not be asked (${res ? `HTTP ${res.status}` : "no answer"}); Stop and Start it from the bar.`;
        rec.lines.push(line);
        const log = liveBox()?.querySelector("#image-log");
        if (log) {
          log.textContent += line + "\n";
          log.scrollTop = log.scrollHeight;
        }
      });
    } else if (!on && abort) abort.closest(".abort-row")?.remove();
  };
  reply.canContinue = Boolean(video && t.startPicture);
  // Each card's reply box, as it was left: open or not, the words typed,
  // the mode, the last line said, and a fix plan waiting to be made.
  reply.keep = (entry) => {
    const all = (rec.replies ??= new Map());
    if (!all.has(entry.id)) all.set(entry.id, { open: false, text: "", mode: "change", foot: "" });
    return all.get(entry.id);
  };
  reply.restore = (entry, foot) => {
    if (rec.fixPlans?.has(entry.id)) showFixPlan(entry.id, foot);
  };
  renderKept(box, t.repo, rec.shown, t.agent ? reply : null);
  // A request as it will be sent: the words, what to avoid, the settings as
  // chosen right now, a seed of its own, and the files picked, read when it
  // is sent.
  const makeItem = (prompt) => {
    const c = chosen();
    const typed = $("#image-negative").value.trim();
    return { prompt, negative: typed || (spec?.avoid && c.level && c.level !== "low" ? spec.avoid : ""), quality: c.quality ?? null, level: c.level ?? null, q: c.q, expand: Boolean(c.q?.expand), settings: c.text, pieces: c.pieces ?? 1, each: c.eachText ?? c.text, seed: randomSeed(), estimate: c.estimate ? { base: c.estimate.base, seconds: c.estimate.seconds } : null, follow: c.follow ?? null, startFile: box.querySelector("#video-start")?.files[0] ?? null, refFiles: [...(box.querySelector("#video-refs")?.files ?? [])].slice(0, 9), id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, ...(c.kind === "scene" ? { scene: true, sceneSeconds: c.asked, shots: null } : {}) };
  };
  // Room first: the disk grows (its models stay), then the part can be added.
  box.querySelector("#grow-for-refs")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Growing the disk";
    try {
      state.rental = await api.post("/api/rent/grow", { diskGb: t.referenceGrowTo });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = `Grow the disk to ${t.referenceGrowTo} GB`;
      notice(`Could not grow the disk: ${err.message}`, "bad");
      return;
    }
    notice(`The disk is now ${t.referenceGrowTo} GB, and its models stay. Add the reference part when the machine is back.`, "ok");
    await load();
    openModel(t.repo);
  });
  box.querySelector("#fast-passes")?.addEventListener("change", (e) => {
    setFastPasses(t.repo, e.target.checked);
    refreshEstimate();
  });
  box.querySelector("#fp8-weights")?.addEventListener("change", (e) => {
    setSpeedChoice("fp8Weights", t.repo, e.target.checked);
    refreshEstimate();
  });
  box.querySelector("#compiled-blocks")?.addEventListener("change", (e) => {
    setSpeedChoice("compiledBlocks", t.repo, e.target.checked);
    refreshEstimate();
  });
  if (box.querySelector("#loras")) wireLoras(box, t, () => {
    refreshEstimate();
    const sb = box.querySelector("#suggest-go");
    if (sb) sb.textContent = suggestLabel(t);
  });
  box.querySelector("#replace-for-refs")?.addEventListener("click", () => {
    state.rentFrom = t.repo;
    replaceMachine({ diskGb: t.referenceGrowTo });
  });
  box.querySelector("#get-refs")?.addEventListener("click", () => runStep({ id: t.repo, name: t.repo.split("/").pop() }, state.plan, Math.max(0, (state.plan?.steps ?? []).findIndex((s) => s.optional))));
  // The queue: several requests, run one after another by one click. It is
  // kept in this browser under the model, so leaving the window or the page
  // loses none of it; a starting picture picked from the disk cannot be
  // kept, and is picked again.
  const queue = t.agent ? (rec.queue ??= queueItems(t.repo)) : [];
  // What can start now: a request whose starting picture was lost with the
  // page has to be picked again first.
  const ready = () => queue.filter((it) => !(it.startName && !it.startFile) && !(it.refCount && !it.refFiles?.length));
  // Pictures picked for queued requests are kept in this browser, so a
  // window left or a page reloaded loses none of them; a request from
  // before pictures were kept asks for its picture again.
  if (queue.some((it) => it.id && ((it.startName && !it.startFile) || (it.refCount && !it.refFiles?.length)))) {
    Promise.all(queue.map(async (it) => {
      if (!it.id) return;
      const pics = await loadPictures(it.id).catch(() => null);
      if (!pics) return;
      if (pics.start && !it.startFile) it.startFile = pics.start;
      if (pics.refs?.length && !it.refFiles?.length) it.refFiles = pics.refs;
    })).then(() => {
      renderQueue();
      if (!rec.active) drain(["The queue from before goes on, with its pictures."]);
    });
  }
  // The queue runs itself: what is in it starts as soon as the machine is
  // free of this model's work, with no click, so a list left here keeps a
  // rented GPU busy for as long as it lasts. Held, it waits for Start all.
  const drain = (intro = []) => {
    if (!t.agent || rec.active || queueHeld()) return false;
    const items = ready();
    if (!items.length) return false;
    for (const it of items) queue.splice(queue.indexOf(it), 1);
    renderQueue();
    run(items, { intro, append: rec.lines.length > 0 });
    return true;
  };
  const renderQueue = () => {
    // Drawn into the window as it stands now: a run that began in an
    // earlier one empties the queue on show, not a box since replaced.
    const wrap = (liveBox() ?? box).querySelector("#queue");
    if (!wrap) return;
    rememberQueue(t.repo, queue);
    const held = queueHeld();
    wrap.hidden = !queue.length;
    const list = wrap.querySelector("#queue-list");
    list.innerHTML = queue.map((item, i) => `<li>${esc(item.prompt)} <span class="muted small">${esc(item.settings)}${item.estimate ? `, about ${esc(shortDuration(item.estimate.seconds))}` : ""}${item.refFiles?.length || item.refCount ? ` · ${item.refFiles?.length || item.refCount} reference picture${(item.refFiles?.length || item.refCount) === 1 ? "" : "s"}` : ""}${item.startFile ? ` · from ${esc(item.startFile.name)}` : ""}${item.replyTo ? ` · a reply to an earlier ${item.paintOver ? "picture" : "clip"}` : ""}${item.startName && !item.startFile ? ` · the starting picture ${esc(item.startName)} has to be picked again` : ""}</span><button class="ghost queue-remove" data-i="${i}">Remove</button></li>`).join("");
    for (const btn of list.querySelectorAll(".queue-remove")) btn.addEventListener("click", () => {
      const [gone] = queue.splice(Number(btn.dataset.i), 1);
      if (gone?.id) forgetPictures(gone.id);
      renderQueue();
    });
    const total = queue.reduce((a, item) => a + (item.estimate?.seconds ?? (item.quality ? tookSeconds(t.repo, item.quality) ?? qualities[item.quality]?.seconds ?? 0 : 0)), 0);
    const waiting = held ? "Held: they start with Start all." : rec.active ? "They start by themselves when the request under way finishes." : ready().length ? "" : "They start once their pictures are picked again.";
    wrap.querySelector("#queue-estimate").textContent = queue.length ? `${queue.length} request${queue.length === 1 ? "" : "s"}${total ? `, about ${shortDuration(total)}${price ? ` and ${money((price * total) / 3600)} of machine time` : ""} in all` : ""}. ${waiting}`.trim() : "";
    const go = wrap.querySelector("#queue-go");
    go.hidden = !held;
    go.textContent = `Start all ${queue.length}`;
  };
  box.querySelector("#queue-add")?.addEventListener("click", async () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    const item = makeItem(prompt);
    const btn = box.querySelector("#queue-add");
    btn.disabled = true;
    try {
      item.notes = await withExpansion(item);
    } finally {
      btn.disabled = false;
    }
    queue.push(item);
    $("#image-prompt").value = "";
    $("#image-prompt").dispatchEvent(new Event("input"));
    renderQueue();
    drain();
  });
  box.querySelector("#queue-clear")?.addEventListener("click", () => {
    queue.length = 0;
    renderQueue();
  });
  box.querySelector("#queue-go")?.addEventListener("click", () => {
    if (!queue.length) return;
    const items = queue.splice(0);
    renderQueue();
    run(items, { append: rec.lines.length > 0 });
  });
  box.querySelector("#queue-hold")?.addEventListener("change", (e) => {
    try {
      localStorage.setItem("queueHold", e.target.checked ? "1" : "0");
    } catch {
      // no storage
    }
    renderQueue();
    if (!e.target.checked) drain();
  });
  renderQueue();
  $("#image-go").addEventListener("click", async () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    const item = makeItem(prompt);
    const go = $("#image-go");
    go.disabled = true;
    let intro;
    try {
      intro = await withExpansion(item);
    } finally {
      if (!rec.active) go.disabled = false;
    }
    run([item], { intro });
  });

  // At High, the expanded description is shown before anything is sent, to
  // change or to set aside. What is sent is what is in the box, as it
  // stands, with nobody reading it again.
  async function withExpansion(item) {
    // A long clip at High: Claude's better description comes as the shots
    // it would make, all shown together to read, change and send, instead
    // of one text cut into equal pieces unseen.
    if (item.expand && !item.scene && !item.expanded && item.pieces > 1 && canScene && !item.replyTo && !item.continues) {
      item.scene = true;
      item.sceneSeconds = Math.round((item.q.frames * item.pieces) / spec.fps);
      item.shots = null;
      item.expand = false;
    }
    if (item.scene && !item.shots) return withScene(item);
    const el = box.querySelector("#suggest");
    if (!item.expand || item.expanded || !claudeAvailable() || !el) return [];
    el.hidden = false;
    el.innerHTML = `<p class="muted small">Claude is expanding the description for High quality; it shows here first, to change before it is sent.</p>`;
    const got = await expandWords(item.prompt, video, t.repo, item.negative, await startingPictureFor(item, t.repo), clipSeconds(item.q), video ? await loraContext(t) : null);
    if (!got.text) {
      el.hidden = true;
      item.expand = false;
      return [`Claude gave no expansion (${got.why}); the words go as they are.`];
    }
    return new Promise((resolve) => {
      el.innerHTML = `<p class="muted small"><b>Expanded for High quality.</b> Change it as you like; it goes to the model as it stands here, unreviewed.</p>
        <textarea class="suggest-text" id="expand-text" rows="5">${esc(got.text)}</textarea>
        <p class="tools-row"><button class="primary" id="expand-send">Send this</button><button class="ghost" id="expand-mine">Send my words as typed</button></p>`;
      el.querySelector("#expand-text").focus();
      el.querySelector("#expand-send").addEventListener("click", () => {
        const text = el.querySelector("#expand-text").value.trim() || got.text;
        item.expanded = text;
        item.expandedEdited = text !== got.text;
        el.hidden = true;
        resolve([]);
      });
      el.querySelector("#expand-mine").addEventListener("click", () => {
        item.expand = false;
        el.hidden = true;
        resolve(["Sending your words as typed."]);
      });
    });
  }

  // A scene: Claude lays the description out as shots, each with its own
  // words and length, shown first to change, add to or cut. What is in the
  // rows is what goes, shot by shot, with nobody reading it again. With no
  // shots, the words go as one long clip of equal pieces.
  // `how` "send" is a scene item on its way (Try again on one): the
  // buttons send the shots or the plain words. "choose" is the preview,
  // which can be read while the machine works on something else: the
  // buttons then make the scene now, add it to the queue, or drop it.
  async function withScene(item, { how = "send", given = null } = {}) {
    const el = box.querySelector("#suggest");
    const level = item.level ?? "medium";
    const asPlain = (line) => {
      const pieces = Math.max(1, Math.ceil(item.sceneSeconds / spec.maxSeconds));
      const each = clipEstimate(spec, level, item.sceneSeconds / pieces, t.repo);
      item.scene = false;
      item.shots = null;
      item.pieces = pieces;
      item.q = { ...item.q, frames: each.frames };
      item.each = `${(each.frames / spec.fps).toFixed(1)} s at ${level} quality, ${each.level.width} by ${each.level.height}, ${each.frames} frames, ${each.level.steps} steps`;
      item.settings = pieces > 1 ? `${((each.frames * pieces) / spec.fps).toFixed(1)} s as ${pieces} pieces of ${item.each}` : item.each;
      item.estimate = { base: each.base * pieces, seconds: each.seconds * pieces };
      return [`${line} ${pieces > 1 ? `Made as a long clip of ${pieces} equal pieces from your words instead.` : "Made as one clip from your words instead."}`];
    };
    const done = (notes, choice = null) => (how === "choose" ? { notes, choice } : notes);
    if (!claudeAvailable() || !el) return done(asPlain("No Anthropic key for Claude to lay out the shots."));
    el.hidden = false;
    el.innerHTML = `<p class="muted small">Claude is laying the scene out as shots; they show here first, to change before anything is sent.</p>`;
    // Shots laid out already (a window opened again on a preview) are shown
    // as they were left; otherwise Claude lays them out.
    if (!given && how === "choose") rec.sceneWorking = true;
    const picture = given ? null : await startingPictureFor(item, t.repo);
    let got = given?.got ?? (await sceneShots(item.prompt, item.sceneSeconds, spec, t.repo, item.negative, picture));
    // With the photo in front of it Claude may write no shots at all; told
    // of the photo instead of shown it, it lays out the same everyday
    // scene with the person and place kept as they are in the picture.
    let unseen = given?.unseen ?? false;
    if (!given && !got.shots.length && picture) {
      const again = await sceneShots(item.prompt, item.sceneSeconds, spec, t.repo, item.negative, null, { pictureUnseen: true });
      if (again.shots.length) {
        got = again;
        unseen = true;
      } else if (!got.text && again.text) got = again;
    }
    const remark = `${unseen ? `<p class="muted small">With the photo in front of it, Claude wrote no shots. Told of the photo instead of shown it, it laid these out; they keep the person and the place as they are in the picture.</p>` : ""}${got.note ? `<p class="muted small"><b>Claude's note:</b> ${esc(got.note)}</p>` : ""}`;
    const finals = how === "choose" ? `<button class="primary" id="scene-go" ${rec.active ? "hidden" : ""}>Generate this scene</button><button class="${rec.active ? "primary" : "ghost"}" id="scene-queue">Add to queue${rec.active ? " (runs after the request under way)" : ""}</button><button class="ghost" id="scene-discard">Discard</button>` : `<button class="primary" id="shots-send">Send these shots</button><button class="ghost" id="shots-mine">Send my words as one long clip</button>`;
    rec.sceneWorking = false;
    // The window was opened again while Claude worked: the shots go to the
    // window on show, which takes the preview from here.
    if (how === "choose" && !el.isConnected) {
      rec.scenePending = { item, got, unseen };
      rec.redrawScene?.();
      return new Promise(() => {});
    }
    // Kept while it is on show, edits and all, for a window opened again.
    const pending = how === "choose" ? (rec.scenePending = { item, got, unseen }) : null;
    const settled = () => {
      if (rec.scenePending === pending) rec.scenePending = null;
    };
    return new Promise((resolve) => {
      // The final buttons: `take()` settles the item from what is on
      // show, or says there is nothing to send yet.
      const wire = (take) => {
        const finish = (choice) => {
          const notes = take();
          if (notes === null) return;
          el.hidden = true;
          settled();
          resolve(done(notes, choice));
        };
        el.querySelector("#shots-send")?.addEventListener("click", () => finish(null));
        el.querySelector("#scene-go")?.addEventListener("click", () => finish("run"));
        el.querySelector("#scene-queue")?.addEventListener("click", () => finish("queue"));
        el.querySelector("#shots-mine")?.addEventListener("click", () => {
          el.hidden = true;
          settled();
          resolve(done(asPlain("Sending your words as typed.")));
        });
        el.querySelector("#scene-discard")?.addEventListener("click", () => {
          el.hidden = true;
          settled();
          resolve(done([], null));
        });
      };
      if (!got.shots.length) {
        const notes = asPlain(`Claude laid out no shots (${got.why}).`);
        if (how !== "choose") {
          el.hidden = true;
          return resolve(notes);
        }
        const said = got.text ? `<p class="muted small">Claude wrote, instead of shots: <q>${esc(got.text.trim().slice(0, 600))}${got.text.trim().length > 600 ? "…" : ""}</q></p>` : "";
        el.innerHTML = `<p class="muted small"><b>No shots from Claude</b> (${esc(got.why)}). Your words can go as ${item.pieces > 1 ? `one long clip of ${item.pieces} equal pieces` : "one clip"} instead.</p>${said}<p class="tools-row">${finals}</p>`;
        return wire(() => notes);
      }
      // The LoRAs on the machine for this model: each shot ticks its own,
      // at its own strength, starting from what is ticked for the model.
      const shotLoraItems = () => {
        const b = loraBook(t.repo);
        return Object.entries(b.items).filter(([key, i]) => i.kind !== "finetune" && loraHere(t, key)).map(([key, i]) => ({ key, item: i }));
      };
      const shotLorasOf = (li) => {
        const out = {};
        li.querySelectorAll(".shot-lora").forEach((row) => {
          if (row.querySelector(".shot-lora-on").checked) out[row.dataset.key] = Number(row.querySelector(".shot-lora-strength").value) || 1;
        });
        return out;
      };
      const loraLine = shotLoraItems().length ? " Each shot can carry its own LoRAs." : "";
      el.innerHTML = `<p class="muted small"><b>Claude's shots.</b> Each is made on its own from its row (${spec.minSeconds} to ${spec.maxSeconds} s), then joined, with its own avoid list on top of yours. Change the words, length or avoid list, or ask Claude for edits.${loraLine}</p>${remark}
        <ol class="shots shot-cards" id="shots"></ol>
        <p class="tools-row"><button class="ghost" id="shot-add">Add a shot</button></p>
        <p class="muted small" id="shots-total"></p>
        ${claudeAvailable() ? `<div class="shots-ask"><input class="ask-text" id="shots-ask" placeholder="Ask Claude to change all the shots"><button class="ghost" id="shots-ask-go">Ask</button><span class="muted small ask-said" id="shots-ask-said"></span></div>` : ""}
        <p class="tools-row">${finals}</p>`;
      const list = el.querySelector("#shots");
      const read = () => [...list.querySelectorAll("li")].map((li) => ({ seconds: Math.min(spec.maxSeconds, Math.max(spec.minSeconds, Number(li.querySelector(".shot-seconds").value) || spec.minSeconds)), text: li.querySelector(".shot-text").value.trim(), negative: rowAvoid(li), ...(shotLoraItems().length ? { loras: shotLorasOf(li) } : {}) })).filter((s) => s.text);
      const total = () => {
        renumber();
        const shots = read();
        if (pending) pending.got = { ...pending.got, shots: [...list.querySelectorAll("li")].map((li) => ({ seconds: Number(li.querySelector(".shot-seconds").value) || spec.minSeconds, text: li.querySelector(".shot-text").value, negative: rowAvoid(li), written: Number(li.dataset.written) || 0, ...(shotLoraItems().length ? { loras: shotLorasOf(li) } : {}) })) };
        const secs = shots.reduce((a, s) => a + framesFor(s.seconds, spec) / spec.fps, 0);
        const est = shots.reduce((a, s) => a + clipEstimate(spec, level, s.seconds, t.repo).seconds, 0);
        const lv = spec.levels[level] ?? spec.levels.medium;
        el.querySelector("#shots-total").textContent = shots.length ? `${shots.length} shot${shots.length === 1 ? "" : "s"}, ${secs.toFixed(1)} s in all at ${level} quality (${lv.width} by ${lv.height}, ${lv.steps} passes each), about ${shortDuration(est)}${price ? ` and ${money((price * est) / 3600)} of machine time` : ""}. A lower quality above makes every shot quicker.` : "No shots: add one, or send your words as one long clip.";
      };
      // A shot made shorter than Claude wrote it for would lose the end of
      // its action, so the row says so and Claude can fit it to the new length.
      const fitHint = (li) => {
        const written = Number(li.dataset.written) || 0;
        const now = Math.min(spec.maxSeconds, Math.max(spec.minSeconds, Number(li.querySelector(".shot-seconds").value) || spec.minSeconds));
        let hint = li.querySelector(".shot-fit");
        if (!(written && now < written - 0.5)) {
          hint?.remove();
          return;
        }
        if (!hint) {
          hint = document.createElement("p");
          hint.className = "shot-fit muted small";
          li.append(hint);
        }
        hint.innerHTML = `Written for ${written} s; at ${now} s the end may be cut. ${claudeAvailable() ? `<button class="ghost shot-fit-go">Fit to ${now} s</button>` : "Shorten the action to match."}`;
        hint.querySelector(".shot-fit-go")?.addEventListener("click", async (ev) => {
          const b = ev.currentTarget;
          b.disabled = true;
          b.textContent = "Fitting";
          const got = await claudeText({ kind: "prompt", mode: "fit", clip: true, model: t.repo, prompt: li.querySelector(".shot-text").value.trim(), fromSeconds: written, seconds: now });
          const description = (/^Description:\s*(.+)$/m.exec(got.text ?? "")?.[1] ?? "").trim();
          if (!description) {
            hint.textContent = `Could not fit it: ${got.why || "Claude wrote no Description line"}.`;
            return;
          }
          const dropped = (/^Dropped:\s*(.+)$/m.exec(got.text)?.[1] ?? "").trim();
          li.querySelector(".shot-text").value = description;
          li.dataset.written = String(now);
          hint.remove();
          if (dropped && !/^(nothing|none|-)\.?$/i.test(dropped)) {
            const note = document.createElement("p");
            note.className = "shot-fit muted small";
            note.textContent = `Left out to fit: ${dropped}. Add a shot for it if you want it.`;
            li.append(note);
          }
          total();
        });
      };
      // The shots numbered as they stand, and each card's LoRA line saying
      // what is on for it, so a folded line still says what it holds.
      const renumber = () => list.querySelectorAll("li").forEach((li, i) => {
        li.querySelector(".shot-n").textContent = `Shot ${i + 1}`;
        const sum = li.querySelector(".shot-loras summary");
        if (sum) {
          const on = Object.entries(shotLorasOf(li)).map(([key, scale]) => `${loraBook(t.repo).items[key]?.name ?? key} ${Number(scale).toFixed(2)}`);
          sum.textContent = on.length ? `LoRAs: ${on.join(", ")}` : "Add a LoRA";
        }
      });
      // The LoRAs ticked for a row, with how their creators prompt for them, for Claude.
      const shotLoraMaterial = async (li) => {
        const own = shotLorasOf(li);
        if (!Object.keys(own).length) return null;
        const all = await loraContext(t);
        return Object.entries(own).map(([key, scale]) => {
          const l = all.find((x) => x.key === key);
          const item = loraBook(t.repo).items[key];
          return l ? { ...l, strength: scale } : { key, name: item?.name ?? key, strength: scale, trigger: item?.trigger ?? [], tips: [], samples: [] };
        });
      };
      const rowSeconds = (li) => Math.min(spec.maxSeconds, Math.max(spec.minSeconds, Number(li.querySelector(".shot-seconds").value) || spec.minSeconds));
      const rowAvoid = (li) => joinAvoid(li.querySelector(".shot-avoid").value);
      // Claude's Avoid line for a shot goes into its field; no line leaves
      // the field as it was.
      const setAvoid = (li, text) => {
        const line = /^Avoid:\s*(.+)$/m.exec(text ?? "")?.[1];
        if (line != null) li.querySelector(".shot-avoid").value = avoidWords(line);
      };
      const addRow = (shot) => {
        const li = document.createElement("li");
        if (shot.written || shot.text) li.dataset.written = String(shot.written || Math.min(spec.maxSeconds, Math.max(spec.minSeconds, shot.seconds)));
        const items = shotLoraItems();
        const chosen = shot.loras ?? loraBook(t.repo).on;
        const loraRows = items.length ? `<details class="shot-loras small"><summary>Add a LoRA</summary><div class="shot-lora-rows">${items.map(({ key, item }) => `<span class="shot-lora" data-key="${esc(key)}"><label class="check"><input type="checkbox" class="shot-lora-on" ${key in chosen ? "checked" : ""}> ${esc(item.name)}</label> <label class="lora-scale">at <input type="number" class="shot-lora-strength" min="0" max="1.5" step="0.05" value="${Number(chosen[key] ?? item.scale ?? 1)}"></label></span>`).join("")}${claudeAvailable() ? `<button class="ghost shot-fit-lora" title="Claude rewrites this shot's words in the shape its ticked LoRAs' creators prompt for, with their trigger words, and sets the strengths they recommend">Fit the words to the LoRAs</button>` : ""}<span class="shot-lora-note muted"></span></div></details>` : "";
        const askRow = claudeAvailable() ? `<div class="shot-ask"><input class="ask-text shot-ask-text" placeholder="Ask Claude to change this shot"><button class="ghost shot-ask-go">Ask</button></div><p class="shot-said muted small" hidden></p>` : "";
        li.innerHTML = `<div class="shot-head"><span class="shot-n"></span><label class="shot-len"><input type="number" class="shot-seconds" min="${spec.minSeconds}" max="${spec.maxSeconds}" step="1" value="${shot.seconds}"> s</label><button class="ghost shot-remove" title="Remove this shot">Remove</button></div><textarea class="shot-text" rows="3">${esc(shot.text)}</textarea><label class="shot-avoid-row small"><span class="muted">Avoid</span><input class="shot-avoid" value="${esc(shot.negative ?? "")}" placeholder="what this shot must keep out, on top of the list above" title="What the model must keep out of this shot, comma-separated, on top of the avoid list of the whole request"></label>${loraRows}${askRow}`;
        li.querySelector(".shot-remove").addEventListener("click", () => {
          li.remove();
          total();
        });
        li.querySelector(".shot-seconds").addEventListener("input", () => {
          total();
          fitHint(li);
        });
        li.querySelector(".shot-text").addEventListener("input", total);
        li.querySelector(".shot-avoid").addEventListener("input", total);
        li.querySelectorAll(".shot-lora-on, .shot-lora-strength").forEach((inp) => inp.addEventListener("input", total));
        // A line to Claude for this shot alone: the change asked for is
        // made in the row's words, and said back in one short line.
        const askGo = li.querySelector(".shot-ask-go");
        const ask = async () => {
          const input = li.querySelector(".shot-ask-text");
          const request = input.value.trim();
          const said = li.querySelector(".shot-said");
          if (!request) return;
          askGo.disabled = true;
          said.hidden = false;
          said.textContent = "Claude is changing it";
          const loras = await shotLoraMaterial(li);
          const got = await claudeText({ kind: "prompt", mode: "revise", clip: true, model: t.repo, prompt: li.querySelector(".shot-text").value.trim(), negative: rowAvoid(li), request, seconds: rowSeconds(li), ...(loras ? { loras } : {}) });
          askGo.disabled = false;
          const description = (/^Description:\s*(.+)$/m.exec(got.text ?? "")?.[1] ?? "").trim();
          if (!description) {
            said.textContent = `No change: ${got.why || "Claude wrote no Description line"}.`;
            return;
          }
          li.querySelector(".shot-text").value = description;
          setAvoid(li, got.text);
          li.dataset.written = String(rowSeconds(li));
          said.textContent = `Claude: ${(/^Changed:\s*(.+)$/m.exec(got.text)?.[1] ?? "").trim() || "changed as asked."}`;
          input.value = "";
          total();
        };
        askGo?.addEventListener("click", ask);
        li.querySelector(".shot-ask-text")?.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") {
            ev.preventDefault();
            ask();
          }
        });
        // Claude fits this shot's words to the LoRAs ticked for it, the
        // way the suggest button does for a clip, and takes the strengths.
        li.querySelector(".shot-fit-lora")?.addEventListener("click", async (ev) => {
          const b = ev.currentTarget;
          const note = li.querySelector(".shot-lora-note");
          const own = shotLorasOf(li);
          if (!Object.keys(own).length) {
            note.textContent = "Tick a LoRA for this shot first.";
            return;
          }
          b.disabled = true;
          note.textContent = "Claude is reading how the LoRAs are prompted for";
          const loras = await shotLoraMaterial(li);
          const secs = rowSeconds(li);
          const got = await claudeText({ kind: "prompt", mode: "suggest", clip: true, model: t.repo, prompt: li.querySelector(".shot-text").value.trim(), negative: rowAvoid(li), seconds: secs, loras });
          b.disabled = false;
          const description = (/^Description:\s*(.+)$/m.exec(got.text ?? "")?.[1] ?? "").trim();
          if (!description) {
            note.textContent = `No fit: ${got.why || "Claude wrote no Description line"}.`;
            return;
          }
          li.querySelector(".shot-text").value = description;
          setAvoid(li, got.text);
          const changes = suggestedLoraChanges(got.text, loras);
          for (const x of changes.strengths) {
            const inp = li.querySelector(`.shot-lora[data-key="${CSS.escape(x.key)}"] .shot-lora-strength`);
            if (inp) inp.value = String(x.to);
          }
          const why = (/^Why:\s*([\s\S]+)$/m.exec(got.text)?.[1] ?? "").trim();
          note.textContent = `Fitted by Claude${changes.strengths.length ? `, strength ${changes.strengths.map((x) => `${x.name} ${x.to.toFixed(2)}`).join(", ")}` : ""}${why ? `: ${why}` : "."}`;
          total();
        });
        list.append(li);
      };
      for (const s of got.shots) addRow(s);
      total();
      el.querySelector("#shot-add").addEventListener("click", () => {
        addRow({ seconds: spec.minSeconds, text: "" });
        list.lastElementChild.querySelector(".shot-text").focus();
        total();
      });
      // A line to Claude for the whole scene: the shots come back changed
      // where the request touches them, each row's LoRAs kept by place.
      const askAll = async () => {
        const input = el.querySelector("#shots-ask");
        const said = el.querySelector("#shots-ask-said");
        const go = el.querySelector("#shots-ask-go");
        const request = input.value.trim();
        const rows = [...list.querySelectorAll("li")];
        const shots = rows.map((li, i) => ({ index: i + 1, seconds: rowSeconds(li), text: li.querySelector(".shot-text").value.trim(), negative: rowAvoid(li) })).filter((x) => x.text);
        if (!request || !shots.length) return;
        go.disabled = true;
        said.textContent = "Claude is changing the shots";
        const got = await claudeText({ kind: "prompt", mode: "revise-all", clip: true, model: t.repo, request, shots, minSeconds: spec.minSeconds, maxSeconds: spec.maxSeconds });
        go.disabled = false;
        const revised = parseShots(got.text ?? "").shots;
        if (!revised.length) {
          said.textContent = `No change: ${got.why || "Claude wrote no Shot lines"}.`;
          return;
        }
        const picks = rows.map((li) => (shotLoraItems().length ? shotLorasOf(li) : null));
        const avoids = rows.map(rowAvoid);
        const wroteAvoid = /^Avoid:/im.test(got.text ?? "");
        list.innerHTML = "";
        revised.forEach((x, i) => addRow({ seconds: Math.min(spec.maxSeconds, Math.max(spec.minSeconds, x.seconds)), text: x.text, negative: wroteAvoid ? x.negative : avoids[i] ?? "", ...(picks[i] ? { loras: picks[i] } : {}) }));
        said.textContent = `Claude: ${(/^Changed:\s*(.+)$/m.exec(got.text)?.[1] ?? "").trim() || "changed as asked."}`;
        input.value = "";
        total();
      };
      el.querySelector("#shots-ask-go")?.addEventListener("click", askAll);
      el.querySelector("#shots-ask")?.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          askAll();
        }
      });
      wire(() => {
        const shots = read();
        if (!shots.length) return null;
        if (unseen) item.notes = [...(item.notes ?? []), "The shots were laid out with the starting picture described to Claude, not shown: with it in front of Claude, no shots came."];
        item.shots = shots.map((s) => ({ seconds: framesFor(s.seconds, spec) / spec.fps, frames: framesFor(s.seconds, spec), text: s.text, negative: s.negative, ...(s.loras ? { loras: s.loras } : {}) }));
        item.shotsEdited = shots.length !== got.shots.length || shots.some((s, i) => s.text !== got.shots[i].text || s.negative !== (got.shots[i].negative ?? "") || s.seconds !== Math.min(spec.maxSeconds, Math.max(spec.minSeconds, got.shots[i].seconds)));
        item.pieces = item.shots.length;
        const lv = spec.levels[level] ?? spec.levels.medium;
        const sum = item.shots.reduce((a, s) => a + s.frames, 0) / spec.fps;
        const ests = item.shots.map((s) => clipEstimate(spec, level, s.seconds, t.repo));
        item.settings = `${sum.toFixed(1)} s as a scene of ${item.pieces} shots at ${level} quality, ${lv.width} by ${lv.height}, ${lv.steps} steps`;
        item.each = `${level} quality, ${lv.width} by ${lv.height}, ${lv.steps} steps`;
        item.estimate = { base: ests.reduce((a, e) => a + e.base, 0), seconds: ests.reduce((a, e) => a + e.seconds, 0) };
        return [];
      });
    });
  }
  // Work still going from before this window was drawn: its log is back
  // on show and the lines keep coming; the buttons wait for it.
  if (rec.lines.length) {
    const log = box.querySelector("#image-log");
    log.hidden = false;
    log.textContent = rec.lines.join("\n") + "\n";
    log.scrollTop = log.scrollHeight;
  }
  if (rec.active) {
    setBusy(box, true);
    if (rec.status) {
      const st = box.querySelector("#image-status");
      st.hidden = false;
      st.textContent = rec.status;
    }
  } else if (rec.failed.length) retryRow(rec.failed);
  // Requests from before that are still on the machine (the page was
  // reloaded while they ran): followed again, unless they are being followed.
  const pending = t.agent && !rec.active ? pendingJobs(t.repo) : [];
  if (pending.length) run(pending.map((pj) => ({ item: pj.item, id: pj.id, started: pj.at, args: null })), { resumed: true });
  else drain(["The queue from before goes on."]);

  // The way to go again, right under the failure: the failed requests
  // once more. A single one is read afresh from the box, so changed words
  // or settings count; a queue's failures go again as they were.
  function retryRow(items) {
    const b = liveBox();
    if (!items.length || !b || b.querySelector("#image-retry")) return;
    const row = document.createElement("p");
    row.className = "tools-row";
    const at = items.length === 1 && items[0].retryAt ? items[0].retryAt : null;
    row.innerHTML = `<button class="primary" id="image-retry">${at ? `Try again at ${at} s` : "Try again"}</button>`;
    b.querySelector("#image-log").after(row);
    row.querySelector("#image-retry").addEventListener("click", async () => {
      row.remove();
      const fresh = items.length === 1 && !items[0].replyTo;
      if (at) {
        const sec = liveBox()?.querySelector("#video-seconds");
        if (sec) sec.value = String(at);
        refreshEstimate();
      }
      if (!fresh) return run(items);
      // Asked afresh: at High the expansion shows first, as from the button.
      const item = makeItem($("#image-prompt").value.trim() || items[0].prompt);
      const intro = await withExpansion(item);
      run([item], { intro });
    });
  }

  // A reply to a result: what should change, said as to a person. The
  // words are revised with the change in them, by Claude when a key is
  // there and from the reply itself otherwise, and the same model is asked
  // again with the same seed. A picture is painted over at a strength that
  // fits the size of the change, which costs that fraction of a fresh one;
  // a clip cannot be changed in place by these models, so it is made again
  // whole, and the seed keeps the scene close.
  async function reply(entry, text, foot, mode = "change") {
    if (mode === "continue" && entry.kind === "video") return continueClip(entry, text, foot);
    if (mode === "change" && piecedClip(entry)) return fixClip(entry, text, foot);
    const picture = entry.kind !== "video";
    foot.textContent = claudeAvailable() ? "Claude is writing the revised description" : "Revising the words";
    const revised = await reviseFor(entry, text, t.repo);
    const c = chosen();
    // The settings the result was made with: kept with it, or read from its
    // caption for one kept before they were, so a reply never takes the
    // settings chosen for something else.
    const q = entry.q ?? qFromSettings(entry.settings, spec, qualities) ?? c.q;
    const item = { prompt: revised.prompt, negative: revised.negative, quality: entry.quality ?? (!spec && entry.settings ? entry.settings.split(",")[0].trim() : null) ?? c.quality ?? null, q, settings: entry.settings ?? c.text, seed: entry.seed ?? randomSeed(), replyTo: { id: entry.id, text }, startFile: null, estimate: null };
    const lines = [`Reply to the earlier ${picture ? "picture" : "clip"}: "${text}"`, `${revised.by === "Claude" ? "Claude's revised description" : `From your words${revised.why ? ` (Claude: ${revised.why})` : ""}`}: "${item.prompt}"${item.negative ? `, avoiding "${item.negative}"` : ""}.`];
    if (picture) {
      item.paintOver = true;
      item.strength = Math.min(0.9, Math.max(0.2, 1 - revised.keep / 100));
      const took = entry.took ?? (item.quality ? tookSeconds(t.repo, item.quality) : null);
      lines.push(`Painting over the earlier picture with the same seed, keeping about ${Math.round((1 - item.strength) * 100)}% of it: about ${Math.round(item.strength * 100)}% of the time of a fresh one${took ? `, around ${shortDuration(took * item.strength)}` : ""}.`);
    } else {
      if (spec && q?.frames) {
        const base = 0.5 * ((q.width * q.height) / 1e6) * q.frames * q.steps * (spec.heavy ?? 1);
        item.estimate = { base, seconds: Math.max(1, Math.round(base * (calibration(t.repo)?.factor ?? 1))) };
      }
      lines.push(`This model cannot change a clip in place, so it is made again whole from the revised words with the same seed; the scene stays close.${item.estimate ? ` About ${shortDuration(item.estimate.seconds)}.` : ""}`);
    }
    if (entry.seedKept === false) lines.push("This machine's image is from before seeds were passed along, so the remake may differ more than that; a machine on the current image keeps to it.");
    const b = liveBox();
    if (b) {
      b.querySelector("#image-prompt").value = item.prompt;
      b.querySelector("#image-negative").value = item.negative;
    }
    if (rec.active) {
      queue.push(item);
      renderQueue();
      for (const line of lines) rec.lines.push(line);
      foot.textContent = "Added to the queue; it goes after what is running.";
      return;
    }
    foot.textContent = "Asked; the log above follows it.";
    run([item], { intro: lines });
  }

  // A clip continued: what happens next, said as to a person. The next clip
  // starts from this one's last frame, with the words for what follows,
  // written by Claude when a key is there and read from the reply otherwise.
  async function continueClip(entry, text, foot) {
    foot.textContent = claudeAvailable() ? "Claude is writing the next shot" : "Reading what happens next";
    const words = await continueWords(entry, text, t.repo);
    const c = chosen();
    const q = entry.q ?? qFromSettings(entry.settings, spec, qualities) ?? c.q;
    const level = entry.level ?? c.level ?? "medium";
    const item = { prompt: words.prompt, negative: entry.negative ?? "", quality: null, level, q, settings: entry.q ? `${(q.frames / spec.fps).toFixed(1)} s at ${level} quality, ${q.width} by ${q.height}, ${q.frames} frames, ${q.steps} steps` : c.text, seed: randomSeed(), continues: { id: entry.id, text }, startFrom: entry.id, after: entry.id, startFile: null, pieces: 1, estimate: null };
    if (spec && q?.frames) {
      const base = 0.5 * ((q.width * q.height) / 1e6) * q.frames * q.steps * (spec.heavy ?? 1);
      item.estimate = { base, seconds: Math.max(1, Math.round(base * (calibration(t.repo)?.factor ?? 1))) };
    }
    const lines = [`Continuing the earlier clip: "${text}"`, `${words.by === "Claude" ? "Claude's next shot" : `From your words${words.why ? ` (Claude: ${words.why})` : ""}`}: "${item.prompt}". It starts from that clip's last frame${entry.last ? "" : ", read from the clip in this browser"}.${item.estimate ? ` About ${shortDuration(item.estimate.seconds)}.` : ""}`];
    if (rec.active) {
      queue.push(item);
      renderQueue();
      for (const line of lines) rec.lines.push(line);
      foot.textContent = "Added to the queue; it goes after what is running.";
      return;
    }
    foot.textContent = "Asked; the log above follows it.";
    run([item], { intro: lines });
  }

  // A fix to a clip made as shots: what is wrong, said as to a person. Only
  // the shots the complaint touches are made again, from revised words with
  // the same seeds, each from the last frame of the shot before; the rest
  // are kept as they were, and all are joined again, so a hat missing from
  // one shot of a thirty-second clip costs one shot, not thirty seconds.
  // Claude says which shots and writes their words, with a key; without
  // one the shot is read from the reply ("in shot 2", "the last shot") and
  // its words revised from it. The plan shows first, under the clip, to
  // tick, untick or change before anything is sent.
  async function fixClip(entry, text, foot) {
    const group = entry.piece.group;
    const n = entry.piece.joined ?? entry.piece.of;
    const kept = await keptResults(t.repo);
    const old = [];
    for (let k = 1; k <= n; k++) {
      const e = kept.filter((x) => x.piece?.group === group && x.piece.index === k && x.blob).sort((a, b) => b.madeAt - a.madeAt)[0];
      if (!e) throw new Error(`${entry.shots ? "shot" : "piece"} ${k} of the ${n} is no longer kept here, so the clip cannot be fixed shot by shot; ask for it again as a new request`);
      old.push(e);
    }
    const level = entry.level ?? old[0].level ?? "medium";
    const lv = spec.levels[level] ?? spec.levels.medium;
    const word = entry.shots ? "shot" : "piece";
    const shots = old.map((e, i) => ({ index: i + 1, seconds: (e.q?.frames ?? 0) / spec.fps, frames: e.q?.frames ?? framesFor(spec.minSeconds, spec), text: e.prompt, negative: e.negative ?? "", seed: e.seed, keep: e.id, loras: e.loras ?? null }));
    foot.textContent = claudeAvailable() ? "Claude is working out which shots to make again" : "Reading which shot to make again";
    const plan = await fixPlan(entry, shots, text, t.repo);
    foot.textContent = "";
    // The plan is kept with the clip, edits and all, so the window can be
    // left and opened again without losing it.
    (rec.fixPlans ??= new Map()).set(entry.id, { entry, text, shots, plan, level, n, word, oldQ: old[0].q, oldSeed: old[0].seed, suggested: shots.map((s) => plan.changes.get(s.index) ?? reviseWords(s.text, entry.negative, text).prompt), ticks: shots.map((s) => plan.changes.has(s.index)), texts: shots.map((s) => plan.changes.get(s.index) ?? s.text), carry: plan.carry });
    // Into the card on show now: the window may have been opened again meanwhile.
    const live = rec.replies?.get(entry.id)?.footEl;
    showFixPlan(entry.id, live?.isConnected ? live : foot);
  }

  // The fix plan for a clip, drawn from what is kept: which shots are made
  // again, in which words, and whether the change carries through.
  function showFixPlan(id, foot) {
    const kept = rec.fixPlans?.get(id);
    const wrap = foot?.closest(".reply");
    if (!kept || !wrap) return;
    const { entry, text, shots, plan, level, n, word, suggested } = kept;
    const group = entry.piece.group;
    const lv = spec.levels[level] ?? spec.levels.medium;
    const old = [{ q: kept.oldQ, seed: kept.oldSeed }];
    wrap.hidden = false;
    wrap.querySelector(".fix")?.remove();
    const el = document.createElement("div");
    el.className = "fix";
    const none = !plan.changes.size;
    const reading = plan.claude ? `Claude named no ${word} to make again (${esc(plan.claude)})${none ? `: tick the ${word}s to make again.` : `; the ${word} your reply names is ticked.`}` : plan.by === "Claude" ? `Claude's reading${plan.why ? `: ${esc(plan.why)}` : "."}` : none ? `No ${word} is named in the reply${plan.why && plan.why !== "no shot named in the reply" ? ` (Claude: ${esc(plan.why)})` : ""}: tick the ${word}s to make again.` : `From your words${plan.why ? ` (Claude: ${esc(plan.why)})` : ""}.`;
    el.innerHTML = `<p class="muted small"><b>The fix, ${word} by ${word}.</b> ${reading} A ticked ${word} is made again from the words in its row, with the same seed, starting from the last frame of the ${word} before; the others are kept as they are, and all are joined again.</p>
      <ol class="shots fix-shots"></ol>
      <label class="muted small fix-carry-row"><input type="checkbox" class="fix-carry" ${kept.carry ? "checked" : ""}> Make the ${word}s after the last ticked one again too, so the change carries through them</label>
      <p class="muted small fix-total"></p>
      <p class="tools-row"><button class="primary fix-go">${rec.active ? "Add the fix to the queue (runs after the request under way)" : "Make the fix"}</button><button class="ghost fix-discard">Discard</button></p>`;
    const list = el.querySelector(".fix-shots");
    for (const s of shots) {
      const li = document.createElement("li");
      li.innerHTML = `<label class="shot-len"><input type="checkbox" class="fix-redo" ${kept.ticks[s.index - 1] ? "checked" : ""}> ${s.index} · ${s.seconds.toFixed(1)} s</label><textarea class="shot-text" rows="2">${esc(kept.texts[s.index - 1])}</textarea><span class="muted small fix-state"></span>`;
      list.append(li);
    }
    const rows = [...list.querySelectorAll("li")];
    // Which shots go: the ticked ones, and with the carry tick every one
    // after the last of them.
    const redo = () => {
      const ticked = rows.map((li, i) => (li.querySelector(".fix-redo").checked ? i + 1 : 0)).filter(Boolean);
      const last = ticked.at(-1) ?? 0;
      const carry = el.querySelector(".fix-carry").checked && last;
      return rows.map((_, i) => ticked.includes(i + 1) || (carry && i + 1 > last));
    };
    const total = () => {
      const going = redo();
      rows.forEach((li, i) => (li.querySelector(".fix-state").textContent = going[i] ? (li.querySelector(".fix-redo").checked ? "made again" : "made again, after the change") : "kept"));
      const count = going.filter(Boolean).length;
      const secs = shots.reduce((a, s, i) => a + (going[i] ? s.frames / spec.fps : 0), 0);
      const est = shots.reduce((a, s, i) => a + (going[i] ? clipEstimate(spec, level, s.seconds, t.repo).seconds : 0), 0);
      el.querySelector(".fix-total").textContent = count ? `${count} of ${n} ${word}s made again (${secs.toFixed(1)} s of ${shots.reduce((a, s) => a + s.frames / spec.fps, 0).toFixed(1)}) at ${level} quality, ${lv.width} by ${lv.height}, ${lv.steps} passes each, about ${shortDuration(est)}${price ? ` and ${money((price * est) / 3600)} of machine time` : ""}; the other ${n - count} kept, then all joined again.` : `Nothing ticked: tick a ${word} to make again, or discard.`;
      el.querySelector(".fix-go").disabled = !count;
    };
    rows.forEach((li, i) => {
      const tick = li.querySelector(".fix-redo");
      const area = li.querySelector(".shot-text");
      tick.addEventListener("change", () => {
        // Ticked with its old words still there, a shot takes the revised ones: the same words and seed would give the same shot.
        if (tick.checked && area.value.trim() === shots[i].text) area.value = suggested[i];
        kept.ticks[i] = tick.checked;
        kept.texts[i] = area.value;
        total();
      });
      area.addEventListener("input", () => {
        if (!tick.checked && area.value.trim() !== shots[i].text) tick.checked = true;
        kept.ticks[i] = tick.checked;
        kept.texts[i] = area.value;
        total();
      });
    });
    el.querySelector(".fix-carry").addEventListener("change", (e) => {
      kept.carry = e.target.checked;
      total();
    });
    total();
    wrap.append(el);
    el.querySelector(".fix-discard").addEventListener("click", () => {
      rec.fixPlans.delete(id);
      el.remove();
    });
    el.querySelector(".fix-go").addEventListener("click", () => {
      const going = redo();
      if (!going.some(Boolean)) return;
      const planned = shots.map((s, i) => ({ seconds: s.seconds, frames: s.frames, text: going[i] ? rows[i].querySelector(".shot-text").value.trim() || s.text : s.text, negative: s.negative ?? "", seed: s.seed, keep: s.keep, redo: going[i] }));
      const made = planned.filter((s) => s.redo);
      const ests = made.map((s) => clipEstimate(spec, level, s.seconds, t.repo));
      const sum = planned.reduce((a, s) => a + s.frames, 0) / spec.fps;
      const which = planned.map((s, i) => (s.redo ? i + 1 : 0)).filter(Boolean);
      const edited = made.some((s, i) => s.text !== suggested[which[i] - 1]);
      const item = { prompt: entry.prompt, negative: entry.negative ?? "", quality: null, level, q: old[0].q ?? entry.q, seed: entry.seed ?? old[0].seed ?? randomSeed(), pieces: n, shots: planned, shotsEdited: Boolean(entry.shotsEdited), scene: false, expand: false, expandSaid: true, startFile: null, replyTo: { id: entry.id, text }, fix: { group, text, redo: which, by: plan.by, edited, scene: Boolean(entry.shots) }, settings: `${which.length} of ${n} ${entry.shots ? "shots" : "pieces"} made again, ${sum.toFixed(1)} s in all at ${level} quality, ${lv.width} by ${lv.height}, ${lv.steps} steps`, each: `${level} quality, ${lv.width} by ${lv.height}, ${lv.steps} steps`, estimate: { base: ests.reduce((a, e) => a + e.base, 0), seconds: ests.reduce((a, e) => a + e.seconds, 0) } };
      const lines = [`Fix to the earlier clip: "${text}"`];
      rec.fixPlans.delete(id);
      el.remove();
      if (rec.active) {
        queue.push(item);
        renderQueue();
        for (const line of lines) rec.lines.push(line);
        foot.textContent = "Added to the queue; it goes after what is running.";
        return;
      }
      foot.textContent = "Asked; the log above follows it.";
      run([item], { intro: lines });
    });
  }

  // A request's arguments for the machine: the files it needs are read now,
  // and at High the words are expanded first, once, by Claude.
  async function requestArgs(item, say = () => {}) {
    let target = { repo: t.repo, file: t.file };
    let extra = {};
    if (item.expanded && !item.expandSaid) {
      item.expandSaid = true;
      say(`Expanded description for "${item.prompt}"${item.expandedEdited ? ", with your changes" : ""}: "${item.expanded}"`);
    }
    for (const note of item.notes ?? []) say(note);
    item.notes = [];
    if (item.expand && !item.replyTo && !item.expanded && claudeAvailable()) {
      say("Claude is expanding the description");
      const expanded = await expandWords(item.prompt, video, t.repo, item.negative, await startingPictureFor(item, t.repo), clipSeconds(item.q), video ? await loraContext(t) : null);
      if (expanded.text) {
        item.expanded = expanded.text;
        say(`Expanded: "${expanded.text}"`);
      } else say(`Claude gave no expansion (${expanded.why}); the words go as they are.`);
    }
    if (video && t.startPicture) {
      if (t.startPicture === "required" && !item.startFile) throw new Error("this model needs a starting picture");
      if (item.startFile) {
        extra.init = await readAsDataUrl(item.startFile);
        extra.strength = 0.9;
      }
    }
    // Reference pictures: the people and things the clip is to show, for
    // a model with a reference workflow; the clip comes from them and the
    // words, not from a starting frame.
    if (item.refFiles?.length) {
      extra.references = await Promise.all(item.refFiles.map((f) => readAsDataUrl(f)));
      say(`From ${item.refFiles.length} reference picture${item.refFiles.length === 1 ? "" : "s"} (${item.refFiles.map((f) => f.name).join(", ")}): the clip shows what is in them, as the words say.`);
    }
    // The first shot made again for a fix starts from the photo the clip
    // was made from, kept with that shot.
    if (item.startInit) {
      extra.init = item.startInit;
      extra.strength = 0.9;
    }
    // A continuation, or the next piece of a long clip: it starts from the
    // last frame of the clip before, kept in this browser.
    if (item.startFrom) {
      const src = (await keptResults(t.repo)).find((e) => e.id === item.startFrom);
      if (!src?.blob) throw new Error("the clip this starts from is no longer kept here");
      extra.init = await lastFrameOf(src);
      extra.strength = 0.9;
    }
    // Starting from a picture, the avoid list names what a model lets slip
    // through a turn or a long motion: another person in the same clothes,
    // another face, another place.
    if (extra.init && video) {
      const guard = "a different person, changed face, changed hair, changed clothes, changed background, studio backdrop";
      const have = String(item.negative ?? "").toLowerCase();
      extra.negative = [item.negative, ...guard.split(", ").filter((g) => !have.includes(g))].filter(Boolean).join(", ");
    }
    // A reply paints over the picture it answers, kept in this browser.
    if (item.paintOver) {
      const src = (await keptResults(t.repo)).find((e) => e.id === item.replyTo?.id);
      if (!src?.blob) throw new Error("the picture this replies to is no longer kept here");
      extra.init = await readAsDataUrl(src.blob);
      extra.strength = item.strength ?? 0.4;
    }
    if (addon && videoLora) {
      const base = bases[Number(box.querySelector("#addon-base")?.value ?? -1)];
      if (!base) throw new Error(`${baseName} is not on the rented GPU yet; open it and download it there first`);
      const variant = variants[Number(box.querySelector("#addon-variant").value)];
      if (t.startPicture === "required" && !extra.init) throw new Error("this LoRA needs a starting picture");
      const ending = box.querySelector("#video-last")?.value ?? "none";
      let lastInit = null;
      if (ending === "same") lastInit = extra.init ?? null;
      else if (ending === "file") {
        const f = box.querySelector("#video-last-file")?.files[0];
        if (!f) throw new Error("pick the last picture, or choose the same picture");
        lastInit = await readAsDataUrl(f);
      }
      target = { repo: base.repo, file: base.file };
      extra = { ...extra, addon: { kind: "lora", repo: t.repo, file: variant.file, lora: null, scale: Number(box.querySelector("#addon-scale").value) }, ...(lastInit ? { lastInit } : {}) };
    } else if (addon) {
      const base = bases[Number(box.querySelector("#addon-base")?.value ?? -1)];
      if (!base) throw new Error("no base model on the rented GPU yet");
      const variant = variants[Number(box.querySelector("#addon-variant").value)];
      if (variant.xl !== base.xl) throw new Error(`${variant.label} is for ${variant.xl ? "SDXL" : "SD 1.5"} bases; pick a matching variant or base`);
      const refFile = box.querySelector("#addon-ref")?.files[0];
      if (t.addonKind === "ip-adapter" && !refFile) throw new Error("pick a reference picture first");
      const ipImage = refFile ? await readAsDataUrl(refFile) : null;
      target = base;
      extra = { addon: { kind: t.addonKind, repo: t.repo, file: variant.file, lora: variant.lora, scale: Number(box.querySelector("#addon-scale").value) }, ipImage, xl: base.xl };
    }
    // The LoRAs ticked for this model and a fine-tune, if one is chosen.
    let prompt = item.expanded ?? item.prompt;
    if (video && !addon && t.engine === "diffusers" && t.agent) {
      const part = loraJobPart(t, item.shotLoras ?? null);
      extra = { ...extra, ...part.job };
      // A LoRA's trigger words lead the description, where it looks for them.
      const missing = part.trigger.filter((w) => !String(prompt).toLowerCase().includes(w.toLowerCase()));
      if (missing.length) prompt = `${missing.join(", ")}, ${prompt}`;
    }
    return { ...target, prompt, negative: extra.negative ?? item.negative, quality: item.q, video, seed: item.seed ?? null, ...extra };
  }

  // A finished result: timed against the guess, kept in this browser,
  // saved to the computer if that is on, and shown.
  async function finishResult(req, job, openedFor, say) {
    const { item, args } = req;
    const repo = args?.repo ?? t.repo;
    const blob = job.blob ?? b64ToBlob(job.video || job.image, job.video ? "video/mp4" : "image/png");
    const kind = job.video || job.blob?.type === "video/mp4" ? "video" : "image";
    // A picture painted over takes a fraction of the time, which says
    // nothing about a fresh one: the guess is not adjusted from it.
    if (job.took && !(item.paintOver && kind === "image")) {
      if (spec && item.estimate?.base && !item.follow) noteEstimate(t.repo, item.estimate.base, job.took);
      else if (item.quality) rememberTook(repo, item.quality, job.took);
      if (job.loadSeconds > 5) rememberLoad(t.repo, job.loadSeconds);
      const guess = item.estimate?.seconds ?? (item.quality ? qualities[item.quality]?.seconds : null);
      say(`This ${what} took ${shortDuration(job.took)} of machine time${price ? `, about ${money((price * job.took) / 3600)} at ${money(price)} an hour` : ""}${guess ? `; the guess was ${shortDuration(guess)}${spec ? ", and the next guess is adjusted" : ""}` : ""}${job.loadSeconds > 5 ? `. Loading the model first took ${shortDuration(job.loadSeconds)}${price ? `, about ${money((price * job.loadSeconds) / 3600)}` : ""}` : ""}.`);
      const qbox = liveBox()?.querySelector("#quality");
      if (qbox && !spec) {
        const picked = qbox.querySelector("input[name=quality]:checked")?.value;
        qbox.innerHTML = Object.entries(qualities).map(([q, info]) => `<label><input type="radio" name="quality" value="${q}" ${q === picked ? "checked" : ""}> ${qualityLabel(q, info, plan.fast)}</label>`).join("");
      }
      refreshEstimate();
    } else if (job.took) say(`This picture took ${shortDuration(job.took)} of machine time${price ? `, about ${money((price * job.took) / 3600)}` : ""}.`);
    const madeBy = addon ? `${t.repo.split("/").pop()} on ${repo.split("/").pop()}` : t.file;
    // The seed the machine used, so a reply can keep to it; a machine from
    // before seeds were passed along says nothing, and that is remembered.
    const entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, model: t.repo, kind, prompt: item.prompt, negative: item.negative, madeAt: Date.now(), bytes: blob.size, blob, took: job.took ?? null, settings: item.settings, madeBy, seed: job.seed ?? item.seed ?? null, seedKept: job.seed != null, q: item.q ?? null, quality: item.quality ?? null, level: item.level ?? null, expanded: item.expanded ?? null, expandedEdited: Boolean(item.expandedEdited), replyTo: item.replyTo ?? null, continues: item.continues ?? null, piece: item.piece ?? null, last: job.lastFrame ?? null, jobId: job.id ?? null, shots: item.shots?.length ? item.shots : null, shotsEdited: Boolean(item.shotsEdited), fix: item.fix ?? null, startPicture: (item.startFile || item.startInit) && typeof args?.init === "string" ? args.init : null, refs: item.refFiles?.length ?? 0, loras: item.shotLoras ?? null };
    await keepResult(entry);
    rec.shown.add(entry.id);
    // The pictures kept for a queued request are not needed once it is made.
    if (item.id && !item.piece) forgetPictures(item.id);
    const name = `${kind === "video" ? "clip" : "image"}-${entry.id}.${kind === "video" ? "mp4" : "png"}`;
    const auto = autosaveSettings();
    if (auto.on) {
      if (blob.size <= auto.maxMb * 1048576) {
        saveBlob(blob, name);
        say(`Saved ${name} to this computer (${mbText(blob.size)}); it is kept in this browser as well.`);
      } else say(`Kept in this browser; not saved to this computer by itself, as ${mbText(blob.size)} is over the ${auto.maxMb} MB limit. Download it below.`);
    } else say("Kept in this browser; Download saves it to this computer.");
    const show = (out) => {
      if (kind === "video") showClip(out, { blob, prompt: item.prompt, name });
      else showPicture(out, { data: job.image, prompt: item.prompt, negative: item.negative, model: t.repo, madeBy, agent: t.agent, repo, modelFile: args?.file ?? t.file, chain: [] });
    };
    // The window may have been left meanwhile: a note says it is ready,
    // and the kept list shows it when the model is opened again. Drawn
    // again for the same model, the window as it stands now shows it.
    const b = liveBox();
    if (!b) {
      pictureReady(openedFor, kind);
      return entry;
    }
    const out = b.querySelector("#image-out");
    show(out);
    const card = out.lastElementChild;
    card.dataset.entry = entry.id;
    const cap = document.createElement("p");
    cap.className = "muted small caption";
    cap.textContent = captionText(entry);
    card.querySelector(".tools-row")?.before(cap);
    // A reply, a continuation or the next piece lands right under what it
    // follows, not at the end of the row.
    const ref = item.replyTo?.id ?? item.continues?.id ?? item.after ?? null;
    const followed = ref ? out.querySelector(`[data-entry="${CSS.escape(ref)}"]`) : null;
    if (followed) followed.after(card);
    addReply(card, entry, reply);
    renderKept(b, t.repo, rec.shown, reply);
    return entry;
  }

  // A long clip: pieces made one after another, each from the last frame of
  // the one before, kept and shown as they come, then joined on the machine
  // into one clip. A machine from before joining leaves the pieces as they are.
  const onStatusFor = (text) => rec.onStatus?.(text);
  async function runPieces(item, openedFor, say) {
    const fix = item.fix ?? null;
    const group = fix?.group ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const shots = item.shots?.length ? item.shots : null;
    const lv = spec.levels[item.level] ?? spec.levels.medium;
    const word = fix ? (fix.scene ? "Shot" : "Piece") : "Shot";
    if (fix) {
      say(`${fix.redo.length} of ${item.pieces} ${word.toLowerCase()}s made again from revised words${fix.by === "Claude" ? " by Claude" : ""}${fix.edited ? ", with your changes" : ""}, each with the seed it had and starting from the last frame of the one before; the other ${item.pieces - fix.redo.length} kept as ${item.pieces - fix.redo.length === 1 ? "it was" : "they were"}; then all joined again:`);
      shots.forEach((s, i) => say(`  ${word} ${i + 1} (${s.seconds.toFixed(1)} s): ${s.redo ? s.text : "kept"}`));
    } else if (shots) {
      say(`Scene of ${(shots.reduce((a, s) => a + s.frames, 0) / spec.fps).toFixed(1)} seconds in ${shots.length} shots, laid out by Claude${item.shotsEdited ? ", with your changes" : ""}, each starting where the last ended, then joined:`);
      shots.forEach((s, i) => say(`  Shot ${i + 1} (${s.seconds.toFixed(1)} s): ${s.text}${s.negative ? ` (avoiding ${s.negative})` : ""}`));
    } else say(`A ${((item.q.frames * item.pieces) / spec.fps).toFixed(1)}-second clip, made as ${item.pieces} pieces of ${(item.q.frames / spec.fps).toFixed(1)} s, each starting where the last ended, then joined.`);
    const entries = [];
    const fresh = new Set();
    let prev = null;
    for (let k = 1; k <= item.pieces; k++) {
      const shot = shots?.[k - 1] ?? null;
      // A shot the fix leaves alone: the one kept here stands in its place.
      if (fix && !shot.redo) {
        const old = (await keptResults(t.repo)).find((e) => e.id === shot.keep);
        if (!old?.blob) throw new Error(`${word.toLowerCase()} ${k} is no longer kept here`);
        say(`${word} ${k} of ${item.pieces}: kept as it was`);
        prev = old;
        entries.push(old);
        continue;
      }
      // The first shot made again starts from the photo the clip began
      // from, kept with the old shot; without one it starts from its words.
      const first = fix && k === 1 ? (await keptResults(t.repo)).find((e) => e.id === shot.keep) : null;
      if (fix && k === 1 && !first?.startPicture && t.startPicture === "required") throw new Error("the first shot began from a photo that is not kept here; pick it again and ask for the clip as a new request");
      const piece = shot
        ? { ...item, prompt: shot.text, negative: joinAvoid(item.negative, shot.negative), q: { ...item.q, frames: shot.frames }, scene: false, shots: null, fix: null, pieces: 1, shotLoras: shot.loras ?? null, piece: { group, index: k, of: item.pieces, shot: !fix || fix.scene, ...(fix ? { fixes: shot.keep } : {}) }, seed: fix && Number.isInteger(shot.seed) ? shot.seed : (item.seed + k - 1) % 2 ** 31, startFrom: prev?.id ?? null, after: prev?.id ?? null, startFile: k === 1 ? item.startFile : null, startInit: first?.startPicture ?? null, replyTo: null, expand: false, expanded: null, expandSaid: true, estimate: { base: clipEstimate(spec, item.level, shot.seconds, t.repo).base, seconds: clipEstimate(spec, item.level, shot.seconds, t.repo).seconds }, settings: `${word.toLowerCase()} ${k} of ${item.pieces}${fix ? ", made again" : ""}, ${shot.seconds.toFixed(1)} s at ${item.level} quality, ${lv.width} by ${lv.height}, ${shot.frames} frames, ${lv.steps} steps` }
        : { ...item, pieces: 1, piece: { group, index: k, of: item.pieces }, seed: (item.seed + k - 1) % 2 ** 31, startFrom: prev?.id ?? null, after: prev?.id ?? null, startFile: k === 1 ? item.startFile : null, expand: k === 1 ? item.expand : false, expanded: item.expanded ?? null, expandSaid: k > 1 ? true : item.expandSaid, estimate: item.estimate ? { base: item.estimate.base, seconds: Math.round(item.estimate.seconds / item.pieces) } : null, settings: `piece ${k} of ${item.pieces}, ${item.each ?? item.settings}` };
      say(`${shot ? word : "Piece"} ${k} of ${item.pieces}${fix ? ", made again" : ""}${prev ? ", from the last frame of the one before" : piece.startInit ? ", from the photo the clip began from" : ""}`);
      const req = { item: piece, args: await requestArgs(piece, say) };
      if (piece.expanded) item.expanded = piece.expanded;
      await agentBatch(t.agent, [req], say, {
        repo: t.repo,
        onStatus: (text) => onStatusFor(text),
        onDone: async (r, job, err) => {
          if (err) throw err;
          prev = await finishResult(r, job, openedFor, say);
          entries.push(prev);
          fresh.add(prev.id);
        },
      });
    }
    // The pieces for the machine to join: the ones it still has, by job;
    // the others (kept shots from before a restart, or from more than
    // half an hour ago) sent up from this browser.
    const pieces = [];
    let sent = 0;
    for (const e of entries) {
      const there = e.jobId && (fresh.has(e.id) || (await fetch(`${t.agent}/jobs/${e.jobId}?lean=1`, { headers: agentHeaders(), cache: "no-store", signal: AbortSignal.timeout(20e3) }).then((r) => r.ok).catch(() => false)));
      if (there) pieces.push({ id: e.jobId });
      else {
        if (!e.blob) {
          say(`${word} ${e.piece?.index ?? "?"} is no longer kept here, so the pieces cannot be joined; they are kept one by one, in order.`);
          return;
        }
        pieces.push({ video: await blobToBase64(e.blob) });
        sent++;
      }
    }
    say(`Joining the ${entries.length} pieces into one clip on the machine${sent ? ` (${sent} of them sent up from this browser)` : ""}`);
    const ids = pieces.every((p) => p.id) ? pieces.map((p) => p.id) : null;
    const res = await fetch(`${t.agent}/jobs/join`, { method: "POST", headers: { "Content-Type": "application/json", ...agentHeaders() }, body: JSON.stringify({ ...(ids ? { ids } : {}), pieces }) }).catch(() => null);
    if (!res || res.status === 404 || (res.status === 400 && sent)) {
      say(`This machine's image is from before ${sent ? "kept pieces could be sent up to be joined" : "clips could be joined on it"}; the pieces are kept and saved one by one, in order. A machine on the current image joins them.`);
      return;
    }
    if (!res.ok) {
      say(`The machine could not join them (${(await res.json().catch(() => ({}))).error || `HTTP ${res.status}`}); the pieces are kept one by one.`);
      return;
    }
    const { id } = await res.json();
    const job = await followJob(t.agent, id, say);
    job.took = null;
    const total = entries.reduce((a, e) => a + (e.q?.frames ?? 0), 0) / spec.fps;
    const joinedSettings = fix ? `${total.toFixed(1)} s ${fix.scene ? `as a scene of ${entries.length} shots` : `in ${entries.length} pieces`}, ${item.each ?? ""}`.replace(/, $/, "") : shots ? `${total.toFixed(1)} s as a scene of ${entries.length} shots, ${item.each ?? ""}`.replace(/, $/, "") : `${total.toFixed(1)} s in ${entries.length} pieces, ${item.each ?? ""}`.replace(/, $/, "");
    await finishResult({ item: { ...item, settings: joinedSettings, piece: { group, joined: entries.length }, estimate: null, after: entries.at(-1).id, replyTo: fix ? item.replyTo : null, continues: null, expanded: item.expanded ?? null, shots: fix && !fix.scene ? null : item.shots, shotsEdited: fix ? true : item.shotsEdited }, args: null }, job, openedFor, say);
  }

  // Runs requests: one from the Generate button, several from the queue,
  // or ones from before found still on the machine.
  async function run(items, { resumed = false, intro = [], append = false } = {}) {
    rec.active = true;
    rec.failed = [];
    const keepLog = resumed || append;
    if (!keepLog) rec.lines = [];
    const first = liveBox();
    if (first) {
      const log = first.querySelector("#image-log");
      log.hidden = false;
      if (!keepLog) log.textContent = "";
      first.querySelector("#image-retry")?.closest("p")?.remove();
      setBusy(first, true);
    }
    // A line lands in the record and in the window as it stands now.
    const say = (line) => {
      rec.lines.push(line);
      const log = liveBox()?.querySelector("#image-log");
      if (!log) return;
      log.hidden = false;
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    };
    for (const line of intro) say(line);
    // The state of the request in flight, refreshed every poll.
    const onStatus = (text) => {
      rec.status = text;
      const st = liveBox()?.querySelector("#image-status");
      if (!st) return;
      st.hidden = !text;
      st.textContent = text;
    };
    rec.onStatus = onStatus;
    try {
      if (items[0]?.item?.quality ?? items[0]?.quality) {
        try {
          localStorage.setItem("imageQuality", items[0].item?.quality ?? items[0].quality);
        } catch {
          // no storage
        }
      }
      if (!t.agent) {
        const item = items[0];
        const { id } = await api.post("/api/run", { kind: "generate-image", args: { repo: t.repo, file: t.file, prompt: item.prompt, negative: item.negative, quality: item.quality } });
        const result = await follow(id, say);
        const out = liveBox()?.querySelector("#image-out");
        if (result.status === "done" && result.result && out) {
          out.innerHTML = "";
          showPicture(out, { file: result.result, prompt: item.prompt, negative: item.negative, model: t.repo, madeBy: t.file, chain: [] });
        }
        return;
      }
      const openedFor = state.model?.id ?? t.repo;
      backgroundNote(liveBox(), state.model ?? { id: t.repo }, items.length > 1 ? `The ${what}s are made` : `The ${what} is made`);
      const stopAfter = Boolean(liveBox()?.querySelector("#image-stop-after")?.checked);
      if (resumed) say(`${items.length} request${items.length === 1 ? "" : "s"} from before ${items.length === 1 ? "is" : "are"} still on the machine; following ${items.length === 1 ? "it" : "them"} again.`);
      const long = resumed ? [] : items.filter((it) => it.pieces > 1);
      const requests = [];
      for (const item of items) if (!long.includes(item)) requests.push(resumed ? item : { item, args: await requestArgs(item, say) });
      let made = 0;
      const failedItems = [];
      try {
        if (requests.length) await agentBatch(t.agent, requests, say, {
          repo: t.repo,
          onStatus,
          onDone: async (req, job, err, i) => {
            if (err) {
              if (req.item) failedItems.push(req.item);
              say(`Could not make ${requests.length > 1 ? `request ${i + 1}` : "it"}: ${err.message}`);
              await machineSays(t.agent, say);
              // Out of memory: the size is remembered as too big for this
              // machine, the estimate warns above it from now on, and the
              // way to go again is at a length that stays under it.
              if (/ran out of memory/i.test(err.message) && req.item?.q) {
                const q = req.item.q;
                const limit = rememberMemoryLimit(t.repo, q, spec ? `${(q.frames / spec.fps).toFixed(1)} seconds at ${req.item.level ?? "this"} quality (${q.frames} frames at ${q.width} by ${q.height})` : `${q.width} by ${q.height}`);
                if (spec) {
                  const shorter = fitsUnder(limit, req.item.level ?? "medium", q.frames / spec.fps);
                  req.item.retryAt = shorter;
                  refreshEstimate();
                  say(shorter ? `A ${shorter}-second clip at ${req.item.level ?? "this"} quality should fit this machine; Try again below asks for that. Low quality is a surer fit.` : "Try a lower quality, or a bigger card.");
                } else say("Try a smaller preset, or a bigger card.");
              }
              return;
            }
            made++;
            if (req.item?.q) rememberFit(t.repo, req.item.q, spec ? `${(req.item.q.frames / spec.fps).toFixed(1)} seconds at ${req.item.level ?? "this"} quality` : `${req.item.q.width} by ${req.item.q.height}`);
            await finishResult(req, job, openedFor, say);
          },
        });
        for (const item of long) {
          try {
            await runPieces(item, openedFor, say);
            made++;
          } catch (err) {
            failedItems.push(item);
            say(`Could not make the long clip: ${err.message}`);
            await machineSays(t.agent, say);
          }
        }
      } finally {
        // Made or failed, the machine stops now if that was asked: the
        // bill ends with the work, not after an idle wait. With more in
        // the queue, the stop waits for the last of it.
        if (stopAfter && !(ready().length && !queueHeld())) stopAfterJob(say);
      }
      if (items.length > 1) say(`All done: ${made} made${failedItems.length ? `, ${failedItems.length} failed` : ""}.`);
      if (failedItems.length) {
        rec.failed = failedItems;
        retryRow(failedItems);
      }
    } catch (err) {
      say(`Could not start: ${err.message}`);
      rec.failed = items.filter((it) => !it.id || it.item).map((it) => it.item ?? it);
      retryRow(rec.failed);
    } finally {
      rec.active = false;
      onStatus("");
      const b = liveBox();
      if (b) setBusy(b, false);
      // Whatever was added to the queue meanwhile goes next, by itself.
      const n = ready().length;
      if (n && !queueHeld()) drain([`Next from the queue${n > 1 ? `: ${n} requests` : ""}.`]);
      else if (b) renderQueue();
    }
  }
}

// Whether a download on the rented machine stops it when done: yes unless
// unticked once, which is remembered.
function stopAfterDownloadWanted() {
  try {
    return localStorage.getItem("stopAfterDownload") !== "0";
  } catch {
    return true;
  }
}

// Whether the queue waits for a click instead of starting by itself.
function queueHeld() {
  try {
    return localStorage.getItem("queueHold") === "1";
  } catch {
    return false;
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not read the picture"));
    r.readAsDataURL(file);
  });
}

function mbText(bytes) {
  return `${(bytes / 1048576).toFixed(bytes < 10 * 1048576 ? 1 : 0)} MB`;
}

// Everything made with a model on the rented GPU, kept in this browser:
// closing the window, leaving the page or the machine stopping loses
// nothing. Listed under the try box with Download and Remove.
async function renderKept(box, repo, shownIds = new Set(), onReply = null) {
  const el = box.querySelector("#kept");
  if (!el) return;
  let list = [];
  try {
    list = await keptResults(repo);
  } catch {
    list = [];
  }
  if (!box.isConnected) return;
  list = list.filter((e) => !shownIds.has(e.id)).sort((a, b) => b.madeAt - a.madeAt);
  if (!list.length) {
    el.innerHTML = "";
    return;
  }
  const total = list.reduce((a, e) => a + (e.bytes || 0), 0);
  // This session's results are on show; earlier ones wait under a bar,
  // drawn only when it is opened.
  const since = sessionStart();
  const recent = list.filter((e) => e.madeAt >= since);
  const older = list.filter((e) => !(e.madeAt >= since));
  el.innerHTML = `<div class="kept-head"><b>Kept here</b> <span class="muted small">${list.length} ${list.length === 1 ? "result" : "results"} made with this model, ${mbText(total)} in this browser, until removed.</span></div>`;
  const card = (e) => {
    const url = URL.createObjectURL(e.blob);
    const name = `${e.kind === "video" ? "clip" : "image"}-${e.id}.${e.kind === "video" ? "mp4" : "png"}`;
    const card = document.createElement("div");
    card.className = "image-card kept";
    card.innerHTML = `${e.kind === "video" ? `<video class="result-image" src="${url}" controls loop muted playsinline title="${esc(e.prompt)}"></video>` : `<img class="result-image" src="${url}" alt="${esc(e.prompt)}">`}
      <p class="muted small caption">${esc(captionText(e))} · ${new Date(e.madeAt).toLocaleString()}${e.took ? ` · ${shortDuration(e.took)} of machine time` : ""} · ${mbText(e.bytes || 0)}</p>
      <p class="tools-row"><a class="button" href="${url}" download="${name}">Download</a><button class="ghost kept-remove">Remove</button></p>`;
    card.querySelector(".kept-remove").addEventListener("click", async () => {
      await forgetResult(e.id);
      card.remove();
      renderKept(box, repo, shownIds, onReply);
    });
    addReply(card, e, onReply);
    return card;
  };
  for (const e of recent) el.appendChild(card(e));
  if (!older.length) return;
  const fold = document.createElement("details");
  fold.className = "kept-older";
  const olderMb = older.reduce((a, e) => a + (e.bytes || 0), 0);
  fold.innerHTML = `<summary>Earlier sessions · ${older.length} ${older.length === 1 ? "result" : "results"}, ${mbText(olderMb)}</summary><div class="kept-older-list"></div>`;
  fold.addEventListener("toggle", () => {
    const into = fold.querySelector(".kept-older-list");
    if (fold.open && !into.childElementCount) for (const e of older) into.appendChild(card(e));
  });
  el.appendChild(fold);
}

// When this browser tab's session began: results made since are on show,
// earlier ones are folded away. A reload keeps the session; a new tab or
// window starts one.
function sessionStart() {
  try {
    let v = Number(sessionStorage.getItem("hfSessionStart"));
    if (!v) {
      v = Date.now();
      sessionStorage.setItem("hfSessionStart", String(v));
    }
    return v;
  } catch {
    return (sessionStart.fallback ??= Date.now());
  }
}
sessionStart();

// A picture with its tools: download, Claude's check, and Improve, which
// hands it to Claude or to an image model that paints over it. An edited
// picture appears underneath with the chain of hands that made it.
// A picture is either a file the app made (on this computer) or bytes the
// rented GPU sent to the browser, kept here and saved only when downloaded.
function showPicture(into, { file = null, data = null, prompt, negative, model, madeBy, chain, agent = null, repo = null, modelFile = null }) {
  const card = document.createElement("div");
  card.className = "image-card";
  const src = file ? `/output/${file}` : `data:image/png;base64,${data}`;
  const name = file ?? `image-${Date.now()}.png`;
  markMade();
  card.innerHTML = `<img class="result-image" src="${esc(src)}" alt="${esc(prompt)}">
    ${chain.length ? `<div class="chain">${esc(chainText(madeBy, chain))}</div>` : ""}
    <p class="muted small tools-row"><span>${file ? `Saved to ~/HuggingFound/output/${esc(file)}.` : "Made on the rented GPU; it lives in this page until you download it."}</span><a class="button" href="${esc(src)}" download="${esc(name)}">Download</a></p>`;
  into.appendChild(card);
  addImprove(card.lastElementChild, {
    kind: "image",
    check: {
      sent: "this picture and your description",
      payload: () => (file ? { kind: "image", model, file, prompt, negative } : { kind: "image", model, image: { media_type: "image/png", data }, prompt, negative }),
      // Claude ends with a better description and avoid list; one click tries them.
      after: (text, foot) => {
        const better = /^Description:\s*(.+)$/m.exec(text)?.[1]?.trim();
        const avoid = /^Avoid:\s*(.+)$/m.exec(text)?.[1]?.trim();
        if (!better) return;
        foot.prepend(useButton("Use Claude's suggestion", () => {
          $("#image-prompt").value = better;
          if (avoid) $("#image-negative").value = avoid;
          $("#image-prompt").focus();
        }));
      },
    },
    context: () => ({ file, data, prompt, negative, model, agent, repo, modelFile }),
    onImage: (edited, by, request, details) => {
      const next = [...chain, { by, request, verb: "edited" }];
      if (details.planned) next.splice(-1, 0, { by: "Claude", request, verb: "planned" });
      showPicture(into, { ...(details.data ? { data: details.data } : { file: edited }), prompt: details.prompt, negative: details.negative, model, madeBy, chain: next, agent, repo, modelFile });
    },
  });
}

// Asks the rented GPU's agent for a picture and waits for it: a job is
// submitted, then polled, so RunPod's proxy never holds a long request.
// `quality` is a preset from the plan, with the exact settings to use.
async function agentPicture(agent, args, onLine = () => {}) {
  return (await agentJob(agent, args, onLine)).image;
}

// A job on the rented GPU: a picture, or a clip from a video family. The
// browser asks the machine directly and keeps the result in the page.
async function agentJob(agent, args, onLine = () => {}) {
  const [req] = await agentBatch(agent, [{ args }], onLine);
  if (req.err) throw req.err;
  return req.job;
}

// Several jobs on the rented GPU, handed over all at once so the machine
// goes on with them even if this page is left, then followed one after
// another. While they run, the machine's status changes (a restart below,
// say) do not redraw the window and lose its log, the still-there check
// waits, and the site is told every so often that the machine is in use,
// so its idle clock never stops a machine mid-clip. A worker that lost its
// model is reset and that job asked once more.
async function agentBatch(agent, requests, onLine = () => {}, { repo = null, onDone = null, onStatus = () => {} } = {}) {
  state.agentBusy = (state.agentBusy ?? 0) + 1;
  api.post("/api/rent/touch", {}).catch(() => {});
  const keep = setInterval(() => api.post("/api/rent/touch", {}).catch(() => {}), 45e3);
  try {
    for (const req of requests) {
      if (req.id) continue;
      req.started = Date.now();
      req.id = await submitJob(agent, req.args, onLine);
      if (repo) rememberPending(repo, req.id, req.item, req.started);
    }
    let stopped = null;
    for (const [i, req] of requests.entries()) {
      if (stopped) {
        req.err = stopped;
      } else {
        if (requests.length > 1) onLine(`${i + 1} of ${requests.length}: ${req.item?.prompt ?? req.args?.prompt ?? ""}`);
        try {
          req.job = await followJob(agent, req.id, onLine, req.started ?? Date.now(), { patienceMs: patienceFor(req.item), onStatus });
        } catch (err) {
          if (/no model is loaded/i.test(err.message) && req.args) {
            try {
              await resetAgent(agent, req.id, onLine);
              if (repo) forgetPending(repo, req.id);
              req.started = Date.now();
              req.id = await submitJob(agent, req.args, onLine);
              if (repo) rememberPending(repo, req.id, req.item, req.started);
              req.job = await followJob(agent, req.id, onLine, req.started, { patienceMs: patienceFor(req.item), onStatus });
            } catch (again) {
              req.err = again;
            }
          } else req.err = err;
        }
        // The machine is gone or stopped: the rest cannot be made either.
        if (req.err && /machine (stopped|is gone)/.test(req.err.message)) stopped = req.err;
      }
      if (repo) forgetPending(repo, req.id);
      if (onDone) await onDone(req, req.job ?? null, req.err ?? null, i);
    }
    return requests;
  } finally {
    clearInterval(keep);
    state.agentBusy--;
  }
}

// How long a request may take before the log remarks on it: twice the
// guess, and twenty minutes at the least.
function patienceFor(item) {
  const guess = Number(item?.estimate?.seconds) || 0;
  return Math.max(20 * 60e3, 2 * guess * 1000);
}

// Resets the machine's agent. A newer agent drops its model on request; an
// older one is restarted in place by RunPod, which keeps its host, card and
// disk, and is back when the failed job's record is gone from it.
// The secret the machine was started with, sent with every call to it.

// The machine's own account of a failure, in the log under the page's line:
// which stage it was in and the last lines of the worker's traceback, read
// from the machine's report; nothing to fetch by hand.
async function machineSays(agent, say) {
  if (!agent) return;
  try {
    const d = await fetch(`${agent}/diagnostics`, { headers: agentHeaders(), cache: "no-store", signal: AbortSignal.timeout(15e3) }).then((r) => (r.ok ? r.json() : null));
    const f = d?.failures?.[0];
    if (!f || Date.now() - f.at > 10 * 60e3) return;
    const lines = String(f.trace || "").trim().split("\n").filter(Boolean);
    say(`The machine's account: ${f.error}${f.phase ? ` (while ${f.phase})` : ""}.${lines.length ? " The end of its traceback:" : ""}`);
    for (const l of lines.slice(-14)) say(`  │ ${l}`);
    say("The whole report is under Machine report in the GPU panel (the bar's Manage), ready to copy.");
    rememberMachineFailure(d, f);
  } catch {
    // the machine's account is a help, not a need
  }
}
// Failures remembered across machines, in this browser: a replaced
// machine takes its journal with it, this stays.
function rememberMachineFailure(d, f) {
  try {
    const list = JSON.parse(localStorage.getItem("machineFailures") || "[]");
    if (list.some((x) => x.at === f.at && x.error === f.error)) return;
    list.unshift({ at: f.at, machine: state.rental?.id ?? null, dataCenter: state.rental?.dataCenter ?? null, image: d.version ?? null, what: f.what, error: f.error, phase: f.phase ?? null, trace: String(f.trace || "").split("\n").slice(-30).join("\n") });
    localStorage.setItem("machineFailures", JSON.stringify(list.slice(0, 20)));
  } catch {
    // no storage
  }
}
// The report as text: what the machine runs, holds, has loaded, how its
// disk stands, its last failures with their tracebacks, its journal's
// tail, and failures remembered from machines before it.
async function machineReport(r) {
  const when = (t) => (t ? new Date(t).toLocaleString() : "?");
  let earlier = [];
  try {
    earlier = JSON.parse(localStorage.getItem("machineFailures") || "[]");
  } catch {
    earlier = [];
  }
  const head = [`HuggingFound machine report, ${new Date().toLocaleString()}`, `Machine ${r.id ?? "?"}: ${r.gpu ?? "?"}${r.gpuCount > 1 ? ` x${r.gpuCount}` : ""}, ${r.gb ?? "?"} GB of card memory, disk ${r.diskGb ?? "?"} GB, data centre ${r.dataCenter ?? "?"}, status ${r.status ?? "?"}${r.containerUp === false ? " (no container yet)" : ""}, image ${r.agentVersion ?? "?"} of ${r.agentCurrent ?? "?"}`, `Chat: ${state.chatServer?.url ? `Ollama's address ${state.chatServer.url} saved on the site` : "no chat address saved on the site"}${chatViaAgent() ? ", chats carried by the agent" : state.chatServer?.direct ? ", chats straight to Ollama" : ""}; Ollama ${r.ready === true ? "answering" : r.ready === false ? "not answering the site's check" : "unprobed"}, ${r.chatModels ?? "?"} chat model(s).`];
  let d = null;
  try {
    d = r.agent ? await fetch(`${r.agent}/diagnostics`, { headers: agentHeaders(), cache: "no-store", signal: AbortSignal.timeout(15e3) }).then((x) => (x.ok ? x.json() : null)) : null;
  } catch {
    d = null;
  }
  const parts = [...head];
  if (!d) parts.push("", "The machine's agent did not answer, so this is the site's view alone.");
  else {
    const p = d.python ?? {};
    parts.push("", `Agent ${d.version}, up ${Math.round((d.agentUptimeSeconds ?? 0) / 60)} min. Python ${p.python ?? "?"}, torch ${p.torch ?? "?"} (CUDA ${p.cudaVersion ?? "?"}), diffusers ${p.diffusers ?? "?"}, transformers ${p.transformers ?? "?"}, peft ${p.peft ?? "none"}, av ${p.av ?? "none"}.`);
    parts.push(`Cards: ${(p.gpus ?? []).map((g) => `${g.name} ${g.gb} GB`).join(", ") || p.gpu || "none seen"}${p.bf16 === false ? " (no bf16)" : ""}${p.problem ? `; problem: ${p.problem}` : ""}.`);
    parts.push(`Disk: ${d.disk ? `${d.disk.freeGb} GB free of ${d.disk.totalGb}${d.disk.usedGb != null ? `, ${d.disk.usedGb} GB in the machine's folders` : ""}${d.disk.quota ? " (a quota; the size as the site said it)" : ""}` : "unknown"}. Env: disk ${d.env?.HF_DISK_GB ?? "?"} GB at rent${d.env?.diskGbHint ? `, ${d.env.diskGbHint} GB since` : ""}, idle ${d.env?.HF_IDLE_MINUTES ?? "?"} min, allocator ${d.env?.PYTORCH_CUDA_ALLOC_CONF ?? "default"}.`);
    parts.push(`Models on it: ${(d.models ?? []).map((m) => `${m.repo}${m.file !== "model_index.json" ? `/${m.file}` : ""} ${m.gb} GB${m.files != null ? ` (${m.files} files)` : ""}`).join("; ") || "none"}. Add-ons: ${(d.addons ?? []).map((a) => `${a.repo}/${a.file}`).join("; ") || "none"}.`);
    parts.push(`Loaded: ${d.loaded ? `${d.loaded.dir} (${d.loaded.kind}, mode ${d.loaded.mode || "?"}${d.loaded.note ? `: ${d.loaded.note}` : ""})` : "nothing"}. Worker ${d.worker?.running ? (d.worker.busy ? "busy" : "idle") : "not running"}.`);
    if (d.downloads?.length) parts.push(`Downloads: ${d.downloads.map((t) => `${t.key} ${t.status}${t.error ? ` (${t.error})` : ""} ${when(t.startedAt)}`).join("; ")}.`);
    if (d.jobs?.length) parts.push(`Jobs: ${d.jobs.map((j) => `${j.id.slice(0, 6)} ${j.status}${j.phase ? ` (${j.phase})` : ""}${j.error ? `: ${j.error.slice(0, 120)}` : ""}`).join("; ")}.`);
    parts.push("", d.failures?.length ? "Last failures on this machine:" : "No failures on this machine.");
    for (const f of (d.failures ?? []).slice(0, 5)) {
      parts.push(`- ${when(f.at)}, ${f.kind}: ${f.what}`, `  ${f.error}${f.phase ? ` (while ${f.phase})` : ""}`);
      const lines = String(f.trace || "").trim().split("\n").filter(Boolean).slice(-20);
      for (const l of lines) parts.push(`    ${l}`);
    }
    if (d.worker?.tail) parts.push("", "Worker's last lines:", ...String(d.worker.tail).trim().split("\n").slice(-25).map((l) => `  ${l}`));
    if (d.journal) parts.push("", "Journal (tail):", ...String(d.journal).trim().split("\n").slice(-40).map((l) => `  ${l}`));
  }
  if (earlier.length) {
    parts.push("", "Failures remembered from earlier machines (this browser):");
    for (const f of earlier.slice(0, 8)) parts.push(`- ${when(f.at)}, machine ${f.machine ?? "?"} (${f.dataCenter ?? "?"}, image ${f.image ?? "?"}): ${f.what ?? ""}`, `  ${f.error}${f.phase ? ` (while ${f.phase})` : ""}`);
  }
  return parts.join("\n");
}
function agentHeaders() {
  // Only the standard header: a browser asks the machine first whether a
  // header may be sent, and a machine on an earlier image allows this one.
  const token = state.rental?.agentToken;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function resetAgent(agent, jobId, onLine) {
  const reset = await fetch(`${agent}/unload`, { method: "POST", headers: agentHeaders() }).catch(() => null);
  if (reset?.ok) {
    onLine("The machine had lost track of its model after the last failure; loading it again.");
    return;
  }
  onLine("The machine lost track of its model after the last failure. Restarting it in place, about a minute; its disk and models stay. Then asking again.");
  try {
    await api.post("/api/rent/restart", {});
  } catch (err) {
    throw new Error(`the machine could not be restarted (${err.message}); stop it from the GPU panel, run this again, and it starts afresh`);
  }
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    if (Date.now() - started > 6 * 60e3) throw new Error("the machine has not come back within six minutes of restarting; try again in a moment");
    const probe = await fetch(`${agent}/jobs/${jobId}`, { headers: agentHeaders(), signal: AbortSignal.timeout(5000) }).catch(() => null);
    // A fresh agent has no record of the failed job; the old one still does.
    if (probe?.status === 404) break;
  }
  onLine("The machine is back.");
}

// ---- LoRAs and fine-tunes for a video model -----------------------------
// Optional, per model: LoRAs found on Hugging Face and Civitai for the
// model, added to the machine one by one, then ticked (each at its own
// strength) for the clips made here; and a fine-tuned version of the
// model (DaSiWa's MiniMax-H3, say) used in its transformer's place. What
// was added and ticked is kept in this browser under the model, so the
// window shows the same when it is opened again.
function loraBook(repo) {
  try {
    const b = JSON.parse(localStorage.getItem(`loras:${repo}`) || "null");
    if (b && typeof b === "object") return { items: b.items ?? {}, on: b.on ?? {}, finetune: b.finetune ?? null, found: b.found ?? null };
  } catch {
    // no storage: nothing ticked
  }
  return { items: {}, on: {}, finetune: null, found: null };
}
function saveLoraBook(repo, book) {
  try {
    localStorage.setItem(`loras:${repo}`, JSON.stringify(book));
  } catch {
    // no storage: it lasts as long as the page
  }
}
const loraKey = (repo, file) => `${repo}/${file}`;
// Whether the finder asks Civitai for adult listings too: off unless ticked, kept in this browser.
function loraAdult() {
  try {
    return localStorage.getItem("lorasAdult") === "1";
  } catch {
    return false;
  }
}
function setLoraAdult(on) {
  try {
    if (on) localStorage.setItem("lorasAdult", "1");
    else localStorage.removeItem("lorasAdult");
  } catch {
    // no storage: it lasts as long as the page
  }
}
// LoRAs and fine-tunes on the machine came with image 25; an older
// machine would make the clip without them, so it is said instead.
const LORA_AGENT = 25;
function loraMachineTooOld() {
  const v = state.rental?.agentVersion;
  return v != null && v < LORA_AGENT ? `This machine runs an older HuggingFound image (version ${v}) that does not take LoRAs or fine-tunes; replace the machine for one on the current image (its models download again).` : "";
}
// What is on the machine of what was added: an add-on's key is "repo/file".
function loraHere(t, key) {
  return (t.addonsHere ?? []).includes(key);
}
function loraSummary(t) {
  const book = loraBook(t.repo);
  const on = Object.keys(book.on).filter((k) => loraHere(t, k) && book.items[k]);
  const ft = book.finetune && loraHere(t, book.finetune) ? book.items[book.finetune] : null;
  const parts = [ft ? `${ft.name}` : "", on.length ? `${on.length} LoRA${on.length === 1 ? "" : "s"} on` : ""].filter(Boolean);
  return { on: parts.length > 0, text: parts.length ? parts.join(", ") : "optional" };
}
// The part of a job the LoRAs and the fine-tune make, and their trigger words.
// `own` is a shot's own choice ({key: strength}) in place of the model's ticks.
function loraJobPart(t, own = null) {
  const book = loraBook(t.repo);
  const loras = [];
  const trigger = [];
  for (const [key, scale] of Object.entries(own ?? book.on)) {
    const item = book.items[key];
    if (!item) continue;
    if (!loraHere(t, key)) throw new Error(`the LoRA ${item.name} is not on the machine any more (a new machine, or removed); add it again under LoRAs, or untick it`);
    loras.push({ repo: item.repo, file: item.file, scale: Number(scale) });
    trigger.push(...(item.trigger ?? []));
  }
  if (loras.length > 4) throw new Error("four LoRAs at most at once; untick some");
  let finetune = null;
  if (book.finetune) {
    const item = book.items[book.finetune];
    if (item && !loraHere(t, book.finetune)) throw new Error(`the fine-tune ${item.name} is not on the machine any more; add it again under LoRAs, or choose the model as published`);
    if (item) finetune = { repo: item.repo, file: item.file };
  }
  if ((loras.length || finetune) && loraMachineTooOld()) throw new Error(loraMachineTooOld());
  return { job: { ...(loras.length ? { loras } : {}), ...(finetune ? { finetune } : {}) }, trigger: [...new Set(trigger)].slice(0, 8) };
}
// Skipping the passes that would barely change anything (TeaCache's
// idea, through diffusers' first-block cache on the machine): a switch
// per model, kept in this browser, which image 26 brought.
const CACHE_AGENT = 26;
const CACHE_THRESHOLD = 0.1;
const CACHE_TIME = 0.65;
function fastPasses(repo) {
  try {
    return localStorage.getItem(`fastPasses:${repo}`) === "1";
  } catch {
    return false;
  }
}
function setFastPasses(repo, on) {
  try {
    if (on) localStorage.setItem(`fastPasses:${repo}`, "1");
    else localStorage.removeItem(`fastPasses:${repo}`);
  } catch {
    // no storage: it lasts as long as the page
  }
}
function cacheMachineTooOld() {
  const v = state.rental?.agentVersion;
  return v != null && v < CACHE_AGENT;
}
// Two more speed switches per model, kept in this browser, which image 27
// brought: fp8 weights (torchao's, on a card with fp8 units) and the
// transformer's blocks compiled. Each scales the time guess until the
// clips made here teach it better.
const SPEED_AGENT = 27;
const FP8_TIME = 0.75;
const COMPILE_TIME = 0.85;
function speedChoice(name, repo) {
  try {
    return localStorage.getItem(`${name}:${repo}`) === "1";
  } catch {
    return false;
  }
}
function setSpeedChoice(name, repo, on) {
  try {
    if (on) localStorage.setItem(`${name}:${repo}`, "1");
    else localStorage.removeItem(`${name}:${repo}`);
  } catch {
    // no storage: it lasts as long as the page
  }
}
const fp8Weights = (repo) => speedChoice("fp8Weights", repo);
const compiledBlocks = (repo) => speedChoice("compiledBlocks", repo);
function speedMachineTooOld() {
  const v = state.rental?.agentVersion;
  return v != null && v < SPEED_AGENT;
}
// What the suggest button offers: with LoRAs ticked, a description in their creators' shape.
function suggestLabel(t) {
  const book = loraBook(t.repo);
  const names = Object.keys(book.on).filter((k) => loraHere(t, k) && book.items[k] && book.items[k].kind !== "finetune").map((k) => book.items[k].name);
  return names.length ? `Ask Claude to fit it to ${names.join(" and ")}` : "Suggest a better description";
}
// The steps and guidance a ticked LoRA's creator used, when the person
// chose to follow them under LoRAs: the last ticked one with any.
function loraSettings(t) {
  const book = loraBook(t.repo);
  let out = null;
  for (const key of Object.keys(book.on)) {
    const item = book.items[key];
    if (item?.settings && (item.settings.steps || item.settings.cfg != null) && loraHere(t, key)) out = { ...item.settings, name: item.name };
  }
  return out;
}
const settingsLabel = (settings) => [settings.steps ? `${settings.steps} steps` : "", settings.cfg != null ? `guidance ${settings.cfg}` : ""].filter(Boolean).join(", ");
// What a showcase clip was made with, in words.
function sampleSettingsParts(s) {
  return [s.steps != null ? `${s.steps} steps` : "", s.cfg != null ? `guidance ${s.cfg}` : "", s.sampler ? String(s.sampler) : "", s.width && s.height ? `${s.width} by ${s.height}` : "", s.frames ? `${s.frames} frames` : "", s.fps ? `${s.fps} fps` : "", s.shift != null ? `shift ${s.shift}` : "", s.strength != null ? `this one at ${s.strength}` : "", s.with?.length ? `with ${s.with.map((w) => `${w.name}${w.strength != null ? ` at ${w.strength}` : ""}`).join(", ")}` : "", s.checkpoint ? `on ${s.checkpoint}` : ""].filter(Boolean);
}
// The recipes read this visit, by model, version and adult setting.
const loraRecipes = new Map();
async function loadLoraRecipe(t, item) {
  const id = item.repo ?? item.id;
  // The version on the machine, from the file's name; a card's newest file otherwise.
  const version = /^v(\d+)_f\d+\.safetensors$/.exec(item.file ?? item.files?.[0]?.file ?? "")?.[1] ?? null;
  const adult = Boolean(item.adult) || loraAdult();
  const key = `${id}|${version ?? ""}|${adult ? 1 : 0}`;
  if (!loraRecipes.has(key)) loraRecipes.set(key, await api.get(`/api/loras/recipe?base=${encodeURIComponent(t.repo)}&id=${encodeURIComponent(id)}${version ? `&version=${version}` : ""}${adult ? "&adult=1" : ""}`));
  return loraRecipes.get(key);
}
// The LoRAs ticked for a model's clips, each with how its creator prompts
// for it, for Claude to write the description in that shape and name the
// strength and settings; nothing when none is on.
async function loraContext(t) {
  if (t.engine !== "diffusers" || !t.agent) return [];
  const book = loraBook(t.repo);
  const out = [];
  for (const [key, scale] of Object.entries(book.on)) {
    const item = book.items[key];
    if (!item || item.kind === "finetune" || !loraHere(t, key)) continue;
    let r = null;
    try {
      r = await loadLoraRecipe(t, item);
    } catch {
      r = null;
    }
    const rec = r?.strength ? `${r.strength.low === r.strength.high ? r.strength.low : `${r.strength.low} to ${r.strength.high}`}${r.strength.from === "notes" ? ` (their words: ${r.strength.text || "on the page"})` : " (what the showcase clips used)"}` : "";
    out.push({ key, name: item.name, creator: r?.creator ?? item.creator ?? "", strength: Number(scale), recommended: rec, trigger: r?.trigger?.length ? r.trigger : item.trigger ?? [], tips: r?.tips ?? [], settings: r?.settings && (r.settings.steps || r.settings.cfg != null) ? settingsLabel(r.settings) : "", samples: (r?.samples ?? []).slice(0, 3).map((x) => ({ prompt: x.prompt, settings: sampleSettingsParts(x).join(", ") })) });
  }
  return out;
}
// The strengths and settings Claude's suggestion names for the ticked LoRAs.
function suggestedLoraChanges(text, loras) {
  const strengths = [];
  for (const m of String(text).matchAll(/^Strength:\s*(.+?)\s*=\s*(\d+(?:\.\d+)?)\s*$/gm)) {
    const name = m[1].trim().toLowerCase();
    const l = loras.find((x) => x.name.toLowerCase() === name) ?? loras.find((x) => x.name.toLowerCase().includes(name) || name.includes(x.name.toLowerCase()));
    const to = Math.min(1.5, Math.max(0, Math.round(Number(m[2]) * 20) / 20));
    if (l && to !== l.strength && !strengths.some((x) => x.key === l.key)) strengths.push({ key: l.key, name: l.name, from: l.strength, to });
  }
  const line = /^Settings:\s*(.+)$/m.exec(String(text))?.[1] ?? "";
  const steps = Number.parseInt(/(\d{1,3})\s*steps/i.exec(line)?.[1] ?? "", 10);
  const cfg = Number.parseFloat(/guidance\s*(?:of\s*)?(\d+(?:\.\d+)?)/i.exec(line)?.[1] ?? "");
  const settings = /as they are/i.test(line) || (!(steps > 0) && !Number.isFinite(cfg)) ? null : { ...(steps > 0 ? { steps } : {}), ...(Number.isFinite(cfg) ? { cfg } : {}) };
  return { strengths, settings };
}
function wireLoras(box, t, onChange = () => {}) {
  const body = box.querySelector("#loras-body");
  const count = box.querySelector("#loras-count");
  const book = () => loraBook(t.repo);
  const save = (b) => {
    saveLoraBook(t.repo, b);
    count.textContent = loraSummary(t).text;
    onChange();
  };
  // Which added item has its creator's settings open, kept across redraws.
  let openRecipe = null;
  const fmtGb = (gb) => (gb ? (gb < 1 ? `${Math.round(gb * 1024)} MB` : `${gb.toFixed(1)} GB`) : "");
  const sourceName = (s) => (s === "civitai" ? "Civitai" : "Hugging Face");
  const draw = () => {
    const b = book();
    const mine = Object.entries(b.items);
    const fts = mine.filter(([, i]) => i.kind === "finetune");
    const los = mine.filter(([, i]) => i.kind !== "finetune");
    const row = ([key, i]) => {
      const here = loraHere(t, key);
      const on = key in b.on;
      return `<div class="lora-row ${here ? "" : "gone"}" data-key="${esc(key)}">
        <label class="check"><input type="checkbox" class="lora-on" ${on && here ? "checked" : ""} ${here ? "" : "disabled"}> <b>${esc(i.name)}</b>${i.adult ? ' <span class="pill adult">18+</span>' : ""} <span class="muted small">${sourceName(i.source)}${i.gb ? ` · ${fmtGb(i.gb)}` : ""}${i.trigger?.length ? ` · trigger: ${esc(i.trigger.join(", "))}` : ""}</span></label>
        ${here ? `<label class="lora-scale small">strength <input type="range" class="lora-strength" min="0" max="1.5" step="0.05" value="${Number(b.on[key] ?? i.scale ?? 1)}"> <output>${Number(b.on[key] ?? i.scale ?? 1).toFixed(2)}</output></label>` : `<span class="muted small">not on this machine</span> <button class="ghost lora-readd">Add again</button>`}
        ${i.settings && (i.settings.steps || i.settings.cfg != null) ? `<span class="pill lora-settings-pill" title="Clips with it ticked are made at these, as its creator's showcase was">${esc(settingsLabel(i.settings))} <button class="lora-drop-settings" title="Back to the quality setting's own steps and guidance" aria-label="Drop these settings">×</button></span>` : ""}
        <button class="ghost lora-recipe" title="How its creator made the clips that show it off: strength, prompts, settings">Creator's settings</button>
        <button class="ghost lora-forget" title="Take it off the list${here ? " and off the machine" : ""}">Remove</button>
      </div>`;
    };
    body.innerHTML = `
      ${fts.length ? `<div class="lora-group"><p class="small"><b>Model version</b> <span class="muted">a fine-tune runs in place of the model's own transformer</span></p>
        <label class="check"><input type="radio" name="lora-ft" value="" ${b.finetune ? "" : "checked"}> ${esc(t.repo.split("/").pop())} as published</label>
        ${fts.map(([key, i]) => `<div class="lora-row ft ${loraHere(t, key) ? "" : "gone"}" data-key="${esc(key)}"><label class="check"><input type="radio" name="lora-ft" value="${esc(key)}" ${b.finetune === key ? "checked" : ""} ${loraHere(t, key) ? "" : "disabled"}> <b>${esc(i.name)}</b>${i.adult ? ' <span class="pill adult">18+</span>' : ""} <span class="muted small">${sourceName(i.source)}${i.gb ? ` · ${fmtGb(i.gb)}` : ""}${i.fp ? ` · ${esc(i.fp)}` : ""}${loraHere(t, key) ? "" : " · not on this machine"}</span></label> ${loraHere(t, key) ? "" : `<button class="ghost lora-readd" data-key="${esc(key)}">Add again</button>`} <button class="ghost lora-recipe" title="How its creator made the clips that show it off">Creator's settings</button> <button class="ghost lora-forget" data-key="${esc(key)}">Remove</button></div>`).join("")}</div>` : ""}
      ${los.length ? `<div class="lora-group"><p class="small"><b>LoRAs</b> <span class="muted">tick to use; up to four at once</span></p>${los.map(row).join("")}</div>` : ""}
      <p class="tools-row"><button class="ghost" id="lora-look">${b.found ? "Look again" : "Look for LoRAs"}</button><span class="muted small">on Hugging Face and Civitai, made for ${esc(t.repo.split("/").pop())}. Nothing is used unless you tick it.</span></p>
      <label class="check small"><input type="checkbox" id="lora-adult" ${loraAdult() ? "checked" : ""}> Include 18+ results <span class="muted">adult LoRAs from Civitai, marked 18+; for adults only</span></label>
      <div class="tools-row lora-link"><input type="url" id="lora-url" placeholder="Or paste a link: a PromptHero model page, a Civitai model page or a Hugging Face repository"><button class="ghost" id="lora-url-go">Read the link</button></div>
      <div id="lora-linked"></div>
      <div id="lora-found"></div>`;
    if (b.found) drawFound(b.found);
    body.querySelectorAll(".lora-on").forEach((c) => c.addEventListener("change", () => {
      const key = c.closest(".lora-row").dataset.key;
      const nb = book();
      if (c.checked) {
        if (Object.keys(nb.on).length >= 4) {
          c.checked = false;
          notice("Four LoRAs at most at once; untick one first.", "info");
          return;
        }
        nb.on[key] = Number(nb.items[key]?.scale ?? 1);
      } else delete nb.on[key];
      save(nb);
    }));
    body.querySelectorAll(".lora-strength").forEach((r) => r.addEventListener("input", () => {
      const key = r.closest(".lora-row").dataset.key;
      r.nextElementSibling.textContent = Number(r.value).toFixed(2);
      const nb = book();
      nb.items[key].scale = Number(r.value);
      if (key in nb.on) nb.on[key] = Number(r.value);
      save(nb);
    }));
    body.querySelectorAll('input[name="lora-ft"]').forEach((r) => r.addEventListener("change", () => {
      const nb = book();
      nb.finetune = r.value || null;
      save(nb);
    }));
    body.querySelectorAll(".lora-forget").forEach((btn) => btn.addEventListener("click", async () => {
      const key = btn.dataset.key || btn.closest(".lora-row")?.dataset.key;
      const nb = book();
      const item = nb.items[key];
      if (!item) return;
      if (loraHere(t, key)) {
        if (!confirm(`Remove ${item.name} from the machine and from this list?`)) return;
        try {
          await api.post("/api/remove", { kind: "gpu-addon", repo: item.repo, file: item.file });
          t.addonsHere = (t.addonsHere ?? []).filter((k) => k !== key);
        } catch (err) {
          notice(`Could not remove it from the machine: ${err.message}`, "bad");
          return;
        }
      }
      delete nb.items[key];
      delete nb.on[key];
      if (nb.finetune === key) nb.finetune = null;
      save(nb);
      draw();
    }));
    body.querySelectorAll(".lora-readd").forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.dataset.key || btn.closest(".lora-row")?.dataset.key;
      const item = book().items[key];
      if (item) addToMachine(item, btn);
    }));
    body.querySelectorAll(".lora-row .lora-recipe").forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.closest(".lora-row").dataset.key;
      const item = book().items[key];
      if (item) showRecipe(item, btn);
    }));
    body.querySelectorAll(".lora-drop-settings").forEach((btn) => btn.addEventListener("click", () => {
      const key = btn.closest(".lora-row").dataset.key;
      const nb = book();
      if (nb.items[key]) delete nb.items[key].settings;
      save(nb);
      draw();
    }));
    if (openRecipe) {
      const btn = body.querySelector(`.lora-row[data-key="${CSS.escape(openRecipe)}"] .lora-recipe`);
      const item = book().items[openRecipe];
      if (btn && item) showRecipe(item, btn);
      else openRecipe = null;
    }
    body.querySelector("#lora-look").addEventListener("click", look);
    body.querySelector("#lora-adult").addEventListener("change", (e) => {
      setLoraAdult(e.target.checked);
      look();
    });
    const go = body.querySelector("#lora-url-go");
    const field = body.querySelector("#lora-url");
    go.addEventListener("click", () => readLink(field.value));
    field.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        readLink(field.value);
      }
    });
  };
  // A pasted link, read as one item, with its files to pick from.
  async function readLink(link) {
    const out = body.querySelector("#lora-linked");
    if (!String(link).trim()) return;
    out.innerHTML = `<p class="muted small">Reading the link</p>`;
    let item;
    try {
      ({ item } = await api.get(`/api/loras/link?base=${encodeURIComponent(t.repo)}&url=${encodeURIComponent(String(link).trim())}`));
    } catch (err) {
      out.innerHTML = `<p class="notice bad small">${esc(err.message)}</p>`;
      return;
    }
    out.innerHTML = `${hitCard(item, item.via === "prompthero" ? "From PromptHero, a copy of this Civitai model." : "")}${item.source === "civitai" ? civitaiNote() : ""}`;
    out.querySelector(".lora-pick").addEventListener("click", (e) => pickFile(item, e.currentTarget));
    out.querySelector(".lora-recipe").addEventListener("click", (e) => showRecipe(item, e.currentTarget));
  }
  async function look() {
    const out = body.querySelector("#lora-found");
    const btn = body.querySelector("#lora-look");
    btn.disabled = true;
    btn.textContent = "Looking";
    out.innerHTML = `<p class="muted small">Asking Hugging Face and Civitai</p>`;
    let found;
    try {
      found = await api.get(`/api/loras?id=${encodeURIComponent(t.repo)}${loraAdult() ? "&adult=1" : ""}`);
    } catch (err) {
      out.innerHTML = `<p class="notice bad small">Could not look: ${esc(err.message)}</p>`;
      btn.disabled = false;
      btn.textContent = "Look again";
      return;
    }
    const nb = book();
    nb.found = { at: Date.now(), adult: Boolean(found.adult), civitaiKnown: found.civitaiKnown, hfError: found.hfError, civitaiError: found.civitaiError, items: found.items.slice(0, 100) };
    save(nb);
    draw();
  }
  function drawFound(found) {
    const out = body.querySelector("#lora-found");
    // Fine-tunes take a MiniMax-H3 transformer's place only; elsewhere they are left out.
    const items = found.items.filter((i) => i.kind !== "finetune" || found.civitaiKnown);
    const card = (i) => hitCard(i);
    const fts = items.filter((i) => i.kind === "finetune");
    const los = items.filter((i) => i.kind !== "finetune");
    const notes = [found.hfError ? `Hugging Face did not answer (${found.hfError}).` : "", found.civitaiError ? `Civitai did not answer (${found.civitaiError}).` : "", found.civitaiKnown ? "" : "Civitai has no listing for this model, so only Hugging Face was searched."].filter(Boolean).join(" ");
    out.innerHTML = `${notes ? `<p class="muted small">${esc(notes)}</p>` : ""}
      ${!items.length ? `<p class="muted small">Nothing found for this model.</p>` : ""}
      ${fts.length ? `<details class="lora-list"><summary class="small"><b>${fts.length} fine-tuned version${fts.length === 1 ? "" : "s"}</b> <span class="muted">used instead of the model's own transformer; one file of 10 to 60 GB on the machine's disk</span></summary>${fts.map(card).join("")}</details>` : ""}
      ${los.length ? `<details class="lora-list" open><summary class="small"><b>${los.length} LoRA${los.length === 1 ? "" : "s"}</b> <span class="muted">small add-ons for style, motion or speed, most downloaded first</span></summary>${los.map(card).join("")}</details>` : ""}
      ${civitaiNote()}`;
    out.querySelectorAll(".lora-pick").forEach((btn) => btn.addEventListener("click", () => pickFile(items.find((i) => i.id === btn.closest(".lora-hit").dataset.id), btn)));
    out.querySelectorAll(".lora-recipe").forEach((btn) => btn.addEventListener("click", () => showRecipe(items.find((i) => i.id === btn.closest(".lora-hit").dataset.id), btn)));
  }
  function hitCard(i, note = "") {
    const have = new Set(Object.values(book().items).map((x) => x.repo));
    return `<div class="lora-hit" data-id="${esc(i.id)}"><div><b>${esc(i.name)}</b> <span class="pill">${sourceName(i.source)}</span> <span class="pill">${i.kind === "finetune" ? "Fine-tune" : "LoRA"}</span>${i.adult ? ' <span class="pill adult">18+</span>' : ""}${have.has(i.id) ? ` <span class="pill ok">added</span>` : ""}<br><span class="muted small">${note ? `${esc(note)} ` : ""}${i.creator ? `by ${esc(i.creator)} · ` : ""}${Number(i.downloads || 0).toLocaleString()} downloads · <a href="${esc(i.url)}" target="_blank" rel="noopener">page</a></span></div><span class="tools-row"><button class="ghost lora-recipe" title="How its creator made the clips that show it off">Creator's settings</button><button class="ghost lora-pick">Add to the machine</button></span><div class="lora-files"></div></div>`;
  }
  // How the creator made the clips that show it off, under the row or the
  // card: read once a visit, then shown and hidden on the button.
  async function showRecipe(item, btn) {
    const holder = btn.closest(".lora-row, .lora-hit");
    let out = holder.querySelector(":scope > .lora-recipe-box");
    if (out && !out.hidden) {
      out.hidden = true;
      btn.textContent = "Creator's settings";
      if (openRecipe === holder.dataset.key) openRecipe = null;
      return;
    }
    if (!out) {
      out = document.createElement("div");
      out.className = "lora-recipe-box";
      holder.appendChild(out);
    }
    out.hidden = false;
    btn.textContent = "Hide the creator's settings";
    if (holder.dataset.key) openRecipe = holder.dataset.key;
    out.innerHTML = `<p class="muted small">Reading the creator's page</p>`;
    let recipe;
    try {
      recipe = await loadLoraRecipe(t, item);
    } catch (err) {
      out.innerHTML = `<p class="notice bad small">Could not read the creator's page: ${esc(err.message)}</p>`;
      return;
    }
    drawRecipe(out, recipe, item, holder.dataset.key ?? null);
  }
  function drawRecipe(out, r, item, key) {
    const here = key ? loraHere(t, key) : false;
    const isLora = (item.kind ?? "lora") !== "finetune";
    const fmt = (x) => String(Math.round(Number(x) * 100) / 100);
    const pick = r.strength ? Math.round(((r.strength.low + r.strength.high) / 2) * 20) / 20 : null;
    const strengthLine = r.strength
      ? `<b>${r.strength.low === r.strength.high ? fmt(r.strength.low) : `${fmt(r.strength.low)} to ${fmt(r.strength.high)}`}</b> <span class="muted">${r.strength.from === "notes" ? `the creator's own word${r.strength.text ? ` ("${esc(r.strength.text)}")` : ""}` : "what the showcase clips used"}</span>${key && here && isLora ? ` <button class="ghost lora-use-strength" data-value="${pick}">Set ${fmt(pick)}</button>` : ""}`
      : `<span class="muted">nothing said on the page; 1 is as trained</span>`;
    const sample = (s, n) => `<div class="lora-sample" data-n="${n}">
        ${s.url && s.type === "video" ? `<video controls muted playsinline preload="metadata" src="${esc(s.url)}"></video>` : s.url ? `<img src="${esc(s.url)}" alt="" loading="lazy">` : ""}
        <div class="lora-sample-body">
          <p class="muted small">${esc([s.reactions != null ? `${s.reactions} reaction${s.reactions === 1 ? "" : "s"}` : "", s.seconds ? `${Math.round(s.seconds)} s` : "", ...sampleSettingsParts(s)].filter(Boolean).join(" · ") || "the prompt it was made from")}</p>
          <textarea class="lora-sample-prompt" rows="4" readonly>${esc(s.prompt)}</textarea>
          <p class="tools-row"><button class="ghost lora-use-prompt">Use this prompt</button><button class="ghost lora-copy-prompt">Copy</button>${key && here && isLora && (s.steps != null || s.cfg != null) ? `<button class="ghost lora-use-settings" data-steps="${s.steps ?? ""}" data-cfg="${s.cfg ?? ""}">Make clips with it at ${esc(settingsLabel({ steps: s.steps, cfg: s.cfg }))}</button>` : ""}</p>
        </div>
      </div>`;
    const shown = r.samples ?? [];
    out.innerHTML = `
      <p class="small"><b>How ${r.creator ? esc(r.creator) : "the creator"} made the clips that show it off</b> <span class="muted">· <a href="${esc(r.url)}" target="_blank" rel="noopener">the page</a>${r.version?.name ? ` · ${esc(r.version.name)}` : ""}</span></p>
      <p class="small">Strength: ${strengthLine}</p>
      ${r.settings && (r.settings.steps || r.settings.cfg != null) ? `<p class="small">Settings: <b>${esc(settingsLabel(r.settings))}</b> <span class="muted">${r.source === "civitai" ? "what most of the showcase clips used" : "from the page"}</span>${key && here && isLora ? ` <button class="ghost lora-use-settings" data-steps="${r.settings.steps ?? ""}" data-cfg="${r.settings.cfg ?? ""}">Make clips with it at these</button>` : ""}</p>` : ""}
      ${r.trigger?.length ? `<p class="small">Trigger words: ${r.trigger.map((w) => `<code>${esc(w)}</code>`).join(" ")}${isLora ? ` <span class="muted">put at the start of your description for you while it is ticked</span>` : ""}</p>` : ""}
      ${r.tips?.length ? `<p class="small"><b>The creator's notes</b></p><ul class="lora-tips small">${r.tips.map((tip) => `<li>${esc(tip)}</li>`).join("")}</ul>` : `<p class="muted small">The page says nothing about how to use it.</p>`}
      ${r.notesText ? `<details class="small"><summary class="muted">Everything written on the page</summary><pre class="lora-notes">${esc(r.notesText)}</pre></details>` : ""}
      ${shown.length ? `<p class="small"><b>Showcase clips</b> <span class="muted">${shown.some((s) => s.reactions != null) ? "the most liked first" : "in the creator's order"}, each with the prompt it was made from${r.hidden ? `; ${r.hidden} adult one${r.hidden === 1 ? "" : "s"} not shown (tick Include 18+ results)` : ""}</span></p>${shown.slice(0, 3).map(sample).join("")}${shown.length > 3 ? `<details class="small"><summary class="muted">${shown.length - 3} more</summary>${shown.slice(3).map((s, n) => sample(s, n + 3)).join("")}</details>` : ""}` : `<p class="muted small">No showcase clip with its prompt on the page${r.hidden ? ` (${r.hidden} adult one${r.hidden === 1 ? "" : "s"} not shown; tick Include 18+ results)` : ""}.</p>`}
      <p class="tools-row"><button class="ghost lora-ask-claude">Ask Claude how to prompt with it</button><span class="muted small">Claude reads the notes and the showcase prompts and says what to set and how to shape your description.</span></p>
      <div class="lora-claude" hidden></div>`;
    out.querySelector(".lora-use-strength")?.addEventListener("click", (e) => {
      const v = Number(e.currentTarget.dataset.value);
      const nb = book();
      if (!nb.items[key]) return;
      nb.items[key].scale = v;
      if (key in nb.on) nb.on[key] = v;
      save(nb);
      const slider = out.closest(".lora-row")?.querySelector(".lora-strength");
      if (slider) {
        slider.value = String(v);
        slider.nextElementSibling.textContent = v.toFixed(2);
      }
      notice(`${item.name} is set to strength ${v.toFixed(2)}.`, "ok");
    });
    out.querySelectorAll(".lora-sample").forEach((el) => {
      const s = shown[Number(el.dataset.n)];
      el.querySelector(".lora-use-prompt").addEventListener("click", () => {
        const field = $("#image-prompt");
        if (!field) return;
        field.value = s.prompt;
        field.dispatchEvent(new Event("input"));
        if (s.negative && $("#image-negative")) $("#image-negative").value = s.negative;
        notice("The showcase prompt is in the description box: change the subject and the scene to yours and keep its shape.", "info");
        field.focus();
      });
      el.querySelector(".lora-copy-prompt").addEventListener("click", async (e) => {
        const b = e.currentTarget;
        try {
          await navigator.clipboard.writeText(s.prompt);
          b.textContent = "Copied";
        } catch {
          b.textContent = "Select it and copy";
        }
      });
    });
    out.querySelectorAll(".lora-use-settings").forEach((b) => b.addEventListener("click", () => {
      const nb = book();
      if (!nb.items[key]) return;
      const steps = Number.parseInt(b.dataset.steps, 10);
      const cfg = Number.parseFloat(b.dataset.cfg);
      nb.items[key].settings = { ...(steps > 0 ? { steps } : {}), ...(Number.isFinite(cfg) ? { cfg } : {}), from: r.name };
      save(nb);
      notice(`Clips with ${item.name} ticked are made at ${settingsLabel(nb.items[key].settings)}, as its creator's were.`, "ok");
      draw();
    }));
    out.querySelector(".lora-ask-claude").addEventListener("click", async (e) => {
      const b = e.currentTarget;
      const slot = out.querySelector(".lora-claude");
      b.disabled = true;
      slot.hidden = false;
      slot.innerHTML = `<p class="muted small">Claude is reading the creator's page</p>`;
      const got = await claudeText({ kind: "prompt", mode: "lora", model: t.repo, lora: { name: r.name, creator: r.creator, trigger: r.trigger, strength: r.strength ? `${r.strength.low === r.strength.high ? r.strength.low : `${r.strength.low} to ${r.strength.high}`}${r.strength.from === "notes" ? ` (the creator's words: ${r.strength.text || "on the page"})` : " (what the showcase clips used)"}` : "", tips: r.tips, samples: shown.slice(0, 4).map((s) => ({ prompt: s.prompt, settings: sampleSettingsParts(s).join(", ") })) } }, (text) => {
        slot.innerHTML = `<pre class="lora-claude-text">${esc(text)}</pre>`;
      });
      b.disabled = false;
      if (!got.text) {
        slot.innerHTML = `<p class="muted small">No answer: ${esc(got.why)}.</p>`;
        return;
      }
      slot.innerHTML = `<p class="muted small"><b>Claude on using ${esc(r.name)}</b></p><pre class="lora-claude-text">${esc(got.text)}</pre>`;
    });
  }
  const civitaiNote = () => (state.civitaiToken ? "" : `<p class="muted small">Civitai lets only signed-in accounts download: add your Civitai API key in Settings (Hugging Face and Civitai) to add one from there.</p>`);
  // A repository's or Civitai model's files, one to pick when there are several.
  async function pickFile(item, btn) {
    const slot = btn.closest(".lora-hit").querySelector(".lora-files");
    let files = item.files;
    if (!files) {
      btn.disabled = true;
      btn.textContent = "Reading its files";
      try {
        ({ files } = await api.get(`/api/loras/files?id=${encodeURIComponent(item.id)}`));
      } catch (err) {
        slot.innerHTML = `<p class="notice bad small">${esc(err.message)}</p>`;
        btn.disabled = false;
        btn.textContent = "Add to the machine";
        return;
      }
      btn.disabled = false;
      btn.textContent = "Add to the machine";
    }
    if (!files?.length) {
      slot.innerHTML = `<p class="muted small">No weights file the machine can use.</p>`;
      return;
    }
    const usable = files.filter((f) => !f.unreadable);
    slot.innerHTML = `<div class="tools-row"><select class="lora-file">${files.map((f, n) => `<option value="${n}" ${f.unreadable ? "disabled" : ""}>${esc(f.label)}${f.gb ? `, ${fmtGb(f.gb)}` : ""}${f.fp ? `, ${esc(f.fp)}` : ""}${f.unreadable ? ` (${esc(f.unreadable)})` : ""}</option>`).join("")}</select><button class="primary lora-get" ${usable.length ? "" : "disabled"}>Download it onto the machine</button></div><p class="muted small lora-progress"></p>`;
    const select = slot.querySelector(".lora-file");
    const first = files.findIndex((f) => !f.unreadable);
    if (first >= 0) select.value = String(first);
    slot.querySelector(".lora-get").addEventListener("click", (e) => {
      const f = files[Number(select.value)];
      addToMachine({ repo: item.id, file: f.file, name: files.length > 1 && item.kind !== "finetune" ? `${item.name} (${f.label.replace(/\.safetensors$/i, "")})` : item.name, kind: f.kind ?? item.kind, source: item.source, url: item.url, gb: f.gb ?? null, fp: f.fp ?? null, trigger: f.trigger ?? [], download: item.source === "civitai" ? f.url : null, scale: 1, ...(item.adult ? { adult: true } : {}) }, e.currentTarget, slot.querySelector(".lora-progress"));
    });
  }
  // The machine fetches the file; the list follows its progress, then keeps it.
  async function addToMachine(item, btn, line = null) {
    const say = (text) => {
      if (line) line.textContent = text;
      else notice(text, "info");
    };
    if (loraMachineTooOld()) {
      say(loraMachineTooOld());
      return;
    }
    if (item.adult && !confirm(`${item.name} is marked for adults (18+) where it is published: it is made for explicit content. Add it to the machine?`)) return;
    btn.disabled = true;
    let id;
    try {
      ({ id } = await api.post("/api/run", { kind: "pull-addon", args: { repo: item.repo, files: [item.file], ...(item.download ? { sources: { [item.file]: item.download } } : {}) }, where: "rented", model: t.repo, title: `Add ${item.name} to the machine` }));
    } catch (err) {
      btn.disabled = false;
      say(`Could not start: ${err.message}`);
      return;
    }
    say("Downloading onto the machine");
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const run = (await api.get("/api/runs").catch(() => ({ runs: [] }))).runs.find((r) => r.id === id);
      if (!run) continue;
      if (run.status === "running") {
        say(run.last || "Downloading onto the machine");
        continue;
      }
      if (run.status !== "done") {
        btn.disabled = false;
        say(`It did not finish: ${run.last || run.status}`);
        return;
      }
      break;
    }
    const key = loraKey(item.repo, item.file);
    t.addonsHere = [...new Set([...(t.addonsHere ?? []), key])];
    const nb = book();
    const { download, ...kept } = item;
    nb.items[key] = { ...kept, ...(download ? { download } : {}) };
    // A LoRA is ticked as it arrives; a fine-tune is chosen.
    if (item.kind === "finetune") nb.finetune = key;
    else if (Object.keys(nb.on).length < 4) nb.on[key] = item.scale ?? 1;
    save(nb);
    notice(`${item.name} is on the machine${item.kind === "finetune" ? " and chosen as the model version" : " and ticked"}; the next clip uses it.`, "ok");
    draw();
  }
  draw();
}

// Hands one job to the machine and returns its id.
async function submitJob(agent, { repo, file, prompt, negative, quality, init = null, strength = null, video = false, addon = null, ipImage = null, xl = false, seed = null, lastInit = null, references = null, loras = null, finetune = null }, onLine = () => {}) {
  const q = quality ?? { steps: 20, size: 512, cfg: 7, sampler: "euler_a", scheduler: "discrete" };
  // An add-on on an SDXL base draws at SDXL's size.
  const width = addon && xl ? 1024 : (q.width ?? q.size);
  const height = addon && xl ? 1024 : (q.height ?? q.size);
  const body = { repo, file, prompt, negative, steps: q.steps, width, height, cfg: q.cfg, sampler: q.sampler, scheduler: q.scheduler, ...(q.cache ? { cache: q.cache } : {}), ...(q.fp8 ? { fp8: true } : {}), ...(q.compile ? { compile: true } : {}) };
  if (Number.isInteger(seed)) body.seed = seed;
  if (addon) {
    body.addon = addon;
    if (ipImage) body.ipImage = ipImage;
  }
  if (video) {
    body.frames = q.frames;
    body.fps = q.fps;
    if (lastInit) body.lastInit = lastInit;
    if (references?.length) body.references = references;
    // The LoRAs ticked for this model, and a fine-tune in its transformer's place.
    if (loras?.length) body.loras = loras;
    if (finetune) body.finetune = finetune;
  }
  if (init) {
    body.init = init;
    body.strength = strength ?? 0.55;
  }
  onLine(video ? `Asking the rented GPU for a ${q.frames}-frame clip at ${width} by ${height}, ${q.steps} steps` : `Asking the rented GPU for a ${width} by ${height} picture, ${q.steps} steps${init ? ", painting over the picture" : ""}`);
  const res = await fetch(`${agent}/jobs`, { method: "POST", headers: { "Content-Type": "application/json", ...agentHeaders() }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `the machine answered HTTP ${res.status}`);
  return (await res.json()).id;
}

// Follows a job on the machine to its end and brings back the result: a
// Blob of the bytes, and for a picture the base64 as well.
// There is no giving up by the clock: a clip takes as long as it takes and
// the machine says whether it is still at it. Past `patienceMs` (twice the
// guess) the log says so now and then, and the way to stop is by hand.
async function followJob(agent, id, onLine = () => {}, started = Date.now(), { patienceMs = 20 * 60e3, onStatus = () => {} } = {}) {
  let last = "";
  let noted = false;
  let misses = 0;
  let nudged = 0;
  // When the machine began the picture itself, after any loading.
  let genStarted = 0;
  // The state as of the last poll, said every poll whether or not it
  // changed, with how long this has gone on and when the machine last
  // answered: the line that shows the wait is alive.
  let lastWord = "Asked";
  let lastOk = Date.now();
  // When the machine last reported a different step: a percentage that
  // stands still while the polls come back is the machine's pace, not a
  // page that stopped asking, and the line says so.
  let lastProgress = null;
  let progressAt = Date.now();
  const status = () => {
    const quiet = Date.now() - lastOk;
    const still = Date.now() - progressAt;
    onStatus(`${lastWord} · ${shortDuration((Date.now() - started) / 1000)} in${quiet > 15e3 ? ` · no answer from the machine for ${Math.round(quiet / 1000)} s` : lastProgress != null && still > 60e3 ? ` · the machine has reported ${Math.round(lastProgress * 100)}% for ${shortDuration(still / 1000)}` : ""}`);
  };
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let job;
    try {
      job = await pollJob(agent, id);
      if (misses >= 4) onLine("Reconnected to the machine.");
      misses = 0;
      lastOk = Date.now();
    } catch (err) {
      status();
      // A machine with no record of the job (it restarted) will never have it.
      if (err.gone) throw new Error("the machine no longer has this job: it restarted meanwhile; ask again");
      // The job goes on on the machine; a dropped connection is waited out.
      misses++;
      if (misses === 4) onLine("The connection to the machine dropped; the work goes on there, waiting to reconnect");
      // Unless the machine itself stopped: then nothing goes on there, and
      // waiting would be for ever. The site knows from RunPod.
      if (misses % 6 === 0) {
        const r = await api.get("/api/rent").catch(() => null);
        if (r && !r.rented) throw new Error("the rented machine is gone, and this job with it; rent one again");
        if (r && ["EXITED", "TERMINATED", "ERROR"].includes(r.status)) {
          state.rental = r;
          renderRental();
          throw new Error(`the machine stopped while generating. ${stopWhy(r)}Start it from the bar and try again; it loads the model first`);
        }
      }
      if (misses > 200) throw new Error(`lost the machine for five minutes while waiting (${err.message}); the job may still finish there`);
      continue;
    }
    if (!genStarted && ["generating", "completed"].includes(job.status)) genStarted = Date.now();
    if (job.progress != null && job.progress !== lastProgress) {
      lastProgress = job.progress;
      progressAt = Date.now();
    }
    const word = { loading: "Loading the model into the GPU (the first picture with a model takes longer)", queued: "Waiting for the GPU", generating: job.progress ? `Generating, ${Math.round(job.progress * 100)}%` : "Generating" }[job.status];
    if (word) {
      lastWord = { loading: "Loading the model", queued: "Waiting for the GPU", generating: job.progress ? `Generating, ${Math.round(job.progress * 100)}%` : "Generating, first step" }[job.status];
      status();
    }
    if (word && word !== last) {
      onLine(word);
      last = word;
    }
    if (job.note && !noted) {
      onLine(job.note);
      noted = true;
    }
    if (job.status === "completed") {
      job.took = (Date.now() - (genStarted || started)) / 1000;
      job.loadSeconds = genStarted ? (genStarted - started) / 1000 : 0;
      onLine(`Done in ${Math.round((Date.now() - started) / 1000)} s${job.loadSeconds > 5 ? ` (${Math.round(job.loadSeconds)} s of it loading the model)` : ""}.`);
      // A newer machine keeps the result apart from the status: fetched now, as bytes.
      if (!job.video && !job.image && job.result) {
        job.blob = await fetchResult(agent, id, job.kind === "video" ? "clip" : "picture", job.bytes, onLine);
        if (job.kind !== "video") job.image = await blobToBase64(job.blob);
      } else if (job.video || job.image) job.blob = b64ToBlob(job.video || job.image, job.video ? "video/mp4" : "image/png");
      // A clip's last frame, kept apart by a newer machine, for whatever starts from it.
      if (job.last) job.lastFrame = await fetch(`${agent}/jobs/${id}/last`, { headers: agentHeaders(), signal: AbortSignal.timeout(60e3) }).then((r) => (r.ok ? r.blob() : null)).catch(() => null);
      return job;
    }
    if (job.status === "failed") throw Object.assign(new Error(job.error || "the machine could not make the picture"), { jobId: id });
    const waited = Date.now() - started;
    if (waited > patienceMs && waited - nudged > 10 * 60e3) {
      nudged = waited;
      onLine(`Still going on the machine after ${Math.round(waited / 60e3)} min${job.progress ? ` (${Math.round(job.progress * 100)}%)` : job.status === "loading" ? " (loading the model)" : ""}; longer than guessed, but it is waited for as long as the machine is at it. Give up beside the log stops it there.`);
    }
  }
}

async function agentJobOnce(agent, args, onLine = () => {}) {
  const started = Date.now();
  const id = await submitJob(agent, args, onLine);
  return followJob(agent, id, onLine, started);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = () => reject(new Error("could not read the result"));
    r.readAsDataURL(blob);
  });
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

// One look at a job on the machine, without its result. The usual wait is
// short, so a machine that has gone is noticed; a wait that runs out is
// tried once more with patience, since a machine from before sends a
// finished clip, tens of megabytes, along with the status.
async function pollJob(agent, id) {
  const ask = (ms) => fetch(`${agent}/jobs/${id}?lean=1`, { headers: agentHeaders(), cache: "no-store", signal: AbortSignal.timeout(ms) });
  let poll;
  try {
    poll = await ask(10000);
  } catch (err) {
    if (err.name !== "TimeoutError" && err.name !== "AbortError") throw err;
    // A machine from before sends a finished clip with the status, which
    // takes a while; a longer wait, but not one that freezes the display
    // for minutes: past it the poll counts as missed and is tried again.
    poll = await ask(90e3);
  }
  if (poll.status === 404) throw Object.assign(new Error("HTTP 404"), { gone: true });
  if (!poll.ok) throw new Error(`HTTP ${poll.status}`);
  return poll.json();
}

// The finished picture or clip, as bytes, from a machine that keeps it
// apart from the status; tried a few times, since the result waits there.
async function fetchResult(agent, id, what, bytes, onLine) {
  onLine(`Fetching the ${what} from the machine${bytes ? `, ${(bytes / 1048576).toFixed(1)} MB` : ""}`);
  let last = null;
  for (let i = 0; i < 5; i++) {
    try {
      const res = await fetch(`${agent}/jobs/${id}/result`, { headers: agentHeaders(), signal: AbortSignal.timeout(10 * 60e3) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.blob();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`the ${what} is made and waits on the machine, but could not be fetched (${last?.message ?? "no answer"}); try again in a moment`);
}

// A clip from the rented GPU, shown and kept in the page until downloaded.
function showClip(into, { blob = null, data = null, prompt, name = `clip-${Date.now()}.mp4` }) {
  const card = document.createElement("div");
  card.className = "image-card";
  const src = blob ? URL.createObjectURL(blob) : `data:video/mp4;base64,${data}`;
  markMade();
  card.innerHTML = `<video class="result-image" src="${esc(src)}" controls autoplay loop muted playsinline title="${esc(prompt)}"></video>
    <p class="muted small tools-row"><span>Made on the rented GPU; kept in this browser under this model until removed.</span><a class="button" href="${esc(src)}" download="${esc(name)}">Download</a></p>`;
  into.appendChild(card);
}

function renderTranscribe(box, t) {
  box.innerHTML = `<h3>Try it</h3>
    <p class="muted small">Pick a recording. WAV works everywhere; MP3, M4A and others are converted with ffmpeg${t.ffmpeg ? ", which is installed" : ", which is not installed, so whisper.cpp reads them directly and may refuse some formats"}.</p>
    ${effortHtml("transcribe", OTHER_EFFORTS, "")}
    <div class="file-row">
      <input type="file" id="audio" accept="audio/*,video/*">
      <button class="primary" id="audio-go">Transcribe</button>
    </div>
    <pre class="log" id="audio-log" hidden></pre>
    <div id="audio-out"></div>`;
  wireEffort(box, "transcribe");
  $("#audio-go").addEventListener("click", async () => {
    const file = $("#audio").files[0];
    if (!file) return;
    const log = $("#audio-log");
    log.hidden = false;
    log.textContent = "Uploading\n";
    $("#audio-go").disabled = true;
    try {
      const up = await fetch("/api/upload", { method: "POST", headers: { "x-filename": file.name }, body: file }).then(check);
      const { id } = await api.post("/api/run", { kind: "transcribe", args: { repo: t.repo, file: t.file, audio: up.path, effort: chosenEffort(box, "transcribe") } });
      const result = await follow(id, (line) => {
        log.textContent += line + "\n";
        log.scrollTop = log.scrollHeight;
      });
      if (result.status === "done" && result.result) {
        const r = await api.get(`/api/result?file=${encodeURIComponent(result.result)}`);
        $("#audio-out").innerHTML = `<div class="transcript">${esc(r.text.trim() || "(no speech found)")}</div><p class="tools-row"><button class="ghost" id="transcript-download">Download</button></p>`;
        $("#transcript-download").addEventListener("click", () => saveText(`${file.name.replace(/\.[^.]+$/, "")}-transcript.txt`, r.text));
      }
    } catch (err) {
      log.textContent += `Could not transcribe: ${err.message}\n`;
    } finally {
      $("#audio-go").disabled = false;
    }
  });
}

// ---- hiding models ------------------------------------------------------------
// A model that turned out no good can be hidden from search and Browse.
// The list is kept with the settings (the file on a computer, the account
// on the site) and in this browser, so a visitor who never signs in keeps it too.

function localHidden() {
  try {
    const list = JSON.parse(localStorage.getItem("hidden:models") || "[]");
    return Array.isArray(list) ? list.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function saveHidden() {
  const list = [...state.hidden];
  try {
    localStorage.setItem("hidden:models", JSON.stringify(list));
  } catch {
    // no storage
  }
  if (!state.hosted || state.user) await api.post("/api/settings", { HIDDEN_MODELS: list }).catch(() => {});
  renderHiddenList();
  render();
}

// Hiding a model also clears it off the rented machine, so a model judged
// no good stops taking up its disk; the answer says what went.
async function hideModel(id) {
  state.hidden.add(id);
  await saveHidden();
  if (!state.rental?.rented) return [];
  try {
    const { removed } = await api.post("/api/rent/forget", { id });
    if (removed.length) await load();
    return removed;
  } catch {
    return [];
  }
}

async function unhideModel(id) {
  state.hidden.delete(id);
  await saveHidden();
}

function renderHideButton(id) {
  const btn = $("#hide-model");
  btn.hidden = !id;
  btn.textContent = state.hidden.has(id) ? "Show this model again" : "Hide this model";
}

$("#hide-model").addEventListener("click", async () => {
  const id = state.open;
  if (!id) return;
  if (state.hidden.has(id)) {
    await unhideModel(id);
    renderHideButton(id);
    notice(`${id.split("/").pop()} is back in search and Browse.`, "ok");
    return;
  }
  const removed = await hideModel(id);
  $("#modal").hidden = true;
  state.open = null;
  notice(`${id.split("/").pop()} is hidden from search and Browse${removed.length ? ` and removed from the rented GPU` : ""}. Settings lists hidden models, with a way to bring one back.`, "ok");
});

function renderHiddenList() {
  const list = $("#hidden-list");
  const ids = [...state.hidden].sort();
  $("#hidden-note").textContent = ids.length ? `${ids.length} model${ids.length === 1 ? "" : "s"} you hid from search and Browse${state.hosted && !state.user ? ", kept in this browser" : ""}.` : "Nothing hidden. A model's window has a Hide button for the ones that are no good.";
  list.innerHTML = ids.map((id) => `<li><span>${esc(id)}</span><button class="ghost" data-unhide="${esc(id)}">Show again</button></li>`).join("");
  for (const btn of list.querySelectorAll("[data-unhide]")) btn.addEventListener("click", () => unhideModel(btn.dataset.unhide));
}

// ---- settings --------------------------------------------------------------

function renderRunners() {
  const r = state.runners;
  const rows = [
    [r.ollama.remote ? "Chat server" : "Ollama", r.ollama.remote ? (r.ollama.running ? `connected, ${r.ollama.models.length} model${r.ollama.models.length === 1 ? "" : "s"}` : "not answering") : r.ollama.installed ? (r.ollama.running ? `running, ${r.ollama.models.length} model${r.ollama.models.length === 1 ? "" : "s"}` : "installed, not running") : "not installed"],
    ["whisper.cpp", r.whisper.installed ? "installed" : "not installed"],
    ["stable-diffusion.cpp", r.sd.installed ? (r.sd.server ? (r.sd.loaded.ready ? `installed, ${r.sd.loaded.file.split("/").pop()} loaded in memory` : "installed, keeps models loaded between pictures") : "installed (one picture at a time; the server build is missing)") : "not installed"],
    ["ffmpeg", r.ffmpeg ? "installed" : "not installed (only needed for non-WAV recordings)"],
  ];
  $("#runner-list").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><span class="muted">${esc(v)}</span></li>`).join("");
}

$("#open-settings").addEventListener("click", () => {
  $("#settings").hidden = false;
  if (!state.hosted) renderStorage($("#local-body").hidden ? ["settings"] : ["local", "settings"]).catch(() => ($("#storage-total").textContent = "Could not read the models folder."));
});
$("#close-settings").addEventListener("click", () => ($("#settings").hidden = true));
$("#close-modal").addEventListener("click", () => {
  $("#modal").hidden = true;
  state.open = null;
});
// A click beside a window closes it, as Close and Escape do. A conversation
// is kept in this browser, so closing the model window loses nothing; a
// drag that ends outside (selecting text) does not count, only a click
// that began there.
let pressedBackdrop = null;
for (const id of ["#settings", "#modal", "#gpu-models"]) {
  const el = $(id);
  if (!el) continue;
  el.addEventListener("pointerdown", (e) => {
    pressedBackdrop = e.target === e.currentTarget ? e.currentTarget : null;
  });
  el.addEventListener("click", (e) => {
    if (e.target !== e.currentTarget || pressedBackdrop !== e.currentTarget) return;
    e.currentTarget.hidden = true;
    if (id === "#modal") state.open = null;
  });
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    $("#modal").hidden = true;
    $("#settings").hidden = true;
    $("#checker").hidden = true;
    $("#signin").hidden = true;
    $("#gpu-models").hidden = true;
    state.open = null;
  }
});

$("#save-token").addEventListener("click", async () => {
  const token = $("#token").value.trim();
  if (!token) return;
  await api.post(state.hosted && !state.user ? "/api/guest" : "/api/settings", { HF_TOKEN: token });
  $("#token").value = "";
  await load();
  $("#settings").hidden = true;
  notice("Token saved. Gated models you have accepted on Hugging Face can be downloaded now.", "ok");
});
// Chat models can live on another machine; this says whether it answers.
async function renderChatServerStatus() {
  const el = $("#chat-server-status");
  if (!state.chatServer) {
    el.textContent = "Chat models run on this computer.";
    return;
  }
  el.textContent = `Checking ${state.chatServer.url}`;
  try {
    const r = await api.get("/api/chat-server");
    const rented = state.chatServer.rented ? "The rented GPU. " : "";
    el.textContent = r.ok
      ? `${rented}Connected to Ollama ${r.version}. It holds ${r.models} model${r.models === 1 ? "" : "s"}; chat models are downloaded and run there.`
      : state.chatServer.rented
        ? "The rented GPU; Ollama on it is not answering yet. A new machine takes a few minutes to start."
        : `Saved, but the server did not answer (${r.error}). Check the address, and that the tunnel is open if you use one.`;
  } catch (err) {
    el.textContent = `Could not check the server: ${err.message}`;
  }
}

$("#save-chat-server").addEventListener("click", async () => {
  try {
    await api.post("/api/settings", { OLLAMA_SERVER: $("#chat-server").value.trim(), OLLAMA_SERVER_GB: $("#chat-server-gb").value.trim() });
  } catch (err) {
    alert(err.message);
    return;
  }
  await load();
  if (state.open) openModel(state.open);
});
$("#clear-chat-server").addEventListener("click", async () => {
  await api.post("/api/settings", { OLLAMA_SERVER: "" });
  await load();
  if (state.open) openModel(state.open);
});

// ---- accounts on the hosted site -----------------------------------------------
// Signing in keeps the person's keys and their rented machine with an
// account; nothing they say to a model is kept. On a computer there is no
// account: the app is its owner's.

function renderAccount() {
  const user = state.user;
  if (!state.hosted) {
    $("#open-settings").hidden = false;
    return;
  }
  // The Sign in button shows whenever Google is set up and nobody is signed
  // in for good; a guest sees it too, to keep their keys.
  $("#sign-in").hidden = (user && !user.guest) || !state.auth?.ready;
  $("#create-account").hidden = $("#sign-in").hidden;
  // Settings are open to everyone: a visitor who saves a key there becomes a guest.
  $("#open-settings").hidden = false;
  // The paste-in checker shows once something has been made with a model in this browser.
  $("#open-checker").hidden = !madeSomething();
  const box = $("#account");
  box.hidden = !user;
  const until = user?.expiresAt ? new Date(user.expiresAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  $("#account-line").textContent = user ? (user.guest ? `You are a guest. Your keys and the rented machine are kept until ${until}, ${state.auth?.guestHours ?? 12} hours after your last use; then the machine is stopped and the keys forgotten.${state.auth?.google ? " Sign in with Google to keep them." : ""}` : `Signed in as ${user.email}.`) : "";
  $("#delete-account").textContent = user?.guest ? "Forget my keys now" : "Delete my account";
  if (!user) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = user.guest
    ? `<span class="muted small" title="Kept until ${esc(until)}">Guest, keys kept until ${esc(until)}</span><button class="ghost" id="sign-out">Forget keys</button>`
    : `${user.picture ? `<img class="avatar" src="${esc(user.picture)}" alt="" referrerpolicy="no-referrer">` : ""}<span class="muted small">${esc(user.name || user.email)}</span><button class="ghost" id="sign-out">Sign out</button>`;
  box.querySelector("#sign-out").addEventListener("click", async () => {
    if (user.guest) {
      if (!confirm("Forget your keys now? A rented machine is stopped first and then forgotten by this site; it stays in your RunPod account.")) return;
      await api.post("/api/account/delete", {});
    } else {
      await api.post("/api/auth/logout", {});
    }
    $("#settings").hidden = true;
    await load();
  });
}

// Whether a model has answered, drawn or filmed anything in this browser;
// remembered here, so the answer checker is offered from then on.
function madeSomething() {
  try {
    return localStorage.getItem("hf:made") === "1";
  } catch {
    return false;
  }
}
function markMade() {
  try {
    localStorage.setItem("hf:made", "1");
  } catch {}
  if (state.hosted) $("#open-checker").hidden = false;
}

function openSignIn() {
  $("#signup").hidden = true;
  $("#signin").hidden = false;
  $("#signin-error").textContent = "";
  mountGoogle($("#google-button"), "signin_with");
}

// Creating an account is the same Google step; this window says first what
// the account keeps and what it never sees.
function openSignUp() {
  $("#signin").hidden = true;
  $("#signup").hidden = false;
  $("#signup-error").textContent = "";
  mountGoogle($("#google-button-signup"), "signup_with");
}

// Google's own button, drawn by its script, which is loaded only when the
// sign-in window opens. Picking an account hands over an ID token; the
// server checks it and starts the session.
function mountGoogle(host, text) {
  if (!state.auth?.google) {
    host.innerHTML = `<p class="muted small">Sign-in is not set up on this site yet; the owner has to add a Google client id.</p>`;
    return;
  }
  const ready = () => {
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({ client_id: state.auth.google, callback: onGoogleCredential });
    host.innerHTML = "";
    window.google.accounts.id.renderButton(host, { theme: "outline", size: "large", width: 300, text });
  };
  if (window.google?.accounts?.id) return ready();
  if (!state.gsi) {
    state.gsi = document.createElement("script");
    state.gsi.src = "https://accounts.google.com/gsi/client";
    state.gsi.async = true;
    state.gsi.defer = true;
    document.head.appendChild(state.gsi);
  }
  state.gsi.addEventListener("load", ready, { once: true });
}

async function onGoogleCredential(response) {
  try {
    await api.post("/api/auth/google", { credential: response.credential });
  } catch (err) {
    $("#signin-error").textContent = err.message;
    $("#signup-error").textContent = err.message;
    return;
  }
  $("#signin").hidden = true;
  $("#signup").hidden = true;
  await load();
  notice("Signed in. Your keys and your rented GPU are kept with your account; what you say to models is not.", "ok");
  if (state.open) openModel(state.open);
}

$("#sign-in").addEventListener("click", openSignIn);
$("#create-account").addEventListener("click", openSignUp);
$("#to-signup").addEventListener("click", (e) => {
  e.preventDefault();
  openSignUp();
});
$("#close-signin").addEventListener("click", () => ($("#signin").hidden = true));
$("#close-signup").addEventListener("click", () => ($("#signup").hidden = true));
for (const id of ["#signin", "#signup"]) {
  $(id).addEventListener("click", (e) => {
    if (e.target === e.currentTarget) e.currentTarget.hidden = true;
  });
}
$("#delete-account").addEventListener("click", async () => {
  if (!confirm(state.user?.guest ? "Forget your keys now? The rented GPU and every model on it are deleted too." : "Delete your account? The keys, the rented GPU and every model on it are deleted; nothing else was kept.")) return;
  try {
    await api.post("/api/account/delete", {});
  } catch (err) {
    alert(err.message);
    return;
  }
  $("#settings").hidden = true;
  await load();
  notice("Your account was deleted.", "ok");
});

// ---- a GPU rented by the hour ----------------------------------------------

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function minutesText(seconds) {
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

// What the machine is doing, in a word, and the pill colour for it.
function rentalPhase(r) {
  if (!r?.rented) return null;
  if (r.status === "RUNNING") return r.ready ? ["ready", "ready"] : ["starting Ollama", "starting"];
  if (r.status === "PROVISIONING" || r.status === "STARTING" || r.status === "UNKNOWN") return ["starting", "starting"];
  if (r.status === "EXITED") return ["stopped", "stopped"];
  return [r.status.toLowerCase(), "error"];
}

// Where GPUs are rented from, by the keys saved: RunPod, Vast.ai, or both.
function placesText() {
  const p = [state.runpodKey ? "RunPod" : "", state.vastKey ? "Vast.ai" : ""].filter(Boolean);
  return p.length ? p.join(" and ") : "RunPod";
}
function placeOf(r) {
  return r?.provider === "vast" || r?.cloud === "VAST" ? "Vast.ai" : "RunPod";
}
// Every card on offer in one list: each size at RunPod, and the same size
// at Vast.ai when a Vast.ai key is saved. A row's key is its size, with
// ":vast" for Vast.ai's; the rest of a row reads like a size from RunPod.
function rentRows(options = state.rentOptions ?? []) {
  const rows = [];
  for (const t of options) {
    if (state.runpodKey || !state.vastKey) rows.push({ ...t, provider: "runpod", key: String(t.gb) });
    // With Vast.ai alone, a size it has none of still shows, sold out there.
    if (t.vast && (t.vast.gpu || !state.runpodKey)) rows.push({ ...t, ...t.vast, provider: "vast", key: `${t.gb}:vast`, vast: null });
  }
  return rows;
}
// Among the free cards, the ones meaningfully faster than the pick (a
// third or more, by the speed figure the site gives each card), fastest
// first, with what the same clip costs there next to the pick.
function fasterRows(pick, rows) {
  const base = pick?.gpu?.speed;
  if (!base || !(pick.pricePerHour > 0)) return [];
  const out = [];
  for (const r of rows) {
    const s = r.gpu?.speed;
    // Only cards at least as big: a faster card the model does not fit is no use.
    if (r === pick || !s || !(r.pricePerHour > 0) || s / base < 1.3 || (r.gb ?? 0) < (pick.gb ?? 0)) continue;
    if (out.some((x) => x.gpu.name === r.gpu.name && x.provider === r.provider)) continue;
    out.push({ ...r, times: Math.round((s / base) * 10) / 10, costRatio: Math.round(((r.pricePerHour / pick.pricePerHour) / (s / base)) * 100) / 100 });
  }
  return out.sort((a, b) => b.times - a.times).slice(0, 3);
}
function rentRow(key) {
  return rentRows().find((r) => r.key === String(key)) ?? null;
}
// How a row says where it is: nothing for RunPod's Secure Cloud.
function placeTag(row) {
  return row.provider === "vast" ? ", Vast.ai" : row.gpu?.cloud === "COMMUNITY" ? ", Community Cloud" : "";
}

// ---- how far a starting machine has got ---------------------------------
// The stages a machine goes through between being asked for and answering,
// with when each usually ends (seconds since it was asked for). The stage
// comes from what RunPod or Vast.ai and the machine say; the fill within
// it from the time since it was asked for, kept by the site. So the bar
// reads the same in every window and after reopening one.
const BOOT_STAGES = {
  runpod: [
    { key: "order", label: "RunPod places it on a host", until: 30 },
    { key: "image", label: "the host fetches the machine image", until: 180 },
    { key: "start", label: "Ollama and the agent start", until: 240 },
  ],
  vast: [
    { key: "order", label: "Vast.ai sets up the host", until: 60 },
    { key: "image", label: "the host fetches the machine image", until: 900 },
    { key: "tunnel", label: "the machine opens its secure address", until: 990 },
    { key: "start", label: "Ollama and the agent start", until: 1050 },
  ],
};
// Whether the machine answers on both sides: Ollama, and the agent when it has one.
function machineUp(r) {
  return Boolean(r?.rented && r.status === "RUNNING" && r.ready && (r.imagesReady || r.images === false));
}
function bootStage(r) {
  if (r.status === "PROVISIONING" || r.status === "UNKNOWN") return "order";
  if (r.status === "STARTING") return r.provider === "vast" || !r.containerUp ? "image" : "start";
  if (r.status === "RUNNING") {
    if (r.containerUp === false) return "image";
    if (r.provider === "vast" && !r.url) return "tunnel";
    return "start";
  }
  return null;
}
// When the wait began: when the site asked for the machine, else when this page first saw it starting.
const bootSeen = new Map();
function bootSince(r) {
  if (r.startAskedAt) return r.startAskedAt;
  if (!bootSeen.has(r.id)) bootSeen.set(r.id, Date.now());
  return bootSeen.get(r.id);
}
function bootHtml(r) {
  if (!r?.rented || machineUp(r) || ["EXITED", "TERMINATED", "ERROR"].includes(r.status)) return "";
  if (r.waitingForGpu) return `<div class="boot"><p class="small"><b>Waiting for this host's GPU to be free.</b> A stopped Vast.ai machine starts again only on the host that holds its disk; it starts by itself once the card is free.</p></div>`;
  const stages = BOOT_STAGES[r.provider === "vast" ? "vast" : "runpod"];
  const key = bootStage(r) ?? "order";
  const i = Math.max(0, stages.findIndex((s) => s.key === key));
  const total = stages.at(-1).until;
  const elapsed = Math.max(0, (Date.now() - bootSince(r)) / 1000);
  const lo = i ? stages[i - 1].until : 0;
  const hi = stages[i].until;
  const frac = Math.min(0.9, Math.max(0, (elapsed - lo) / (hi - lo)));
  const pct = Math.min(99, Math.round(((lo + frac * (hi - lo)) / total) * 100));
  // Ollama answering before the agent: the last few seconds, said as such.
  const detail = key === "start" && r.ready && !r.imagesReady ? "Ollama answers; the agent is still starting" : stages[i].label[0].toUpperCase() + stages[i].label.slice(1);
  const usual = r.provider === "vast" ? "5 to 20 minutes, most of it the image download on a host that has not had it before" : "2 to 4 minutes, longer on a host fetching the image for the first time";
  const slow = elapsed > total * 2.5;
  const steps = stages.map((s, j) => `<span class="boot-step ${j < i ? "done" : j === i ? "now" : ""}">${j < i ? "✓" : j === i ? "●" : "○"} ${esc(s.label)}</span>`).join("");
  return `<div class="boot" data-boot="1">
    <div class="progress guess" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><div class="fill" style="width:${pct}%"></div></div>
    <p class="small"><b>${pct}%</b> · ${esc(detail)}. ${esc(bootElapsed(elapsed))} so far; usually ${usual}.</p>
    <p class="boot-steps small">${steps}</p>
    ${r.podNote ? `<p class="muted small">${placeOf(r)} says: ${esc(r.podNote)}</p>` : ""}
    ${slow ? `<p class="small warn-text">Longer than usual. The host may be slow to fetch the image or not delivering; replacing the machine puts it on another host.</p>` : ""}
  </div>`;
}
function bootElapsed(seconds) {
  const s = Math.round(seconds);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}
// Redraws every progress bar on show, each second while a machine starts.
function paintBoot() {
  const nodes = document.querySelectorAll("[data-boot-slot]");
  const html = bootHtml(state.rental);
  for (const n of nodes) if (n.innerHTML !== html) n.innerHTML = html;
  clearTimeout(state.bootTimer);
  if (html && nodes.length) state.bootTimer = setTimeout(paintBoot, 1000);
}

// The sizes and prices RunPod offers. The server keeps them for a while;
// `fresh` asks RunPod again, for the Refresh button and after a rent that
// found the stock gone.
async function loadRentOptions({ fresh = false, quiet = false } = {}) {
  // A quiet check (the watch, Check again) keeps the list on show meanwhile.
  if (!quiet || !state.rentOptions) {
    state.rentOptionsLoading = true;
    renderRental();
  }
  try {
    const r = await api.get(`/api/rent/options${fresh ? "?fresh=1" : ""}`);
    state.rentOptions = r.configured ? r.tiers : null;
    state.rentProviders = r.providers ?? { runpod: true, vast: false };
    state.rentStock = r.stock ?? {};
    state.rentCommunity = Boolean(r.community);
    state.rentCheckedAt = r.checkedAt ?? Date.now();
    state.rentOptionsError = "";
  } catch (err) {
    state.rentOptions = null;
    state.rentOptionsError = err.message;
    // RunPod throttling passes by itself; ask again when it says to, without a click.
    const m = /again in (\d+) (seconds|minutes|hours)/.exec(err.message);
    const wait = /stopped answering|rate limiting|enough for the moment/.test(err.message) ? Math.min((Number(m?.[1]) || 30) * ({ seconds: 1, minutes: 60, hours: 3600 }[m?.[2]] ?? 1) + 2, 900) : 0;
    clearTimeout(state.rentOptionsRetry);
    if (wait) state.rentOptionsRetry = setTimeout(loadRentOptions, wait * 1000);
  }
  state.rentOptionsLoading = false;
  await checkWatch();
  renderRental();
  // A model window asking about a GPU can now name the card and its price.
  if (state.open && state.rentAsk === state.open) openModel(state.open);
}

// ---- renting a size as soon as one is free -----------------------------
// The site itself watches RunPod (a check every minute on its server, with
// this page closed too) and rents the size the moment one is free at no
// more than the price set. The person is told four ways: a system
// notification through the browser's push service, which shows even with
// this tab closed while the browser runs; and, with the tab open, a chime,
// the tab's title, and a notice on the page.
function sizeName(gb) {
  const t = [...(state.rentOptions ?? []), ...(state.rentTiers ?? [])].find((x) => x.gb === gb);
  return t?.count > 1 ? `${t.count} × ${t.gb / t.count} GB GPU machine` : `${gb} GB GPU`;
}
function rentWhenFreeHtml(t) {
  const w = state.rental?.watch;
  if (w?.gb === t.gb) return `<span class="watching">Renting it when one is free (the site is watching). <button class="ghost watch-server-stop">Stop</button></span>`;
  if (w || state.rental?.rented) return "";
  return `<button class="primary rent-when" data-gb="${t.gb}">Rent when available</button>`;
}
// The short form under a sold-out size: the most it may cost, the disk,
// how long to watch, and how long to hold the machine once rented.
function openRentWhen(gb, anchor) {
  const t = (state.rentOptions ?? []).find((x) => x.gb === gb);
  if (!t || !anchor) return;
  anchor.parentElement.querySelector(".rent-when-form")?.remove();
  const listed = t.pricePerHour ?? t.gpu?.pricePerHour ?? 0;
  const cap = listed ? Math.ceil(listed * 1.15 * 100) / 100 : "";
  const disk = Number($("#rent-disk")?.value) || Number(state.rentDisk ?? 50);
  const form = document.createElement("div");
  form.className = "rent-when-form";
  form.innerHTML = `<p class="muted small">The site checks ${placesText()} every minute, with this page closed too, and rents a ${esc(sizeName(gb))} the moment one is free.</p>
    <div class="rent-when-fields">
      <label>Up to $<input type="number" class="rw-price" min="0.1" max="200" step="0.01" value="${cap}"> an hour</label>
      <label>Disk <input type="number" class="rw-disk" min="10" max="4000" step="10" value="${disk}"> GB</label>
      <label>Watch for <input type="number" class="rw-hours" min="1" max="72" step="1" value="24"> hours</label>
      <label>Hold it <input type="number" class="rw-hold" min="0" max="240" step="5" value="60"> minutes</label>
    </div>
    <p class="muted small rw-cost"></p>
    <p class="tools-row"><button class="primary rw-go">Start watching</button><button class="ghost rw-cancel">Cancel</button></p>`;
  anchor.after(form);
  const cost = () => {
    const price = Number(form.querySelector(".rw-price").value) || 0;
    const hold = Number(form.querySelector(".rw-hold").value) || 0;
    form.querySelector(".rw-cost").textContent = `Once rented it runs while you are away for up to ${hold} minutes, at most ${money((price * hold) / 60)}, then stops as usual if unused; its models stay on the disk. You get a notification either way.${listed ? ` Listed now at ${money(listed)} an hour.` : ""}`;
  };
  for (const i of form.querySelectorAll("input")) i.addEventListener("input", cost);
  cost();
  form.querySelector(".rw-cancel").addEventListener("click", (e) => {
    e.preventDefault();
    form.remove();
  });
  form.querySelector(".rw-go").addEventListener("click", async (e) => {
    e.preventDefault();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Starting";
    // The chime needs a click to be allowed later; this is that click.
    armChime();
    const told = await subscribePush();
    try {
      state.rental = await api.post("/api/rent/watch", { gb, diskGb: Number(form.querySelector(".rw-disk").value), maxPricePerHour: Number(form.querySelector(".rw-price").value), hours: Number(form.querySelector(".rw-hours").value), holdMinutes: Number(form.querySelector(".rw-hold").value) });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Start watching";
      notice(`Could not start watching: ${err.message}`, "bad");
      return;
    }
    rememberWatchSeen();
    form.remove();
    if (state.rental?.rented) announceRented(state.rental.watchResult);
    else notice(`Watching for a ${sizeName(gb)}. ${told}`, "ok");
    renderRental();
    if (state.open) openModel(state.open);
  });
}
async function stopRentWatch() {
  try {
    await api.post("/api/rent/unwatch", {});
  } catch (err) {
    notice(`Could not stop the watch: ${err.message}`, "bad");
    return;
  }
  state.rental = await api.get("/api/rent").catch(() => state.rental);
  notice("Stopped watching.", "ok");
  renderRental();
  if (state.open) openModel(state.open);
}
// The browser's push service, for a notification with the tab closed: the
// person is asked once whether the site may notify them.
async function subscribePush() {
  try {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !window.Notification) return "This browser cannot notify with the tab closed; keep the tab open to hear the chime.";
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted") return "Notifications are blocked for this site, so you will hear of it here only: keep the tab open, or allow notifications in the browser's site settings.";
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const { key } = await api.get("/api/push/key");
    const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((key.length + 3) % 4));
    const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, (c) => c.charCodeAt(0)) }));
    await api.post("/api/push/subscribe", { subscription: sub.toJSON() });
    return "You will get a system notification when it is rented, even with this tab closed, as long as the browser is running.";
  } catch (err) {
    return `Notifications could not be set up (${err.message}); keep the tab open to hear the chime.`;
  }
}
let chime = null;
function armChime() {
  try {
    chime ??= new (window.AudioContext || window.webkitAudioContext)();
    chime.resume?.();
  } catch {
    chime = null;
  }
}
function playChime() {
  try {
    if (!chime) return;
    for (const [f, at] of [[880, 0], [1320, 0.18]]) {
      const o = chime.createOscillator();
      const g = chime.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, chime.currentTime + at);
      g.gain.exponentialRampToValueAtTime(0.25, chime.currentTime + at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, chime.currentTime + at + 0.5);
      o.connect(g).connect(chime.destination);
      o.start(chime.currentTime + at);
      o.stop(chime.currentTime + at + 0.55);
    }
  } catch {
    // no sound here; the notice and the title still tell
  }
}
// What became of a watch is told once: kept as seen in this browser.
function rememberWatchSeen(at = Date.now()) {
  try {
    localStorage.setItem("watchSeen", String(at));
  } catch {
    // no storage: it may be told again
  }
}
function watchSeen() {
  try {
    return Number(localStorage.getItem("watchSeen")) || 0;
  } catch {
    return 0;
  }
}
function announceRented(result) {
  if (!result) return;
  rememberWatchSeen(result.at || Date.now());
  const rented = result.kind === "rented";
  const text = rented ? `Your GPU is rented: ${result.text}. It is starting and answers in a few minutes.` : `The GPU watch ended: ${result.text}.`;
  notice(text, rented ? "ok" : "info");
  if (rented) playChime();
  // The tab says so too, until the page is looked at.
  if (document.hidden) {
    const was = document.title;
    document.title = rented ? "● GPU rented · HuggingFound" : "● GPU watch ended · HuggingFound";
    const back = () => {
      if (document.hidden) return;
      document.title = was;
      document.removeEventListener("visibilitychange", back);
    };
    document.addEventListener("visibilitychange", back);
  }
  // A notification from the page itself when the push service was not set up
  // (the same tag, so one shown by push is replaced, not doubled).
  try {
    if (window.Notification && Notification.permission === "granted") navigator.serviceWorker?.getRegistration?.().then((reg) => (reg ? reg.showNotification("HuggingFound", { body: text, tag: "gpu-watch" }) : new Notification("HuggingFound", { body: text, tag: "gpu-watch" }))).catch(() => {});
  } catch {
    // the notice on the page is enough
  }
}
// While a watch runs, the page asks the site every half minute what became
// of it, and tells the moment it is rented.
function watchPoll() {
  if (state.watchPollTimer) return;
  state.watchPollTimer = setTimeout(async () => {
    state.watchPollTimer = null;
    const r = await api.get("/api/rent").catch(() => null);
    if (!r) return watchPoll();
    state.rental = r;
    const result = r.watchResult;
    if (result && result.at > watchSeen()) {
      announceRented(result);
      if (r.rented) pollRental();
    }
    renderRental();
    if (r.watch) watchPoll();
  }, 30e3);
}

// How long a sold-out size has been out, and how long it took to come back
// before, from what the site has seen of RunPod's stock. RunPod itself
// never says when a card will be free; this is the nearest thing.
function ago(ms) {
  const m = Math.round(ms / 60e3);
  return m < 1 ? "under a minute" : m < 90 ? `${m} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} days`;
}
function stockText(t) {
  if (t.available || !t.gpu) return "";
  const s = state.rentStock?.[t.gb];
  if (!s) return "No history for this size yet; Tell me when free checks every minute.";
  const now = state.rentCheckedAt ?? Date.now();
  const parts = [];
  if (s.outSinceKnown && s.outSince) parts.push(`Sold out for ${ago(now - s.outSince)}`);
  else if (s.lastFreeAt) parts.push(`Last free ${ago(now - s.lastFreeAt)} ago`);
  else if (now - s.historySince < 10 * 60e3) return "No history for this size yet; Tell me when free checks every minute.";
  else parts.push(`Not seen free in the last ${ago(now - s.historySince)} of checks`);
  if (s.typicalWaitMs) {
    const usual = `before, it came back after about ${ago(s.typicalWaitMs)}`;
    const elapsed = s.outSinceKnown && s.outSince ? now - s.outSince : 0;
    parts.push(elapsed > s.typicalWaitMs ? `${usual}, so it may be soon` : usual);
    if (s.waits > 1) parts[parts.length - 1] += ` (${s.waits} times seen, longest ${ago(s.longestWaitMs)})`;
  }
  return `${parts.join("; ")}.`;
}

// Watching a sold-out size: checked every minute while this page is open;
// when one is free the page says so, and rents it if asked to. Kept in
// this browser, so a reload goes on watching.
function rentWatch() {
  if (state.rentWatch !== undefined) return state.rentWatch;
  try {
    state.rentWatch = JSON.parse(localStorage.getItem("rentWatch") || "null");
  } catch {
    state.rentWatch = null;
  }
  return state.rentWatch;
}
function setRentWatch(w) {
  state.rentWatch = w;
  try {
    if (w) localStorage.setItem("rentWatch", JSON.stringify(w));
    else localStorage.removeItem("rentWatch");
  } catch {
    // no storage: the watch lasts as long as the page
  }
  clearInterval(state.rentWatchTimer);
  state.rentWatchTimer = w ? setInterval(() => loadRentOptions({ fresh: true, quiet: true }), 60e3) : null;
}
function startRentWatch(gb) {
  setRentWatch({ gb, rent: false, diskGb: Number(state.rentDisk ?? 50), since: Date.now() });
  try {
    if (window.Notification && Notification.permission === "default") Notification.requestPermission().catch(() => {});
  } catch {
    // no notifications here: the page's own notice does
  }
  renderRental();
  if (state.open) openModel(state.open);
}
async function checkWatch() {
  const w = rentWatch();
  if (!w) return;
  if (!state.rentWatchTimer) setRentWatch(w);
  if (state.rental?.rented) return setRentWatch(null);
  const t = (state.rentOptions ?? []).find((x) => x.gb === w.gb);
  if (!t?.available) return;
  const name = `${t.count > 1 ? `${t.count} × ${t.gb / t.count} GB` : `${t.gb} GB`} (${t.gpu?.name ?? "GPU"})`;
  setRentWatch(null);
  state.rentWant = t.gb;
  state.rentWantKey = String(t.gb);
  const tell = (text) => {
    notice(text, "ok");
    try {
      if (window.Notification && Notification.permission === "granted") new Notification("HuggingFound", { body: text });
    } catch {
      // the notice on the page is enough
    }
  };
  if (!w.rent) return tell(`A ${name} is free at RunPod now, ${money(t.pricePerHour)} an hour. It is chosen in Settings; rent it before it goes.`);
  try {
    state.rental = await api.post("/api/rent", { gb: t.gb, diskGb: w.diskGb });
    tell(`A ${name} came free and was rented, as you asked: ${money(t.pricePerHour)} an hour, with a ${w.diskGb} GB disk. It answers in a few minutes.`);
    pollRental?.();
  } catch (err) {
    tell(`A ${name} came free, but renting it failed: ${err.message}`);
  }
}
// The watch line, for Settings and the model window alike.
function watchHtml(t) {
  const w = rentWatch();
  if (w?.gb === t.gb) return `<span class="watching">Telling you when one is free, while this page is open. <button class="ghost watch-stop">Stop</button></span>`;
  return `<button class="ghost watch-go" data-gb="${t.gb}">Tell me when free</button>`;
}
function wireWatch(root) {
  for (const b of root.querySelectorAll(".rent-when")) b.addEventListener("click", (e) => {
    e.preventDefault();
    openRentWhen(Number(b.dataset.gb), b.closest(".tier, .sold-out") ?? b.parentElement);
  });
  for (const b of root.querySelectorAll(".watch-server-stop")) b.addEventListener("click", (e) => {
    e.preventDefault();
    stopRentWatch();
  });
  for (const b of root.querySelectorAll(".watch-go")) b.addEventListener("click", (e) => {
    e.preventDefault();
    startRentWatch(Number(b.dataset.gb));
  });
  for (const b of root.querySelectorAll(".watch-stop")) b.addEventListener("click", (e) => {
    e.preventDefault();
    setRentWatch(null);
    renderRental();
    if (state.open) openModel(state.open);
  });
  for (const c of root.querySelectorAll(".watch-rent")) c.addEventListener("change", () => {
    const w = rentWatch();
    if (w) setRentWatch({ ...w, rent: c.checked });
    renderRentBar(state.rental);
  });
}

function renderRental() {
  const r = state.rental;
  renderRentBar(r);
  queueMicrotask(paintBoot);
  const panel = $("#rent-panel");
  if (!panel) return;
  if (r?.rented) {
    const [word, cls] = rentalPhase(r);
    const running = ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(r.status);
    const cost = r.costPerHour != null ? `${money(r.costPerHour)} an hour. ` : "";
    const time = running && r.uptimeSeconds ? `Running for ${minutesText(r.uptimeSeconds)}${r.spent != null ? `, about ${money(r.spent)} this time` : ""}. ` : "";
    const why = stopWhy(r);
    const stopped = r.status === "EXITED" ? `Stopped: no hourly charge. ${why}The ${r.diskGb ? `${r.diskGb} GB ` : ""}disk keeps its models for ${r.diskPerDay ? `about ${money(r.diskPerDay)} a day (${money(r.diskPerDay * 30)} a month)` : "a small charge a day"}; Start brings it back in a minute or two, Delete removes it and the models.` : "";
    const todaySpend = r.spentToday ? `Today's machines have cost about ${money(r.spentToday)} so far. ` : "";
    // At the day's cap with someone here: the stop is announced, with the
    // way to put it off by raising the cap.
    const graceLeft = r.capGraceUntil ? Math.max(0, r.capGraceUntil - Date.now()) : 0;
    const capNote = running && graceLeft > 0 ? `<div class="notice warn cap-note"><span>Today's machines have reached the ${money(r.maxSpend ?? state.maxSpend ?? 50)} spend cap. This machine stops in about ${Math.max(1, Math.ceil(graceLeft / 60e3))} min, once nothing is being made on it, unless the cap is raised.</span> <button class="primary" id="rent-raise-cap">Raise the cap to ${money((r.maxSpend ?? state.maxSpend ?? 50) + 25)}</button></div>` : "";
    const trouble = r.imageProblem ? ` The image server on it cannot start (${r.imageProblem}); chat still works, and a machine rented after the image is fixed will make pictures.` : "";
    // Listed as running for long with nothing on it answering: a host that
    // never started the container (the image still being fetched, or a
    // host not delivering), said plainly, with RunPod's own word on it and
    // the way out, rather than a bar that looks fine while the hour bills.
    const stuckMin = running && !r.ready && !r.imagesReady && r.uptimeSeconds > 600 ? Math.round(r.uptimeSeconds / 60) : 0;
    const place = placeOf(r);
    const stuck = stuckMin ? `<div class="notice warn"><span>Listed as running by ${place} for ${stuckMin} minutes, but ${r.containerUp === false ? "no container has started on it" : r.provider === "vast" && !r.url ? "its secure address (a Cloudflare tunnel the machine opens) has not come up" : "nothing on it answers"}${r.podNote ? ` (${place}: ${esc(r.podNote)})` : ""}. ${r.containerUp === false ? "A fresh host fetches the machine image first, a few minutes; this long, the host is not delivering." : "Stop and Start may bring it back."}${r.dataCenter ? ` Data centre ${esc(r.dataCenter)}${(r.slowDataCenters ?? []).includes(r.dataCenter) ? ", which the next rent is placed away from when the card is in stock elsewhere" : ""}.` : ""}</span> <button class="primary" id="rent-replace-stuck">Replace the machine</button></div>` : "";
    const older = r.agentVersion != null && r.agentCurrent != null && r.agentVersion < r.agentCurrent;
    const idle = r.idleMinutes ? `Stops by itself after ${r.idleMinutes} minutes without a ${state.hosted ? "download" : "chat or download"}${state.stopOnQuit ? ", and when HuggingFound quits" : ""}.${state.hosted ? " Chats go straight from your browser to the machine, so the site cannot see them; each message you send counts as use." : ""}` : `Never stops by itself${state.stopOnQuit ? "; quitting HuggingFound stops it" : ""}.`;
    panel.innerHTML = `<div class="rent-card">
      <div class="rent-head"><span>${esc(r.gpu || "GPU")}${r.gb ? `, ${r.gb} GB` : ""}${r.provider === "vast" ? " at Vast.ai" : r.cloud === "COMMUNITY" ? ", Community Cloud" : ""}</span><span class="pill ${cls}">${esc(word)}</span></div>
      <p class="muted small">${esc(cost)}${esc(time)}${esc(todaySpend)}${esc(stopped)}${r.error ? ` Last check failed: ${esc(r.error)}` : ""}</p>
      <div data-boot-slot>${bootHtml(r)}</div>
      ${capNote}${stuck}
      ${r.waitingForGpu ? `<div class="notice warn"><span>Waiting for the GPU on this machine's host to be free again: a stopped Vast.ai machine starts only on the host that holds its disk, and someone else has its card for now. It starts by itself once the card is free${r.podNote ? ` (Vast.ai: ${esc(r.podNote)})` : ""}.</span> <button class="ghost" id="rent-replace-wait">Replace the machine</button></div>` : ""}
      <p class="muted small">${esc(idle)} ${r.images === false ? "This machine runs chat models only: the full machine image was not available when it was rented. Delete it and rent again for image models once it is." : "Chat and image models are downloaded to it and run there; speech models stay on your computer."}${esc(trouble)}</p>
      ${(r.provider === "vast" ? state.vastKey : state.runpodKey) ? "" : `<div class="notice bad">The ${place} key is gone while this machine is rented: Stop and Delete need it. Enter the key of the account that rented it above. <button class="ghost" id="rent-key-focus">Enter the key</button> It still stops by itself after ${r.idleMinutes || 1440} minutes without use${r.maxSpend ? ` or at ${money(r.maxSpend)}` : ""}.</div>`}
      ${older ? `<div class="notice warn">This machine runs an older HuggingFound image (version ${r.agentVersion} of ${r.agentCurrent}). What was added since${r.agentVersion < 2 ? ", folder-layout models" : ""}${r.agentVersion < 3 ? ", the FLUX, Qwen-Image and video families" : ""}${r.agentVersion < 4 ? ", add-ons" : ""}${r.agentVersion < 9 ? ", MiniMax-H3 clips with sound" : ""}${r.agentVersion < 10 ? ", MiniMax-H3 on both cards of a two-card machine instead of swapping" : ""}${r.agentVersion < 11 ? ", fixes to one shot of a clip joined with the other shots kept in this browser" : ""}${r.agentVersion < 12 ? ", LTX-2.5 clips with sound" : ""}${r.agentVersion < 16 ? ", LTX-2.5 with its parts staged through the card and its memory accounted for" : ""}${r.agentVersion < 17 ? ", LoRAs on MiniMax-H3 such as the 360 orbit" : ""}${r.agentVersion < 18 ? ", a true reading of the disk's room" : ""}${r.agentVersion < 19 ? ", the library LoRAs are set with" : ""}${r.agentVersion < 20 ? ", clips from reference pictures on MiniMax-H3" : ""}${r.agentVersion < 21 ? ", a disk grown after the rent read at its new size" : ""}${r.agentVersion < 22 ? ", the disk's use counted once" : ""}${r.agentVersion < 23 ? ", freeing a chat model held up by an earlier reply" : ""}${r.agentVersion < 30 ? ", fp8 weights kept off a model that takes turns on the card (where every clip failed)" : ""}${r.agentVersion < 31 ? ", pass skipping on MiniMax-H3 (where every clip failed with the switch on)" : ""}, needs a fresh machine. Chat and single-file image models still work on this one. <button class="primary" id="rent-replace-old">Replace the machine</button></div>` : ""}
      ${state.rentError ? `<div class="notice ${state.rentError.noGpu ? "warn" : "bad"}">${esc(state.rentError.message)}${state.rentError.retrying ? ` <b>Start is asked again every minute for ${Math.max(1, Math.ceil((startRetry.until - Date.now()) / 60e3))} more minutes${startRetry.tries ? ` (${startRetry.tries} so far)` : ""}; this can be left as it is.</b>` : state.rentError.noGpu && state.rentError.action === "start" ? " Start was asked again every minute for half an hour without luck." : ""}${state.rentError.noGpu ? ` <button class="primary" id="rent-replace">Replace the machine</button>${state.rentError.retrying ? `<button class="ghost" id="rent-stop-retry">Stop asking</button>` : ""}` : ""}</div>` : ""}
      <div class="actions">
        ${running ? `<button class="ghost" id="rent-stop">Stop</button>` : ""}
        ${r.status === "EXITED" || r.status === "ERROR" ? `<button class="primary" id="rent-start">Start</button>` : ""}
        <button class="ghost" id="rent-delete">Delete machine and models</button>
        <button class="ghost" id="rent-report">Machine report</button>
      </div>
      <div id="rent-spend"></div>
      <div id="rent-others"></div>
      <label class="field">
        <span>Stop after this many idle minutes</span>
        <input type="number" id="rent-idle" min="0" max="1440" step="1" value="${Number(r.idleMinutes ?? 30)}">
        <small class="muted">Unset, 30 minutes. 0 keeps it running until you stop it, though the machine itself gives up after a day without the site. A download in progress keeps it awake, up to six hours; "Stop the GPU when this finishes" under a download, ticked unless you untick it, ends the bill a minute after it is done.</small>
      </label>
      <label class="field">
        <span>Ask whether I am still here after this many minutes without a click or key</span>
        <input type="number" id="rent-presence" min="1" max="240" step="1" value="${Math.max(1, Math.round(state.presenceMinutes ?? 30))}">
        <small class="muted">While the machine runs, even during a download or a picture. With no answer in a short countdown the machine stops; its models stay.</small>
      </label>
      <label class="field">
        <span>Stop once today's machines have cost this many dollars</span>
        <input type="number" id="rent-cap" min="0" max="10000" step="1" value="${Number(r.maxSpend ?? 50)}">
        <small class="muted">Counted across stops, starts and replaced machines since midnight UTC, from the running time ${place} reports; 0 removes the cap. ${r.costPerHour ? `At ${money(r.costPerHour)} an hour, ${money(r.maxSpend ?? 50)} is about ${((r.maxSpend ?? 50) / r.costPerHour).toFixed(1)} hours.` : ""}</small>
      </label>
      ${state.hosted ? "" : `<label class="check"><input type="checkbox" id="rent-quit" ${state.stopOnQuit ? "checked" : ""}> Stop it when HuggingFound quits</label>`}
      <div class="actions"><button class="ghost" id="rent-save-idle">Save</button></div>
    </div>
    ${privateImageHtml(true)}`;
    loadRegistries(panel);
    loadSpend(panel);
    loadOthers(panel);
    panel.querySelector("#rent-stop")?.addEventListener("click", () => rentAction("stop", "Stop the rented GPU? The hourly charge ends; its disk and models stay, and Start brings it back."));
    panel.querySelector("#rent-replace")?.addEventListener("click", replaceMachine);
    panel.querySelector("#rent-replace-stuck")?.addEventListener("click", replaceMachine);
    panel.querySelector("#rent-replace-wait")?.addEventListener("click", replaceMachine);
    panel.querySelector("#rent-stop-retry")?.addEventListener("click", () => {
      stopRetryingStart();
      if (state.rentError) state.rentError.retrying = false;
      renderRental();
    });
    panel.querySelector("#rent-raise-cap")?.addEventListener("click", async () => {
      const cap = (r.maxSpend ?? state.maxSpend ?? 50) + 25;
      try {
        await api.post("/api/settings", { RUNPOD_MAX_SPEND: cap });
        state.maxSpend = cap;
        notice(`The spend cap for today is now ${money(cap)}; the machine stays up.`, "ok");
        state.rental = await api.get("/api/rent");
        renderRental();
      } catch (err) {
        notice(`Could not raise the cap: ${err.message}`, "bad");
      }
    });
    panel.querySelector("#rent-key-focus")?.addEventListener("click", () => {
      const field = $(r.provider === "vast" ? "#vast-key" : "#runpod-key");
      field.scrollIntoView({ block: "center" });
      field.focus();
    });
    panel.querySelector("#rent-replace-old")?.addEventListener("click", replaceMachine);
    panel.querySelector("#rent-start")?.addEventListener("click", () => rentAction("start", null));
    // The machine's own account of itself, here as well as in the panel of
    // what is on the machine: what it runs, holds, has loaded, and how its
    // last failures went, ready to copy.
    panel.querySelector("#rent-report")?.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      let out = panel.querySelector("#rent-report-out");
      let copy = panel.querySelector("#rent-report-copy");
      if (!out) {
        const wrap = document.createElement("div");
        wrap.innerHTML = `<p class="tools-row"><button class="ghost" id="rent-report-copy" hidden>Copy the report</button></p><pre class="log small" id="rent-report-out"></pre>`;
        btn.closest(".rent-card")?.append(wrap);
        out = wrap.querySelector("#rent-report-out");
        copy = wrap.querySelector("#rent-report-copy");
      }
      out.hidden = false;
      out.textContent = "Asking the machine for its report";
      const text = await machineReport(state.rental ?? {});
      out.textContent = text;
      copy.hidden = false;
      copy.textContent = "Copy the report";
      copy.onclick = () => navigator.clipboard?.writeText(text).then(() => (copy.textContent = "Copied"), () => (copy.textContent = "Select the text and copy it"));
    });
    panel.querySelector("#rent-delete")?.addEventListener("click", () => rentAction("delete", "Delete the rented machine and every model on it? Nothing is charged after this; the models can be downloaded again on a new one."));
    panel.querySelector("#rent-save-idle").addEventListener("click", async () => {
      try {
        await api.post("/api/settings", { RUNPOD_IDLE_MINUTES: Number($("#rent-idle").value), RUNPOD_MAX_SPEND: Number($("#rent-cap").value), RUNPOD_PRESENCE_MINUTES: Number($("#rent-presence").value), ...(state.hosted ? {} : { RUNPOD_STOP_ON_QUIT: $("#rent-quit").checked }) });
      } catch (err) {
        alert(err.message);
        return;
      }
      await load();
      notice("Saved.", "ok");
    });
    pollRental();
    return;
  }
  if (!state.runpodKey && !state.vastKey) {
    panel.innerHTML = "";
    return;
  }
  // Nothing rented, yet machines from before may sit on the account billing
  // for their disks: they are looked for whenever the offer is shown.
  if (state.rentOptionsLoading) {
    panel.innerHTML = `<p class="muted small">Asking ${placesText()} what is on offer</p>`;
    return;
  }
  if (!state.rentOptions) {
    const throttled = /stopped answering|rate limiting/.test(state.rentOptionsError ?? "");
    panel.innerHTML = `<p class="muted small">${state.rentOptionsError ? esc(state.rentOptionsError) : `Could not read ${placesText()}'s offer.`}${throttled ? " The sizes appear here by themselves when it answers again." : ""} <button class="ghost" id="rent-retry">Try again</button></p>`;
    panel.querySelector("#rent-retry").addEventListener("click", loadRentOptions);
    return;
  }
  // The row chosen: the one picked before, else one of the size wanted, else the first free one.
  const rows = rentRows();
  const want = (rows.find((r) => r.key === state.rentWantKey && r.available) ?? rows.find((r) => r.gb === state.rentWant && r.available) ?? rows.find((r) => r.available))?.key;
  const vastError = state.vastKey ? state.rentOptions.find((t) => t.vast?.error)?.vast.error : "";
  const checked = state.rentCheckedAt ? new Date(state.rentCheckedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  panel.innerHTML = `<p class="tools-row stock-row"><span class="muted small">${checked ? `Checked at ${checked}.` : ""} Stock changes by the minute.</span><button class="ghost" id="rent-refresh">Check again</button></p>
    ${state.runpodKey ? `<label class="check community" title="RunPod's Community Cloud is machines that third parties host. It is cheaper and often has cards when the Secure Cloud has none; its hosts are less reliable, and your models and Hugging Face token sit on someone else's machine while it runs."><input type="checkbox" id="rent-community" ${state.rentCommunity ? "checked" : ""}> Also rent from RunPod's Community Cloud <small class="muted">third-party hosts: cheaper and more often in stock, less reliable. The Secure Cloud is still used first.</small></label>` : ""}
    ${vastError ? `<p class="notice warn small">Vast.ai's cards are missing from the list: ${esc(vastError)}</p>` : ""}
    <div class="tiers">${rows.map((t) => `<label class="tier ${t.available ? "" : "off"}${t.provider === "vast" ? " vast" : ""}">
      <input type="radio" name="rent-tier" value="${t.key}" ${t.key === want ? "checked" : ""} ${t.available ? "" : "disabled"}>
      <span><b>${t.count > 1 ? `${t.count} × ${t.gb / t.count} GB GPUs` : `${t.gb} GB GPU`}</b> <span class="price">${t.gpu ? `${esc(t.gpu.name)}${t.available ? `, ${money(t.pricePerHour)} an hour${placeTag(t)}` : ", none free right now"}` : t.provider === "vast" ? "none free at Vast.ai right now" : "not on offer right now"}</span>${t.provider === "vast" ? (t.gpu ? `<small>A Vast.ai host${t.gpu.location ? ` in ${esc(t.gpu.location)}` : ""}${t.gpu.downloadPerTb ? `; it charges ${money(t.gpu.downloadPerTb)} a TB for downloads` : ""}.</small>` : "") : `<small>Model files up to about ${t.files} GB: ${esc(t.examples)}.</small>`}${!t.available && (t.gpu || t.provider === "vast") && (t.provider === "runpod" || !state.runpodKey) ? `${t.provider === "runpod" ? `<small class="stock-note">${esc(stockText(t))}</small>` : ""}<span class="tier-watch">${rentWhenFreeHtml(t)}${state.rental?.watch?.gb === t.gb ? "" : watchHtml(t)}</span>` : ""}</span>
    </label>`).join("")}</div>
    <label class="field">
      <span>Disk for its models, in GB</span>
      <input type="number" id="rent-disk" min="10" max="4000" step="10" value="${Number(state.rentDisk ?? 50)}">
      <small class="muted">Models are kept on it between stops, so make it bigger than the models you will keep.${state.runpodKey ? ` At RunPod it can be grown later, when a model does not fit, never shrunk; RunPod charges ${money(DISK_STOPPED_PER_GB_MONTH / 30 * Number(state.rentDisk ?? 50))} a day for ${Number(state.rentDisk ?? 50)} GB while the machine is stopped, half that while it runs.` : ""}${state.vastKey ? " At Vast.ai the disk is fixed when the machine is rented, and each host sets its own price for it, the same running or stopped; the hourly prices shown include 50 GB of it." : ""}</small>
    </label>
    <div class="actions"><button class="primary" id="rent-go" ${want ? "" : "disabled"}>Rent it</button></div>
    <div id="rent-others"></div>
    ${privateImageHtml()}
    <p class="muted small">Ollama on the machine answers at a long random address that RunPod makes for it${state.vastKey ? " (on a Vast.ai machine, a Cloudflare tunnel the machine opens itself)" : ""}; only this computer knows it, and it goes when the machine is deleted. The disk is set up once; the machine itself usually answers two to four minutes after renting${state.vastKey ? ", or ten to twenty at a Vast.ai host fetching the machine image for the first time" : ""}.</p>`;
  loadRegistries(panel);
  panel.querySelector("#rent-refresh").addEventListener("click", (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = "Checking";
    loadRentOptions({ fresh: true, quiet: true });
  });
  wireWatch(panel);
  panel.querySelector("#rent-community")?.addEventListener("change", async (e) => {
    try {
      await api.post("/api/settings", { RUNPOD_COMMUNITY: e.target.checked });
    } catch (err) {
      notice(`Could not save that: ${err.message}`, "bad");
      return;
    }
    loadRentOptions({ fresh: true, quiet: true });
  });
  loadOthers(panel);
  panel.querySelector("#rent-go").addEventListener("click", async () => {
    const offer = rentRow(panel.querySelector('input[name="rent-tier"]:checked')?.value);
    const diskGb = Number($("#rent-disk").value);
    if (!offer?.gpu) return;
    const gb = offer.gb;
    state.rentDisk = diskGb;
    state.rentWantKey = offer.key;
    if (!confirm(`Rent a ${offer.gpu.name}${offer.count > 1 ? ` × ${offer.count}` : ""} (${gb} GB) at ${placeOf(offer)} for ${money(offer.pricePerHour)} an hour, with a ${diskGb} GB disk?\n\n${perQueryText(offer.pricePerHour)}${safeguardText(offer.pricePerHour)}`)) return;
    if (!(await guardOthers())) return;
    const btn = panel.querySelector("#rent-go");
    btn.disabled = true;
    btn.textContent = "Renting";
    try {
      state.rental = await api.post("/api/rent", { gb, diskGb, provider: offer.provider });
    } catch (err) {
      alert(`Could not rent it: ${err.message}`);
      // Stock moved under the list: the sizes are fetched again.
      state.rentOptions = null;
      loadRentOptions({ fresh: true });
      return;
    }
    await load();
    // Renting that started from a model's window goes back to that window:
    // the key entry and the sizes close, and the model plans for the machine.
    const from = state.rentFrom;
    state.rentFrom = null;
    if (from) {
      $("#settings").hidden = true;
      notice(`A ${gb} GB GPU is being rented; ${from.split("/").pop()} now runs on it. It usually answers within a few minutes.`, "ok");
      whereFor.set(from, "rented");
      state.rentAsk = null;
      openModel(from);
      return;
    }
    notice("A GPU is being rented; chat models now point at it. It usually answers within a few minutes.", "ok");
    afterRentalChange();
  });
}

// The open model window follows the machine: once one is rented, the plan
// that asked for it switches to it.
function afterRentalChange() {
  if (!state.open) return;
  if (state.rental?.rented && state.chatServer) {
    whereFor.set(state.open, "rented");
    state.rentAsk = null;
  }
  openModel(state.open);
}

// The private-image choice, shown with or without a machine: it applies to
// the next machine rented.
function privateImageHtml(hasMachine = false) {
  return `<details class="private-image" ${state.registryAuth ? "open" : ""}>
      <summary>Private machine image</summary>
      <p class="muted small">The machine runs HuggingFound's image, a public package of plain software. To pull it from a private package instead, save a registry login in RunPod (Settings, Container registry auth: your GitHub user name and a token with read:packages) and pick it here; it is kept with your other settings and sent to RunPod with each machine${hasMachine ? ", starting with the next one you rent" : ""}.</p>
      <div class="row"><select id="rent-registry"><option value="">Public image (default)</option></select><button class="ghost" id="rent-registry-save">Save</button></div>
      <p class="muted small" id="rent-registry-note"></p>
    </details>`;
}

// The registry logins saved in the RunPod account, offered by name.
async function loadRegistries(panel) {
  const select = panel.querySelector("#rent-registry");
  const note = panel.querySelector("#rent-registry-note");
  if (!select) return;
  try {
    const { registries } = await api.get("/api/rent/registries");
    for (const r of registries) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = `Private, pulled with "${r.name}"`;
      select.appendChild(opt);
    }
    select.value = registries.some((r) => r.id === state.registryAuth) ? state.registryAuth : "";
    note.textContent = state.registryAuth && select.value !== state.registryAuth ? "The saved login is no longer in your RunPod account; pick another or go back to the public image." : registries.length ? "" : "No registry logins in your RunPod account yet.";
  } catch (err) {
    note.textContent = `Could not list the logins: ${err.message}`;
  }
  panel.querySelector("#rent-registry-save").addEventListener("click", async () => {
    try {
      await api.post("/api/settings", { RUNPOD_REGISTRY_AUTH: select.value });
    } catch (err) {
      alert(err.message);
      return;
    }
    notice(select.value ? "Machines are now made from the private image, pulled with that login." : "Machines are made from the public image.", "ok");
    await load();
  });
}

// A stopped machine whose host has no free card: Start is asked again
// every minute for a while, by itself, since a card often frees within
// minutes; the way out meanwhile is a fresh machine of the same size.
const startRetry = { timer: null, tries: 0, until: 0 };
const START_RETRY_MS = 30 * 60e3;
function stopRetryingStart() {
  clearTimeout(startRetry.timer);
  startRetry.timer = null;
  startRetry.until = 0;
}
function retryStartLater() {
  clearTimeout(startRetry.timer);
  if (Date.now() >= startRetry.until) {
    startRetry.timer = null;
    if (state.rentError?.retrying) {
      state.rentError.retrying = false;
      renderRental();
    }
    return;
  }
  startRetry.timer = setTimeout(async () => {
    startRetry.tries++;
    try {
      state.rental = await api.post("/api/rent/start", {});
    } catch (err) {
      if (err.body?.noGpu && Date.now() < startRetry.until) {
        state.rentError = { action: "start", message: err.message, noGpu: true, retrying: true };
        renderRental();
        return retryStartLater();
      }
      state.rentError = { action: "start", message: err.message, noGpu: Boolean(err.body?.noGpu), retrying: false };
      renderRental();
      return;
    }
    stopRetryingStart();
    state.rentError = null;
    await load();
    notice(`The host had a free card again, on try ${startRetry.tries}: the rented GPU is starting, and the hourly charge runs from now.`, "ok");
    if (state.open) openModel(state.open);
  }, 60e3);
}
async function rentAction(action, question) {
  if (question && !confirm(question)) return;
  stopRetryingStart();
  try {
    state.rental = await api.post(`/api/rent/${action}`, {});
  } catch (err) {
    // Said in the panel, not in a browser alert; a stopped machine whose
    // host has no free card gets the way out: a fresh machine of the same size.
    state.rentError = { action, message: err.message, noGpu: Boolean(err.body?.noGpu) };
    if (action === "start" && err.body?.noGpu) {
      startRetry.until = Date.now() + START_RETRY_MS;
      startRetry.tries = 0;
      state.rentError.retrying = true;
      retryStartLater();
    }
    renderRental();
    if ($("#settings").hidden) {
      $("#settings").hidden = false;
      $("#rent").scrollIntoView({ block: "start" });
    }
    return;
  }
  state.rentError = null;
  await load();
  const r = state.rental;
  const words = {
    stop: `Stopped the rented GPU: the hourly charge has ended. Its ${r?.diskGb ? `${r.diskGb} GB ` : ""}disk keeps the models for a small charge a day; Start brings it back, Delete removes it and the models.`,
    start: "Starting the rented GPU; it answers within a minute or two. The hourly charge runs from now.",
    delete: "Deleted the rented machine and its models. Nothing is charged any more. Rent a new one below or from any model's window.",
  }[action];
  if (words) notice(words, "ok");
  afterRentalChange();
}

// What stops the bill if the machine is forgotten, in the words of the
// confirm before renting: the idle time, the spend cap, and what a day
// would cost without them when the price makes that worth saying.
// What one picture or clip of the open model would cost at a price an hour,
// from the preset's guessed time or the time measured here, for the rent
// confirm and the offer: the hourly rate alone says little about a clip.
function perQueryText(pricePerHour) {
  const plan = state.plan;
  const t = plan?.tryWith;
  if (!pricePerHour || !t || !["image", "video"].includes(t.kind) || !plan.qualities?.default) return "";
  const clip = t.kind === "video";
  const seconds = tookSeconds(t.repo, "default") ?? plan.qualities.default.seconds;
  if (!seconds) return "";
  const load = plan.file?.gb > 20 ? ` The first ${clip ? "clip" : "picture"} after a start adds the minutes it takes to load the model (${money((pricePerHour * Math.max(60, plan.file.gb * 3)) / 3600)} or so for ${plan.file.gb.toFixed(0)} GB).` : "";
  return `One ${clip ? "clip" : "picture"} at the Default setting takes about ${shortDuration(seconds)} on such a card, about ${money((pricePerHour * seconds) / 3600)} of machine time; the machine bills while it loads and waits too.${load}\n\n`;
}

// The time a picture or clip of a model took here, by preset, kept in this browser.
function tookSeconds(repo, q) {
  try {
    const n = Number(localStorage.getItem(`took:${repo}|${q}`));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
function rememberTook(repo, q, seconds) {
  try {
    localStorage.setItem(`took:${repo}|${q}`, String(Math.round(seconds)));
  } catch {
    // no storage
  }
}

// How long loading the model took on the machine last time, kept here.
function loadSeconds(repo) {
  try {
    const n = Number(localStorage.getItem(`load:${repo}`));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
}
function rememberLoad(repo, seconds) {
  try {
    localStorage.setItem(`load:${repo}`, String(Math.round(seconds)));
  } catch {
    // no storage
  }
}

// ---- guessing a clip's time, and learning from the clips made ------------------
// The machine makes at most this many frames in one clip.
const MAX_FRAMES = 361;
// The frame count nearest a length in seconds that the model's video VAE
// decodes (its step and offset), within what the machine makes.
function framesFor(seconds, spec) {
  const want = Math.max(spec.minSeconds, Math.min(spec.maxSeconds, Number(seconds) || spec.defaultSeconds)) * spec.fps;
  let n = Math.max(1, Math.round((want - spec.frameAdd) / spec.frameStep));
  while (n > 1 && n * spec.frameStep + spec.frameAdd > MAX_FRAMES) n--;
  return n * spec.frameStep + spec.frameAdd;
}
// The guess: a pixel-step per frame, more for a model too big for one
// card, times what the clips made here before taught (their time against
// the guess made for them).
function clipEstimate(spec, level, seconds, repo) {
  const lv = spec.levels[level] ?? spec.levels.medium;
  const frames = framesFor(seconds, spec);
  const base = 0.5 * ((lv.width * lv.height) / 1e6) * frames * lv.steps * (spec.heavy ?? 1);
  const c = calibration(repo);
  return { frames, level: lv, base, seconds: Math.max(1, Math.round(base * (c?.factor ?? 1))), n: c?.n ?? 0 };
}
function calibration(repo) {
  try {
    const c = JSON.parse(localStorage.getItem(`calib:${repo}`) || "null");
    return c && c.factor > 0 ? c : null;
  } catch {
    return null;
  }
}
// A clip took so long against a guess: the next guess leans on that, half
// on the newest clip and half on what came before.
function noteEstimate(repo, base, took) {
  if (!(base > 0 && took > 0)) return;
  const c = calibration(repo);
  const ratio = took / base;
  const factor = c ? c.factor * 0.5 + ratio * 0.5 : ratio;
  try {
    localStorage.setItem(`calib:${repo}`, JSON.stringify({ factor, n: (c?.n ?? 0) + 1 }));
  } catch {
    // no storage
  }
}

// ---- keeping what was made -------------------------------------------------------
// Everything made on the rented GPU is kept in this browser (IndexedDB, by
// model) until removed, up to a budget, oldest out first. A browser with
// no such storage keeps them for the page's lifetime.
const KEPT_BUDGET = 2 * 1024 ** 3;
const keptMem = new Map();
function keptDb() {
  return new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open("huggingfound-kept", 2);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("results")) {
        const store = db.createObjectStore("results", { keyPath: "id" });
        store.createIndex("model", "model", { unique: false });
      }
      // Pictures picked for queued requests, by the request's id.
      if (!db.objectStoreNames.contains("pictures")) db.createObjectStore("pictures", { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}
function keptOp(mode, run, store = "results") {
  return keptDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let out;
    try {
      out = run(tx.objectStore(store));
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => {
      db.close();
      resolve(out && "result" in out ? out.result : out);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error);
    };
  }));
}
async function keepResult(entry) {
  try {
    await keptOp("readwrite", (s) => s.put(entry));
    await trimKept();
  } catch {
    keptMem.set(entry.id, entry);
  }
}
async function keptResults(model) {
  const mem = [...keptMem.values()].filter((e) => e.model === model);
  try {
    const all = await keptOp("readonly", (s) => s.index("model").getAll(model));
    return [...all, ...mem];
  } catch {
    return mem;
  }
}
async function forgetResult(id) {
  keptMem.delete(id);
  try {
    await keptOp("readwrite", (s) => s.delete(id));
  } catch {
    // nothing kept there
  }
}
async function trimKept() {
  const all = await keptOp("readonly", (s) => s.getAll());
  let total = all.reduce((a, e) => a + (e.bytes || 0), 0);
  if (total <= KEPT_BUDGET) return;
  all.sort((a, b) => a.madeAt - b.madeAt);
  for (const e of all) {
    if (total <= KEPT_BUDGET) break;
    await keptOp("readwrite", (s) => s.delete(e.id));
    total -= e.bytes || 0;
  }
}

// Saving each finished result to the computer as it comes, up to a size.
function autosaveSettings() {
  try {
    const s = JSON.parse(localStorage.getItem("autosave") || "null");
    if (s && typeof s.on === "boolean") return { on: s.on, maxMb: Number(s.maxMb) > 0 ? Number(s.maxMb) : 150 };
  } catch {
    // no storage
  }
  return { on: true, maxMb: 150 };
}
function rememberAutosave(s) {
  try {
    localStorage.setItem("autosave", JSON.stringify(s));
  } catch {
    // no storage
  }
}
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60e3);
}

// Jobs handed to the machine and not yet brought back, kept here so a
// window left or a page reloaded finds them again.
function pendingJobs(repo) {
  try {
    return JSON.parse(localStorage.getItem(`pending:${repo}`) || "[]").filter((p) => p.id && Date.now() - (p.at || 0) < 12 * 3600e3);
  } catch {
    return [];
  }
}
function rememberPending(repo, id, item, at) {
  try {
    const list = pendingJobs(repo).filter((p) => p.id !== id);
    list.push({ id, at, item: item ? { ...item, startFile: undefined, startInit: undefined } : null });
    localStorage.setItem(`pending:${repo}`, JSON.stringify(list));
  } catch {
    // no storage
  }
}
function forgetPending(repo, id) {
  try {
    localStorage.setItem(`pending:${repo}`, JSON.stringify(pendingJobs(repo).filter((p) => p.id !== id)));
  } catch {
    // no storage
  }
}

// The queue under a model, kept in this browser so that leaving the window
// or the page keeps it; a picked file cannot be kept, only its name.
function queueItems(repo) {
  try {
    return JSON.parse(localStorage.getItem(`queue:${repo}`) || "[]").map((item) => ({ ...item, startFile: null, refFiles: [] }));
  } catch {
    return [];
  }
}
function rememberQueue(repo, items) {
  try {
    localStorage.setItem(`queue:${repo}`, JSON.stringify(items.map(({ startFile, refFiles, ...rest }) => ({ ...rest, startName: startFile?.name ?? rest.startName ?? null, refCount: refFiles?.length || rest.refCount || 0 }))));
  } catch {
    // no storage
  }
  // The pictures themselves, in this browser's store, by the request's id.
  for (const it of items) if (it.id && (it.startFile || it.refFiles?.length) && !it.picturesKept) {
    it.picturesKept = true;
    savePictures(it.id, it.startFile ?? null, it.refFiles ?? []).catch(() => (it.picturesKept = false));
  }
}
// Pictures picked for a queued request, kept apart from the request's
// words in the browser's database, so a reload loses none of them.
function savePictures(id, start, refs) {
  const pack = (f) => ({ name: f.name, type: f.type, blob: f });
  return keptOp("readwrite", (s) => s.put({ id, start: start ? pack(start) : null, refs: refs.map(pack) }), "pictures");
}
async function loadPictures(id) {
  const row = await keptOp("readonly", (s) => s.get(id), "pictures");
  if (!row) return null;
  const unpack = (p) => new File([p.blob], p.name, { type: p.type });
  return { start: row.start ? unpack(row.start) : null, refs: (row.refs ?? []).map(unpack) };
}
function forgetPictures(id) {
  return keptOp("readwrite", (s) => s.delete(id), "pictures").catch(() => {});
}

// What a result is, in a line: what it answers, the words asked, what
// Claude expanded them into, and the settings.
function captionText(e) {
  return [e.replyTo ? `In reply to an earlier ${e.kind === "video" ? "clip" : "picture"} ("${e.replyTo.text}")` : "", e.fix ? `${e.fix.scene ? "shot" : "piece"}${e.fix.redo.length === 1 ? "" : "s"} ${listText(e.fix.redo)} made again for it, the rest kept` : "", e.continues ? `Continues an earlier clip ("${e.continues.text}")` : "", e.refs ? `from ${e.refs} reference picture${e.refs === 1 ? "" : "s"}` : "", e.prompt, e.expanded ? `expanded by Claude${e.expandedEdited ? " and edited" : ""}: ${e.expanded}` : "", e.shots ? `a scene of ${e.shots.length} shots laid out by Claude${e.shotsEdited ? " and edited" : ""}: ${e.shots.map((s, i) => `${i + 1} (${Number(s.seconds).toFixed(1)} s) ${s.text}${s.negative ? ` (avoiding ${s.negative})` : ""}`).join(" / ")}` : "", e.settings ?? ""].filter(Boolean).join(" · ");
}

// The settings of a result kept before they were kept with it, read back
// from its caption: "5.1 s at high quality, 1280 by 704, 81 frames, 50
// steps", or a picture preset's name.
function qFromSettings(settings, spec, qualities) {
  const s = String(settings ?? "");
  if (spec) {
    const size = /(\d+) by (\d+)/.exec(s);
    const frames = /(\d+) frames/.exec(s);
    const steps = /(\d+) steps/.exec(s);
    if (!(size && frames && steps)) return null;
    const level = /at (low|medium|high) quality/.exec(s)?.[1];
    return { width: Number(size[1]), height: Number(size[2]), frames: Number(frames[1]), steps: Number(steps[1]), fps: spec.fps, cfg: spec.cfg, ...(spec.levels?.[level]?.expand ? { expand: true } : {}) };
  }
  const name = s.split(",")[0].trim();
  return qualities?.[name] ?? null;
}

// Text from Claude through the site, with the person's own key: the whole
// answer, or a reason why there is none (the site refused, Claude
// declined, the connection failed), for the log to say.
async function claudeText(payload, onText = null, onStatus = null) {
  // With a key saved on the account, that is the key: one typed into the
  // Check an answer panel is for that panel, and a stale one there must not
  // speak for every expansion and suggestion.
  const creds = state.hosted ? (state.claudeHosted?.saved ? {} : hostedCredentials() ?? {}) : {};
  let res;
  try {
    res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify(payload) });
  } catch (err) {
    return { text: "", why: `the site could not be reached (${err.message})` };
  }
  if (!res.ok) return { text: "", why: (await res.json().catch(() => ({}))).error || `the site answered HTTP ${res.status}` };
  let out = "";
  let end = null;
  try {
    await readLines(res, (j) => {
      if (j.error) throw new Error(j.error);
      if (j.text) {
        out += j.text;
        onText?.(out);
      }
      // Where Claude is while nothing is written yet: thinking, and for how long.
      if (j.status) onStatus?.(j);
      if (j.done) end = j;
    });
  } catch (err) {
    return { text: "", why: err.message };
  }
  if (end?.declined) return { text: "", why: end.note || "Claude declined this one" };
  out = out.trim().replace(/^["“]|["”]$/g, "");
  return { text: out, why: out ? "" : "Claude answered with nothing" };
}

// The starting picture of a request as Claude takes it: the file picked,
// or the last frame of the kept clip it continues; nothing when there is
// none, or it is too big for Claude.
async function startingPictureFor(item, repo) {
  try {
    if (item.startFile) {
      if (item.startFile.size > 5 * 1048576) return null;
      return { media_type: item.startFile.type || "image/png", data: (await readAsDataUrl(item.startFile)).split(",")[1] };
    }
    if (item.startFrom) {
      const src = (await keptResults(repo)).find((e) => e.id === item.startFrom);
      if (!src) return null;
      const url = await lastFrameOf(src);
      const data = url.split(",")[1];
      return data && data.length <= 7 * 1048576 ? { media_type: "image/png", data } : null;
    }
  } catch {
    return null;
  }
  return null;
}

// Claude expands a short description into the detailed one these models do
// best with; or says why not, and the words go as they are.
// A scene laid out by Claude as shots, each with a length and a
// description, read from lines of the form "Shot 1 (8 s): ...".
async function sceneShots(prompt, seconds, spec, model, negative, image = null, { pictureUnseen = false } = {}) {
  const got = await claudeText({ kind: "prompt", mode: "scene", clip: true, model, prompt, negative, seconds, minSeconds: spec.minSeconds, maxSeconds: spec.maxSeconds, ...(image ? { image } : {}), ...(pictureUnseen ? { pictureUnseen: true } : {}) });
  if (!got.text) return { shots: [], why: got.why, text: "", note: "" };
  const { shots, note } = parseShots(got.text);
  return { shots, note, text: got.text, why: shots.length ? "" : "Claude wrote no Shot lines" };
}
// The shot lines as written, however they are dressed: "Shot 1 (8 s):",
// "**Shot 2 (7 seconds)** -", "- Shot 3 (15–20 s):" (a running time: the
// span is the length). A last line starting "Note:" is Claude's remark.
function parseShots(text) {
  const shots = [];
  let note = "";
  for (const raw of String(text).split(/\n+/)) {
    const line = raw.replace(/[*_`#]+/g, "").trim();
    const n = line.match(/^note\s*[:\u2013-]\s*(.+)$/i);
    if (n) {
      note = n[1].trim();
      continue;
    }
    const av = line.match(/^(?:[-\u2022]\s*)?avoid(?:\s*\d+)?\s*[:\u2013-]\s*(.+)$/i);
    if (av) {
      if (shots.length) shots.at(-1).negative = avoidWords(av[1]);
      continue;
    }
    const m = line.match(/^(?:[-\u2022]\s*)?(?:\d+[.)]\s*)?shot\s*\d+\s*[(\[]?\s*(?:about\s*|~\s*)?(\d+(?:\.\d+)?)\s*(?:\s*(?:s|sec|secs|seconds?)?\s*[\u2013-]\s*(\d+(?:\.\d+)?))?\s*(?:s|sec|secs|seconds?)?\s*[)\]]?\s*[:.\u2013-]\s*(.+)$/i);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : null;
    shots.push({ seconds: b != null && b > a ? b - a : a, text: m[3].trim(), negative: "" });
  }
  return { shots, note };
}
// An avoid list as written, or nothing: "nothing", "none" and "-" are empty.
function avoidWords(text) {
  const t = String(text ?? "").replace(/[*_`]/g, "").trim().replace(/\.$/, "");
  return /^(nothing|none|n\/a|-|—)$/i.test(t) ? "" : t;
}
// Two avoid lists as one, each phrase once: the request's list for every
// shot, then what the shot itself must keep out.
function joinAvoid(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) for (const raw of String(list ?? "").split(/\s*,\s*/)) {
    const phrase = raw.trim();
    if (!phrase || seen.has(phrase.toLowerCase())) continue;
    seen.add(phrase.toLowerCase());
    out.push(phrase);
  }
  return out.join(", ");
}

// A clip's length in seconds from its settings, for Claude to write only
// as much action as the clip has time for.
const clipSeconds = (q) => (q?.frames && q?.fps ? Math.round((q.frames / q.fps) * 10) / 10 : null);
async function expandWords(prompt, clip, model, negative, image = null, seconds = null, loras = null) {
  const got = await claudeText({ kind: "prompt", mode: "expand", clip, model, prompt, negative, ...(clip && seconds ? { seconds } : {}), ...(image ? { image } : {}), ...(loras?.length ? { loras } : {}) });
  if (got.text && got.text.length <= prompt.length) return { text: "", why: "Claude's description was no longer than yours" };
  return got;
}

// What a machine could and could not hold for a model, learned from its
// clips: the smallest load (frames by canvas) that ran out of memory, and
// the largest that was made. Kept in this browser by model.
function memoryLimit(repo) {
  try {
    const o = JSON.parse(localStorage.getItem(`oom:${repo}`) || "null");
    return o && o.load > 0 ? o : null;
  } catch {
    return null;
  }
}
function rememberMemoryLimit(repo, q, text) {
  const load = (q.frames || 1) * q.width * q.height;
  const known = memoryLimit(repo);
  const next = known && known.load <= load ? known : { load, text };
  try {
    localStorage.setItem(`oom:${repo}`, JSON.stringify(next));
  } catch {
    // no storage
  }
  return next;
}
function fitLoad(repo) {
  try {
    const f = JSON.parse(localStorage.getItem(`fit:${repo}`) || "null");
    return f && f.load > 0 ? f : null;
  } catch {
    return null;
  }
}
function rememberFit(repo, q, text) {
  const load = (q.frames || 1) * q.width * q.height;
  const known = fitLoad(repo);
  if (known && known.load >= load) return;
  try {
    localStorage.setItem(`fit:${repo}`, JSON.stringify({ load, text }));
  } catch {
    // no storage
  }
}

// A clip's last frame as a picture: the one the machine kept with it, or,
// for a clip from before that, read from the clip in this browser.
async function lastFrameOf(entry) {
  if (entry.last) return readAsDataUrl(entry.last);
  if (!entry.blob) throw new Error("the clip is no longer kept here");
  return frameFromClip(entry.blob);
}
function frameFromClip(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const v = document.createElement("video");
    v.muted = true;
    v.playsInline = true;
    v.preload = "auto";
    let settled = false;
    const done = (fn) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      fn();
    };
    v.addEventListener("error", () => done(() => reject(new Error("the clip's last frame could not be read in this browser"))));
    v.addEventListener("loadedmetadata", () => {
      v.currentTime = Math.max(0, (Number.isFinite(v.duration) ? v.duration : 0) - 0.05);
    });
    v.addEventListener("seeked", () => {
      try {
        const c = document.createElement("canvas");
        c.width = v.videoWidth;
        c.height = v.videoHeight;
        c.getContext("2d").drawImage(v, 0, 0);
        done(() => resolve(c.toDataURL("image/png")));
      } catch (err) {
        done(() => reject(new Error(`the clip's last frame could not be read (${err.message})`)));
      }
    });
    setTimeout(() => done(() => reject(new Error("the clip's last frame could not be read in time"))), 20000);
    v.src = url;
  });
}

// The words for the next clip: Claude writes the next shot from the first
// clip's description and what happens next, with a key; otherwise the
// reply itself, less the "ok, now" that leads into it.
async function continueWords(entry, text, model) {
  const local = { prompt: nextWords(text), by: "words" };
  if (!claudeAvailable()) return local;
  const image = await startingPictureFor({ startFrom: entry.id }, entry.model);
  const got = await claudeText({ kind: "prompt", mode: "continue", clip: true, model, prompt: entry.prompt, request: text, ...(clipSeconds(entry.q) ? { seconds: clipSeconds(entry.q) } : {}), ...(image ? { image } : {}) });
  return got.text ? { prompt: got.text, by: "Claude" } : { ...local, why: got.why };
}
function nextWords(text) {
  let s = String(text).trim();
  for (let i = 0; i < 4; i++) s = s.replace(/^(ok|okay|alright|right|good|great|nice|fine|perfect|love it|now|then|next|and|so|after that|afterwards|from there|please|,|\.|:)\s*/i, "");
  return s.replace(/\s+/g, " ").trim() || String(text).trim();
}

// A seed for one request: the same seed with the same words gives the same
// result, and with revised words one close to it.
function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

// The revised description for a reply: Claude writes it, with the picture
// in front of it when there is one, when a key is there; otherwise, or
// when Claude gives nothing usable, it comes from the words of the reply.
async function reviseFor(entry, text, model) {
  const local = reviseWords(entry.prompt, entry.negative, text);
  if (!claudeAvailable()) return local;
  let picture = null;
  try {
    picture = entry.kind !== "video" && entry.blob && entry.blob.size <= 5 * 1048576 ? { media_type: "image/png", data: await blobToBase64(entry.blob) } : null;
  } catch {
    picture = null;
  }
  const got = await claudeText({ kind: "image", mode: "reply", clip: entry.kind === "video", model, request: text, prompt: entry.prompt, negative: entry.negative, ...(entry.kind === "video" && clipSeconds(entry.q) ? { seconds: clipSeconds(entry.q) } : {}), ...(picture ? { image: picture } : {}) });
  if (!got.text) return { ...local, why: got.why };
  const description = /^Description:\s*(.+)$/m.exec(got.text)?.[1]?.trim();
  if (!description) return { ...local, why: "Claude wrote no Description line" };
  const avoid = /^Avoid:\s*(.+)$/m.exec(got.text)?.[1]?.trim() ?? "";
  const keep = Number(/^Keep:\s*(\d+)/m.exec(got.text)?.[1]);
  return { prompt: description, negative: /^(nothing|none|-)\.?$/i.test(avoid) ? entry.negative || "" : avoid, keep: Number.isFinite(keep) ? keep : local.keep, by: "Claude" };
}

// A clip made as pieces and joined, or one of its pieces: a change to it is
// a fix, shot by shot, rather than a remake whole.
function piecedClip(entry) {
  return entry?.kind === "video" && Boolean(entry.piece?.group) && (entry.piece.joined > 1 || entry.piece.of > 1);
}

// Which shots of a pieced clip a reply touches, and their revised words:
// Claude's reading with a key, and the reply's own words otherwise or when
// Claude names no shot. `changes` maps a shot's number to its new words;
// `carry` says whether the shots after the last named go again too.
async function fixPlan(entry, shots, text, model) {
  const local = fixFromWords(shots, entry.negative, text);
  if (!claudeAvailable()) return local;
  const got = await claudeText({ kind: "prompt", mode: "fix", clip: true, model, request: text, prompt: entry.prompt, negative: entry.negative, shots: shots.map((s) => ({ index: s.index, seconds: s.seconds, text: s.text })) });
  if (!got.text) return { ...local, why: got.why };
  const changes = new Map();
  for (const m of got.text.matchAll(/^[^\w\n]*Shot\s+(\d+)\s*(?:\([^)]*\))?\s*[:\-–]\s*(.+)$/gim)) {
    const i = Number(m[1]);
    const words = m[2].replace(/[*_`]/g, "").trim();
    if (i >= 1 && i <= shots.length && words) changes.set(i, words);
  }
  const why = /^[^\w\n]*Why:\s*(.+)$/im.exec(got.text)?.[1]?.replace(/[*_`]/g, "").trim() ?? "";
  // No shot named by Claude: the reply's own words say which, if any.
  if (!changes.size) return { ...local, claude: why || got.text.trim().slice(0, 200) || "no Shot line" };
  return { changes, carry: /^[^\w\n]*Carry:\s*yes/im.test(got.text), why, by: "Claude" };
}

// The shot a reply names, read from its words: "in shot 2", "the second
// shot", "the last one", "at 0:12", "12 seconds in"; its words revised
// from the reply as a single clip's would be.
function fixFromWords(shots, negative, text) {
  const s = ` ${String(text)} `;
  const ordinal = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };
  const picked = new Set();
  for (const m of s.matchAll(/\b(?:shot|piece|part|section|segment)s?\s*(?:number\s*|no\.?\s*|#)?(\d+)\b/gi)) picked.add(Number(m[1]));
  for (const m of s.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|\d+th)\s+(?:shot|piece|part|one|bit|section|segment)\b/gi)) picked.add(ordinal[m[1].toLowerCase()] ?? parseInt(m[1], 10));
  if (/\b(last|final|closing|end)\s+(shot|piece|part|one|bit|section|segment)\b|\b(at|near|towards?) the (end|close)\b/i.test(s)) picked.add(shots.length);
  if (/\b(opening|start|starting|beginning)\s+(shot|piece|part|one|bit|section|segment)\b|\b(at|near) the (start|beginning|opening)\b/i.test(s)) picked.add(1);
  for (const m of s.matchAll(/\b(?:at|around|about|near)\s+(\d+):(\d{2})\b|\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds?)\s+in\b/gi)) {
    const at = m[1] != null ? Number(m[1]) * 60 + Number(m[2]) : Number(m[3]);
    let acc = 0;
    for (const sh of shots) {
      acc += sh.seconds;
      if (at < acc) {
        picked.add(sh.index);
        break;
      }
    }
  }
  const changes = new Map();
  for (const i of [...picked].filter((i) => i >= 1 && i <= shots.length).sort((a, b) => a - b)) changes.set(i, reviseWords(shots[i - 1].text, negative, text).prompt);
  return { changes, carry: false, why: changes.size ? "" : "no shot named in the reply", by: "words" };
}

// Numbers as a person lists them: "2", "2 and 3", "1, 3 and 4".
function listText(nums) {
  const a = nums.map(String);
  return a.length <= 1 ? a.join("") : `${a.slice(0, -1).join(", ")} and ${a.at(-1)}`;
}

// The revised words from the reply alone. Praise and the framing of the
// complaint go; what is asked for joins the description and what is asked
// away joins the avoid list. "looks good but I asked for two jump ropes,
// you only showed one" adds "two jump ropes" to the description. The size
// of the change is read from the words too: how much of the picture to keep.
function reviseWords(prompt, negative, text) {
  let s = ` ${String(text).trim()} `;
  const keep = keepFromWords(s);
  // Everything before a "but" is the praise; the ask follows it.
  const turn = /\b(but|however|except|although|though|apart from that|other than that)\b[,:\s]*/i.exec(s);
  if (turn && turn.index < 140) s = s.slice(turn.index + turn[0].length);
  const adds = [];
  const avoids = [];
  for (let clause of s.split(/[,.;!?\n]+|\b(?:and|also|plus)\b/i)) {
    clause = clause.trim();
    if (!clause) continue;
    // A complaint about what came rather than an ask: "you only showed one", "there is only one".
    if (/^(you|it|there|this|that|the (picture|clip|image|video|photo))\b.*\b(only|just|one|single|none|no|nothing|missing|wrong)\b/i.test(clause) && !/\b(should|needs?|must|want|make|add|more|give|put|show me)\b/i.test(clause)) continue;
    if (/\b(looks?|is|was|came out|turned out)\b.*\b(good|great|nice|fine|lovely|perfect|close|better|right)\b|^(thanks?|thank you|good|great|nice|ok|okay|love it|i like (it|this|that))\b/i.test(clause)) continue;
    let core = clause
      .replace(/^(and |so |please |also |now |then |well )+/i, "")
      .replace(/^(i|we) (don't|do not|didn't|did not) (want|need|like|ask for)( to see| any)?\s*/i, "without ")
      .replace(/^(i|we)('d| would| only| just| really| actually| had)? (asked|ask|wanted|want|said|meant|need|needed|hoped|expected|was hoping|would like|like)( for| to see| to have| to get| it to be| it to have| there to be| you to)?\s*/i, "")
      .replace(/^(can|could|would|will) (you|it|we)( please)? /i, "")
      .replace(/^(please )?(make|turn|have|let|get|give|show|put) (it|them|him|her|me)( be| have| with)? /i, "")
      .replace(/^(please )?(make|turn|have|let|get|give|show|put|add|include|use|try)\s+/i, "")
      .replace(/^(it|they|there|this|that|he|she) (should|needs? to|must|has to|have to|ought to)( be| have| show| include)?\s*/i, "")
      .replace(/^(there should be|i'd like|i would like|i want|with|needs?)\s+/i, "")
      .replace(/^(a bit|a little|a touch|slightly|much|way|far|a lot) /i, "")
      .trim();
    if (!core) continue;
    const away = /^(no|not|without|remove|get rid of|take (away|out|off)|drop|lose|delete|don't|do not|never|less|fewer|minus)\b\s*/i.exec(core);
    if (away) {
      const rest = core.slice(away[0].length).replace(/^(any|the|a|an|all|of|some|that|this) /i, "").trim();
      if (rest) avoids.push(rest);
      continue;
    }
    core = core.replace(/^(instead|rather)( of)?\s*/i, "").replace(/\s+(instead|too|as well|though)$/i, "").replace(/\bplease\b/gi, "").replace(/\s+/g, " ").trim();
    // The size of the change is not part of the picture.
    if (/^((completely|entirely|totally|very|quite|a bit|slightly) )?(different|changed|new|again|better|more)$/i.test(core)) continue;
    if (core) adds.push(core);
  }
  const extra = adds.filter((a) => !prompt.toLowerCase().includes(a.toLowerCase()));
  const avoid = [negative, ...avoids.filter((a) => !(negative || "").toLowerCase().includes(a.toLowerCase()))].filter(Boolean).join(", ");
  return { prompt: extra.length ? `${prompt}, ${extra.join(", ")}` : prompt, negative: avoid, keep, by: "words" };
}
function keepFromWords(s) {
  if (/\b(completely|entirely|totally|instead|different|redo|start over|from scratch|new scene|another|nothing like)\b/i.test(s)) return 35;
  if (/\b(slightly|a (bit|little|touch|tad)|tiny|subtle|lighting|colou?rs?|brighter|darker|warmer|cooler|tone|contrast|sharper)\b/i.test(s)) return 80;
  return 60;
}

// Under a result: a reply, said as to a person, that asks the same model
// for the change. The form folds out of a button, so a card stays small.
function addReply(card, entry, onReply) {
  if (!card || !onReply || !entry || card.querySelector(".reply-wrap")) return;
  const clip = entry.kind === "video";
  const canContinue = clip && Boolean(onReply.canContinue);
  const pieced = piecedClip(entry);
  const words = {
    change: pieced
      ? { hint: "Say what is wrong, as to a person: good, but the orange hat is missing from the second shot on", note: "Only the shots the change touches are made again, with the seeds they had; the rest are kept as they are, and all are joined again. The plan shows here first.", go: "Fix it" }
      : { hint: clip ? "Say what to change, as to a person: good, but the camera should move slower" : "Say what to change, as to a person: good, but I asked for two jump ropes and there is one", note: clip ? "The clip is made again from the revised words with the same seed, so the scene stays close." : "The same model paints over this picture with the change: a fraction of the time of a fresh one.", go: "Ask again" },
    continue: { hint: "Say what happens next, as to a person: now he stands up and leaves the cards on the table", note: "The next clip starts from this one's last frame, so the scene carries on; the two play one after another here.", go: "Continue it" },
  };
  const wrap = document.createElement("div");
  wrap.className = "reply-wrap";
  wrap.innerHTML = `<button class="ghost reply-go">${canContinue ? (pieced ? "Reply: fix a shot or continue it" : "Reply: change or continue it") : pieced ? "Reply: fix a shot" : "Reply with a change"}</button>
    <div class="reply" hidden>
      ${canContinue ? `<div class="row reply-mode"><label><input type="radio" name="reply-mode-${esc(entry.id)}" value="change" checked> ${pieced ? "Fix a shot" : "Change it"}</label><label><input type="radio" name="reply-mode-${esc(entry.id)}" value="continue"> Continue it</label></div>` : ""}
      <textarea class="reply-text" rows="2" placeholder="${words.change.hint}"></textarea>
      <div class="row"><button class="primary reply-run">${words.change.go}</button><span class="muted small reply-note">${words.change.note}</span></div>
      <div class="muted small reply-foot"></div>
    </div>`;
  card.appendChild(wrap);
  const form = wrap.querySelector(".reply");
  const text = wrap.querySelector(".reply-text");
  const foot = wrap.querySelector(".reply-foot");
  const mode = () => wrap.querySelector(".reply-mode input:checked")?.value ?? "change";
  // As it was left, when the window is opened again.
  const keep = onReply.keep?.(entry) ?? null;
  if (keep) {
    form.hidden = !keep.open;
    text.value = keep.text;
    foot.textContent = keep.foot;
    keep.footEl = foot;
    const r = wrap.querySelector(`.reply-mode input[value="${keep.mode}"]`);
    if (r) r.checked = true;
    if (keep.busy) wrap.querySelector(".reply-run").disabled = true;
    text.addEventListener("input", () => (keep.text = text.value));
  }
  for (const r of wrap.querySelectorAll(".reply-mode input")) r.addEventListener("change", () => {
    if (keep) keep.mode = mode();
    text.placeholder = words[mode()].hint;
    wrap.querySelector(".reply-note").textContent = words[mode()].note;
    wrap.querySelector(".reply-run").textContent = words[mode()].go;
  });
  // Shown for the mode the box was left in.
  if (keep) {
    text.placeholder = words[mode()].hint;
    wrap.querySelector(".reply-note").textContent = words[mode()].note;
    wrap.querySelector(".reply-run").textContent = words[mode()].go;
  }
  wrap.querySelector(".reply-go").addEventListener("click", () => {
    form.hidden = !form.hidden;
    if (keep) keep.open = !form.hidden;
    if (!form.hidden) text.focus();
  });
  wrap.querySelector(".reply-run").addEventListener("click", async () => {
    const ask = text.value.trim();
    if (!ask) {
      text.focus();
      return;
    }
    const run = wrap.querySelector(".reply-run");
    run.disabled = true;
    // What the reply says as it goes is kept, and shown in the card of a
    // window opened again meanwhile.
    const sync = () => {
      if (!keep) return;
      keep.foot = foot.textContent;
      if (keep.footEl && keep.footEl !== foot && keep.footEl.isConnected) keep.footEl.textContent = foot.textContent;
    };
    if (keep) keep.busy = true;
    const syncing = keep ? setInterval(sync, 300) : null;
    try {
      await onReply(entry, ask, keep?.footEl?.isConnected ? keep.footEl : foot, mode());
      text.value = "";
      if (keep) keep.text = "";
    } catch (err) {
      foot.textContent = `Could not ask: ${err.message}`;
    } finally {
      run.disabled = false;
      if (keep) {
        clearInterval(syncing);
        sync();
        keep.busy = false;
        const live = keep.footEl?.closest(".reply-wrap")?.querySelector(".reply-run");
        if (live) live.disabled = false;
      }
    }
  });
  onReply.restore?.(entry, foot);
}

function safeguardText(pricePerHour) {
  const idle = state.idleSet ? state.idleMinutes ?? 30 : pricePerHour >= 2 ? 10 : 30;
  const cap = state.maxSpend ?? 50;
  const guards = [`when nobody answers the still-there check this page shows after ${Math.round(state.presenceMinutes ?? 30)} minutes without a click`, idle ? `after ${idle} minutes without a chat, picture or download` : "", cap ? `once today's machines have cost ${money(cap)}` : ""].filter(Boolean);
  const day = pricePerHour >= 3 ? ` Left running, it would cost about ${money(pricePerHour * 24)} a day.` : "";
  return `RunPod bills your account while it runs.${day} It stops by itself ${guards.join(", or ") || "only when you stop it"}${guards.length ? ", whichever comes first" : ""}, and the machine itself stops when the site has not seen it used; you can stop or delete it from the bar at any time. Both limits are in Settings.`;
}

// RunPod's price for a stopped machine's disk, dollars a GB a month.
const DISK_STOPPED_PER_GB_MONTH = 0.2;

// Stops the rented machine after a picture or clip the person ticked the box
// for, and says so in the log; a download still going keeps it up instead.
async function stopAfterJob(say) {
  try {
    if (state.rental?.downloading) {
      say("The machine stays up: a download of yours is still going on it.");
      return;
    }
    state.rental = await api.post("/api/rent/stop", { reason: "done" });
    say("Stopped the rented GPU, as asked: the hourly charge has ended. Start brings it back from the bar.");
    renderRental();
  } catch (err) {
    say(`Could not stop the machine: ${err.message}. Stop it from the bar.`);
  }
}

// Why the machine last stopped by itself, in a sentence, or nothing.
function stopWhy(r) {
  const why = r?.stopReason ?? "";
  if (why.startsWith("idle:")) return `It stopped itself after ${why.slice(5)} idle minutes. `;
  if (why.startsWith("cap:")) return `It stopped itself at the ${money(Number(why.slice(4)))} spend cap for the day. `;
  if (why.startsWith("away:")) return `It was stopped when nobody answered the still-there check${why.slice(5) ? ` after ${why.slice(5)} minutes` : ""}. `;
  if (why === "done") return "It stopped when the download finished, as asked. ";
  return "";
}

// The account's RunPod bill for the week, GPU time apart from disks, so it
// is plain where the money went; RunPod's figures run about an hour behind.
async function loadSpend(panel) {
  const box = panel.querySelector("#rent-spend");
  // The bill is RunPod's; Vast.ai's is on its own site.
  if (!box || !state.runpodKey) return;
  let bill;
  try {
    bill = await api.get("/api/rent/spend");
  } catch {
    return;
  }
  if (!panel.contains(box)) return;
  const line = (label, v) => `<li><span>${esc(label)}</span><span>${money(v.total)}</span><span class="muted">GPU ${money(v.gpu)}, disks ${money(v.disk)}</span></li>`;
  const days = bill.days.slice(0, 7);
  const others = bill.pods.filter((p) => !p.ours && p.total > 0);
  const othersSum = others.reduce((a, p) => a + p.total, 0);
  box.innerHTML = `<details class="spend"><summary>RunPod's bill for this account: ${money(bill.total.total)} in the last ${days.length || 7} day${days.length === 1 ? "" : "s"}, ${money(bill.today.total)} today</summary>
    <ul class="spend-days">${days.map((d) => line(d.day, d)).join("")}</ul>
    <p class="muted small">${others.length ? `${money(othersSum)} of it went to ${others.length} machine${others.length === 1 ? "" : "s"} other than this one (replaced, or from earlier sessions). ` : ""}GPU is the hourly rate while a machine runs, from its creation, image pull included; disks are charged every day, stopped or running. RunPod's figures run about an hour behind; the site's own count for today is ${money(bill.metered)}.</p>
  </details>`;
}

// Machines on the RunPod account that this site no longer manages, each
// still charging for its disk, with one button to be rid of them all.
async function loadOthers(panel) {
  const box = panel.querySelector("#rent-others");
  if (!box) return;
  let others;
  try {
    ({ others } = await api.get("/api/rent/others"));
  } catch {
    return;
  }
  if (!panel.contains(box)) return;
  state.others = others;
  renderRentBar(state.rental);
  if (!others.length) {
    box.innerHTML = "";
    return;
  }
  const perDay = others.reduce((a, o) => a + (o.diskPerDay || 0), 0);
  const running = others.filter((o) => o.running);
  const hourly = running.reduce((a, o) => a + (o.costPerHour || 0), 0);
  const list = others.map((o) => `${o.gpu || "GPU"}${o.gpuCount > 1 ? ` × ${o.gpuCount}` : ""}${o.provider === "vast" ? " at Vast.ai" : ""}, ${o.diskGb} GB disk, ${o.running ? `running at ${money(o.costPerHour || 0)} an hour` : "stopped"} (${o.id})`);
  const atVast = others.some((o) => o.provider === "vast");
  const atRunpod = others.some((o) => o.provider !== "vast");
  const where = atVast && atRunpod ? "RunPod and Vast.ai" : atVast ? "Vast.ai" : "RunPod";
  box.innerHTML = `<div class="notice ${running.length ? "bad" : "warn"}">
    <b>${others.length} other HuggingFound machine${others.length === 1 ? "" : "s"} on ${atVast && atRunpod ? "your RunPod and Vast.ai accounts" : `this ${where} account`}</b>, which this site no longer manages (rented in an earlier session, under a key since removed, or by a guest whose time ran out). ${running.length ? `${running.length} ${running.length === 1 ? "is" : "are"} running, ${money(hourly)} an hour. ` : ""}Their disks cost about ${money(perDay)} a day (${money(perDay * 30)} a month) while they sit stopped. ${others.length === 1 ? "It keeps" : "They keep"} billing until deleted.
    <ul class="small">${list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <button class="primary" id="rent-others-delete">Delete ${others.length === 1 ? "it" : `all ${others.length}`}, disks and models included</button>
  </div>`;
  box.querySelector("#rent-others-delete").addEventListener("click", async () => {
    if (!confirm(`Delete ${others.length === 1 ? "this machine" : `these ${others.length} machines`} at ${where}, with ${others.length === 1 ? "its disk and models" : "their disks and models"}?\n\n${list.join("\n")}\n\nNothing is charged for them after this.`)) return;
    const btn = box.querySelector("#rent-others-delete");
    btn.disabled = true;
    btn.textContent = "Deleting";
    try {
      const { deleted } = await api.post("/api/rent/others/delete", { ids: others.map((o) => o.id) });
      notice(`Deleted ${deleted.length} machine${deleted.length === 1 ? "" : "s"} at ${where}; about ${money(perDay)} a day no longer charged.`, "ok");
      box.innerHTML = "";
      state.others = [];
      renderRentBar(state.rental);
    } catch (err) {
      btn.disabled = false;
      btn.textContent = "Try again";
      notice(`Could not delete: ${err.message}`, "bad");
    }
  });
}

// Deletes the machine, then opens renting with the same size chosen, so
// the old one is gone before the new one is ordered.
async function replaceMachine({ diskGb: biggerDisk = null } = {}) {
  stopRetryingStart();
  const gb = state.rental?.gb;
  const diskGb = Math.max(Number(state.rental?.diskGb) || 0, Number(biggerDisk) || 0) || null;
  const provider = state.rental?.provider;
  if (!confirm(`Delete this machine${state.rental?.status === "RUNNING" ? ", which is running," : ""} and rent a fresh ${gb ? `${gb} GB ` : ""}one${biggerDisk ? ` with a ${diskGb} GB disk` : ""}? Its models download again on the new machine.`)) return;
  try {
    state.rental = await api.post("/api/rent/delete", {});
  } catch (err) {
    state.rentError = { action: "delete", message: err.message };
    renderRental();
    return;
  }
  state.rentError = null;
  state.rentWant = (state.rentTiers ?? []).find((t) => t.gb === gb)?.gb ?? state.rentWant;
  // The same place too: a Vast.ai machine is replaced at Vast.ai when it has one.
  state.rentWantKey = provider === "vast" && gb ? `${gb}:vast` : null;
  // The same disk as the old one, or the bigger one asked for: a smaller default would not hold its models.
  if (diskGb) {
    state.rentDisk = diskGb;
    state.rentDiskWant = Math.max(Number(state.rentDiskWant) || 0, diskGb);
  }
  await load();
  $("#settings").hidden = false;
  renderRental();
  $("#rent").scrollIntoView({ block: "start" });
}

// The bar under the header: a machine is being paid for, and here is how to stop it.
function renderRentBar(r) {
  const bar = $("#rent-bar");
  // A watch that rented a card, or ended, while this page was closed: told
  // once on coming back (the push notification told already, if allowed).
  if (r?.watchResult && r.watchResult.at > watchSeen() && !state.watchTold) {
    state.watchTold = true;
    queueMicrotask(() => announceRented(r.watchResult));
  }
  const others = state.others ?? [];
  if (!r?.rented) {
    // A watch for a sold-out size: what is watched for, and the way to stop it.
    if (r?.watch) {
      const w = r.watch;
      bar.hidden = false;
      bar.innerHTML = `<div class="wrap"><span>Watching ${placesText()} for a ${esc(sizeName(w.gb))}: the site checks every minute, with this page closed too, and rents one at up to ${money(w.maxPricePerHour)} an hour. ${w.lastNote ? esc(w.lastNote[0].toUpperCase() + w.lastNote.slice(1)) + "." : w.checkedAt ? `Last checked ${new Date(w.checkedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}</span><span class="buttons"><button class="ghost" id="bar-unwatch">Stop watching</button></span></div>`;
      bar.querySelector("#bar-unwatch").addEventListener("click", stopRentWatch);
      watchPoll();
      return;
    }
    // This browser's own watch (Tell me when free): shown here on every page
    // too, so it is never out of sight while it runs.
    const pw = rentWatch();
    if (pw) {
      bar.hidden = false;
      bar.innerHTML = `<div class="wrap"><span>Waiting for a ${esc(sizeName(pw.gb))} to be free: checked every minute while this site is open in a tab, and you are told when one is${pw.rent ? ", and it is rented" : ""}.${pw.since ? ` Since ${new Date(pw.since).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.` : ""}</span><span class="buttons"><button class="ghost" id="bar-page-unwatch">Stop waiting</button></span></div>`;
      bar.querySelector("#bar-page-unwatch").addEventListener("click", () => {
        setRentWatch(null);
        renderRental();
        if (state.open) openModel(state.open);
      });
      return;
    }
    // Nothing rented, but machines from before may sit on the account billing for their disks.
    if (!others.length) {
      bar.hidden = true;
      bar.innerHTML = "";
      return;
    }
    const perDay = others.reduce((a, o) => a + (o.diskPerDay || 0), 0);
    const running = others.filter((o) => o.running);
    bar.hidden = false;
    bar.innerHTML = `<div class="wrap"><span>No GPU rented, but ${others.length} other HuggingFound machine${others.length === 1 ? "" : "s"} ${others.length === 1 ? "sits" : "sit"} on your RunPod account${running.length ? `, ${running.length} running at ${money(running.reduce((a, o) => a + (o.costPerHour || 0), 0))} an hour` : ""}, costing about ${money(perDay)} a day for ${others.length === 1 ? "its disk" : "their disks"}.</span><span class="buttons"><button id="bar-others">See and delete them</button></span></div>`;
    bar.querySelector("#bar-others").addEventListener("click", () => {
      $("#settings").hidden = false;
      $("#sec-rent").open = true;
      $("#rent").scrollIntoView({ block: "start" });
    });
    return;
  }
  const [word] = rentalPhase(r);
  const running = ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(r.status);
  const cost = running && r.costPerHour != null ? `, ${money(r.costPerHour)} an hour` : "";
  const time = running && r.uptimeSeconds ? `, running ${minutesText(r.uptimeSeconds)}${r.spent != null ? ` (about ${money(r.spent)})` : ""}` : "";
  bar.hidden = false;
  const held = (r.chatModels ?? 0) + (r.imageModels ?? 0);
  const busy = r.downloading ? `<span class="pill live">${r.downloading} downloading</span>` : "";
  const disk = !running && r.diskPerDay ? `, disk ${money(r.diskPerDay)} a day` : "";
  const extra = others.length ? `<button class="ghost others-note" id="bar-others" title="Machines from before that this site no longer manages, each billing for its disk">${others.length} other machine${others.length === 1 ? "" : "s"} on the account</button>` : "";
  bar.innerHTML = `<div class="wrap"><span>Rented GPU: ${esc(r.gpu || "")}${r.gb ? ` ${r.gb} GB` : ""}${r.cloud === "COMMUNITY" ? " (Community Cloud)" : r.provider === "vast" ? " (Vast.ai)" : ""}, ${esc(word)}${cost}${time}${disk}.${extra}</span><span class="buttons"><button class="ghost" id="bar-models">${held ? `${held} model${held === 1 ? "" : "s"} on it` : "Models on it"}${busy ? ` ${busy}` : ""}</button>${running ? `<button id="bar-stop">Stop</button>` : `<button id="bar-start">Start</button>`}<button class="ghost" id="bar-delete" title="Delete the machine, its disk and its models; nothing is charged after">Delete</button><button class="ghost" id="bar-settings">Manage</button></span></div>`;
  bar.querySelector("#bar-models").addEventListener("click", openGpuModels);
  bar.querySelector("#bar-stop")?.addEventListener("click", () => rentAction("stop", "Stop the rented GPU? The hourly charge ends; its disk and models stay, and Start brings it back."));
  bar.querySelector("#bar-start")?.addEventListener("click", () => rentAction("start", null));
  bar.querySelector("#bar-delete").addEventListener("click", () => rentAction("delete", `Delete the rented machine${running ? ", which is running," : ""} with its ${r.diskGb ? `${r.diskGb} GB ` : ""}disk and every model on it?\n\nNothing is charged after this${r.diskPerDay ? `, not even the ${money(r.diskPerDay)} a day for the disk` : ""}. The models can be downloaded again on a new machine.`));
  bar.querySelector("#bar-others")?.addEventListener("click", () => {
    $("#settings").hidden = false;
    $("#sec-rent").open = true;
    $("#rent").scrollIntoView({ block: "start" });
  });
  bar.querySelector("#bar-settings").addEventListener("click", () => {
    $("#settings").hidden = false;
    $("#sec-rent").open = true;
    $("#rent").scrollIntoView({ block: "start" });
  });
}

// The other HuggingFound machines on the RunPod account, asked for once in
// a while (the server remembers the answer for a few minutes), so the bar
// and the rent panel can say they are there and what they cost.
async function loadOthersState() {
  if (!state.runpodKey) {
    state.others = [];
    return;
  }
  try {
    ({ others: state.others } = await api.get("/api/rent/others"));
  } catch {
    // RunPod not answering: nothing to say
  }
  renderRentBar(state.rental);
}

// One machine at a time on the account. Before renting, any other
// HuggingFound machine there is shown: a running one blocks (the server
// refuses too), stopped ones are offered for deletion first, since each
// bills for its disk and the person is about to pay for a new one.
async function guardOthers() {
  let others;
  try {
    ({ others } = await api.get("/api/rent/others"));
  } catch {
    return true;
  }
  state.others = others;
  if (!others.length) return true;
  const list = others.map((o) => `${o.gpu || "GPU"}${o.gpuCount > 1 ? ` × ${o.gpuCount}` : ""}${o.provider === "vast" ? " at Vast.ai" : ""}, ${o.diskGb} GB disk, ${o.running ? `running at ${money(o.costPerHour || 0)} an hour` : "stopped"} (${o.id})`).join("\n");
  const running = others.filter((o) => o.running);
  const where = others.some((o) => o.provider === "vast") ? (others.some((o) => o.provider !== "vast") ? "RunPod and Vast.ai" : "Vast.ai") : "RunPod";
  if (running.length) {
    alert(`Another HuggingFound machine is already running on your ${where} account:\n\n${list}\n\nOne machine at a time. Stop or delete it under Settings, Rent a GPU, before renting another.`);
    return false;
  }
  const perDay = others.reduce((a, o) => a + (o.diskPerDay || 0), 0);
  if (!confirm(`${others.length} other HuggingFound machine${others.length === 1 ? "" : "s"} from before ${others.length === 1 ? "sits" : "sit"} stopped on your ${where} account, costing about ${money(perDay)} a day for ${others.length === 1 ? "its disk" : "their disks"}:\n\n${list}\n\nDelete ${others.length === 1 ? "it" : "them"} now and rent the new machine? Cancel keeps everything as it is.`)) return false;
  try {
    const { deleted } = await api.post("/api/rent/others/delete", { ids: others.map((o) => o.id) });
    state.others = [];
    notice(`Deleted ${deleted.length} machine${deleted.length === 1 ? "" : "s"} at ${where}.`, "ok");
  } catch (err) {
    alert(`Could not delete them: ${err.message}`);
    return false;
  }
  return true;
}

// ---- the models on the rented machine --------------------------------------------
// One place, reachable from the bar on every view, that lists everything the
// machine holds: chat models and which one is loaded, image models and which
// one is in the GPU, each with Open (its window, planned for the machine)
// and Remove.

function openGpuModels() {
  $("#gpu-models").hidden = false;
  renderGpuModels();
}

async function renderGpuModels() {
  const body = $("#gpu-models-body");
  const sub = $("#gpu-models-sub");
  const r = state.rental;
  if (!r?.rented) {
    sub.textContent = "No GPU is rented.";
    body.innerHTML = "";
    return;
  }
  const [word] = rentalPhase(r);
  sub.textContent = `${r.gpu || "GPU"}${r.gb ? `, ${r.gb} GB` : ""}, ${word}${r.costPerHour != null ? `, ${money(r.costPerHour)} an hour` : ""}.`;
  // The placeholder shows only the first time; a refresh keeps the list in
  // place until the new one is ready, so nothing flickers.
  if (!body.querySelector(".gpu-list, h3")) body.innerHTML = `<p class="muted small">Looking at the machine</p>`;
  let models;
  try {
    models = await api.get("/api/rent/models");
  } catch (err) {
    body.innerHTML = `<p class="muted small">Could not ask the machine: ${esc(err.message)}</p>`;
    return;
  }
  // The machine's own account of itself, to read or to paste when asking
  // for help: what it runs, holds, has loaded, and how its last failures went.
  const reportRow = `<p class="tools-row report-row"><button class="ghost" id="gpu-report">Machine report</button><button class="ghost" id="gpu-report-copy" hidden>Copy the report</button></p><pre class="log small" id="gpu-report-out" hidden></pre>`;
  // One entry per model. The newest download of a model stands for the
  // older tries; while it runs, it stands for the model's own row too,
  // since a folder half-fetched is nothing to open or remove yet, and
  // says what is on the disk so far. A newest try that failed shows on
  // the model's row, with the way on. A download that is done shows as
  // its model alone.
  const newest = new Map();
  for (const run of models.runs ?? []) if (run.model && !newest.has(run.model)) newest.set(run.model, run);
  const runs = (models.runs ?? []).filter((run) => (run.model ? newest.get(run.model) === run && run.status === "running" : run.status !== "done"));
  const coming = new Set(runs.map((run) => run.model).filter(Boolean));
  const failedFor = (m) => {
    const run = newest.get(m.repo ?? m.id ?? "");
    return run && run.status === "failed" ? run : null;
  };
  const onDisk = new Map();
  for (const m of [...(models.images ?? []), ...(models.chat ?? [])]) if (coming.has(m.repo ?? m.id) && m.gb) onDisk.set(m.repo ?? m.id, (onDisk.get(m.repo ?? m.id) ?? 0) + m.gb);
  const listed = (list) => (list ?? []).filter((m) => !coming.has(m.repo ?? m.id));
  const row = (m, kind) => {
    // A folder model is named by its model; its index file is a detail.
    const title = kind === "chat" ? m.name : m.file === "model_index.json" ? `${(m.repo ?? m.id ?? "").split("/").pop() || m.file} (folder model)` : `${m.file}`;
    const live = kind === "chat" ? m.running : m.loaded;
    const failed = failedFor(m);
    return `<li data-kind="${kind}" data-id="${esc(m.id ?? "")}" data-name="${esc(m.name ?? "")}" data-repo="${esc(m.repo ?? "")}" data-file="${esc(m.file ?? "")}">
      <div><div class="name">${esc(title)}</div><div class="sub">${m.id ? `<span>${esc(m.id)}</span>` : ""}<span>${m.gb ? `${m.gb} GB` : ""}</span>${live ? `<span class="pill live">${kind === "chat" ? "loaded, answering" : "loaded in the GPU"}</span>` : ""}${failed ? `<span class="pill bad">last download failed</span><span>${esc(failed.last)}</span>` : ""}</div></div>
      <div class="buttons">${m.id ? `<button class="primary" data-open>Open</button>` : ""}<button class="ghost" data-remove>Remove</button></div>
    </li>`;
  };
  const chatList = listed(models.chat);
  const imageList = listed(models.images);
  const chat = models.chatOk ? (chatList.length ? `<ul class="gpu-list">${chatList.map((m) => row(m, "chat")).join("")}</ul>` : `<p class="muted small">No chat models on it yet. Open a chat model and download it there.</p>`) : `<p class="muted small">Ollama on the machine is not answering${r.status === "EXITED" ? "; the machine is stopped" : " yet"}.</p>`;
  const images = !r.images ? `<p class="muted small">This machine runs chat models only; a machine rented now runs image models too.</p>` : r.imageProblem ? `<p class="muted small">The image server on this machine cannot start (${esc(r.imageProblem)}). This is a fault in the machine image, not in your setup; a machine rented after it is fixed will work.</p>` : models.imagesOk ? (imageList.length ? `<ul class="gpu-list">${imageList.map((m) => row(m, "image")).join("")}</ul>` : `<p class="muted small">No image models on it yet${coming.size ? " besides the one coming" : ""}. Open an image model and download it there.</p>`) : `<p class="muted small">The image agent on the machine is not answering${r.status === "EXITED" ? "; the machine is stopped" : " yet"}.</p>`;
  const runRow = (run) => {
    const name = run.model ? run.model.split("/").pop() : run.title || run.first;
    const pill = run.status === "running" ? `<span class="pill live">downloading</span>` : run.status === "done" ? `<span class="pill good">done</span>` : `<span class="pill bad">failed</span>`;
    const pct = /(\d{1,3})% of/.exec(run.last ?? "");
    const mini = run.status === "running" ? `<div class="progress small ${pct ? "" : "guess"}"><div class="fill" style="width:${pct ? pct[1] : 10}%"></div></div>` : "";
    const sofar = onDisk.has(run.model) ? `<span>${onDisk.get(run.model).toFixed(1)} GB of it on the disk so far</span>` : "";
    return `<li data-model="${esc(run.model ?? "")}">
      <div><div class="name">${esc(name)}</div><div class="sub"><span>${esc(run.title || run.first)}</span>${run.last && run.last !== run.first ? `<span>${esc(run.last)}</span>` : ""}${sofar}${pill}</div>${mini}</div>
      <div class="buttons">${run.model ? `<button class="primary" data-open-run>Open</button>` : ""}</div>
    </li>`;
  };
  const downloads = runs.length ? `<h3>Downloads</h3><ul class="gpu-list" id="gpu-runs">${runs.map(runRow).join("")}</ul>` : "";
  body.innerHTML = `${downloads}<h3>Chat models</h3>${chat}<h3>Image models</h3>${images}<p class="muted small">Models stay on the machine's disk while it is stopped and go when it is deleted. Each download onto it, and each conversation or picture, counts as use for the idle timer.</p><div class="actions"><button class="ghost" id="gpu-models-refresh">Refresh</button></div>` + reportRow;
  body.querySelector("#gpu-report")?.addEventListener("click", async () => {
    const out = body.querySelector("#gpu-report-out");
    const copy = body.querySelector("#gpu-report-copy");
    out.hidden = false;
    out.textContent = "Asking the machine for its report";
    const text = await machineReport(r);
    out.textContent = text;
    copy.hidden = false;
    copy.onclick = () => navigator.clipboard?.writeText(text).then(() => (copy.textContent = "Copied"), () => (copy.textContent = "Select the text and copy it"));
  });
  body.querySelector("#gpu-models-refresh").addEventListener("click", renderGpuModels);
  for (const li of body.querySelectorAll("#gpu-runs li")) {
    li.querySelector("[data-open-run]")?.addEventListener("click", () => {
      whereFor.set(li.dataset.model, "rented");
      state.rentAsk = null;
      $("#gpu-models").hidden = true;
      openModel(li.dataset.model);
    });
  }
  // While something downloads, the list refreshes itself.
  clearTimeout(state.gpuRunsTimer);
  if (runs.some((run) => run.status === "running") && !$("#gpu-models").hidden) state.gpuRunsTimer = setTimeout(() => (!$("#gpu-models").hidden ? renderGpuModels() : null), 3000);
  for (const li of body.querySelectorAll("li[data-kind]")) {
    li.querySelector("[data-open]")?.addEventListener("click", () => {
      whereFor.set(li.dataset.id, "rented");
      state.rentAsk = null;
      $("#gpu-models").hidden = true;
      openModel(li.dataset.id);
    });
    li.querySelector("[data-remove]").addEventListener("click", async () => {
      const what = li.dataset.kind === "chat" ? li.dataset.name : li.dataset.file;
      if (!confirm(`Remove ${what} from the rented GPU? It frees the machine's disk; the model can be downloaded again any time.`)) return;
      try {
        await api.post("/api/remove", li.dataset.kind === "chat" ? { kind: "ollama", name: li.dataset.name } : { kind: "gpu-file", repo: li.dataset.repo, file: li.dataset.file });
      } catch (err) {
        alert(err.message);
        return;
      }
      renderGpuModels();
      if (state.open) openModel(state.open);
    });
  }
}

$("#close-gpu-models").addEventListener("click", () => ($("#gpu-models").hidden = true));
$("#gpu-models").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});

// While a machine exists its status is refreshed: often while it starts,
// once a minute after that for the running time and the cost.
// One timer, ever: each call replaces the pending one, so however often the
// panel is redrawn there is one poll in flight. (Two timers once doubled
// each tick until RunPod throttled the key.)
// How often the page asks about the machine: often while it starts, every
// minute while it runs, every five while it is stopped, and not at all in a
// hidden tab or after an hour without a touch (unless a download is going):
// every ask spends the RunPod account's daily allowance.
function pollRental() {
  clearTimeout(state.rentPoll);
  state.rentPoll = null;
  state.rentPollPaused = false;
  if (!state.rental?.rented) return;
  const untouched = Date.now() - (state.lastTouch ?? Date.now());
  if (document.hidden || (untouched > 3600e3 && !state.rental.downloading)) {
    state.rentPollPaused = true;
    return;
  }
  const stopped = ["EXITED", "TERMINATED", "ERROR"].includes(state.rental.status);
  state.rentPoll = setTimeout(rentalTick, stopped ? 300000 : machineUp(state.rental) ? 60000 : 12000);
}

state.lastTouch = Date.now();
for (const ev of ["pointerdown", "keydown"]) {
  document.addEventListener(ev, () => {
    state.lastTouch = Date.now();
    if (state.rentPollPaused) rentalTick();
  }, { passive: true });
}

// ---- the still-there check ---------------------------------------------------------
// A machine costs money whether or not anyone is at the page. After some
// minutes without a click or key while one runs, the page asks; with no
// answer in a short countdown it stops the machine. The disk and its
// models stay, and Start brings it back. The minutes are a setting; the
// default is short. Never in the middle of a picture, clip or answer the
// page itself is waiting on: watching the log is being there.
const presence = { shown: false, deadline: 0, timer: null };
const PRESENCE_CHECK_MS = 5000;
function presenceMs() {
  return (state.presenceMinutes ?? 30) * 60e3;
}
function machineBilling() {
  const r = state.rental;
  return Boolean(r?.rented) && ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(r.status);
}
function presenceTick() {
  if (presence.shown) {
    presenceCountdown();
    return;
  }
  if (!machineBilling()) return;
  // A machine rented by a watch while the person was away is held for them
  // to come back to: nobody is asked whether they are there until then.
  if ((state.rental?.holdUntil ?? 0) > Date.now()) return;
  if (state.agentBusy || state.chatBusy) {
    state.lastTouch = Date.now();
    return;
  }
  if (Date.now() - state.lastTouch < presenceMs()) return;
  const r = state.rental;
  // A short countdown, shorter still when the setting itself is short.
  const grace = Math.min(120e3, Math.max(3e3, presenceMs() / 2));
  presence.shown = true;
  presence.deadline = Date.now() + grace;
  $("#presence-text").textContent = `Nothing has been clicked or typed here for ${Math.round(presenceMs() / 60e3) || "a few"} minute${Math.round(presenceMs() / 60e3) === 1 ? "" : "s"} while the rented GPU${r.costPerHour != null ? ` (${money(r.costPerHour)} an hour)` : ""} runs. Unless you answer, it stops when the count reaches zero; its models stay on its disk and Start brings it back. Change the minutes in Settings.`;
  $("#presence").hidden = false;
  presenceCountdown();
}
function presenceCountdown() {
  const left = Math.max(0, presence.deadline - Date.now());
  $("#presence-left").textContent = `${Math.floor(left / 60e3)}:${String(Math.ceil((left % 60e3) / 1000) % 60).padStart(2, "0")}`;
  if (left > 0) return;
  presenceDismiss();
  stopForAbsence();
}
function presenceDismiss() {
  presence.shown = false;
  $("#presence").hidden = true;
}
async function stopForAbsence() {
  if (!machineBilling()) return;
  const minutes = Math.round(presenceMs() / 60e3);
  try {
    state.rental = await api.post("/api/rent/stop", { reason: "away", minutes });
  } catch (err) {
    // At work on a request, from this window or another: it stays up, and
    // the check starts over from now.
    if (err.body?.busy) {
      state.lastTouch = Date.now();
      notice("The rented GPU is working on a request, so it stays up; the still-there check comes again once it is idle.", "ok");
      return;
    }
    notice(`Could not stop the rented GPU: ${err.message}. The machine's own idle watch and the spend cap still apply.`, "bad");
    return;
  }
  await load();
  notice(`The rented GPU was stopped after ${minutes} minute${minutes === 1 ? "" : "s"} without anyone here. Its models are kept; Start brings it back from the bar.`, "ok");
  if (state.open) openModel(state.open);
}
$("#presence-yes").addEventListener("click", () => {
  state.lastTouch = Date.now();
  presenceDismiss();
});
$("#presence-stop").addEventListener("click", () => {
  presenceDismiss();
  stopForAbsence();
});
// The countdown runs on the clock, not on ticks, so a background tab's
// slowed timers still end it; the check itself is cheap.
setInterval(presenceTick, PRESENCE_CHECK_MS);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && presence.shown) presenceCountdown();
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.rentPollPaused) rentalTick();
});

async function rentalTick() {
  state.rentPoll = null;
  if (!state.rental?.rented) return;
  const wasReady = state.rental.ready;
  const wasUp = machineUp(state.rental);
  try {
    state.rental = await api.get("/api/rent");
  } catch {
    // the next tick tries again
  }
  // Redrawing schedules the next poll; nothing else does.
  renderRental();
  if (!wasReady && state.rental?.ready) notice("The rented GPU is ready. Chat models are downloaded to it and run there.", "ok");
  // The window follows once Ollama answers, and again once the agent does
  // (a picture or video model waits for the agent, which can come a little
  // later): a window on "starting" never outlives the machine's start.
  if (((!wasReady && state.rental?.ready) || (!wasUp && machineUp(state.rental))) && state.open && !state.agentBusy) openModel(state.open);
}

async function renderImageServerStatus() {
  const el = $("#image-server-status");
  if (!state.imageServer) {
    el.textContent = "Pictures are made on this computer.";
    return;
  }
  el.textContent = `Checking ${state.imageServer}`;
  try {
    const r = await api.get("/api/image-server");
    el.textContent = r.ok ? `Connected. The server has ${r.model} loaded; pictures will be made there.` : `Saved, but the server did not answer (${r.error}). Pictures will fail until it is reachable.`;
  } catch (err) {
    el.textContent = `Could not check the server: ${err.message}`;
  }
}

for (const [field, key, save, clear] of [["#github-token", "GITHUB_TOKEN", "#save-github", "#clear-github"], ["#youtube-key", "YOUTUBE_API_KEY", "#save-youtube", "#clear-youtube"], ["#claude-key", "ANTHROPIC_API_KEY", "#save-claude", "#clear-claude"], ["#runpod-key", "RUNPOD_API_KEY", "#save-runpod", "#clear-runpod"], ["#vast-key", "VAST_API_KEY", "#save-vast", "#clear-vast"], ["#civitai-key", "CIVITAI_TOKEN", "#save-civitai", "#clear-civitai"]]) {
  $(save).addEventListener("click", async () => {
    const value = $(field).value.trim();
    // A visitor's key makes them a guest on the hosted site.
    const asGuest = state.hosted && !state.user;
    if (asGuest && !value) return;
    try {
      await api.post(asGuest ? "/api/guest" : "/api/settings", { [key]: value });
    } catch (err) {
      alert(err.message);
      return;
    }
    $(field).value = "";
    if (key === "RUNPOD_API_KEY" || key === "VAST_API_KEY") state.rentOptions = null;
    await load();
  });
  $(clear).addEventListener("click", async () => {
    // Without the key a running machine cannot be stopped from here.
    // The key of the place the machine is rented at.
    const rentedHere = state.rental?.rented && (key === (state.rental.provider === "vast" ? "VAST_API_KEY" : "RUNPOD_API_KEY"));
    if (rentedHere && ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(state.rental.status)) {
      if (!confirm("A machine is rented with this key. Without the key this site cannot stop or delete it. Stop the machine first, then remove the key?")) return;
      try {
        state.rental = await api.post("/api/rent/stop", {});
      } catch (err) {
        alert(`Could not stop the machine: ${err.message}. The key was kept.`);
        return;
      }
    }
    if (!(state.hosted && !state.user)) await api.post("/api/settings", { [key]: "" });
    if (key === "RUNPOD_API_KEY" || key === "VAST_API_KEY") state.rentOptions = null;
    await load();
  });
}

$("#save-reddit").addEventListener("click", async () => {
  const value = $("#reddit-app").value.trim();
  try {
    await api.post("/api/settings", { REDDIT_CLIENT_ID: value });
  } catch (err) {
    alert(err.message);
    return;
  }
  $("#reddit-app").value = "";
  await load();
});
$("#clear-reddit").addEventListener("click", async () => {
  await api.post("/api/settings", { REDDIT_CLIENT_ID: "" });
  await load();
});

$("#save-image-server").addEventListener("click", async () => {
  const value = $("#image-server").value.trim();
  try {
    await api.post("/api/settings", { IMAGE_SERVER: value });
  } catch (err) {
    alert(err.message);
    return;
  }
  await load();
  if (state.open) openModel(state.open);
});
$("#clear-image-server").addEventListener("click", async () => {
  await api.post("/api/settings", { IMAGE_SERVER: "" });
  await load();
  if (state.open) openModel(state.open);
});

$("#clear-token").addEventListener("click", async () => {
  await api.post("/api/settings", { HF_TOKEN: "" });
  await load();
});

setMode("home");
load().catch((err) => notice(`HuggingFound could not start: ${err.message}`, "bad"));
