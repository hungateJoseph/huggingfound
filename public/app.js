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
  Object.assign(state, { machine: s.machine, categories: s.categories, runners: s.runners, picks: s.picks });
  renderDiskLine();
  $("#env-path").textContent = s.envFile;
  $("#token-current").textContent = s.token ? `A token is saved (${s.token}).` : "No token saved. Open models work without one.";
  state.imageServer = s.imageServer;
  $("#reddit-status").textContent = s.redditApp ? `An app id is saved (${s.redditApp}); Reddit is searched with it.` : "No app id saved; Reddit is skipped.";
  state.voices = s.voices;
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
}

function renderScanStatus() {
  const el = $("#scan-status");
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

// A live search on Hugging Face for whatever traits the user types, or a
// search through what people say about the models gathered so far.
$("#trait-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("#trait").value.trim();
  const btn = $("#trait-go");
  if (!q) {
    state.found = null;
    notice("");
    render();
    return;
  }
  btn.disabled = true;
  btn.textContent = "Searching";
  try {
    if ($("#trait-mode").value === "voices") {
      const result = await api.get(`/api/voices/search?q=${encodeURIComponent(q)}`);
      const { hits } = result;
      const known = new Map([...state.models, ...(state.found?.models ?? [])].map((m) => [m.id, m]));
      const models = hits.filter((h) => known.has(h.id)).map((h) => ({ ...known.get(h.id), voiceMatch: h.snippet }));
      state.found = { q: `what people say: ${q}`, models, voices: true, unknown: hits.length - models.length, web: result };
      const anything = hits.length || result.civitai.length || result.reddit.length;
      notice(anything ? "" : state.voices?.count ? `Nobody in the gathered cards, discussions, Civitai or Reddit says "${q}".` : "Nothing gathered yet. Click \"Gather what people say\" first; Civitai and Reddit are searched live.", anything ? "info" : "warn");
    } else {
      const result = await api.get(`/api/search?q=${encodeURIComponent(q)}`);
      state.found = result;
      notice("");
    }
  } catch (err) {
    notice(`The search did not finish: ${err.message}`, "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Search";
    render();
  }
});

$("#trait-mode").addEventListener("change", () => {
  $("#trait").placeholder = $("#trait-mode").value === "voices"
    ? "Words people use about a model: roleplay, coding help, japanese, blurry hands..."
    : "Search Hugging Face for traits: uncensored roleplay 7b, japanese, medical, tiny, vision...";
});

function renderVoicesStatus() {
  const v = state.voices;
  $("#voices-status").textContent = v?.count
    ? `Gathered for ${v.count} model${v.count === 1 ? "" : "s"} (last ${relative(v.at)}). Cards show a line of it; pick "What people say" in the search box to search it.`
    : "Reads each scanned model's card and community discussions, so you can search by what people say about a model.";
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

  // Search results ignore the category tab: the search itself said what
  // was wanted. Sort and recency still apply.
  const found = state.found ? sortModels(state.found.models.filter(keep)) : [];
  $("#found").innerHTML = found.map(modelCard).join("");
  $("#found-title").hidden = !state.found;
  renderWebFound(state.found?.web ?? null);
  if (state.found) $("#found-title").textContent = `Search: ${state.found.q} (${found.length} of ${state.found.models.length} shown${state.found.unknown ? `, ${state.found.unknown} more not in the current lists` : ""})`;

  const picks = onlyNew || Number($("#since").value) ? [] : state.picks.filter((p) => p.categories.includes(state.tab) && (!q || p.id.toLowerCase().includes(q)));
  $("#picks").innerHTML = picks.map(pickCard).join("");
  $("#picks-title").hidden = picks.length === 0;

  const models = sortModels(state.models.filter((m) => m.categories.includes(state.tab) && keep(m) && (!onlyNew || m.isNew)));
  $("#models").innerHTML = models.map(modelCard).join("");
  $("#scan-title").hidden = models.length === 0;

  const empty = $("#empty");
  if (!picks.length && !models.length && !found.length) {
    empty.hidden = false;
    empty.textContent = state.found ? "Nothing in the search results matches these filters." : state.models.length ? "Nothing matches these filters." : "Run a scan to see what is trending on Hugging Face in this category.";
  } else {
    empty.hidden = true;
  }

  for (const card of document.querySelectorAll(".model")) card.addEventListener("click", () => openModel(card.dataset.id));
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
  $("#reddit-note").textContent = !web.redditConfigured ? "Reddit needs a free app id in Settings before it can be searched." : web.redditError ? `Reddit did not answer: ${web.redditError}` : web.reddit.length ? "Posts from r/LocalLLaMA, r/StableDiffusion, r/SillyTavernAI and related communities. A chip opens a model from the scan that the post names." : "No Reddit posts for these words in the past year.";
  $("#reddit-found").innerHTML = web.reddit.map((p) => `<li>
    <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>
    <div class="who">r/${esc(p.subreddit)}, ${fmt(p.score)} points, ${fmt(p.comments)} comments${p.created ? `, ${relative(p.created)}` : ""}</div>
    ${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}
    ${p.matched.length ? `<div class="chips">${p.matched.map((id) => `<button class="chip" data-open="${esc(id)}">${esc(id.split("/").pop())}</button>`).join("")}</div>` : ""}
  </li>`).join("");
  for (const chip of box.querySelectorAll("button[data-open]")) chip.addEventListener("click", () => openModel(chip.dataset.open));
  for (const chip of box.querySelectorAll("button[data-hub]")) {
    chip.addEventListener("click", () => {
      $("#trait-mode").value = "hub";
      $("#trait").value = chip.dataset.hub;
      $("#trait-form").requestSubmit();
    });
  }
}

function fit(gb) {
  const room = state.machine.comfortableGb;
  if (!gb) return { level: "unknown", text: "Size after scan" };
  if (gb <= room * 0.6) return { level: "good", text: `Fits easily, ${gb.toFixed(1)} GB` };
  if (gb <= room) return { level: "tight", text: `Fits, close other apps, ${gb.toFixed(1)} GB` };
  return { level: "no", text: `Too big, ${gb.toFixed(1)} GB` };
}

function pickCard(p) {
  const f = fit(p.gb);
  const runner = { ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" }[p.runner];
  return `<button class="model" data-id="${esc(p.id)}">
    <div class="name">${esc(p.id.split("/").pop())}</div>
    <div class="author">${esc(p.id.split("/")[0])}</div>
    <div class="summary">${esc(p.why)}</div>
    ${p.speed ? `<div class="speed">${esc(p.speed)}</div>` : ""}
    <div class="meta"><span class="pill ${f.level}">${esc(f.text)}</span>${p.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}<span class="pill runner">${runner}</span></div>
  </button>`;
}

function modelCard(m) {
  const runner = m.runner ? `<span class="pill ${m.runner.easy ? "runner" : ""}">${esc(m.runner.name)}</span>` : "";
  return `<button class="model" data-id="${esc(m.id)}">
    <div class="name">${esc(m.name)}</div>
    <div class="author">${esc(m.author)}</div>
    <div class="summary">${esc(m.summary)}</div>
    ${m.voiceMatch ? `<div class="voice match">${m.voiceMatch.from === "discussion" ? "A discussion titled: " : "The card says: "}${esc(m.voiceMatch.text)}</div>` : m.voice?.text ? `<div class="voice">${esc(m.voice.text)}</div>` : ""}
    ${m.speed ? `<div class="speed">${esc(m.speed)}</div>` : ""}
    <div class="meta">
      ${m.isNew ? '<span class="pill new">New</span>' : ""}
      ${m.adult ? '<span class="pill adult">18+</span>' : ""}
      ${m.fast ? '<span class="pill fast">Fast, 4 steps</span>' : ""}
      ${m.gated ? '<span class="pill gated">Gated</span>' : ""}
      ${runner}
      <span>${fmt(m.downloads)} downloads</span>
      <span>${fmt(m.likes)} likes</span>
    </div>
  </button>`;
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
  const sub = [model.author, model.summary, model.gated ? "gated" : ""].filter(Boolean).join(" · ");
  $("#modal-sub").innerHTML = `${esc(sub)} · <a href="${esc(model.url)}" target="_blank" rel="noopener">Open on Hugging Face</a>`;
  const body = $("#modal-body");
  const parts = [];

  if (!plan.runnable) {
    parts.push(`<div class="notice ${plan.gated ? "info" : "warn"}">${esc(plan.reason)}${plan.link ? ` <a href="${esc(plan.link)}" target="_blank" rel="noopener">${plan.gated ? "Open the model page" : "Search for a GGUF version"}</a>` : ""}</div>`);
    if (plan.gated) parts.push(`<div class="actions"><button class="ghost" id="open-settings-from-model">Add a token in Settings</button></div>`);
    body.innerHTML = parts.join("");
    body.querySelector("#open-settings-from-model")?.addEventListener("click", () => ($("#settings").hidden = false));
    return;
  }

  parts.push(`<div class="spec">
    <div><b>File</b>${plan.file.folder ? `${plan.file.parts.length} parts, merged into one file` : esc(plan.file.name)}</div>
    <div><b>Size</b>${plan.file.gb ? plan.file.gb.toFixed(2) + " GB" : "unknown"}</div>
    <div><b>On this computer</b><span class="pill ${plan.fit.level}">${esc(plan.fit.text)}</span></div>
    <div><b>Runs with</b>${{ ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" }[plan.runner]}</div>
    <div><b>Speed here</b>${esc(plan.speed?.text ?? "")}${plan.measured ? `<span class="measured">${esc(plan.measured)}</span>` : ""}</div>
  </div>
  <p class="muted small">Speed is a rough guess from the file size and this computer's hardware. The first run is slower while the model loads${plan.runner === "sd" ? " and the graphics shaders compile" : ""}; after a real run the measured time shows here.</p>`);
  if (plan.fit.level === "no") parts.push(`<div class="notice warn">This file is larger than the memory this computer has to spare. It may still download, but it will be slow or fail to load. A smaller model is a better first try.</div>`);
  parts.push(`<ol class="steps" id="steps">${plan.steps.map((s, i) => stepHtml(s, i)).join("")}</ol>`);
  parts.push(`<div class="try" id="try"></div>`);
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
  box.innerHTML = `<h3>What people say</h3>${card}${threads}<p class="muted small">From the community tab on Hugging Face; these are other users' words, not a review.</p><div class="web" id="voices-web"><p class="muted small">Looking on Civitai and Reddit</p></div>`;
  const isImage = state.plan?.runner === "sd" || (model.categories ?? []).includes("images");
  const web = await api.get(`/api/voices/web?id=${encodeURIComponent(model.id)}${isImage ? "&images=1" : ""}`);
  const webBox = $("#voices-web");
  if (!webBox || state.open !== model.id) return;
  const civ = web.civitai.length
    ? `<h4>On Civitai</h4><p class="muted small">Pages whose name matches this model; merges and re-uploads share names, so check the link.</p>` + web.civitai.map((c) => `<div class="civ"><div class="name"><a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.name)}</a>${c.nsfw ? ' <span class="pill adult">18+</span>' : ""}</div><div class="stats">${fmt(c.thumbsUp)} thumbs up, ${fmt(c.thumbsDown)} down, ${fmt(c.comments)} comments, ${fmt(c.downloads)} downloads${c.creator ? `, by ${esc(c.creator)}` : ""}</div>${c.description ? `<div class="desc">${esc(c.description)}</div>` : ""}</div>`).join("")
    : web.civitaiError ? `<p class="muted small">Civitai did not answer: ${esc(web.civitaiError)}</p>` : isImage ? `<p class="muted small">No matching page on Civitai.</p>` : "";
  const red = !web.redditConfigured
    ? `<p class="muted small">Reddit posts need a free app id in Settings.</p>`
    : web.redditError ? `<p class="muted small">Reddit did not answer: ${esc(web.redditError)}</p>`
    : web.reddit.length ? `<h4>On Reddit</h4><ul class="posts">${web.reddit.slice(0, 8).map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a><div class="who">r/${esc(p.subreddit)}, ${fmt(p.score)} points, ${fmt(p.comments)} comments</div>${p.excerpt ? `<p>${esc(p.excerpt)}</p>` : ""}</li>`).join("")}</ul>`
    : `<p class="muted small">No Reddit posts name this model.</p>`;
  webBox.innerHTML = civ + red;
}

function stepHtml(s, i) {
  return `<li class="step ${s.done ? "done" : ""}" data-index="${i}">
    <span class="num">${s.done ? "✓" : i + 1}</span>
    <div>
      <div class="title">${esc(s.title)}</div>
      <div class="text">${esc(s.text)}</div>
      ${s.command ? `<code>${esc(s.command)}</code>` : ""}
    </div>
    <button class="go ${s.done ? "ghost" : "primary"}" data-index="${i}" ${s.done ? "disabled" : ""}>${s.done ? "Done" : "Run this step"}</button>
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

function renderChat(box, modelName) {
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
      <div class="messages" id="messages"><div class="msg assistant">Ready. Ask anything; the answer comes from ${esc(modelName)} on this computer.</div></div>
      <div class="chat-input">
        <textarea id="chat-text" placeholder="Type a message" rows="2"></textarea>
        <button class="primary" id="chat-send">Send</button>
      </div>
    </div>`;
  const messages = [];
  const send = async () => {
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
    addMsg("user", text);
    const out = addMsg("assistant", "");
    $("#chat-send").disabled = true;
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: modelName, messages }) });
      if (!res.ok) throw new Error(`Ollama replied HTTP ${res.status}. Is it running and is the model downloaded?`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let reply = "";
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
          out.textContent = reply;
          out.parentElement.scrollTop = out.parentElement.scrollHeight;
        }
      }
      messages.push({ role: "assistant", content: reply });
    } catch (err) {
      out.textContent = `Something went wrong: ${err.message}`;
    } finally {
      $("#chat-send").disabled = false;
    }
  };
  $("#chat-send").addEventListener("click", send);
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
for (const id of ["#modal", "#settings"]) {
  $(id).addEventListener("click", (e) => {
    if (e.target === e.currentTarget) {
      e.currentTarget.hidden = true;
      if (id === "#modal") state.open = null;
    }
  });
}
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

load().catch((err) => notice(`HuggingFound could not start: ${err.message}`, "bad"));
