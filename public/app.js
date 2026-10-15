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
  state.idleMinutes = s.idleMinutes ?? 30;
  state.idleSet = Boolean(s.idleSet);
  state.maxSpend = s.maxSpend ?? 50;
  state.presenceMinutes = s.presenceMinutes ?? 10;
  if (state.runpodKey !== s.runpodKey) state.others = null;
  state.runpodKey = s.runpodKey;
  state.registryAuth = s.registryAuth || "";
  if (state.others == null) loadOthersState();
  state.stopOnQuit = s.stopOnQuit;
  $("#runpod-status").textContent = s.runpodKey ? `A key is saved (${s.runpodKey}).` : s.rental?.rented ? "No key saved, but a machine is still rented: enter the key of the account that rented it to stop or delete it." : state.hosted ? "No key saved; renting is off." : "No key saved; renting is off. The chat server above can still be set by hand.";
  state.runpodKey = s.runpodKey || "";
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
  $("#nav-home").classList.toggle("on", mode !== "browse");
  $("#nav-browse").classList.toggle("on", mode === "browse");
}
$("#nav-home").addEventListener("click", () => setMode(state.found ? "results" : "home"));
$("#found-sort").addEventListener("change", render);
$("#nav-browse").addEventListener("click", () => {
  setMode("browse");
  render();
});

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
    if (plan.needsDisk && plan.growTo) parts.push(`<div class="actions"><button class="primary" id="grow-from-model">Grow the disk to ${plan.growTo} GB</button> <small class="muted">About ${money(DISK_STOPPED_PER_GB_MONTH / 30 * (plan.growTo - (plan.diskGb || 0)))} a day more while the machine is stopped, half that while it runs.</small></div>`);
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
    <span class="fact" title="${esc(plan.file.folder ? `${plan.file.parts.length} parts, merged into one file` : plan.file.repo ? `${plan.file.files.length} files, loaded as a folder by the diffusers library` : plan.file.name)}">${plan.file.folder ? `${plan.file.parts.length} files` : plan.file.repo ? `${plan.file.files.length} files` : esc(plan.file.name)}${plan.file.gb ? `, ${plan.file.gb.toFixed(plan.file.gb < 1 ? 2 : 1)} GB` : ""}</span>
    <span class="fact">${plan.measured ? esc(plan.measured) : esc(plan.speed?.text ?? "")}</span>
  </div>
  ${onMachine ? `<p class="muted small">Runs on your rented GPU; your browser talks to the machine directly and nothing passes through ${state.hosted ? "this site" : "the app"}.</p>` : plan.measured ? "" : `<p class="muted small">${state.hosted ? "Speed is a guess for a typical laptop without a separate GPU." : "Speed is a guess for this computer until a real run measures it."}</p>`}`);
  if (plan.fit.level === "no") parts.push(`<div class="notice warn">${state.hosted ? "Larger than a typical laptop has to spare." : "Larger than this computer has to spare; it may load slowly or not at all."}${choice && !choice.rented ? " A rented GPU holds it: pick On a rented GPU above." : choice ? " Pick On a rented GPU above." : ""}</div>`);
  const onSite = state.hosted && !plan.remote;
  if (onSite) parts.push(`<h3>How to run it</h3>`);
  parts.push(`<ol class="steps" id="steps">${plan.steps.map((s, i) => stepHtml(s, i)).join("")}</ol>`);
  queueMicrotask(() => {
    for (const [i, s] of plan.steps.entries()) if (s.running && $(`#steps .step[data-index="${i}"]`)) followStep(model, plan, i, s.running);
  });
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
    return `<div class="rent-ask"><p><b>Your rented GPU is ${esc(word)}.</b> This window switches to it as soon as it answers.${olderNote}</p><div class="actions">${replace}${back}</div></div>`;
  }
  if (state.hosted && !state.user) {
    const hours = state.auth?.guestHours ?? 12;
    return `<div class="rent-ask">
      <p><b>Renting a GPU takes a RunPod API key.</b> ${esc(size)} RunPod rents GPUs by the hour; with your key this site starts a machine for you, runs the model on it and stops it when you are done. You can enter the key as a guest: it and the machine are kept for ${hours} hours after your last use, then the machine is stopped and the key forgotten.${state.auth?.google ? " Sign in with Google to keep them for good." : ""}</p>
      <div class="actions"><button class="primary" id="ask-yes">Enter a key as a guest</button>${state.auth?.google ? `<button class="ghost" id="ask-signin">Sign in with Google</button>` : ""}<button class="ghost" id="ask-no">I have no key yet</button>${back}</div>
      <div id="ask-yes-box" hidden>
        <label class="field"><span>RunPod API key</span><input type="password" id="ask-key" autocomplete="off" placeholder="rpa_..."><small class="muted">Kept encrypted on this site for ${hours} hours after your last use and sent only to RunPod. Nothing you say to the model passes through this site.</small></label>
        <div class="actions"><button class="primary" id="ask-save">Save the key</button></div>
      </div>
      <div id="ask-no-box" hidden>
        <p class="muted small">It takes about two minutes: make an account at <a href="https://www.runpod.io" target="_blank" rel="noopener">runpod.io</a>, add some credit (ten dollars goes a long way), then on the Credentials page (Account, Credentials, API Keys) create a key that can manage pods. Come back and click "Enter a key as a guest". A 24 GB card costs about half a dollar an hour and a 48 GB one under a dollar.</p>
      </div>
    </div>`;
  }
  if (choice.hasRunpodKey) {
    // With a key saved, renting is one choice and one button here; the
    // key never comes up again while it is saved.
    const options = state.rentOptions ?? [];
    const free = options.filter((t) => t.available && t.pricePerHour != null);
    const pick = free.find((t) => t.gb === choice.tier) ?? free.find((t) => t.gb > (choice.tier ?? 0)) ?? free[0] ?? null;
    const sizes = free.length
      ? `<label class="field"><span>Size</span><select id="ask-size">${free.map((t) => `<option value="${t.gb}" ${pick && t.gb === pick.gb ? "selected" : ""}>${t.count > 1 ? `${t.count} × ${t.gb / t.count} GB` : `${t.gb} GB`}, ${esc(t.gpu.name)}, ${money(t.pricePerHour)} an hour${t.gb === choice.tier ? " (recommended)" : ""}</option>`).join("")}</select></label>`
      : state.rentOptionsError
        ? `<p class="muted small">RunPod is not answering about sizes: ${esc(state.rentOptionsError)}</p>`
        : options.length ? `<p class="muted small">No card is free at RunPod right now; it changes by the minute. Try again shortly.</p>` : `<p class="muted small">Asking RunPod for sizes and prices</p>`;
    return `<div class="rent-ask rent-offer">
      <p><b>Rent a GPU for this.</b> ${esc(size)} RunPod bills your account by the hour while it runs; it stops itself after sitting idle, and the bar at the top can stop or delete it any time.</p>
      ${sizes}
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
    const gb = Number(body.querySelector("#ask-size")?.value);
    const offer = (state.rentOptions ?? []).find((t) => t.gb === gb);
    if (note && offer) note.textContent = perQueryText(offer.pricePerHour).trim();
    // The button's price is the chosen size's, not the first one's.
    const btn = body.querySelector("#ask-rent");
    if (btn && offer && !btn.disabled) btn.textContent = `Rent it, ${money(offer.pricePerHour)} an hour`;
  };
  sayPerQuery();
  body.querySelector("#ask-size")?.addEventListener("change", sayPerQuery);
  body.querySelector("#ask-sizes")?.addEventListener("click", () => {
    state.rentWant = Number(body.querySelector("#ask-size")?.value) || choice.tier;
    state.rentFrom = model.id;
    if (state.rentDiskWant) state.rentDisk = Math.max(Number(state.rentDisk ?? 50), state.rentDiskWant);
    $("#settings").hidden = false;
    $("#sec-rent").open = true;
    renderRental();
    $("#rent").scrollIntoView({ block: "start" });
  });
  body.querySelector("#ask-rent")?.addEventListener("click", async () => {
    const gb = Number(body.querySelector("#ask-size")?.value);
    const offer = (state.rentOptions ?? []).find((t) => t.gb === gb);
    if (!offer) return;
    // The disk is at least what this model wants, with room to spare.
    const diskGb = Math.max(Number(state.rentDisk ?? 50), Number(state.rentDiskWant ?? 0));
    if (!confirm(`Rent a ${offer.gpu.name}${offer.count > 1 ? ` × ${offer.count}` : ""} (${gb} GB) at RunPod for ${money(offer.pricePerHour)} an hour, with a ${diskGb} GB disk?\n\n${perQueryText(offer.pricePerHour)}${safeguardText(offer.pricePerHour)}`)) return;
    if (!(await guardOthers())) return;
    const btn = body.querySelector("#ask-rent");
    const note = body.querySelector("#ask-rent-note");
    btn.disabled = true;
    btn.textContent = "Renting";
    try {
      state.rental = await api.post("/api/rent", { gb, diskGb });
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
    if (!value) return;
    const asGuest = state.hosted && !state.user;
    try {
      await api.post(asGuest ? "/api/guest" : "/api/settings", { RUNPOD_API_KEY: value });
    } catch (err) {
      alert(err.message);
      return;
    }
    // The key entry gives way to the one-time rental, right here.
    state.rentOptions = null;
    state.rentWant = choice.tier;
    state.rentFrom = model.id;
    await load();
    if (state.open) openModel(state.open);
    loadRentOptions();
    notice(asGuest ? `The key is saved for ${state.auth?.guestHours ?? 12} hours after your last use.` : "The RunPod key is saved.", "ok");
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
  if (plan.remote && state.rental?.rented && !li.querySelector(".stop-after")) {
    const tick = document.createElement("label");
    tick.className = "check stop-after";
    tick.title = "The machine stops when this download finishes, unless another of yours is still going; its models stay on its disk";
    tick.innerHTML = `<input type="checkbox"> Stop the GPU when this finishes${state.rental.costPerHour ? ` (${money(state.rental.costPerHour)} an hour)` : ""}`;
    (li.querySelector(".step-buttons") ?? btn.parentElement).appendChild(tick);
    tick.querySelector("input").addEventListener("change", (e) => {
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
    li.querySelector(".stop-after")?.remove();
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
  return {
    line(line) {
      const pct = /(\d{1,3})% of ([\d.]+ GB)(?: \(([^)]+)\))?/.exec(line);
      if (pct) {
        stopGuess();
        set(Number(pct[1]), `${pct[1]}% of ${pct[2]}${pct[3] ? `, ${pct[3]}` : ""}`);
      } else if (/Waiting for (the machine|Ollama on the machine) to start/.test(line)) startGuess();
      else if (/The machine is up\./.test(line)) {
        stopGuess();
        set(100, "Machine up; the download starts");
      } else if (/merging|Merging|Copying|Registering|already here|file \d+ of \d+/i.test(line)) {
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
  const ready = plan.steps.every((s) => s.done);
  if (!ready) {
    const left = plan.steps.filter((s) => !s.done).length;
    // What was made with the model before stays on show here, whatever
    // the machine is doing now.
    box.innerHTML = `<p class="muted small">${left === plan.steps.length ? "Run the steps above and a try box appears here." : `${left} step${left === 1 ? "" : "s"} left before you can try it.`}</p><div id="kept"></div>`;
    renderKept(box, model.id);
    return;
  }
  if (plan.tryWith.kind === "chat") renderChat(box, plan.tryWith.model);
  if (plan.tryWith.kind === "image" || plan.tryWith.kind === "video") renderImage(box, plan.tryWith);
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
    state.chatBusy = (state.chatBusy ?? 0) + 1;
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
      state.chatBusy--;
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
  const qualities = plan?.qualities ?? {};
  const options = Object.entries(qualities).map(([q, info]) => `<label><input type="radio" name="quality" value="${q}" ${q === saved ? "checked" : ""}> ${qualityLabel(q, info, plan.fast)}</label>`).join("");
  const remote = t.remote ? `<div class="notice info">Pictures are made by the image server at ${esc(t.remote)} with the model it has loaded. Change this in Settings.</div>` : "";
  const loaded = plan?.keepsLoaded && !t.remote && !t.agent ? `<p class="muted small loaded-note"><span>After the first picture the model stays loaded in memory for a quarter of an hour, so the next ones skip the loading time.</span><button class="ghost" id="unload-model">Unload now</button></p>` : "";
  const style = plan?.style ? `<p class="muted small style-note"><b>${plan.style.kind === "anime" ? "Anime model." : "Realistic model."}</b> ${esc(plan.style.text)}</p>` : "";
  const addon = t.engine === "addon";
  const bases = addon ? t.bases ?? [] : [];
  const variants = addon ? t.variants ?? [] : [];
  const addonHtml = addon ? `<div class="addon-setup">
      ${bases.length ? `<label class="field"><span>Base model on the rented GPU</span><select id="addon-base">${bases.map((b, i) => `<option value="${i}">${esc(b.label)}${b.xl ? " · SDXL" : " · SD 1.5"}</option>`).join("")}</select></label>` : `<div class="notice warn">No base model is on the rented GPU yet. Open a Stable Diffusion 1.5 or SDXL model from the Easy to set up list, download it on the rented GPU, then come back here.</div>`}
      <label class="field"><span>Variant</span><select id="addon-variant">${variants.map((v, i) => `<option value="${i}">${esc(v.label)}${v.gb ? `, ${v.gb.toFixed(2)} GB` : ""}</option>`).join("")}</select><small class="muted">Pick the variant made for the base's family: SD 1.5 variants for SD 1.5 bases, SDXL for SDXL.</small></label>
      ${t.addonKind === "ip-adapter" ? `<label class="field"><span>Reference picture</span><input type="file" id="addon-ref" accept="image/*"><small class="muted">${variants.some((v) => v.faceid) ? "A clear photo of the face to keep." : "The picture whose subject or style to carry over."}</small></label>` : ""}
      <label class="field"><span>Strength <output id="addon-scale-out">${t.addonKind === "lora" ? "0.8" : "0.6"}</output></span><input type="range" id="addon-scale" min="0.1" max="1.5" step="0.05" value="${t.addonKind === "lora" ? "0.8" : "0.6"}"></label>
    </div>` : "";
  const save = autosaveSettings();
  const what = video ? "clip" : "picture";
  const settingsHtml = spec ? `<div class="clip-settings">
      <label class="field seconds"><span>Length in seconds</span><input type="number" id="video-seconds" min="${spec.minSeconds}" max="${longMax}" step="1" value="${spec.defaultSeconds}"><small class="muted">${spec.minSeconds} to ${spec.maxSeconds} seconds in one shot at ${spec.fps} frames a second${spec.sound ? ", with sound" : ""}; the clip comes out at the nearest length the model's frames allow.${longMax > spec.maxSeconds ? ` Up to ${longMax} seconds is made as pieces of at most ${spec.maxSeconds}, each starting where the last ended, then joined into one clip.` : ""}</small></label>
      <div class="effort-title">Quality</div>
      <div class="quality" id="video-level">${["low", "medium", "high"].map((l) => `<label><input type="radio" name="level" value="${l}" ${l === level ? "checked" : ""}> <b>${l[0].toUpperCase() + l.slice(1)}</b> <span class="muted">${esc(spec.levels[l].text)}</span></label>`).join("")}</div>
      <p class="muted small levels-note">A pass is one round of refinement over the whole clip; past about 30, each adds little. The canvas is the size the model draws at, and none draws better above the one it was trained for. The expansion at High is where the effort of understanding goes: ${claudeAvailable() ? "Claude turns your words into the detailed shot description these models follow best, and the log shows it" : "with an Anthropic key saved, Claude turns your words into the detailed shot description these models follow best; without one, High is the passes and the avoid list"}.</p>
      <p class="muted small estimate" id="estimate"></p>
    </div>` : `<div class="effort-title">Effort</div>
    <div class="quality" id="quality">${options}</div>`;
  box.innerHTML = `<h3>Try it</h3>
    ${remote}
    ${style}
    ${addonHtml}
    ${settingsHtml}
    ${video && t.startPicture ? `<label class="field"><span>Starting picture${t.startPicture === "required" ? "" : " (optional)"}</span><input type="file" id="video-start" accept="image/*"><small class="muted">${t.startPicture === "required" ? "This model animates a picture: the clip begins from it." : "With a picture the clip begins from it; without one it comes from the words alone."}</small></label>` : ""}
    <div class="prompt-input">
      <textarea id="image-prompt" rows="2" placeholder="${video ? "Describe a short clip, for example: waves rolling onto a beach at dusk, slow camera pan" : "Describe a picture, for example: a lighthouse at dusk, oil painting"}"></textarea>
      <span class="go-buttons"><button class="primary" id="image-go">${video ? "Generate a clip" : "Generate"}</button>${t.agent ? `<button class="ghost" id="queue-add" title="Several requests run one after another on the machine; each is kept here and saved as it finishes">Add to queue</button>` : ""}</span>
    </div>
    <label class="field avoid">
      <span>Avoid</span>
      <input type="text" id="image-negative" placeholder="anime, cartoon, drawing, blurry, extra fingers">
      <small class="muted">Models cannot read "not" or "no" in the description; whatever you do not want goes here instead.${spec?.avoid ? " Left empty at Medium or High, the model's standard avoid list is used." : ""}</small>
    </label>
    ${t.agent ? `<div class="queue" id="queue" hidden>
      <p class="muted small"><b>Queue.</b> These run one after another on the rented GPU; each is kept here and saved to this computer as it finishes, so nothing waits on you. Tick the box below and the machine stops when the last one is made.</p>
      <ol id="queue-list"></ol>
      <p class="tools-row"><button class="primary" id="queue-go">Generate all</button><button class="ghost" id="queue-clear">Clear the queue</button></p>
      <p class="muted small" id="queue-estimate"></p>
    </div>` : ""}
    ${loaded}
    ${t.agent ? `<label class="check autosave" title="Finished results are kept in this browser whatever happens; this also saves each one to your computer as it comes, so a finished clip is never lost to a stopped machine or a closed page"><input type="checkbox" id="autosave" ${save.on ? "checked" : ""}> Save each finished ${what} to this computer as it comes, up to <input type="number" id="autosave-mb" min="1" max="5000" step="1" value="${save.maxMb}"> MB <small class="muted">(the browser may ask once to allow several downloads)</small></label>` : ""}
    ${t.agent ? `<label class="check stop-after" title="The machine stops once everything asked for here is made or has failed; its models stay on its disk and Start brings it back"><input type="checkbox" id="image-stop-after"> Stop the rented GPU when everything asked for here is made${state.rental?.costPerHour ? ` (${money(state.rental.costPerHour)} an hour)` : ""}</label>` : ""}
    <pre class="log" id="image-log" data-repo="${esc(t.repo)}" hidden></pre>
    <div id="image-out"></div>
    <div id="kept"></div>`;
  box.querySelector("#unload-model")?.addEventListener("click", async () => {
    await api.post("/api/unload", {});
    notice("The image model was unloaded from memory.", "ok");
  });
  box.querySelector("#addon-scale")?.addEventListener("input", (e) => (box.querySelector("#addon-scale-out").value = e.target.value));
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
    const asked = Math.min(longMax || spec.maxSeconds, Number(box.querySelector("#video-seconds")?.value) || spec.defaultSeconds);
    // Longer than one shot: equal pieces, each within the model's length.
    const pieces = asked > spec.maxSeconds ? Math.ceil(asked / spec.maxSeconds) : 1;
    const seconds = asked / pieces;
    const each = clipEstimate(spec, lvl, seconds, t.repo);
    const q = { steps: each.level.steps, width: each.level.width, height: each.level.height, frames: each.frames, fps: spec.fps, cfg: spec.cfg, ...(each.level.expand ? { expand: true } : {}) };
    const eachText = `${(each.frames / spec.fps).toFixed(1)} s at ${lvl} quality, ${each.level.width} by ${each.level.height}, ${each.frames} frames, ${each.level.steps} steps`;
    const estimate = pieces > 1 ? { ...each, seconds: each.seconds * pieces } : each;
    return { level: lvl, seconds, pieces, q, eachText, text: pieces > 1 ? `${((each.frames * pieces) / spec.fps).toFixed(1)} s as ${pieces} pieces of ${eachText}` : eachText, estimate, each };
  };
  const refreshEstimate = () => {
    const el = box.querySelector("#estimate");
    if (!el || !spec) return;
    const c = chosen();
    const est = c.estimate;
    const load = loadSeconds(t.repo);
    const each = c.each ?? est;
    const shape = c.pieces > 1 ? `a ${((each.frames * c.pieces) / spec.fps).toFixed(1)}-second clip made as ${c.pieces} pieces of ${(each.frames / spec.fps).toFixed(1)} s at ${each.level.width} by ${each.level.height}, ${each.frames} frames each, ${each.level.steps} steps, each starting where the last ended, then joined (a soft seam at each join)` : `a ${(each.frames / spec.fps).toFixed(1)}-second clip at ${each.level.width} by ${each.level.height}, ${each.frames} frames, ${each.level.steps} steps`;
    el.textContent = `About ${shortDuration(est.seconds)}${price ? ` and ${money((price * est.seconds) / 3600)} of machine time` : ""}${c.pieces > 1 ? " in all" : ""} for ${shape}${est.n ? ` (adjusted from the last ${est.n} clip${est.n === 1 ? "" : "s"} made here)` : " (a guess until the first clip is timed)"}.${load ? ` The first clip after a start adds about ${shortDuration(load)} to load the model.` : ""}`;
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
  box.querySelector("#video-seconds")?.addEventListener("input", refreshEstimate);
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
    const log = document.getElementById("image-log");
    return log && log.dataset.repo === t.repo ? log.parentElement : null;
  };
  const setBusy = (b, on) => {
    const go = b.querySelector("#image-go");
    if (go) go.disabled = on;
    const qGo = b.querySelector("#queue-go");
    if (qGo) qGo.disabled = on;
  };
  reply.canContinue = Boolean(video && t.startPicture);
  renderKept(box, t.repo, rec.shown, t.agent ? reply : null);
  // A request as it will be sent: the words, what to avoid, the settings as
  // chosen right now, a seed of its own, and the files picked, read when it
  // is sent.
  const makeItem = (prompt) => {
    const c = chosen();
    const typed = $("#image-negative").value.trim();
    return { prompt, negative: typed || (spec?.avoid && c.level && c.level !== "low" ? spec.avoid : ""), quality: c.quality ?? null, level: c.level ?? null, q: c.q, expand: Boolean(c.q?.expand), settings: c.text, pieces: c.pieces ?? 1, each: c.eachText ?? c.text, seed: randomSeed(), estimate: c.estimate ? { base: c.estimate.base, seconds: c.estimate.seconds } : null, startFile: box.querySelector("#video-start")?.files[0] ?? null };
  };
  // The queue: several requests, run one after another by one click. It is
  // kept in this browser under the model, so leaving the window or the page
  // loses none of it; a starting picture picked from the disk cannot be
  // kept, and is picked again.
  const queue = t.agent ? (rec.queue ??= queueItems(t.repo)) : [];
  const renderQueue = () => {
    const wrap = box.querySelector("#queue");
    if (!wrap) return;
    rememberQueue(t.repo, queue);
    wrap.hidden = !queue.length;
    const list = wrap.querySelector("#queue-list");
    list.innerHTML = queue.map((item, i) => `<li>${esc(item.prompt)} <span class="muted small">${esc(item.settings)}${item.estimate ? `, about ${esc(shortDuration(item.estimate.seconds))}` : ""}${item.replyTo ? ` · a reply to an earlier ${item.paintOver ? "picture" : "clip"}` : ""}${item.startName && !item.startFile ? ` · the starting picture ${esc(item.startName)} has to be picked again` : ""}</span><button class="ghost queue-remove" data-i="${i}">Remove</button></li>`).join("");
    for (const btn of list.querySelectorAll(".queue-remove")) btn.addEventListener("click", () => {
      queue.splice(Number(btn.dataset.i), 1);
      renderQueue();
    });
    const total = queue.reduce((a, item) => a + (item.estimate?.seconds ?? (item.quality ? tookSeconds(t.repo, item.quality) ?? qualities[item.quality]?.seconds ?? 0 : 0)), 0);
    wrap.querySelector("#queue-estimate").textContent = queue.length ? `${queue.length} request${queue.length === 1 ? "" : "s"}${total ? `, about ${shortDuration(total)}${price ? ` and ${money((price * total) / 3600)} of machine time` : ""} in all` : ""}.` : "";
    wrap.querySelector("#queue-go").textContent = `Generate all ${queue.length}`;
  };
  box.querySelector("#queue-add")?.addEventListener("click", () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    queue.push(makeItem(prompt));
    $("#image-prompt").value = "";
    renderQueue();
  });
  box.querySelector("#queue-clear")?.addEventListener("click", () => {
    queue.length = 0;
    renderQueue();
  });
  box.querySelector("#queue-go")?.addEventListener("click", () => {
    if (!queue.length) return;
    run(queue.splice(0));
    renderQueue();
  });
  renderQueue();
  $("#image-go").addEventListener("click", () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    run([makeItem(prompt)]);
  });
  // Work still going from before this window was drawn: its log is back
  // on show and the lines keep coming; the buttons wait for it.
  if (rec.lines.length) {
    const log = box.querySelector("#image-log");
    log.hidden = false;
    log.textContent = rec.lines.join("\n") + "\n";
    log.scrollTop = log.scrollHeight;
  }
  if (rec.active) setBusy(box, true);
  else if (rec.failed.length) retryRow(rec.failed);
  // Requests from before that are still on the machine (the page was
  // reloaded while they ran): followed again, unless they are being followed.
  const pending = t.agent && !rec.active ? pendingJobs(t.repo) : [];
  if (pending.length) run(pending.map((pj) => ({ item: pj.item, id: pj.id, started: pj.at, args: null })), { resumed: true });

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
    row.querySelector("#image-retry").addEventListener("click", () => {
      row.remove();
      const fresh = items.length === 1 && !items[0].replyTo;
      if (at) {
        const sec = liveBox()?.querySelector("#video-seconds");
        if (sec) sec.value = String(at);
        refreshEstimate();
      }
      run(fresh ? [makeItem($("#image-prompt").value.trim() || items[0].prompt)] : items);
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
    const picture = entry.kind !== "video";
    foot.textContent = claudeAvailable() ? "Claude is writing the revised description" : "Revising the words";
    const revised = await reviseFor(entry, text, t.repo);
    const c = chosen();
    // The settings the result was made with: kept with it, or read from its
    // caption for one kept before they were, so a reply never takes the
    // settings chosen for something else.
    const q = entry.q ?? qFromSettings(entry.settings, spec, qualities) ?? c.q;
    const item = { prompt: revised.prompt, negative: revised.negative, quality: entry.quality ?? (!spec && entry.settings ? entry.settings.split(",")[0].trim() : null) ?? c.quality ?? null, q, settings: entry.settings ?? c.text, seed: entry.seed ?? randomSeed(), replyTo: { id: entry.id, text }, startFile: null, estimate: null };
    const lines = [`Reply to the earlier ${picture ? "picture" : "clip"}: "${text}"`, `${revised.by === "Claude" ? "Claude's revised description" : "From your words"}: "${item.prompt}"${item.negative ? `, avoiding "${item.negative}"` : ""}.`];
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
    const lines = [`Continuing the earlier clip: "${text}"`, `${words.by === "Claude" ? "Claude's next shot" : "From your words"}: "${item.prompt}". It starts from that clip's last frame${entry.last ? "" : ", read from the clip in this browser"}.${item.estimate ? ` About ${shortDuration(item.estimate.seconds)}.` : ""}`];
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

  // A request's arguments for the machine: the files it needs are read now,
  // and at High the words are expanded first, once, by Claude.
  async function requestArgs(item, say = () => {}) {
    let target = { repo: t.repo, file: t.file };
    let extra = {};
    if (item.expand && !item.replyTo && !item.expanded && claudeAvailable()) {
      say("Claude is expanding the description");
      const expanded = await expandWords(item.prompt, video, t.repo, item.negative);
      if (expanded) {
        item.expanded = expanded;
        say(`Expanded: "${expanded}"`);
      } else say("Claude gave no expansion; the words go as they are.");
    }
    if (video && t.startPicture) {
      if (t.startPicture === "required" && !item.startFile) throw new Error("this model needs a starting picture");
      if (item.startFile) {
        extra.init = await readAsDataUrl(item.startFile);
        extra.strength = 0.9;
      }
    }
    // A continuation, or the next piece of a long clip: it starts from the
    // last frame of the clip before, kept in this browser.
    if (item.startFrom) {
      const src = (await keptResults(t.repo)).find((e) => e.id === item.startFrom);
      if (!src?.blob) throw new Error("the clip this starts from is no longer kept here");
      extra.init = await lastFrameOf(src);
      extra.strength = 0.9;
    }
    // A reply paints over the picture it answers, kept in this browser.
    if (item.paintOver) {
      const src = (await keptResults(t.repo)).find((e) => e.id === item.replyTo?.id);
      if (!src?.blob) throw new Error("the picture this replies to is no longer kept here");
      extra.init = await readAsDataUrl(src.blob);
      extra.strength = item.strength ?? 0.4;
    }
    if (addon) {
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
    return { ...target, prompt: item.expanded ?? item.prompt, negative: item.negative, quality: item.q, video, seed: item.seed ?? null, ...extra };
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
      if (spec && item.estimate?.base) noteEstimate(t.repo, item.estimate.base, job.took);
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
    const entry = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, model: t.repo, kind, prompt: item.prompt, negative: item.negative, madeAt: Date.now(), bytes: blob.size, blob, took: job.took ?? null, settings: item.settings, madeBy, seed: job.seed ?? item.seed ?? null, seedKept: job.seed != null, q: item.q ?? null, quality: item.quality ?? null, level: item.level ?? null, expanded: item.expanded ?? null, replyTo: item.replyTo ?? null, continues: item.continues ?? null, piece: item.piece ?? null, last: job.lastFrame ?? null, jobId: job.id ?? null };
    await keepResult(entry);
    rec.shown.add(entry.id);
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
  async function runPieces(item, openedFor, say) {
    const group = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    say(`A ${((item.q.frames * item.pieces) / spec.fps).toFixed(1)}-second clip, made as ${item.pieces} pieces of ${(item.q.frames / spec.fps).toFixed(1)} s, each starting where the last ended, then joined.`);
    const entries = [];
    let prev = null;
    for (let k = 1; k <= item.pieces; k++) {
      const piece = { ...item, pieces: 1, piece: { group, index: k, of: item.pieces }, seed: (item.seed + k - 1) % 2 ** 31, startFrom: prev?.id ?? null, after: prev?.id ?? null, startFile: k === 1 ? item.startFile : null, expand: k === 1 ? item.expand : false, expanded: item.expanded ?? null, estimate: item.estimate ? { base: item.estimate.base, seconds: Math.round(item.estimate.seconds / item.pieces) } : null, settings: `piece ${k} of ${item.pieces}, ${item.each ?? item.settings}` };
      say(`Piece ${k} of ${item.pieces}${prev ? ", from the last frame of the one before" : ""}`);
      const req = { item: piece, args: await requestArgs(piece, say) };
      if (piece.expanded) item.expanded = piece.expanded;
      await agentBatch(t.agent, [req], say, {
        repo: t.repo,
        onDone: async (r, job, err) => {
          if (err) throw err;
          prev = await finishResult(r, job, openedFor, say);
          entries.push(prev);
        },
      });
    }
    const ids = entries.map((e) => e.jobId).filter(Boolean);
    if (ids.length !== entries.length) {
      say("The pieces are kept and saved one by one, in order.");
      return;
    }
    say(`Joining the ${entries.length} pieces into one clip on the machine`);
    const res = await fetch(`${t.agent}/jobs/join`, { method: "POST", headers: { "Content-Type": "application/json", ...agentHeaders() }, body: JSON.stringify({ ids }) }).catch(() => null);
    if (!res || res.status === 404) {
      say("This machine's image is from before clips could be joined on it; the pieces are kept and saved one by one, in order. A machine on the current image joins them.");
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
    await finishResult({ item: { ...item, settings: `${total.toFixed(1)} s in ${entries.length} pieces, ${item.each ?? ""}`.replace(/, $/, ""), piece: { group, joined: entries.length }, estimate: null, after: entries.at(-1).id, replyTo: null, continues: null, expanded: item.expanded ?? null }, args: null }, job, openedFor, say);
  }

  // Runs requests: one from the Generate button, several from the queue,
  // or ones from before found still on the machine.
  async function run(items, { resumed = false, intro = [] } = {}) {
    rec.active = true;
    rec.failed = [];
    if (!resumed) rec.lines = [];
    const first = liveBox();
    if (first) {
      const log = first.querySelector("#image-log");
      log.hidden = false;
      if (!resumed) log.textContent = "";
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
          onDone: async (req, job, err, i) => {
            if (err) {
              if (req.item) failedItems.push(req.item);
              say(`Could not make ${requests.length > 1 ? `request ${i + 1}` : "it"}: ${err.message}`);
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
          }
        }
      } finally {
        // Made or failed, the machine stops now if that was asked: the
        // bill ends with the work, not after an idle wait.
        if (stopAfter) stopAfterJob(say);
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
      const b = liveBox();
      if (b) setBusy(b, false);
    }
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
  el.innerHTML = `<div class="kept-head"><b>Kept here</b> <span class="muted small">${list.length} ${list.length === 1 ? "result" : "results"} made with this model, ${mbText(total)} in this browser. They stay until removed, whatever the machine does.</span></div>`;
  for (const e of list) {
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
    el.appendChild(card);
  }
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
async function agentBatch(agent, requests, onLine = () => {}, { repo = null, onDone = null } = {}) {
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
          req.job = await followJob(agent, req.id, onLine, req.started ?? Date.now());
        } catch (err) {
          if (/no model is loaded/i.test(err.message) && req.args) {
            try {
              await resetAgent(agent, req.id, onLine);
              if (repo) forgetPending(repo, req.id);
              req.started = Date.now();
              req.id = await submitJob(agent, req.args, onLine);
              if (repo) rememberPending(repo, req.id, req.item, req.started);
              req.job = await followJob(agent, req.id, onLine, req.started);
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

// Resets the machine's agent. A newer agent drops its model on request; an
// older one is restarted in place by RunPod, which keeps its host, card and
// disk, and is back when the failed job's record is gone from it.
// The secret the machine was started with, sent with every call to it.
function agentHeaders() {
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

// Hands one job to the machine and returns its id.
async function submitJob(agent, { repo, file, prompt, negative, quality, init = null, strength = null, video = false, addon = null, ipImage = null, xl = false, seed = null }, onLine = () => {}) {
  const q = quality ?? { steps: 20, size: 512, cfg: 7, sampler: "euler_a", scheduler: "discrete" };
  // An add-on on an SDXL base draws at SDXL's size.
  const width = addon && xl ? 1024 : (q.width ?? q.size);
  const height = addon && xl ? 1024 : (q.height ?? q.size);
  const body = { repo, file, prompt, negative, steps: q.steps, width, height, cfg: q.cfg, sampler: q.sampler, scheduler: q.scheduler };
  if (Number.isInteger(seed)) body.seed = seed;
  if (addon) {
    body.addon = addon;
    if (ipImage) body.ipImage = ipImage;
  }
  if (video) {
    body.frames = q.frames;
    body.fps = q.fps;
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
async function followJob(agent, id, onLine = () => {}, started = Date.now()) {
  let last = "";
  let noted = false;
  let misses = 0;
  // When the machine began the picture itself, after any loading.
  let genStarted = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    let job;
    try {
      job = await pollJob(agent, id);
      if (misses >= 4) onLine("Reconnected to the machine.");
      misses = 0;
    } catch (err) {
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
    const word = { loading: "Loading the model into the GPU (the first picture with a model takes longer)", queued: "Waiting for the GPU", generating: job.progress ? `Generating, ${Math.round(job.progress * 100)}%` : "Generating" }[job.status];
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
    if (Date.now() - started > 30 * 60e3) throw new Error("no picture after 30 minutes");
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
  const ask = (ms) => fetch(`${agent}/jobs/${id}?lean=1`, { headers: agentHeaders(), signal: AbortSignal.timeout(ms) });
  let poll;
  try {
    poll = await ask(10000);
  } catch (err) {
    if (err.name !== "TimeoutError" && err.name !== "AbortError") throw err;
    poll = await ask(5 * 60e3);
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

// The sizes and prices RunPod offers. The server keeps them for a while;
// `fresh` asks RunPod again, for the Refresh button and after a rent that
// found the stock gone.
async function loadRentOptions({ fresh = false } = {}) {
  state.rentOptionsLoading = true;
  renderRental();
  try {
    const r = await api.get(`/api/rent/options${fresh ? "?fresh=1" : ""}`);
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
    const why = stopWhy(r);
    const stopped = r.status === "EXITED" ? `Stopped: no hourly charge. ${why}The ${r.diskGb ? `${r.diskGb} GB ` : ""}disk keeps its models for ${r.diskPerDay ? `about ${money(r.diskPerDay)} a day (${money(r.diskPerDay * 30)} a month)` : "a small charge a day"}; Start brings it back in a minute or two, Delete removes it and the models.` : "";
    const todaySpend = r.spentToday ? `Today's machines have cost about ${money(r.spentToday)} so far. ` : "";
    const trouble = r.imageProblem ? ` The image server on it cannot start (${r.imageProblem}); chat still works, and a machine rented after the image is fixed will make pictures.` : "";
    const older = r.agentVersion != null && r.agentCurrent != null && r.agentVersion < r.agentCurrent;
    const idle = r.idleMinutes ? `Stops by itself after ${r.idleMinutes} minutes without a ${state.hosted ? "download" : "chat or download"}${state.stopOnQuit ? ", and when HuggingFound quits" : ""}.${state.hosted ? " Chats go straight from your browser to the machine, so the site cannot see them; each message you send counts as use." : ""}` : `Never stops by itself${state.stopOnQuit ? "; quitting HuggingFound stops it" : ""}.`;
    panel.innerHTML = `<div class="rent-card">
      <div class="rent-head"><span>${esc(r.gpu || "GPU")}${r.gb ? `, ${r.gb} GB` : ""}</span><span class="pill ${cls}">${esc(word)}</span></div>
      <p class="muted small">${esc(cost)}${esc(time)}${esc(todaySpend)}${esc(stopped)}${r.error ? ` Last check failed: ${esc(r.error)}` : ""}</p>
      <p class="muted small">${esc(idle)} ${r.images === false ? "This machine runs chat models only: the full machine image was not available when it was rented. Delete it and rent again for image models once it is." : "Chat and image models are downloaded to it and run there; speech models stay on your computer."}${esc(trouble)}</p>
      ${state.runpodKey ? "" : `<div class="notice bad">The RunPod key is gone while this machine is rented: Stop and Delete need it. Enter the key of the account that rented it above. <button class="ghost" id="rent-key-focus">Enter the key</button> It still stops by itself after ${r.idleMinutes || 1440} minutes without use${r.maxSpend ? ` or at ${money(r.maxSpend)}` : ""}.</div>`}
      ${older ? `<div class="notice warn">This machine runs an older HuggingFound image (version ${r.agentVersion} of ${r.agentCurrent}). What was added since${r.agentVersion < 2 ? ", folder-layout models" : ""}${r.agentVersion < 3 ? ", the FLUX, Qwen-Image and video families" : ""}${r.agentVersion < 4 ? ", add-ons" : ""}${r.agentVersion < 9 ? ", MiniMax-H3 clips with sound" : ""}, needs a fresh machine. Chat and single-file image models still work on this one. <button class="primary" id="rent-replace-old">Replace the machine</button></div>` : ""}
      ${state.rentError ? `<div class="notice ${state.rentError.noGpu ? "warn" : "bad"}">${esc(state.rentError.message)}${state.rentError.noGpu ? ` <button class="primary" id="rent-replace">Replace the machine</button>` : ""}</div>` : ""}
      <div class="actions">
        ${running ? `<button class="ghost" id="rent-stop">Stop</button>` : ""}
        ${r.status === "EXITED" || r.status === "ERROR" ? `<button class="primary" id="rent-start">Start</button>` : ""}
        <button class="ghost" id="rent-delete">Delete machine and models</button>
      </div>
      <div id="rent-spend"></div>
      <div id="rent-others"></div>
      <label class="field">
        <span>Stop after this many idle minutes</span>
        <input type="number" id="rent-idle" min="0" max="1440" step="1" value="${Number(r.idleMinutes ?? 30)}">
        <small class="muted">Unset, 30 minutes on a cheap card and 10 on one costing $2 an hour or more. 0 keeps it running until you stop it, though the machine itself gives up after a day without the site. A download in progress keeps it awake, up to six hours; tick "Stop the GPU when this finishes" under the download to end the bill the moment it is done.</small>
      </label>
      <label class="field">
        <span>Ask whether I am still here after this many minutes without a click or key</span>
        <input type="number" id="rent-presence" min="1" max="240" step="1" value="${Math.max(1, Math.round(state.presenceMinutes ?? 10))}">
        <small class="muted">While the machine runs, even during a download or a picture. With no answer in a short countdown the machine stops; its models stay.</small>
      </label>
      <label class="field">
        <span>Stop once today's machines have cost this many dollars</span>
        <input type="number" id="rent-cap" min="0" max="10000" step="1" value="${Number(r.maxSpend ?? 50)}">
        <small class="muted">Counted across stops, starts and replaced machines since midnight UTC, from the running time RunPod reports; 0 removes the cap. ${r.costPerHour ? `At ${money(r.costPerHour)} an hour, ${money(r.maxSpend ?? 50)} is about ${((r.maxSpend ?? 50) / r.costPerHour).toFixed(1)} hours.` : ""}</small>
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
    panel.querySelector("#rent-key-focus")?.addEventListener("click", () => {
      $("#runpod-key").scrollIntoView({ block: "center" });
      $("#runpod-key").focus();
    });
    panel.querySelector("#rent-replace-old")?.addEventListener("click", replaceMachine);
    panel.querySelector("#rent-start")?.addEventListener("click", () => rentAction("start", null));
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
  if (!state.runpodKey) {
    panel.innerHTML = "";
    return;
  }
  // Nothing rented, yet machines from before may sit on the account billing
  // for their disks: they are looked for whenever the offer is shown.
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
      <span><b>${t.count > 1 ? `${t.count} × ${t.gb / t.count} GB GPUs` : `${t.gb} GB GPU`}</b> <span class="price">${t.gpu ? `${esc(t.gpu.name)}${t.available ? `, ${money(t.pricePerHour)} an hour` : ", none free right now"}` : "not on offer right now"}</span><small>Model files up to about ${t.files} GB: ${esc(t.examples)}.</small></span>
    </label>`).join("")}</div>
    <label class="field">
      <span>Disk for its models, in GB</span>
      <input type="number" id="rent-disk" min="10" max="4000" step="10" value="${Number(state.rentDisk ?? 50)}">
      <small class="muted">Models are kept on it between stops, so make it bigger than the models you will keep. It can be grown later, when a model does not fit, never shrunk. RunPod charges ${money(DISK_STOPPED_PER_GB_MONTH / 30 * Number(state.rentDisk ?? 50))} a day for ${Number(state.rentDisk ?? 50)} GB while the machine is stopped, half that while it runs.</small>
    </label>
    <div class="actions"><button class="primary" id="rent-go" ${want ? "" : "disabled"}>Rent it</button><button class="ghost" id="rent-refresh">Refresh prices</button></div>
    <div id="rent-others"></div>
    ${privateImageHtml()}
    <p class="muted small">Ollama on the machine answers at a long random address that RunPod makes for it; only this computer knows it, and it goes when the machine is deleted. The disk is set up once; the machine itself usually answers two to four minutes after renting.</p>`;
  loadRegistries(panel);
  panel.querySelector("#rent-refresh").addEventListener("click", () => {
    state.rentOptions = null;
    loadRentOptions({ fresh: true });
  });
  loadOthers(panel);
  panel.querySelector("#rent-go").addEventListener("click", async () => {
    const gb = Number(panel.querySelector('input[name="rent-tier"]:checked')?.value);
    const diskGb = Number($("#rent-disk").value);
    const offer = state.rentOptions.find((t) => t.gb === gb);
    if (!offer) return;
    state.rentDisk = diskGb;
    if (!confirm(`Rent a ${offer.gpu.name}${offer.count > 1 ? ` × ${offer.count}` : ""} (${gb} GB) at RunPod for ${money(offer.pricePerHour)} an hour, with a ${diskGb} GB disk?\n\n${perQueryText(offer.pricePerHour)}${safeguardText(offer.pricePerHour)}`)) return;
    if (!(await guardOthers())) return;
    const btn = panel.querySelector("#rent-go");
    btn.disabled = true;
    btn.textContent = "Renting";
    try {
      state.rental = await api.post("/api/rent", { gb, diskGb });
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

async function rentAction(action, question) {
  if (question && !confirm(question)) return;
  try {
    state.rental = await api.post(`/api/rent/${action}`, {});
  } catch (err) {
    // Said in the panel, not in a browser alert; a stopped machine whose
    // host has no free card gets the way out: a fresh machine of the same size.
    state.rentError = { action, message: err.message, noGpu: Boolean(err.body?.noGpu) };
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
      req = indexedDB.open("huggingfound-kept", 1);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore("results", { keyPath: "id" });
      store.createIndex("model", "model", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
}
function keptOp(mode, run) {
  return keptDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction("results", mode);
    let out;
    try {
      out = run(tx.objectStore("results"));
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
    list.push({ id, at, item: item ? { ...item, startFile: undefined } : null });
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
    return JSON.parse(localStorage.getItem(`queue:${repo}`) || "[]").map((item) => ({ ...item, startFile: null }));
  } catch {
    return [];
  }
}
function rememberQueue(repo, items) {
  try {
    localStorage.setItem(`queue:${repo}`, JSON.stringify(items.map(({ startFile, ...rest }) => ({ ...rest, startName: startFile?.name ?? rest.startName ?? null }))));
  } catch {
    // no storage
  }
}

// What a result is, in a line: what it answers, the words asked, what
// Claude expanded them into, and the settings.
function captionText(e) {
  return [e.replyTo ? `In reply to an earlier ${e.kind === "video" ? "clip" : "picture"} ("${e.replyTo.text}")` : "", e.continues ? `Continues an earlier clip ("${e.continues.text}")` : "", e.prompt, e.expanded ? `expanded by Claude: ${e.expanded}` : "", e.settings ?? ""].filter(Boolean).join(" · ");
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

// Claude expands a short description into the detailed one these models do
// best with; nothing, when it cannot, and the words go as they are.
async function expandWords(prompt, clip, model, negative) {
  try {
    const creds = state.hosted ? hostedCredentials() ?? {} : {};
    const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify({ kind: "prompt", mode: "expand", clip, model, prompt, negative }) });
    if (!res.ok) return null;
    let out = "";
    let end = null;
    await readLines(res, (j) => {
      if (j.error) throw new Error(j.error);
      if (j.text) out += j.text;
      if (j.done) end = j;
    });
    out = out.trim().replace(/^["“]|["”]$/g, "");
    return !end?.declined && out.length > prompt.length ? out : null;
  } catch {
    return null;
  }
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
  try {
    const creds = state.hosted ? hostedCredentials() ?? {} : {};
    const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify({ kind: "prompt", mode: "continue", clip: true, model, prompt: entry.prompt, request: text }) });
    if (!res.ok) return local;
    let out = "";
    let end = null;
    await readLines(res, (j) => {
      if (j.error) throw new Error(j.error);
      if (j.text) out += j.text;
      if (j.done) end = j;
    });
    out = out.trim().replace(/^["“]|["”]$/g, "");
    return !end?.declined && out ? { prompt: out, by: "Claude" } : local;
  } catch {
    return local;
  }
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
  try {
    const creds = state.hosted ? hostedCredentials() ?? {} : {};
    const picture = entry.kind !== "video" && entry.blob && entry.blob.size <= 5 * 1048576 ? { media_type: "image/png", data: await blobToBase64(entry.blob) } : null;
    const res = await fetch("/api/review", { method: "POST", headers: { "Content-Type": "application/json", ...creds }, body: JSON.stringify({ kind: "image", mode: "reply", clip: entry.kind === "video", model, request: text, prompt: entry.prompt, negative: entry.negative, ...(picture ? { image: picture } : {}) }) });
    if (!res.ok) return local;
    let out = "";
    let end = null;
    await readLines(res, (j) => {
      if (j.error) throw new Error(j.error);
      if (j.text) out += j.text;
      if (j.done) end = j;
    });
    if (end?.declined) return local;
    const description = /^Description:\s*(.+)$/m.exec(out)?.[1]?.trim();
    if (!description) return local;
    const avoid = /^Avoid:\s*(.+)$/m.exec(out)?.[1]?.trim() ?? "";
    const keep = Number(/^Keep:\s*(\d+)/m.exec(out)?.[1]);
    return { prompt: description, negative: /^(nothing|none|-)\.?$/i.test(avoid) ? entry.negative || "" : avoid, keep: Number.isFinite(keep) ? keep : local.keep, by: "Claude" };
  } catch {
    return local;
  }
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
  const words = {
    change: { hint: clip ? "Say what to change, as to a person: good, but the camera should move slower" : "Say what to change, as to a person: good, but I asked for two jump ropes and there is one", note: clip ? "The clip is made again from the revised words with the same seed, so the scene stays close." : "The same model paints over this picture with the change: a fraction of the time of a fresh one.", go: "Ask again" },
    continue: { hint: "Say what happens next, as to a person: now he stands up and leaves the cards on the table", note: "The next clip starts from this one's last frame, so the scene carries on; the two play one after another here.", go: "Continue it" },
  };
  const wrap = document.createElement("div");
  wrap.className = "reply-wrap";
  wrap.innerHTML = `<button class="ghost reply-go">${canContinue ? "Reply: change or continue it" : "Reply with a change"}</button>
    <div class="reply" hidden>
      ${canContinue ? `<div class="row reply-mode"><label><input type="radio" name="reply-mode-${esc(entry.id)}" value="change" checked> Change it</label><label><input type="radio" name="reply-mode-${esc(entry.id)}" value="continue"> Continue it</label></div>` : ""}
      <textarea class="reply-text" rows="2" placeholder="${words.change.hint}"></textarea>
      <div class="row"><button class="primary reply-run">${words.change.go}</button><span class="muted small reply-note">${words.change.note}</span></div>
      <div class="muted small reply-foot"></div>
    </div>`;
  card.appendChild(wrap);
  const form = wrap.querySelector(".reply");
  const text = wrap.querySelector(".reply-text");
  const foot = wrap.querySelector(".reply-foot");
  const mode = () => wrap.querySelector(".reply-mode input:checked")?.value ?? "change";
  for (const r of wrap.querySelectorAll(".reply-mode input")) r.addEventListener("change", () => {
    text.placeholder = words[mode()].hint;
    wrap.querySelector(".reply-note").textContent = words[mode()].note;
    wrap.querySelector(".reply-run").textContent = words[mode()].go;
  });
  wrap.querySelector(".reply-go").addEventListener("click", () => {
    form.hidden = !form.hidden;
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
    try {
      await onReply(entry, ask, foot, mode());
      text.value = "";
    } catch (err) {
      foot.textContent = `Could not ask: ${err.message}`;
    } finally {
      run.disabled = false;
    }
  });
}

function safeguardText(pricePerHour) {
  const idle = state.idleSet ? state.idleMinutes ?? 30 : pricePerHour >= 2 ? 10 : 30;
  const cap = state.maxSpend ?? 50;
  const guards = [`when nobody answers the still-there check this page shows after ${Math.round(state.presenceMinutes ?? 10)} minutes without a click`, idle ? `after ${idle} minutes without a chat, picture or download` : "", cap ? `once today's machines have cost ${money(cap)}` : ""].filter(Boolean);
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
  if (!box) return;
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
  const list = others.map((o) => `${o.gpu || "GPU"}${o.gpuCount > 1 ? ` × ${o.gpuCount}` : ""}, ${o.diskGb} GB disk, ${o.running ? `running at ${money(o.costPerHour || 0)} an hour` : "stopped"} (${o.id})`);
  box.innerHTML = `<div class="notice ${running.length ? "bad" : "warn"}">
    <b>${others.length} other HuggingFound machine${others.length === 1 ? "" : "s"} on this RunPod account</b>, which this site no longer manages (rented in an earlier session, under a key since removed, or by a guest whose time ran out). ${running.length ? `${running.length} ${running.length === 1 ? "is" : "are"} running, ${money(hourly)} an hour. ` : ""}Their disks cost about ${money(perDay)} a day (${money(perDay * 30)} a month) while they sit stopped. ${others.length === 1 ? "It keeps" : "They keep"} billing until deleted.
    <ul class="small">${list.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
    <button class="primary" id="rent-others-delete">Delete ${others.length === 1 ? "it" : `all ${others.length}`}, disks and models included</button>
  </div>`;
  box.querySelector("#rent-others-delete").addEventListener("click", async () => {
    if (!confirm(`Delete ${others.length === 1 ? "this machine" : `these ${others.length} machines`} at RunPod, with ${others.length === 1 ? "its disk and models" : "their disks and models"}?\n\n${list.join("\n")}\n\nNothing is charged for them after this.`)) return;
    const btn = box.querySelector("#rent-others-delete");
    btn.disabled = true;
    btn.textContent = "Deleting";
    try {
      const { deleted } = await api.post("/api/rent/others/delete", { ids: others.map((o) => o.id) });
      notice(`Deleted ${deleted.length} machine${deleted.length === 1 ? "" : "s"} at RunPod; about ${money(perDay)} a day no longer charged.`, "ok");
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
async function replaceMachine() {
  const gb = state.rental?.gb;
  const diskGb = state.rental?.diskGb;
  if (!confirm(`Delete this machine${state.rental?.status === "RUNNING" ? ", which is running," : ""} and rent a fresh ${gb ? `${gb} GB ` : ""}one? Its models download again on the new machine.`)) return;
  try {
    state.rental = await api.post("/api/rent/delete", {});
  } catch (err) {
    state.rentError = { action: "delete", message: err.message };
    renderRental();
    return;
  }
  state.rentError = null;
  state.rentWant = (state.rentTiers ?? []).find((t) => t.gb === gb)?.gb ?? state.rentWant;
  // The same disk as the old one: a smaller default would not hold its models.
  if (diskGb) state.rentDisk = diskGb;
  await load();
  $("#settings").hidden = false;
  renderRental();
  $("#rent").scrollIntoView({ block: "start" });
}

// The bar under the header: a machine is being paid for, and here is how to stop it.
function renderRentBar(r) {
  const bar = $("#rent-bar");
  const others = state.others ?? [];
  if (!r?.rented) {
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
  bar.innerHTML = `<div class="wrap"><span>Rented GPU: ${esc(r.gpu || "")}${r.gb ? ` ${r.gb} GB` : ""}, ${esc(word)}${cost}${time}${disk}.${extra}</span><span class="buttons"><button class="ghost" id="bar-models">${held ? `${held} model${held === 1 ? "" : "s"} on it` : "Models on it"}${busy ? ` ${busy}` : ""}</button>${running ? `<button id="bar-stop">Stop</button>` : `<button id="bar-start">Start</button>`}<button class="ghost" id="bar-delete" title="Delete the machine, its disk and its models; nothing is charged after">Delete</button><button class="ghost" id="bar-settings">Manage</button></span></div>`;
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
  const list = others.map((o) => `${o.gpu || "GPU"}${o.gpuCount > 1 ? ` × ${o.gpuCount}` : ""}, ${o.diskGb} GB disk, ${o.running ? `running at ${money(o.costPerHour || 0)} an hour` : "stopped"} (${o.id})`).join("\n");
  const running = others.filter((o) => o.running);
  if (running.length) {
    alert(`Another HuggingFound machine is already running on this RunPod account:\n\n${list}\n\nOne machine at a time. Stop or delete it under Settings, Rent a GPU, before renting another.`);
    return false;
  }
  const perDay = others.reduce((a, o) => a + (o.diskPerDay || 0), 0);
  if (!confirm(`${others.length} other HuggingFound machine${others.length === 1 ? "" : "s"} from before ${others.length === 1 ? "sits" : "sit"} stopped on this RunPod account, costing about ${money(perDay)} a day for ${others.length === 1 ? "its disk" : "their disks"}:\n\n${list}\n\nDelete ${others.length === 1 ? "it" : "them"} now and rent the new machine? Cancel keeps everything as it is.`)) return false;
  try {
    const { deleted } = await api.post("/api/rent/others/delete", { ids: others.map((o) => o.id) });
    state.others = [];
    notice(`Deleted ${deleted.length} machine${deleted.length === 1 ? "" : "s"} at RunPod.`, "ok");
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
  // What is being downloaded right now, and what just finished, each with
  // the way to its model's window where the full log is.
  const runs = models.runs ?? [];
  const runRow = (run) => {
    const name = run.model ? run.model.split("/").pop() : run.title || run.first;
    const pill = run.status === "running" ? `<span class="pill live">downloading</span>` : run.status === "done" ? `<span class="pill good">done</span>` : `<span class="pill bad">failed</span>`;
    const pct = /(\d{1,3})% of/.exec(run.last ?? "");
    const mini = run.status === "running" ? `<div class="progress small ${pct ? "" : "guess"}"><div class="fill" style="width:${pct ? pct[1] : 10}%"></div></div>` : "";
    return `<li data-model="${esc(run.model ?? "")}">
      <div><div class="name">${esc(name)}</div><div class="sub"><span>${esc(run.title || run.first)}</span>${run.last && run.last !== run.first ? `<span>${esc(run.last)}</span>` : ""}${pill}</div>${mini}</div>
      <div class="buttons">${run.model ? `<button class="primary" data-open-run>Open</button>` : ""}</div>
    </li>`;
  };
  const downloads = runs.length ? `<h3>Downloads</h3><ul class="gpu-list" id="gpu-runs">${runs.map(runRow).join("")}</ul>` : "";
  body.innerHTML = `${downloads}<h3>Chat models</h3>${chat}<h3>Image models</h3>${images}<p class="muted small">Models stay on the machine's disk while it is stopped and go when it is deleted. Each download onto it, and each conversation or picture, counts as use for the idle timer.</p><div class="actions"><button class="ghost" id="gpu-models-refresh">Refresh</button></div>`;
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
  state.rentPoll = setTimeout(rentalTick, stopped ? 300000 : state.rental.ready ? 60000 : 12000);
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
  return (state.presenceMinutes ?? 10) * 60e3;
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
  try {
    state.rental = await api.get("/api/rent");
  } catch {
    // the next tick tries again
  }
  // Redrawing schedules the next poll; nothing else does.
  renderRental();
  if (!wasReady && state.rental?.ready) {
    notice("The rented GPU is ready. Chat models are downloaded to it and run there.", "ok");
    if (state.open && !state.agentBusy) openModel(state.open);
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
    // Without the key a running machine cannot be stopped from here.
    if (key === "RUNPOD_API_KEY" && state.rental?.rented && ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(state.rental.status)) {
      if (!confirm("A machine is rented with this key. Without the key this site cannot stop or delete it. Stop the machine first, then remove the key?")) return;
      try {
        state.rental = await api.post("/api/rent/stop", {});
      } catch (err) {
        alert(`Could not stop the machine: ${err.message}. The key was kept.`);
        return;
      }
    }
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
