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
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ---- boot --------------------------------------------------------------------

async function load() {
  const s = await api.get("/api/state");
  Object.assign(state, { machine: s.machine, categories: s.categories, runners: s.runners, picks: s.picks, hosted: Boolean(s.hosted), refresh: s.refresh, user: s.user, auth: s.auth });
  document.body.dataset.hosted = s.hosted ? "1" : "";
  state.claudeHosted = s.claudeHosted;
  if (s.hosted) renderHostedCopy();
  if (s.hosted && !state.openChecker) setupChecker();
  renderAccount();
  renderDiskLine();
  if (s.hosted) {
    $("#env-note").textContent = s.user?.guest ? "Kept with your guest keys on this site, until they expire." : "Kept with your account on this site.";
    $("#runpod-key").nextElementSibling.textContent = "Make an account at runpod.io and add some credit, then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. It is kept encrypted with your keys here and sent only to RunPod.";
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
  $("#chat-server").value = s.chatServer?.url ?? "";
  $("#chat-server-gb").value = s.chatServer?.gpuGb ?? "";
  renderChatServerStatus();
  // Models hidden by this person: the saved list plus this browser's own.
  state.hidden = new Set([...(s.hidden ?? []), ...localHidden()]);
  renderHiddenList();
  state.rental = s.rental;
  state.rentTiers = s.rentTiers ?? [];
  state.runpodKey = s.runpodKey;
  state.registryAuth = s.registryAuth || "";
  state.stopOnQuit = s.stopOnQuit;
  $("#runpod-status").textContent = s.runpodKey ? `A key is saved (${s.runpodKey}).` : state.hosted ? "No key saved; renting is off." : "No key saved; renting is off. The chat server above can still be set by hand.";
  renderRental();
  if (s.runpodKey && !state.rentOptions) loadRentOptions();
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
  $("#home-lead").textContent = "Say it in plain words. HuggingFound searches Hugging Face and what people say about each model, then runs the one you pick on your computer or on a GPU rented by the hour.";
  $("#browse .intro h1").textContent = "Open models, on your computer or on a rented GPU.";
  $("#browse .intro .lead").textContent = `Scanned from Hugging Face every ${state.refresh?.hours ?? 12} hours, with what people say summed up on each card. Fit and speed are for a typical 16 GB laptop, or for your rented GPU once you have one.`;
  $("#only-runnable-text").textContent = "Only models that run with Ollama, whisper.cpp or stable-diffusion.cpp";
  $(".speed-note").textContent = "Speed lines are rough guesses for a typical laptop without a separate GPU, from the model's size. A GPU or Apple Silicon is several times faster, and the first run is slower while things load.";
}

function renderScanStatus() {
  const el = $("#scan-status");
  if (state.hosted) {
    el.textContent = state.scanAt ? `Catalogue scanned ${relative(state.scanAt)}: ${state.models.length} models. It refreshes every ${state.refresh?.hours ?? 12} hours.` : "The catalogue is being scanned for the first time; check back in a few minutes.";
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

function notice(text, kind = "info") {
  const el = $("#notice");
  el.hidden = !text;
  el.textContent = text;
  el.className = `notice ${kind}`;
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
    state.found = { q, models: result.models, web: result, hubError: result.hubError, gathered: result.gathered, scanned: result.scanned, took: result.took, hiddenRefusing: result.hiddenRefusing, hideRefusing: result.hideRefusing };
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
  $("#nav-home").classList.toggle("on", mode !== "browse");
  $("#nav-browse").classList.toggle("on", mode === "browse");
}
$("#nav-home").addEventListener("click", () => setMode(state.found ? "results" : "home"));
$("#nav-browse").addEventListener("click", () => {
  setMode("browse");
  render();
});

function renderHomeHint() {
  const v = state.voices;
  const parts = [];
  if (!state.scanAt && !state.hosted) parts.push("No scan yet, so results come from Hugging Face's own search and the curated picks.");
  if (!v?.count && !state.hosted) parts.push("Gather what people say (in Browse) to rank by reviews.");
  $("#home-hint").textContent = parts.join(" ");
  $("#home-hint").hidden = !parts.length;
}

function renderVoicesStatus() {
  const v = state.voices;
  $("#get-summarizer").hidden = Boolean(state.summarizer) || !state.runners?.ollama?.installed;
  const writer = state.summarizer ? `${state.summarizer} writes the lines.` : "No chat model is installed in Ollama, so the lines are lifted from the comments rather than written.";
  $("#voices-status").textContent = v?.count
    ? `Gathered for ${v.count} model${v.count === 1 ? "" : "s"} (last ${relative(v.at)}). Cards carry a summary; the search box also finds models by what people say. ${writer}`
    : `Reads each scanned model's card and community discussions and sums them up in a line or two on every card. ${writer}`;
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

  // Search results keep the server's relevance order; only the runnable
  // filter and the person's own hide list apply to them.
  const found = state.found ? state.found.models.filter((m) => shown(m) && (!onlyRunnable || m.runner?.easy)) : [];
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
  $("#civitai-note").textContent = web.civitaiError ? `Civitai did not answer: ${web.civitaiError}` : web.civitai.length ? "Image models on Civitai matching these words, with their thumbs up and comment counts. Many are mirrored on Hugging Face; a chip opens the copy from the scan, or search the Hub for the name." : "Nothing on Civitai for these words.";
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
  $("#github-note").textContent = note("GitHub", web.github, web.githubError, true, "Issues and pull requests on llama.cpp, Ollama, stable-diffusion.cpp, whisper.cpp, SillyTavern, ComfyUI and related projects. A chip opens a model from the scan that the thread names.", "No GitHub issues mention these words.");
  $("#github-found").innerHTML = postList(web.github, (p) => `${p.repo}, ${p.kind}, ${p.state}, ${fmt(p.comments)} comments`);
  $("#hn-note").textContent = note("Hacker News", web.hn, web.hnError, true, "Stories and comments on Hacker News.", "Nothing on Hacker News for these words.");
  $("#hn-found").innerHTML = postList(web.hn, (p) => `${p.kind}, ${fmt(p.points)} points, ${fmt(p.comments)} comments`);
  $("#lemmy-note").textContent = note("Lemmy", web.lemmy, web.lemmyError, true, "Posts from Lemmy communities such as localllama, fosai and stable_diffusion.", "No Lemmy posts for these words.");
  $("#lemmy-found").innerHTML = postList(web.lemmy, (p) => `${p.community}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  $("#youtube-note").textContent = note("YouTube", web.youtube, web.youtubeError, web.youtubeConfigured, "Videos about these words; the title tells whether it is a review or a demonstration.", "No videos for these words.", "YouTube needs a free API key in Settings before videos can be searched.");
  $("#youtube-found").innerHTML = postList(web.youtube, (v) => `${v.channel}${v.views != null ? `, ${fmt(v.views)} views` : ""}`);
  $("#reddit-note").textContent = note("Reddit", web.reddit, web.redditError, web.redditConfigured, "Posts from r/LocalLLaMA, r/StableDiffusion, r/SillyTavernAI and related communities. A chip opens a model from the scan that the post names.", "No Reddit posts for these words in the past year.", "Reddit needs a free app id in Settings before it can be searched.");
  $("#reddit-found").innerHTML = postList(web.reddit, (p) => `r/${p.subreddit}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  const count = ["civitai", "reddit", "github", "hn", "lemmy", "youtube"].reduce((t, k) => t + (web[k]?.length ?? 0), 0);
  $("#web-found-summary").textContent = `Also mentioned elsewhere: ${count} item${count === 1 ? "" : "s"} on Civitai, GitHub, Hacker News, Lemmy, YouTube and Reddit${web.took != null ? ` (${(web.took / 1000).toFixed(1)} s)` : ""}`;
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
  if ((runner === "ollama" && state.chatServer) || (runner === "sd" && state.chatServer?.agent)) {
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
    ${p.speed ? `<div class="speed">${esc(p.speed)}</div>` : ""}
    <div class="meta"><span class="pill makes">${esc(makes.text)}</span><span class="pill ${f.level}">${esc(f.text)}</span>${p.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}${state.hidden.has(p.id) ? '<span class="pill hidden-by">Hidden by you</span>' : ""}</div>
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
  if (/video/.test(pipeline)) kind = "video";
  else if (cats.includes("images") || cats.includes("nsfw-images") || runner === "sd" || /^(text-to-image|image-to-image|image-editing|inpainting|unconditional-image-generation)$/.test(pipeline)) kind = "images";
  else if (cats.includes("speech") || runner === "whisper" || pipeline === "automatic-speech-recognition") kind = "speech";
  else if (pipeline === "text-to-speech" || pipeline === "text-to-audio") kind = "audio";
  else if (cats.includes("vision") || pipeline === "image-text-to-text") kind = "vision";
  else if (runner === "ollama" || pipeline === "text-generation" || cats.some((c) => ["chat", "coding", "math", "nsfw-writing"].includes(c))) kind = "text";
  else kind = "other";
  const text = { video: "Makes video", images: "Makes images", speech: "Transcribes speech", audio: "Makes sound", vision: "Text, understands images", text: "Text only, no pictures", other: pipeline ? pipeline.replace(/-/g, " ") : "Other" }[kind];
  return { kind, text, fits: (want) => (want === "images" ? kind === "images" : want === "video" ? kind === "video" : true) };
}

// What a search is after, when its words say so.
function wantsFrom(q) {
  if (/\b(videos?|animations?|animate|clips?|film|movie)\b/i.test(q)) return "video";
  if (/\b(images?|pictures?|photos?|photographs?|art|artwork|draw|drawing|illustrations?|anime|wallpapers?|renders?|paintings?|portraits?|logos?|sketch)\b/i.test(q)) return "images";
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
    ${m.speed ? `<div class="speed">${esc(m.speed)}</div>` : ""}
    <div class="meta">
      ${makesTag}
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

function lineHtml(line) {
  const m = /^(Users|Author):\s*(.*)$/.exec(line);
  if (!m) return `<div class="line"><b>Users</b><span>${esc(line)}</span></div>`;
  return `<div class="line ${m[1] === "Author" ? "author" : ""}"><b>${m[1] === "Author" ? "Author" : "Users"}</b><span>${esc(m[2])}</span></div>`;
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

  if (!plan.runnable) {
    parts.push(`<div class="notice ${plan.gated ? "info" : "warn"}">${esc(plan.reason)}${plan.link ? ` <a href="${esc(plan.link)}" target="_blank" rel="noopener">${plan.gated ? "Open the model page" : "Search for a GGUF version"}</a>` : ""}</div>`);
    if (plan.gated && state.hosted) parts.push(`<p class="muted small">On your computer, HuggingFound's Settings take a Hugging Face read token, and this plan unlocks there.</p>`);
    else if (plan.gated) parts.push(`<div class="actions"><button class="ghost" id="open-settings-from-model">Add a token in Settings</button></div>`);
    body.innerHTML = parts.join("");
    body.querySelector("#open-settings-from-model")?.addEventListener("click", () => ($("#settings").hidden = false));
    return;
  }

  // A chat model runs here or on a rented GPU; the two buttons switch the
  // plan, and asking for a GPU without one leads to renting it.
  if (choice) parts.push(whereHtml(choice));
  if (choice && state.rentAsk === model.id && choice.where === "local") {
    parts.push(rentAskHtml(choice, plan));
  }
  // The facts in one row: what it makes, the file, the fit, the speed.
  const onMachine = plan.remote && (plan.runner === "ollama" || plan.tryWith?.agent);
  parts.push(`<div class="facts">
    <span class="pill makes">${esc(makesOf(model).text)}</span>
    <span class="pill ${plan.fit.level}">${esc(plan.fit.text)}</span>
    <span class="fact" title="${esc(plan.file.folder ? `${plan.file.parts.length} parts, merged into one file` : plan.file.name)}">${plan.file.folder ? `${plan.file.parts.length} files` : esc(plan.file.name)}${plan.file.gb ? `, ${plan.file.gb.toFixed(1)} GB` : ""}</span>
    <span class="fact">${plan.measured ? esc(plan.measured) : esc(plan.speed?.text ?? "")}</span>
  </div>
  ${onMachine ? `<p class="muted small">Runs on your rented GPU; your browser talks to the machine directly and nothing passes through ${state.hosted ? "this site" : "the app"}.</p>` : plan.measured ? "" : `<p class="muted small">${state.hosted ? "Speed is a guess for a typical laptop without a separate GPU." : "Speed is a guess for this computer until a real run measures it."}</p>`}`);
  if (plan.fit.level === "no") parts.push(`<div class="notice warn">${state.hosted ? "Larger than a typical laptop has to spare." : "Larger than this computer has to spare; it may load slowly or not at all."}${choice && !choice.rented ? " A rented GPU holds it: pick On a rented GPU above." : choice ? " Pick On a rented GPU above." : ""}</div>`);
  const onSite = state.hosted && !plan.remote;
  if (onSite) parts.push(`<h3>How to run it</h3>`);
  parts.push(`<ol class="steps" id="steps">${plan.steps.map((s, i) => stepHtml(s, i)).join("")}</ol>`);
  if (onSite) parts.push(`<div class="get-app hosted-only"><b>HuggingFound on your computer</b> does these steps with one click and opens a try box here. Needs Node 20 or newer.<code>git clone https://github.com/hungateJoseph/huggingfound.git
cd huggingfound
npm install
npm start</code></div>`);
  if (!onSite) parts.push(`<div class="try" id="try"></div>`);
  parts.push(`<div class="voices" id="voices"><h3>What people say</h3><p class="muted small">Reading the model card and the community discussions</p></div>`);
  body.innerHTML = parts.join("");
  loadVoices(model).catch((err) => {
    const box = $("#voices");
    if (box) box.innerHTML = `<h3>What people say</h3><p class="muted small">Could not read the discussions: ${esc(err.message)}</p>`;
  });

  for (const btn of body.querySelectorAll(".go")) {
    btn.addEventListener("click", () => runStep(model, plan, Number(btn.dataset.index)));
  }
  for (const btn of body.querySelectorAll("[data-where]")) btn.addEventListener("click", () => chooseWhere(model.id, btn.dataset.where));
  wireRentAsk(body, model, choice);
  renderTry(model, plan);
}

// ---- where a chat model runs -------------------------------------------------

function whereHtml(choice) {
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
  const back = `<button class="ghost" data-where="local">Run it on my computer instead</button>`;
  const size = choice.tier ? `This ${plan.file?.gb ? `${plan.file.gb.toFixed(1)} GB ` : ""}file wants a ${choice.tier} GB card.` : "This file is bigger than any card on offer.";
  // A machine that exists but is stopped (it stops itself when idle) is
  // started again, not replaced.
  const r = state.rental;
  if (r?.rented) {
    const [word] = rentalPhase(r);
    const fits = !choice.tier || !r.gb || r.gb >= choice.tier;
    if (r.status === "EXITED" || r.status === "ERROR") {
      return `<div class="rent-ask"><p><b>Your rented GPU (${esc(r.gpu || "GPU")}${r.gb ? `, ${r.gb} GB` : ""}) is stopped.</b> It stopped itself after sitting idle; its models are still on its disk. Starting it takes a minute or two.${fits ? "" : ` ${esc(size)} It may be tight on this card.`}</p><div class="actions"><button class="primary" id="ask-start">Start it</button>${back}</div></div>`;
    }
    return `<div class="rent-ask"><p><b>Your rented GPU is ${esc(word)}.</b> This window switches to it as soon as it answers.</p><div class="actions">${back}</div></div>`;
  }
  if (state.hosted && !state.user) {
    const hours = state.auth?.guestHours ?? 12;
    return `<div class="rent-ask">
      <p><b>Renting a GPU takes a RunPod API key.</b> ${esc(size)} RunPod rents GPUs by the hour; with your key this site starts a machine for you, runs the model on it and stops it when you are done. You can enter the key as a guest: it and the machine are kept for ${hours} hours after your last use, then the machine is stopped and the key forgotten.${state.auth?.google ? " Sign in with Google to keep them for good." : ""}</p>
      <div class="actions"><button class="primary" id="ask-yes">Enter a key as a guest</button>${state.auth?.google ? `<button class="ghost" id="ask-signin">Sign in with Google</button>` : ""}<button class="ghost" id="ask-no">I have no key yet</button>${back}</div>
      <div id="ask-yes-box" hidden>
        <label class="field"><span>RunPod API key</span><input type="password" id="ask-key" autocomplete="off" placeholder="rpa_..."><small class="muted">Kept encrypted on this site for ${hours} hours after your last use and sent only to RunPod. Nothing you say to the model passes through this site.</small></label>
        <div class="actions"><button class="primary" id="ask-save">Save and pick a size</button></div>
      </div>
      <div id="ask-no-box" hidden>
        <p class="muted small">It takes about two minutes: make an account at <a href="https://www.runpod.io" target="_blank" rel="noopener">runpod.io</a>, add some credit (ten dollars goes a long way), then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. Come back and click "Enter a key as a guest". A 24 GB card costs about half a dollar an hour and a 48 GB one under a dollar.</p>
      </div>
    </div>`;
  }
  if (choice.hasRunpodKey) {
    const offer = (state.rentOptions ?? []).find((t) => t.gb === choice.tier);
    const price = offer?.pricePerHour != null ? ` The cheapest free one is ${esc(offer.gpu.name)} at ${money(offer.pricePerHour)} an hour.` : "";
    return `<div class="rent-ask"><p><b>No GPU is rented right now.</b> ${esc(size)}${price}</p><div class="actions">${choice.tier ? `<button class="primary" id="ask-rent">Rent a ${choice.tier} GB GPU</button>` : ""}${back}</div></div>`;
  }
  return `<div class="rent-ask">
    <p><b>Do you have a RunPod API key?</b> RunPod rents GPUs by the hour; with a key HuggingFound starts a machine for you, runs the model on it and stops it when you are done. ${esc(size)}</p>
    <div class="actions"><button class="primary" id="ask-yes">Yes, I have one</button><button class="ghost" id="ask-no">No, not yet</button>${back}</div>
    <div id="ask-yes-box" hidden>
      <label class="field"><span>RunPod API key</span><input type="password" id="ask-key" autocomplete="off" placeholder="rpa_..."><small class="muted">Kept ${state.hosted ? "with your account, encrypted" : "in the settings file on this computer"} and sent only to RunPod.</small></label>
      <div class="actions"><button class="primary" id="ask-save">Save and pick a size</button></div>
    </div>
    <div id="ask-no-box" hidden>
      <p class="muted small">It takes about two minutes: make an account at <a href="https://www.runpod.io" target="_blank" rel="noopener">runpod.io</a>, add some credit (ten dollars goes a long way), then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. Come back and click "Yes, I have one". A 24 GB card costs about half a dollar an hour and a 48 GB one under a dollar.</p>
    </div>
  </div>`;
}

function wireRentAsk(body, model, choice) {
  body.querySelector("#ask-signin")?.addEventListener("click", openSignIn);
  body.querySelector("#ask-start")?.addEventListener("click", () => rentAction("start", null));
  body.querySelector("#ask-rent")?.addEventListener("click", () => {
    state.rentWant = choice.tier;
    $("#settings").hidden = false;
    renderRental();
    $("#rent").scrollIntoView({ block: "start" });
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
    if (!value) return;
    const asGuest = state.hosted && !state.user;
    try {
      await api.post(asGuest ? "/api/guest" : "/api/settings", { RUNPOD_API_KEY: value });
    } catch (err) {
      alert(err.message);
      return;
    }
    state.rentOptions = null;
    state.rentWant = choice.tier;
    await load();
    if (state.open) openModel(state.open);
    $("#settings").hidden = false;
    renderRental();
    $("#rent").scrollIntoView({ block: "start" });
    notice(asGuest ? `The key is saved for ${state.auth?.guestHours ?? 12} hours after your last use. Pick a size and the machine starts.` : "The RunPod key is saved. Pick a size and the machine starts.", "ok");
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
  const lines = v.summary?.long ?? [];
  const first = lines.slice(0, 3);
  const rest = lines.slice(3);
  const summary = lines.length ? `<div class="said">${first.map(lineHtml).join("")}${rest.length ? `<details class="more-said"><summary>${rest.length} more</summary>${rest.map(lineHtml).join("")}</details>` : ""}</div>` : `<p class="muted small">Nothing said about this model yet.</p>`;
  box.innerHTML = `<h3>What people say</h3>${summary}<details><summary>Sources on Hugging Face</summary>${card}${threads}<p class="muted small">From the community tab on Hugging Face; these are other users' words, not a review.</p></details><details open><summary>Elsewhere</summary><div class="web" id="voices-web"><p class="muted small">Looking on Civitai, GitHub, Hacker News, Lemmy, YouTube and Reddit</p></div></details>`;
  const isImage = state.plan?.runner === "sd" || (model.categories ?? []).includes("images");
  const web = await api.get(`/api/voices/web?id=${encodeURIComponent(model.id)}${isImage ? "&images=1" : ""}`);
  const webBox = $("#voices-web");
  if (!webBox || state.open !== model.id) return;
  const civ = web.civitai.length
    ? `<h4>On Civitai</h4><p class="muted small">Pages whose name matches this model; merges and re-uploads share names, so check the link.</p>` + web.civitai.map((c) => `<div class="civ"><div class="name"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>${c.nsfw ? ' <span class="pill adult">18+</span>' : ""}</div><div class="stats">${fmt(c.thumbsUp)} thumbs up, ${fmt(c.thumbsDown)} down, ${fmt(c.comments)} comments, ${fmt(c.downloads)} downloads${c.creator ? `, by ${esc(c.creator)}` : ""}</div>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ""}</div>`).join("")
    : web.civitaiError ? `<p class="muted small">Civitai did not answer: ${esc(web.civitaiError)}</p>` : isImage ? `<p class="muted small">No matching page on Civitai.</p>` : "";
  const prompts = web.civitaiPrompts?.length
    ? `<h4>What people make with it on Civitai</h4><p class="muted small">The most liked pictures posted under the matching page, with the prompts their makers used.</p><ul class="posts">${web.civitaiPrompts.slice(0, 6).map((i) => `<li><a href="${esc(i.url)}" target="_blank" rel="noopener">${esc(i.prompt)}</a><div class="who">${fmt(i.reactions)} reactions, ${fmt(i.comments)} comments${i.user ? `, by ${esc(i.user)}` : ""}${i.nsfw ? ", 18+" : ""}</div></li>`).join("")}</ul>`
    : "";
  const section = (title, items, err, configured, who, setup) => configured === false
    ? `<p class="muted small">${esc(setup)}</p>`
    : err ? `<p class="muted small">${esc(title)} did not answer: ${esc(err)}</p>`
    : items.length ? `<h4>On ${esc(title)}</h4><ul class="posts">${items.slice(0, 8).map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="who">${esc(who(p))}</div>${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted small">Nothing on ${esc(title)} names this model.</p>`;
  const gh = section("GitHub", web.github ?? [], web.githubError, true, (p) => `${p.repo}, ${p.kind}, ${p.state}, ${fmt(p.comments)} comments`);
  const hn = section("Hacker News", web.hn ?? [], web.hnError, true, (p) => `${p.kind}, ${fmt(p.points)} points, ${fmt(p.comments)} comments`);
  const lem = section("Lemmy", web.lemmy ?? [], web.lemmyError, true, (p) => `${p.community}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`);
  const yt = section("YouTube", web.youtube ?? [], web.youtubeError, web.youtubeConfigured, (v) => `${v.channel}${v.views != null ? `, ${fmt(v.views)} views` : ""}`, "YouTube videos need a free API key in Settings.");
  const red = section("Reddit", web.reddit ?? [], web.redditError, web.redditConfigured, (p) => `r/${p.subreddit}, ${fmt(p.score)} points, ${fmt(p.comments)} comments`, "Reddit posts need a free app id in Settings.");
  webBox.innerHTML = civ + prompts + gh + hn + lem + yt + red + (web.took != null ? `<p class="muted small">Outside sources answered in ${(web.took / 1000).toFixed(1)} s${web.cached ? "" : "; kept for a week"}.</p>` : `<p class="muted small">From the copy kept this week.</p>`);
}

function stepHtml(s, i) {
  return `<li class="step ${s.done ? "done" : ""}" data-index="${i}">
    <span class="num">${s.done ? "✓" : i + 1}</span>
    <div>
      <div class="title">${esc(s.title)}</div>
      <div class="text">${esc(s.text)}</div>
      ${s.command ? `<code>${esc(s.command)}</code>` : ""}
    </div>
    ${state.hosted && !state.plan?.remote ? "" : `<button class="go ${s.done ? "ghost" : "primary"}" data-index="${i}" ${s.done ? "disabled" : ""}>${s.done ? "Done" : "Run this step"}</button>`}
  </li>`;
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

  btn.disabled = true;
  btn.textContent = "Running";
  li.classList.add("running");
  let log = li.querySelector(".log");
  if (!log) {
    log = document.createElement("pre");
    log.className = "log";
    li.appendChild(log);
  }
  log.textContent = "";

  try {
    const { id } = await api.post("/api/run", { kind: step.kind, args: step.args ?? {}, where: state.choice?.where ?? (plan.remote ? "rented" : "local") });
    const result = await follow(id, (line) => {
      log.textContent += line + "\n";
      log.scrollTop = log.scrollHeight;
    });
    li.classList.remove("running");
    if (result.status === "done") {
      step.done = true;
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
        renderTry(model, plan);
      }
    } else {
      li.classList.add("failed");
      btn.disabled = false;
      btn.textContent = "Try again";
    }
  } catch (err) {
    li.classList.remove("running");
    li.classList.add("failed");
    log.textContent += `Could not start: ${err.message}\n`;
    btn.disabled = false;
    btn.textContent = "Try again";
  }
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
  const ready = plan.steps.every((s) => s.done);
  if (!ready) {
    const left = plan.steps.filter((s) => !s.done).length;
    box.innerHTML = `<p class="muted small">${left === plan.steps.length ? "Run the steps above and a try box appears here." : `${left} step${left === 1 ? "" : "s"} left before you can try it.`}</p>`;
    return;
  }
  if (plan.tryWith.kind === "chat") renderChat(box, plan.tryWith.model);
  if (plan.tryWith.kind === "image") renderImage(box, plan.tryWith);
  if (plan.tryWith.kind === "transcribe") renderTranscribe(box, plan.tryWith);
  renderRemove(box, model, plan);
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
          if (j.error) throw new Error(j.error);
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
    chats.set(modelName, chat);
  }
  return chat;
}
function saveChat(modelName, chat) {
  try {
    localStorage.setItem(`chat:${modelName}`, JSON.stringify(chat.messages.filter((m) => m.role !== "system").slice(-200)));
  } catch {
    // no storage
  }
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
  quick: { label: "Quick", hint: "no thinking, short answer", think: false, options: { num_predict: 400 } },
  standard: { label: "Standard", hint: "the model's defaults" },
  thorough: { label: "Thorough", hint: "thinks first, checks its work; slower and better", think: true, system: "Take your time. Think the problem through step by step, consider what could go wrong, and check your work before you answer. Be thorough and precise." },
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
    <div class="chat">
      <div class="chat-tools"><span class="muted small">${chat.messages.length ? "The conversation is kept in this browser until you start a new one." : `Ask anything; the answer comes from ${esc(modelName)} on ${state.plan?.remote ? "the rented GPU" : "this computer"}.`}</span><span class="tools-row"><button class="ghost" id="chat-download" ${chat.messages.length ? "" : "hidden"}>Download</button><button class="ghost" id="chat-clear">New chat</button></span></div>
      <div class="messages" id="messages"></div>
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
    if (m.role === "assistant") checkFor(el, m);
  }
  if (chat.busy) {
    const out = addMsg("assistant", chat.reply ?? "");
    out.id = "chat-live";
    if (!chat.reply) out.classList.add("pending");
  }
  list.scrollTop = list.scrollHeight;
  const messages = chat.messages;
  const mine = () => $("#try")?.dataset.model === modelName;
  const paint = (text, pending = false) => {
    const el = $("#chat-live");
    if (!el) return;
    const stick = nearBottom(el.parentElement);
    el.textContent = text;
    // Empty while the model thinks: the bubble keeps saying so.
    el.classList.toggle("pending", pending || !text);
    if (stick) el.parentElement.scrollTop = el.parentElement.scrollHeight;
  };
  const send = async () => {
    if (chat.busy) return;
    const text = $("#chat-text").value.trim();
    if (!text) return;
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
    const system = $("#chat-system").value.trim();
    try {
      localStorage.setItem(`system:${modelName}`, system);
    } catch {
      // no storage
    }
    if (system && messages[0]?.role !== "system") messages.unshift({ role: "system", content: system });
    else if (system) messages[0].content = system;
    else if (messages[0]?.role === "system") messages.shift();
    messages.push({ role: "user", content: text });
    saveChat(modelName, chat);
    addMsg("user", text);
    $("#chat-download").hidden = false;
    const out = addMsg("assistant", "");
    out.id = "chat-live";
    out.classList.add("pending");
    chat.busy = true;
    chat.reply = "";
    $("#chat-send").disabled = true;
    let reply = "";
    try {
      // The effort shapes this one request: a care instruction joins the
      // system message, thinking is turned on or off, the length capped.
      const effort = CHAT_EFFORTS[chosenEffort(box, "chat")] ?? CHAT_EFFORTS.standard;
      const sent = messages.map(({ role, content }) => ({ role, content }));
      if (effort.system) {
        if (sent[0]?.role === "system") sent[0] = { role: "system", content: `${sent[0].content}\n\n${effort.system}` };
        else sent.unshift({ role: "system", content: effort.system });
      }
      const body = { model: modelName, messages: sent };
      if (typeof effort.think === "boolean") body.think = effort.think;
      if (effort.options) body.options = effort.options;
      let res = await chatRequest(body);
      // A model without a thinking pass refuses the knob; ask again without it.
      if (!res.ok && "think" in body) {
        const why = await res.text().catch(() => "");
        if (/think/i.test(why)) {
          delete body.think;
          res = await chatRequest(body);
        }
      }
      if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}. Is it running and is the model downloaded?`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          const j = JSON.parse(line);
          if (j.error) throw new Error(j.error);
          reply += j.message?.content ?? "";
          chat.reply = reply;
          paint(reply);
        }
      }
      const said = { role: "assistant", content: reply };
      messages.push(said);
      saveChat(modelName, chat);
      const live = $("#chat-live");
      if (live && mine() && reply.trim()) {
        const stick = nearBottom(live.parentElement);
        // The finished answer shows its pictures; while it streamed it was plain text.
        renderRich(live, reply);
        checkFor(live, said);
        if (stick) live.parentElement.scrollTop = live.parentElement.scrollHeight;
      }
    } catch (err) {
      paint(`${reply}${reply ? "\n\n" : ""}Something went wrong: ${err.message}`);
      if (reply) {
        messages.push({ role: "assistant", content: reply });
        saveChat(modelName, chat);
      }
    } finally {
      chat.busy = false;
      chat.reply = null;
      $("#chat-live")?.removeAttribute("id");
      if (mine()) $("#chat-send").disabled = false;
    }
  };
  wireEffort(box, "chat");
  $("#chat-send").addEventListener("click", send);
  $("#chat-download").addEventListener("click", () => {
    const lines = [`# ${modelName}`, ""];
    for (const m of chat.messages) {
      if (m.role === "system") lines.push(`_Instructions: ${m.content}_`, "");
      else lines.push(`**${m.role === "user" ? "You" : m.chain?.length ? chainText(modelName, m.chain) : modelName}:**`, "", m.content, "");
    }
    saveText(`${modelName.replace(/[^\w.-]+/g, "-")}-conversation.md`, lines.join("\n"));
  });
  $("#chat-clear").addEventListener("click", () => {
    if (chat.busy) return;
    chat.messages.length = 0;
    saveChat(modelName, chat);
    renderChat(box, modelName);
    renderRemove(box, state.model, state.plan);
  });
  $("#chat-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
}

// On the hosted site the browser talks to the rented GPU itself, so what is
// said to the model never passes through the site; on a computer the app's
// own server relays to Ollama.
function chatRequest(body) {
  const direct = state.hosted && state.chatServer?.direct && state.chatServer.url;
  // The site is told only that the machine is in use, so it is not stopped as idle mid-conversation.
  if (direct) api.post("/api/rent/touch", {}).catch(() => {});
  return fetch(direct ? `${state.chatServer.url}/api/chat` : "/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }) });
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
function addImprove(anchor, { kind, current, context, check = null, onUse = null, onImage = null }) {
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
  if (check?.saved) {
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
    } finally {
      run.disabled = false;
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
  const what = fast ? `${info.steps} steps` : q === "default" ? `${info.steps} steps, the standard settings` : q === "fast" ? `${info.steps} steps, sharper sampler` : `${info.steps} steps, for the most detail`;
  return `<b>${names[q]}</b> <span class="muted">${what}${info.seconds ? `, about ${esc(shortDuration(info.seconds))}` : ""}</span>`;
}

function shortDuration(seconds) {
  if (seconds < 60) return `${Math.round(seconds)} s`;
  return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0).replace(/\.0$/, "")} min`;
}

function renderImage(box, t) {
  const plan = state.plan;
  let saved = "default";
  try {
    saved = localStorage.getItem("imageQuality") || "default";
  } catch {
    // no storage
  }
  const qualities = plan?.qualities ?? {};
  const options = Object.entries(qualities).map(([q, info]) => `<label><input type="radio" name="quality" value="${q}" ${q === saved ? "checked" : ""}> ${qualityLabel(q, info, plan.fast)}</label>`).join("");
  const remote = t.remote ? `<div class="notice info">Pictures are made by the image server at ${esc(t.remote)} with the model it has loaded. Change this in Settings.</div>` : "";
  const loaded = plan?.keepsLoaded && !t.remote && !t.agent ? `<p class="muted small loaded-note"><span>After the first picture the model stays loaded in memory for a quarter of an hour, so the next ones skip the loading time.</span><button class="ghost" id="unload-model">Unload now</button></p>` : "";
  const style = plan?.style ? `<p class="muted small style-note"><b>${plan.style.kind === "anime" ? "Anime model." : "Realistic model."}</b> ${esc(plan.style.text)}</p>` : "";
  box.innerHTML = `<h3>Try it</h3>
    ${remote}
    ${style}
    <div class="effort-title">Effort</div>
    <div class="quality" id="quality">${options}</div>
    <div class="prompt-input">
      <textarea id="image-prompt" rows="2" placeholder="Describe a picture, for example: a lighthouse at dusk, oil painting"></textarea>
      <button class="primary" id="image-go">Generate</button>
    </div>
    <label class="field avoid">
      <span>Avoid</span>
      <input type="text" id="image-negative" placeholder="anime, cartoon, drawing, blurry, extra fingers">
      <small class="muted">Models cannot read "not" or "no" in the description; whatever you do not want goes here instead.</small>
    </label>
    ${loaded}
    <pre class="log" id="image-log" hidden></pre>
    <div id="image-out"></div>`;
  box.querySelector("#unload-model")?.addEventListener("click", async () => {
    await api.post("/api/unload", {});
    notice("The image model was unloaded from memory.", "ok");
  });
  $("#image-go").addEventListener("click", async () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    const log = $("#image-log");
    log.hidden = false;
    log.textContent = "";
    $("#image-go").disabled = true;
    try {
      const quality = box.querySelector("input[name=quality]:checked")?.value ?? "default";
      try {
        localStorage.setItem("imageQuality", quality);
      } catch {
        // no storage
      }
      const negative = $("#image-negative").value.trim();
      if (t.agent) {
        // The rented GPU makes the picture; the browser asks it directly and
        // keeps the result, which is saved only when downloaded.
        const image = await agentPicture(t.agent, { repo: t.repo, file: t.file, prompt, negative, quality: plan?.qualities?.[quality] }, (line) => {
          log.textContent += line + "\n";
          log.scrollTop = log.scrollHeight;
        });
        $("#image-out").innerHTML = "";
        showPicture($("#image-out"), { data: image, prompt, negative, model: t.repo, madeBy: t.file, agent: t.agent, repo: t.repo, modelFile: t.file, chain: [] });
        return;
      }
      const { id } = await api.post("/api/run", { kind: "generate-image", args: { repo: t.repo, file: t.file, prompt, negative, quality } });
      const result = await follow(id, (line) => {
        log.textContent += line + "\n";
        log.scrollTop = log.scrollHeight;
      });
      if (result.status === "done" && result.result) {
        $("#image-out").innerHTML = "";
        showPicture($("#image-out"), { file: result.result, prompt, negative, model: t.repo, madeBy: t.file, chain: [] });
      }
    } catch (err) {
      log.textContent += `Could not start: ${err.message}\n`;
    } finally {
      $("#image-go").disabled = false;
    }
  });
}

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
async function agentPicture(agent, { repo, file, prompt, negative, quality, init = null, strength = null }, onLine = () => {}) {
  api.post("/api/rent/touch", {}).catch(() => {});
  const q = quality ?? { steps: 20, size: 512, cfg: 7, sampler: "euler_a", scheduler: "discrete" };
  const body = { repo, file, prompt, negative, steps: q.steps, width: q.size, height: q.size, cfg: q.cfg, sampler: q.sampler, scheduler: q.scheduler };
  if (init) {
    body.init = init;
    body.strength = strength ?? 0.55;
  }
  onLine(`Asking the rented GPU for a ${q.size} by ${q.size} picture, ${q.steps} steps${init ? ", painting over the picture" : ""}`);
  const res = await fetch(`${agent}/jobs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `the machine answered HTTP ${res.status}`);
  const { id } = await res.json();
  let last = "";
  const started = Date.now();
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(`${agent}/jobs/${id}`);
    if (!poll.ok) throw new Error(`lost the machine while waiting (HTTP ${poll.status})`);
    const job = await poll.json();
    const word = { loading: "Loading the model into the GPU (the first picture with a model takes longer)", queued: "Waiting for the GPU", generating: "Generating" }[job.status];
    if (word && word !== last) {
      onLine(word);
      last = word;
    }
    if (job.status === "completed") {
      onLine(`Done in ${Math.round((Date.now() - started) / 1000)} s.`);
      return job.image;
    }
    if (job.status === "failed") throw new Error(job.error || "the machine could not make the picture");
    if (Date.now() - started > 30 * 60e3) throw new Error("no picture after 30 minutes");
  }
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

async function hideModel(id) {
  state.hidden.add(id);
  await saveHidden();
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
  await hideModel(id);
  $("#modal").hidden = true;
  state.open = null;
  notice(`${id.split("/").pop()} is hidden from search and Browse. Settings lists hidden models, with a way to bring one back.`, "ok");
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
// A click beside the model window used to close it; now only Close and
// Escape do, so a stray click does not take a conversation away.
$("#settings").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});
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
  await api.post("/api/settings", { HF_TOKEN: token });
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
  $("#open-settings").hidden = !user;
  // The paste-in checker is for visitors with nothing running here; with a
  // machine, every answer has its own Improve or check.
  $("#open-checker").hidden = Boolean(user);
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

function openSignIn() {
  $("#signin").hidden = false;
  $("#signin-error").textContent = "";
  mountGoogle();
}

// Google's own button, drawn by its script, which is loaded only when the
// sign-in window opens. Picking an account hands over an ID token; the
// server checks it and starts the session.
function mountGoogle() {
  const host = $("#google-button");
  if (!state.auth?.google) {
    host.innerHTML = `<p class="muted small">Sign-in is not set up on this site yet; the owner has to add a Google client id.</p>`;
    return;
  }
  const ready = () => {
    if (!window.google?.accounts?.id) return;
    window.google.accounts.id.initialize({ client_id: state.auth.google, callback: onGoogleCredential });
    host.innerHTML = "";
    window.google.accounts.id.renderButton(host, { theme: "outline", size: "large", width: 300, text: "continue_with" });
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
    return;
  }
  $("#signin").hidden = true;
  await load();
  notice("Signed in. Your keys and your rented GPU are kept with your account; what you say to models is not.", "ok");
  if (state.open) openModel(state.open);
}

$("#sign-in").addEventListener("click", openSignIn);
$("#close-signin").addEventListener("click", () => ($("#signin").hidden = true));
$("#signin").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) e.currentTarget.hidden = true;
});
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

async function loadRentOptions() {
  state.rentOptionsLoading = true;
  renderRental();
  try {
    const r = await api.get("/api/rent/options");
    state.rentOptions = r.configured ? r.tiers : null;
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
  renderRental();
  // A model window asking about a GPU can now name the card and its price.
  if (state.open && state.rentAsk === state.open) openModel(state.open);
}

function renderRental() {
  const r = state.rental;
  renderRentBar(r);
  const panel = $("#rent-panel");
  if (!panel) return;
  if (r?.rented) {
    const [word, cls] = rentalPhase(r);
    const running = ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(r.status);
    const cost = r.costPerHour != null ? `${money(r.costPerHour)} an hour. ` : "";
    const time = running && r.uptimeSeconds ? `Running for ${minutesText(r.uptimeSeconds)}${r.spent != null ? `, about ${money(r.spent)} this time` : ""}. ` : "";
    const stopped = r.status === "EXITED" ? `Stopped: no hourly charge. The ${r.diskGb ? `${r.diskGb} GB ` : ""}disk keeps its models for a small charge a day; Start brings it back in a minute or two, Delete removes it and the models.` : "";
    const trouble = r.imageProblem ? ` The image server on it cannot start (${r.imageProblem}); chat still works, and a machine rented after the image is fixed will make pictures.` : "";
    const idle = r.idleMinutes ? `Stops by itself after ${r.idleMinutes} minutes without a ${state.hosted ? "download" : "chat or download"}${state.stopOnQuit ? ", and when HuggingFound quits" : ""}.${state.hosted ? " Chats go straight from your browser to the machine, so the site cannot see them; each message you send counts as use." : ""}` : `Never stops by itself${state.stopOnQuit ? "; quitting HuggingFound stops it" : ""}.`;
    panel.innerHTML = `<div class="rent-card">
      <div class="rent-head"><span>${esc(r.gpu || "GPU")}${r.gb ? `, ${r.gb} GB` : ""}</span><span class="pill ${cls}">${esc(word)}</span></div>
      <p class="muted small">${esc(cost)}${esc(time)}${esc(stopped)}${r.error ? ` Last check failed: ${esc(r.error)}` : ""}</p>
      <p class="muted small">${esc(idle)} ${r.images === false ? "This machine runs chat models only: the full machine image was not available when it was rented. Delete it and rent again for image models once it is." : "Chat and image models are downloaded to it and run there; speech models stay on your computer."}${esc(trouble)}</p>
      <div class="actions">
        ${running ? `<button class="ghost" id="rent-stop">Stop</button>` : ""}
        ${r.status === "EXITED" || r.status === "ERROR" ? `<button class="primary" id="rent-start">Start</button>` : ""}
        <button class="ghost" id="rent-delete">Delete machine and models</button>
      </div>
      <label class="field">
        <span>Stop after this many idle minutes</span>
        <input type="number" id="rent-idle" min="0" max="1440" step="1" value="${Number(r.idleMinutes ?? 30)}">
        <small class="muted">0 keeps it running until you stop it. A download in progress always keeps it awake.</small>
      </label>
      ${state.hosted ? "" : `<label class="check"><input type="checkbox" id="rent-quit" ${state.stopOnQuit ? "checked" : ""}> Stop it when HuggingFound quits</label>`}
      <div class="actions"><button class="ghost" id="rent-save-idle">Save</button></div>
    </div>
    ${privateImageHtml(true)}`;
    loadRegistries(panel);
    panel.querySelector("#rent-stop")?.addEventListener("click", () => rentAction("stop", "Stop the rented GPU? The hourly charge ends; its disk and models stay, and Start brings it back."));
    panel.querySelector("#rent-start")?.addEventListener("click", () => rentAction("start", null));
    panel.querySelector("#rent-delete")?.addEventListener("click", () => rentAction("delete", "Delete the rented machine and every model on it? Nothing is charged after this; the models can be downloaded again on a new one."));
    panel.querySelector("#rent-save-idle").addEventListener("click", async () => {
      try {
        await api.post("/api/settings", { RUNPOD_IDLE_MINUTES: Number($("#rent-idle").value), ...(state.hosted ? {} : { RUNPOD_STOP_ON_QUIT: $("#rent-quit").checked }) });
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
  if (!state.runpodKey) {
    panel.innerHTML = "";
    return;
  }
  if (state.rentOptionsLoading) {
    panel.innerHTML = `<p class="muted small">Asking RunPod what is on offer</p>`;
    return;
  }
  if (!state.rentOptions) {
    const throttled = /stopped answering|rate limiting/.test(state.rentOptionsError ?? "");
    panel.innerHTML = `<p class="muted small">${state.rentOptionsError ? esc(state.rentOptionsError) : "Could not read RunPod's offer."}${throttled ? " The sizes appear here by themselves when RunPod answers again." : ""} <button class="ghost" id="rent-retry">Try again</button></p>`;
    panel.querySelector("#rent-retry").addEventListener("click", loadRentOptions);
    return;
  }
  const want = state.rentWant && state.rentOptions.some((t) => t.gb === state.rentWant && t.available) ? state.rentWant : state.rentOptions.find((t) => t.available)?.gb;
  panel.innerHTML = `<div class="tiers">${state.rentOptions.map((t) => `<label class="tier ${t.available ? "" : "off"}">
      <input type="radio" name="rent-tier" value="${t.gb}" ${t.gb === want ? "checked" : ""} ${t.available ? "" : "disabled"}>
      <span><b>${t.gb} GB GPU</b> <span class="price">${t.gpu ? `${esc(t.gpu.name)}${t.available ? `, ${money(t.pricePerHour)} an hour` : ", none free right now"}` : "not on offer right now"}</span><small>Model files up to about ${t.files} GB: ${esc(t.examples)}.</small></span>
    </label>`).join("")}</div>
    <label class="field">
      <span>Disk for its models, in GB</span>
      <input type="number" id="rent-disk" min="10" max="4000" step="10" value="${Number(state.rentDisk ?? 50)}">
      <small class="muted">Models are kept on it between stops, so make it bigger than the models you will keep. Fixed once rented. RunPod charges a few cents a day for it, more while the machine is stopped than running.</small>
    </label>
    <div class="actions"><button class="primary" id="rent-go" ${want ? "" : "disabled"}>Rent it</button><button class="ghost" id="rent-refresh">Refresh prices</button></div>
    ${privateImageHtml()}
    <p class="muted small">Ollama on the machine answers at a long random address that RunPod makes for it; only this computer knows it, and it goes when the machine is deleted. The disk is set up once; the machine itself usually answers two to four minutes after renting.</p>`;
  loadRegistries(panel);
  panel.querySelector("#rent-refresh").addEventListener("click", () => {
    state.rentOptions = null;
    loadRentOptions();
  });
  panel.querySelector("#rent-go").addEventListener("click", async () => {
    const gb = Number(panel.querySelector('input[name="rent-tier"]:checked')?.value);
    const diskGb = Number($("#rent-disk").value);
    const offer = state.rentOptions.find((t) => t.gb === gb);
    if (!offer) return;
    state.rentDisk = diskGb;
    if (!confirm(`Rent a ${offer.gpu.name} (${gb} GB) at RunPod for ${money(offer.pricePerHour)} an hour, with a ${diskGb} GB disk?\n\nRunPod bills your account while it runs. It stops by itself after sitting idle, and you can stop or delete it here at any time.`)) return;
    const btn = panel.querySelector("#rent-go");
    btn.disabled = true;
    btn.textContent = "Renting";
    try {
      state.rental = await api.post("/api/rent", { gb, diskGb });
    } catch (err) {
      alert(`Could not rent it: ${err.message}`);
      btn.disabled = false;
      btn.textContent = "Rent it";
      return;
    }
    notice("A GPU is being rented; chat models now point at it. It usually answers within a few minutes.", "ok");
    await load();
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

async function rentAction(action, question) {
  if (question && !confirm(question)) return;
  try {
    state.rental = await api.post(`/api/rent/${action}`, {});
  } catch (err) {
    alert(err.message);
    return;
  }
  await load();
  afterRentalChange();
}

// The bar under the header: a machine is being paid for, and here is how to stop it.
function renderRentBar(r) {
  const bar = $("#rent-bar");
  if (!r?.rented) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  const [word] = rentalPhase(r);
  const running = ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(r.status);
  const cost = running && r.costPerHour != null ? `, ${money(r.costPerHour)} an hour` : "";
  const time = running && r.uptimeSeconds ? `, running ${minutesText(r.uptimeSeconds)}${r.spent != null ? ` (about ${money(r.spent)})` : ""}` : "";
  bar.hidden = false;
  const held = (r.chatModels ?? 0) + (r.imageModels ?? 0);
  bar.innerHTML = `<div class="wrap"><span>Rented GPU: ${esc(r.gpu || "")}${r.gb ? ` ${r.gb} GB` : ""}, ${esc(word)}${cost}${time}.</span><span class="buttons"><button class="ghost" id="bar-models">${held ? `${held} model${held === 1 ? "" : "s"} on it` : "Models on it"}</button>${running ? `<button id="bar-stop">Stop</button>` : `<button id="bar-start">Start</button>`}<button class="ghost" id="bar-settings">Manage</button></span></div>`;
  bar.querySelector("#bar-models").addEventListener("click", openGpuModels);
  bar.querySelector("#bar-stop")?.addEventListener("click", () => rentAction("stop", "Stop the rented GPU? The hourly charge ends; its disk and models stay, and Start brings it back."));
  bar.querySelector("#bar-start")?.addEventListener("click", () => rentAction("start", null));
  bar.querySelector("#bar-settings").addEventListener("click", () => {
    $("#settings").hidden = false;
    $("#rent").scrollIntoView({ block: "start" });
  });
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
  body.innerHTML = `<p class="muted small">Looking at the machine</p>`;
  let models;
  try {
    models = await api.get("/api/rent/models");
  } catch (err) {
    body.innerHTML = `<p class="muted small">Could not ask the machine: ${esc(err.message)}</p>`;
    return;
  }
  const row = (m, kind) => {
    const title = kind === "chat" ? m.name : `${m.file}`;
    const live = kind === "chat" ? m.running : m.loaded;
    return `<li data-kind="${kind}" data-id="${esc(m.id ?? "")}" data-name="${esc(m.name ?? "")}" data-repo="${esc(m.repo ?? "")}" data-file="${esc(m.file ?? "")}">
      <div><div class="name">${esc(title)}</div><div class="sub">${m.id ? `<span>${esc(m.id)}</span>` : ""}<span>${m.gb ? `${m.gb} GB` : ""}</span>${live ? `<span class="pill live">${kind === "chat" ? "loaded, answering" : "loaded in the GPU"}</span>` : ""}</div></div>
      <div class="buttons">${m.id ? `<button class="primary" data-open>Open</button>` : ""}<button class="ghost" data-remove>Remove</button></div>
    </li>`;
  };
  const chat = models.chatOk ? (models.chat.length ? `<ul class="gpu-list">${models.chat.map((m) => row(m, "chat")).join("")}</ul>` : `<p class="muted small">No chat models on it yet. Open a chat model and download it there.</p>`) : `<p class="muted small">Ollama on the machine is not answering${r.status === "EXITED" ? "; the machine is stopped" : " yet"}.</p>`;
  const images = !r.images ? `<p class="muted small">This machine runs chat models only; a machine rented now runs image models too.</p>` : r.imageProblem ? `<p class="muted small">The image server on this machine cannot start (${esc(r.imageProblem)}). This is a fault in the machine image, not in your setup; a machine rented after it is fixed will work.</p>` : models.imagesOk ? (models.images.length ? `<ul class="gpu-list">${models.images.map((m) => row(m, "image")).join("")}</ul>` : `<p class="muted small">No image models on it yet. Open an image model and download it there.</p>`) : `<p class="muted small">The image agent on the machine is not answering${r.status === "EXITED" ? "; the machine is stopped" : " yet"}.</p>`;
  body.innerHTML = `<h3>Chat models</h3>${chat}<h3>Image models</h3>${images}<p class="muted small">Models stay on the machine's disk while it is stopped and go when it is deleted. Each download onto it, and each conversation or picture, counts as use for the idle timer.</p><div class="actions"><button class="ghost" id="gpu-models-refresh">Refresh</button></div>`;
  body.querySelector("#gpu-models-refresh").addEventListener("click", renderGpuModels);
  for (const li of body.querySelectorAll("li")) {
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
function pollRental() {
  clearTimeout(state.rentPoll);
  state.rentPoll = null;
  if (!state.rental?.rented) return;
  const quiet = state.rental.ready || state.rental.status === "EXITED";
  state.rentPoll = setTimeout(rentalTick, quiet ? 60000 : 12000);
}

async function rentalTick() {
  state.rentPoll = null;
  if (!state.rental?.rented) return;
  const wasReady = state.rental.ready;
  try {
    state.rental = await api.get("/api/rent");
  } catch {
    // the next tick tries again
  }
  // Redrawing schedules the next poll; nothing else does.
  renderRental();
  if (!wasReady && state.rental?.ready) {
    notice("The rented GPU is ready. Chat models are downloaded to it and run there.", "ok");
    if (state.open) openModel(state.open);
  }
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

for (const [field, key, save, clear] of [["#github-token", "GITHUB_TOKEN", "#save-github", "#clear-github"], ["#youtube-key", "YOUTUBE_API_KEY", "#save-youtube", "#clear-youtube"], ["#claude-key", "ANTHROPIC_API_KEY", "#save-claude", "#clear-claude"], ["#runpod-key", "RUNPOD_API_KEY", "#save-runpod", "#clear-runpod"]]) {
  $(save).addEventListener("click", async () => {
    const value = $(field).value.trim();
    try {
      await api.post("/api/settings", { [key]: value });
    } catch (err) {
      alert(err.message);
      return;
    }
    $(field).value = "";
    if (key === "RUNPOD_API_KEY") state.rentOptions = null;
    await load();
  });
  $(clear).addEventListener("click", async () => {
    await api.post("/api/settings", { [key]: "" });
    if (key === "RUNPOD_API_KEY") state.rentOptions = null;
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
