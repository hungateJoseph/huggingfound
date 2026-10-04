const $ = (sel) => document.querySelector(sel);

const state = {
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
  Object.assign(state, { machine: s.machine, categories: s.categories, runners: s.runners, picks: s.picks, hosted: Boolean(s.hosted), refresh: s.refresh });
  document.body.dataset.hosted = s.hosted ? "1" : "";
  if (s.hosted) renderHostedCopy();
  renderDiskLine();
  $("#env-path").textContent = s.envFile;
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
  $("#home-lead").textContent = "Say it in plain words. HuggingFound looks through Hugging Face, the model cards, the community discussions and the wider web, and ranks what fits by what people say about it. Pick one, and HuggingFound on your computer downloads and runs it.";
  $("#browse .intro h1").textContent = "Open models, running on your computer.";
  $("#browse .intro .lead").textContent = `This catalogue is scanned from Hugging Face every ${state.refresh?.hours ?? 12} hours, with what people say about each model summed up on its card. Fit and speed are shown for a typical 16 GB laptop. Chat models run through Ollama, images through stable-diffusion.cpp and speech through whisper.cpp, all on your own computer.`;
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
  if (!state.scanAt) parts.push("No scan yet, so results come from Hugging Face's own search and the curated picks.");
  else parts.push(`${state.models.length} models scanned ${relative(state.scanAt)}.`);
  if (v?.count) parts.push(`What people say is gathered for ${v.count} of them${state.summarizer ? ", summed up by " + state.summarizer.split("/").pop() : ", lines lifted from the comments"}.`);
  else if (state.hosted) parts.push("What people say is gathered after each scan.");
  else parts.push("Gather what people say (in Browse) to rank by reviews and show a summary on every card.");
  $("#home-hint").textContent = parts.join(" ");
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

  const keep = (m) => (!onlyRunnable || m.runner?.easy) && (!q || m.id.toLowerCase().includes(q) || (m.voice?.text ?? "").toLowerCase().includes(q));

  // Search results keep the server's relevance order; only the runnable
  // filter applies to them.
  const found = state.found ? state.found.models.filter((m) => !onlyRunnable || m.runner?.easy) : [];
  $("#found").innerHTML = found.map(modelCard).join("");
  $("#results").hidden = !(state.found && (state.mode === "results" || state.mode === "browse"));
  if (state.found) {
    const f = state.found;
    $("#found-title").textContent = `${found.length} model${found.length === 1 ? "" : "s"} for "${f.q}"`;
    const bySay = f.models.filter((m) => m.why?.includes("what people say") || m.why?.includes("discussions")).length;
    const hidden = f.hiddenRefusing ? ` <a href="#" id="toggle-refusing">${f.hideRefusing ? `${f.hiddenRefusing} hidden because users report the model refuses requests; show them` : "Hide models users report as refusing"}</a>.` : "";
    $("#found-hint").innerHTML = `Ranked by name, category and what people say; ${bySay} matched on what people say. ${f.gathered ? "" : "Nothing gathered yet: open Browse, scan and gather to rank by reviews. "}${f.took != null ? `${(f.took / 1000).toFixed(1)} s.` : ""}${hidden}`;
    $("#toggle-refusing")?.addEventListener("click", (e) => {
      e.preventDefault();
      state.showRefusing = !state.showRefusing;
      $("#trait-form").requestSubmit();
    });
    $("#found-empty").hidden = found.length > 0;
    $("#found-empty").textContent = f.models.length ? "Every match needs a Python setup; untick the runnable filter in Browse to see them." : `Nothing matches "${f.q}". Try other words, or Browse the categories.`;
  }
  renderWebFound(state.found?.web ?? null);
  renderHomeHint();

  const picks = onlyNew || Number($("#since").value) ? [] : state.picks.filter((p) => p.categories.includes(state.tab) && (!q || p.id.toLowerCase().includes(q)));
  $("#picks").innerHTML = picks.map(pickCard).join("");
  $("#picks-title").hidden = picks.length === 0;

  const models = sortModels(state.models.filter((m) => m.categories.includes(state.tab) && keep(m) && (!onlyNew || m.isNew)));
  $("#models").innerHTML = models.map(modelCard).join("");
  $("#scan-title").hidden = models.length === 0;

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

function fit(gb) {
  const room = state.machine.comfortableGb;
  if (!gb) return { level: "unknown", text: "Size after scan" };
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
  const f = fit(p.gb);
  const runner = { ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" }[p.runner];
  return `<div class="model" role="button" tabindex="0" data-id="${esc(p.id)}">
    <div class="name">${esc(p.id.split("/").pop())}</div>
    <div class="author">${esc(p.id.split("/")[0])}</div>
    <div class="summary">${esc(p.why)}</div>
    ${p.speed ? `<div class="speed">${esc(p.speed)}</div>` : ""}
    <div class="meta"><span class="pill ${f.level}">${esc(f.text)}</span>${p.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}<span class="pill runner">${runner}</span></div>
  </div>`;
}

function modelCard(m) {
  const runner = m.runner ? `<span class="pill ${m.runner.easy ? "runner" : ""}">${esc(m.runner.name)}</span>` : "";
  return `<div class="model" role="button" tabindex="0" data-id="${esc(m.id)}">
    <div class="name">${esc(m.name)}</div>
    <div class="author">${esc(m.author)}</div>
    <div class="summary">${esc(m.blurb ?? (typeof m.summary === "string" ? m.summary : ""))}</div>
    ${saidHtml(m)}
    ${m.why?.length ? `<div class="why">${m.why.map((w) => `<span class="${w === "what people say" ? "say" : w === "mixed reviews" || w === "users report refusals" ? "mixed" : ""}">${esc(w)}</span>`).join("")}</div>` : ""}
    ${m.speed ? `<div class="speed">${esc(m.speed)}</div>` : ""}
    <div class="meta">
      ${m.isNew ? '<span class="pill new">New</span>' : ""}
      ${m.adult ? '<span class="pill adult">18+</span>' : ""}
      ${m.refusals?.refuses ? `<span class="pill no" title="${esc(m.refusals.example ?? "")}">Users report refusals</span>` : ""}
      ${m.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}
      ${m.gated ? '<span class="pill gated">Gated</span>' : ""}
      ${runner}
      <span>${fmt(m.downloads)} downloads</span>
      <span>${fmt(m.likes)} likes</span>
    </div>
  </div>`;
}

// The one or two summary lines on a card, with a More button that opens the
// rest in place.
function saidHtml(m) {
  const lines = m.summary?.short ?? [];
  if (!lines.length) return m.voiceMatch ? `<div class="voice match">${m.voiceMatch.from === "discussion" ? "A discussion titled: " : "The card says: "}${esc(m.voiceMatch.text)}</div>` : "";
  const more = (m.summary?.long?.length ?? 0) > lines.length || m.talked;
  return `<div class="said">${lines.map(lineHtml).join("")}${more ? `<button class="ghost more" data-more="${esc(m.id)}">More</button>` : ""}<div class="expanded" hidden></div></div>`;
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
      const long = m?.summary?.long ?? [];
      box.innerHTML = `${long.map(lineHtml).join("") || "<span class=\"muted small\">Nothing more gathered.</span>"}<div class="by">${m?.summary?.by && m.summary.by !== "extract" ? `Summed up by ${esc(m.summary.by)} on this computer` : "Lines lifted from the comments; a chat model in Ollama would write them"}${m?.talked ? `, from ${m.talked} discussion${m.talked === 1 ? "" : "s"} and the model card` : ""}. <a href="#" data-open-model="${esc(m?.id ?? "")}">Open the model for every source</a></div>`;
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

async function openModel(id) {
  const modal = $("#modal");
  modal.hidden = false;
  $("#modal-title").textContent = id.split("/").pop();
  $("#modal-sub").textContent = "Looking up files and sizes";
  $("#modal-body").innerHTML = "";
  state.open = id;
  try {
    const { model, plan } = await api.get(`/api/model?id=${encodeURIComponent(id)}`);
    if (state.open !== id) return;
    renderModel(model, plan);
  } catch (err) {
    $("#modal-sub").textContent = "";
    $("#modal-body").innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
  }
}

function renderModel(model, plan) {
  state.plan = plan;
  state.model = model;
  const sub = [model.author, model.summary, model.gated ? "gated" : ""].filter(Boolean).join(" · ");
  $("#modal-sub").innerHTML = `${esc(sub)} · <a href="${esc(model.url)}" target="_blank" rel="noopener">Open on Hugging Face</a>`;
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

  parts.push(`<div class="spec">
    <div><b>File</b>${plan.file.folder ? `${plan.file.parts.length} parts, merged into one file` : esc(plan.file.name)}</div>
    <div><b>Size</b>${plan.file.gb ? plan.file.gb.toFixed(2) + " GB" : "unknown"}</div>
    <div><b>${state.hosted ? "Memory" : "On this computer"}</b><span class="pill ${plan.fit.level}">${esc(plan.fit.text)}</span></div>
    <div><b>Runs with</b>${{ ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" }[plan.runner]}</div>
    <div><b>${state.hosted ? "Speed" : "Speed here"}</b>${esc(plan.speed?.text ?? "")}${plan.measured ? `<span class="measured">${esc(plan.measured)}</span>` : ""}</div>
  </div>
  <p class="muted small">${state.hosted ? "Speed is a rough guess from the file size for a typical laptop without a separate GPU; a GPU or Apple Silicon is several times faster." : `Speed is a rough guess from the file size and this computer's hardware. The first run is slower while the model loads${plan.runner === "sd" ? " and the graphics shaders compile" : ""}; after a real run the measured time shows here.`}</p>`);
  if (plan.fit.level === "no") parts.push(`<div class="notice warn">${state.hosted ? "This file is larger than a typical laptop has to spare; it wants 32 GB of memory or a big GPU." : "This file is larger than the memory this computer has to spare. It may still download, but it will be slow or fail to load. A smaller model is a better first try."}</div>`);
  if (state.hosted) parts.push(`<h3>How to run it</h3><p class="muted small">These are the steps HuggingFound does for you on your computer, one click each. They can also be done by hand.</p>`);
  parts.push(`<ol class="steps" id="steps">${plan.steps.map((s, i) => stepHtml(s, i)).join("")}</ol>`);
  if (state.hosted) parts.push(`<div class="get-app hosted-only"><b>Run HuggingFound on your computer</b> to do these with one click and try the model in a chat, image or transcription box right here. Needs Node 20 or newer.<code>git clone https://github.com/hungateJoseph/huggingfound.git
cd huggingfound
npm install
npm start</code></div>`);
  if (!state.hosted) parts.push(`<div class="try" id="try"></div>`);
  parts.push(`<div class="voices" id="voices"><h3>What people say</h3><p class="muted small">Reading the model card and the community discussions</p></div>`);
  body.innerHTML = parts.join("");
  loadVoices(model).catch((err) => {
    const box = $("#voices");
    if (box) box.innerHTML = `<h3>What people say</h3><p class="muted small">Could not read the discussions: ${esc(err.message)}</p>`;
  });

  for (const btn of body.querySelectorAll(".go")) {
    btn.addEventListener("click", () => runStep(model, plan, Number(btn.dataset.index)));
  }
  renderTry(model, plan);
}

async function loadVoices(model) {
  const v = await api.get(`/api/voices?id=${encodeURIComponent(model.id)}`);
  const box = $("#voices");
  if (!box || state.open !== model.id) return;
  const card = v.card ? `<details ${v.card.length < 400 ? "open" : ""}><summary>What the author's model card says</summary><p class="card-text">${esc(v.card)}</p></details>` : `<p class="muted small">This repository has no model card text.</p>`;
  const threads = v.discussions.length
    ? `<ul>${v.discussions.slice(0, 12).map((d) => `<li><a href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.title)}</a> <span class="who">${d.comments} comment${d.comments === 1 ? "" : "s"}${d.status === "closed" ? ", closed" : ""}</span>${(d.comments_text ?? []).map((c) => `<p>${esc(c.author ? c.author + ": " : "")}${esc(c.text)}</p>`).join("")}</li>`).join("")}</ul>`
    : `<p class="muted small">No community discussions on this repository yet.</p>`;
  const summary = v.summary?.long?.length ? `<div class="said">${v.summary.long.map(lineHtml).join("")}</div><p class="muted small">${v.summary.by !== "extract" ? `Summed up by ${esc(v.summary.by)} on this computer` : "Lines lifted from the comments; a chat model in Ollama would write them"}.</p>` : `<p class="muted small">Nothing said about this model yet.</p>`;
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
    ${state.hosted ? "" : `<button class="go ${s.done ? "ghost" : "primary"}" data-index="${i}" ${s.done ? "disabled" : ""}>${s.done ? "Done" : "Run this step"}</button>`}
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
    const { id } = await api.post("/api/run", { kind: step.kind, args: step.args ?? {} });
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
      const fresh = await api.get(`/api/model?id=${encodeURIComponent(model.id)}`);
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
  btn.textContent = `Remove from this computer (${plan.file.gb ? plan.file.gb.toFixed(1) + " GB" : "frees the download"})`;
  wrap.appendChild(btn);
  btn.addEventListener("click", async () => {
    if (!confirm(`Delete ${model.name} from this computer? The runner stays installed; the model can be downloaded again any time.`)) return;
    btn.disabled = true;
    btn.textContent = "Removing";
    try {
      for (const item of plan.remove) await api.post("/api/remove", item);
      if (!$("#local-body").hidden) renderStorage(["local"]).catch(() => {});
      const fresh = await api.get(`/api/model?id=${encodeURIComponent(model.id)}`);
      if (state.open === model.id) {
        renderModel(fresh.model, fresh.plan);
        notice(`${model.name} was removed from this computer.`, "ok");
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
    ...st.ollama.map((m) => ({ what: `${m.name} (Ollama)`, gb: m.gb, open: repoOfOllama(m.name), body: { kind: "ollama", name: m.name } })),
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
    $("#machine-line").textContent = "Fit and speed shown for a typical 16 GB laptop. Run HuggingFound on your computer to see them for your machine.";
    return;
  }
  const free = st?.disk?.freeGb != null ? ` ${st.disk.freeGb.toFixed(0)} GB free on disk.` : "";
  $("#machine-line").textContent = `${m.os}, ${m.ramGb} GB memory, ${m.gpu}. Room for models up to about ${m.comfortableGb} GB.${free}`;
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
    if (!state.claudeReady) {
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
      const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload()) });
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
    <div class="chat">
      <div class="chat-tools"><span class="muted small">${chat.messages.length ? "The conversation is kept on this computer until you start a new one." : `Ask anything; the answer comes from ${esc(modelName)} on this computer.`}</span><button class="ghost" id="chat-clear">New chat</button></div>
      <div class="messages" id="messages"></div>
      <div class="chat-input">
        <textarea id="chat-text" placeholder="Type a message" rows="2"></textarea>
        <button class="primary" id="chat-send" ${chat.busy ? "disabled" : ""}>Send</button>
      </div>
    </div>`;
  const list = $("#messages");
  // Each finished answer can be checked by Claude; the question is the user turn before it.
  const checkFor = (el, m) => {
    addCheck(el, {
      label: "Ask Claude to check this",
      sent: "your question and this answer",
      saved: m.review ?? "",
      payload: () => {
        const at = chat.messages.indexOf(m);
        const question = chat.messages.slice(0, at).reverse().find((x) => x.role === "user")?.content ?? "";
        return { kind: "text", model: modelName, question, answer: m.content, system: chat.messages[0]?.role === "system" ? chat.messages[0].content : "" };
      },
      onDone: (text) => {
        m.review = text;
        saveChat(modelName, chat);
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
    el.classList.toggle("pending", pending);
    if (stick) el.parentElement.scrollTop = el.parentElement.scrollHeight;
  };
  const send = async () => {
    if (chat.busy) return;
    const text = $("#chat-text").value.trim();
    if (!text) return;
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
    const out = addMsg("assistant", "");
    out.id = "chat-live";
    out.classList.add("pending");
    chat.busy = true;
    chat.reply = "";
    $("#chat-send").disabled = true;
    let reply = "";
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelName, messages: messages.map(({ role, content }) => ({ role, content })) }) });
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
  $("#chat-send").addEventListener("click", send);
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

function addMsg(role, text) {
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  el.textContent = text;
  $("#messages").appendChild(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el;
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
  const loaded = plan?.keepsLoaded && !t.remote ? `<p class="muted small loaded-note"><span>After the first picture the model stays loaded in memory for a quarter of an hour, so the next ones skip the loading time.</span><button class="ghost" id="unload-model">Unload now</button></p>` : "";
  const style = plan?.style ? `<p class="muted small style-note"><b>${plan.style.kind === "anime" ? "Anime model." : "Realistic model."}</b> ${esc(plan.style.text)}</p>` : "";
  box.innerHTML = `<h3>Try it</h3>
    ${remote}
    ${style}
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
      const { id } = await api.post("/api/run", { kind: "generate-image", args: { repo: t.repo, file: t.file, prompt, negative, quality } });
      const result = await follow(id, (line) => {
        log.textContent += line + "\n";
        log.scrollTop = log.scrollHeight;
      });
      if (result.status === "done" && result.result) {
        $("#image-out").innerHTML = `<img class="result-image" src="/output/${esc(result.result)}" alt="${esc(prompt)}"><p class="muted small">Saved to ~/HuggingFound/output/${esc(result.result)}</p>`;
        addCheck($("#image-out").lastElementChild, {
          label: "Ask Claude to check this picture",
          sent: "this picture and your description",
          payload: () => ({ kind: "image", model: t.repo, file: result.result, prompt, negative }),
          // Claude ends with a better description and avoid list; one click tries them.
          after: (text, foot) => {
            const better = /^Description:\s*(.+)$/m.exec(text)?.[1]?.trim();
            const avoid = /^Avoid:\s*(.+)$/m.exec(text)?.[1]?.trim();
            if (!better) return;
            const use = document.createElement("button");
            use.className = "ghost";
            use.id = "use-suggestion";
            use.textContent = "Use Claude's suggestion";
            use.addEventListener("click", () => {
              $("#image-prompt").value = better;
              if (avoid) $("#image-negative").value = avoid;
              $("#image-prompt").focus();
            });
            foot.prepend(use);
          },
        });
      }
    } catch (err) {
      log.textContent += `Could not start: ${err.message}\n`;
    } finally {
      $("#image-go").disabled = false;
    }
  });
}

function renderTranscribe(box, t) {
  box.innerHTML = `<h3>Try it</h3>
    <p class="muted small">Pick a recording. WAV works everywhere; MP3, M4A and others are converted with ffmpeg${t.ffmpeg ? ", which is installed" : ", which is not installed, so whisper.cpp reads them directly and may refuse some formats"}.</p>
    <div class="file-row">
      <input type="file" id="audio" accept="audio/*,video/*">
      <button class="primary" id="audio-go">Transcribe</button>
    </div>
    <pre class="log" id="audio-log" hidden></pre>
    <div id="audio-out"></div>`;
  $("#audio-go").addEventListener("click", async () => {
    const file = $("#audio").files[0];
    if (!file) return;
    const log = $("#audio-log");
    log.hidden = false;
    log.textContent = "Uploading\n";
    $("#audio-go").disabled = true;
    try {
      const up = await fetch("/api/upload", { method: "POST", headers: { "x-filename": file.name }, body: file }).then(check);
      const { id } = await api.post("/api/run", { kind: "transcribe", args: { repo: t.repo, file: t.file, audio: up.path } });
      const result = await follow(id, (line) => {
        log.textContent += line + "\n";
        log.scrollTop = log.scrollHeight;
      });
      if (result.status === "done" && result.result) {
        const r = await api.get(`/api/result?file=${encodeURIComponent(result.result)}`);
        $("#audio-out").innerHTML = `<div class="transcript">${esc(r.text.trim() || "(no speech found)")}</div>`;
      }
    } catch (err) {
      log.textContent += `Could not transcribe: ${err.message}\n`;
    } finally {
      $("#audio-go").disabled = false;
    }
  });
}

// ---- settings --------------------------------------------------------------

function renderRunners() {
  const r = state.runners;
  const rows = [
    ["Ollama", r.ollama.installed ? (r.ollama.running ? `running, ${r.ollama.models.length} model${r.ollama.models.length === 1 ? "" : "s"}` : "installed, not running") : "not installed"],
    ["whisper.cpp", r.whisper.installed ? "installed" : "not installed"],
    ["stable-diffusion.cpp", r.sd.installed ? (r.sd.server ? (r.sd.loaded.ready ? `installed, ${r.sd.loaded.file.split("/").pop()} loaded in memory` : "installed, keeps models loaded between pictures") : "installed (one picture at a time; the server build is missing)") : "not installed"],
    ["ffmpeg", r.ffmpeg ? "installed" : "not installed (only needed for non-WAV recordings)"],
  ];
  $("#runner-list").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><span class="muted">${esc(v)}</span></li>`).join("");
}

$("#open-settings").addEventListener("click", () => {
  $("#settings").hidden = false;
  renderStorage($("#local-body").hidden ? ["settings"] : ["local", "settings"]).catch(() => ($("#storage-total").textContent = "Could not read the models folder."));
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

for (const [field, key, save, clear] of [["#github-token", "GITHUB_TOKEN", "#save-github", "#clear-github"], ["#youtube-key", "YOUTUBE_API_KEY", "#save-youtube", "#clear-youtube"], ["#claude-key", "ANTHROPIC_API_KEY", "#save-claude", "#clear-claude"]]) {
  $(save).addEventListener("click", async () => {
    const value = $(field).value.trim();
    try {
      await api.post("/api/settings", { [key]: value });
    } catch (err) {
      alert(err.message);
      return;
    }
    $(field).value = "";
    await load();
  });
  $(clear).addEventListener("click", async () => {
    await api.post("/api/settings", { [key]: "" });
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
