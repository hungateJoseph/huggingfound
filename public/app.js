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
  $("#machine-line").textContent = `${s.machine.os}, ${s.machine.ramGb} GB memory, ${s.machine.gpu}. Room for models up to about ${s.machine.comfortableGb} GB.`;
  $("#env-path").textContent = s.envFile;
  $("#token-current").textContent = s.token ? `A token is saved (${s.token}).` : "No token saved. Open models work without one.";
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

for (const id of ["#only-runnable", "#only-new", "#search"]) $(id).addEventListener("input", render);

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

  const picks = onlyNew ? [] : state.picks.filter((p) => p.categories.includes(state.tab) && (!q || p.id.toLowerCase().includes(q)));
  $("#picks").innerHTML = picks.map(pickCard).join("");
  $("#picks-title").hidden = picks.length === 0;

  const models = state.models.filter((m) => m.categories.includes(state.tab) && (!onlyRunnable || m.runner?.easy) && (!onlyNew || m.isNew) && (!q || m.id.toLowerCase().includes(q)));
  $("#models").innerHTML = models.map(modelCard).join("");
  $("#scan-title").hidden = models.length === 0;

  const empty = $("#empty");
  if (!picks.length && !models.length) {
    empty.hidden = false;
    empty.textContent = state.models.length ? "Nothing matches these filters." : "Run a scan to see what is trending on Hugging Face in this category.";
  } else {
    empty.hidden = true;
  }

  for (const card of document.querySelectorAll(".model")) card.addEventListener("click", () => openModel(card.dataset.id));
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
    <div class="meta"><span class="pill ${f.level}">${esc(f.text)}</span><span class="pill runner">${runner}</span></div>
  </button>`;
}

function modelCard(m) {
  const runner = m.runner ? `<span class="pill ${m.runner.easy ? "runner" : ""}">${esc(m.runner.name)}</span>` : "";
  return `<button class="model" data-id="${esc(m.id)}">
    <div class="name">${esc(m.name)}</div>
    <div class="author">${esc(m.author)}</div>
    <div class="summary">${esc(m.summary)}</div>
    <div class="meta">
      ${m.isNew ? '<span class="pill new">New</span>' : ""}
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
    <div><b>File</b>${esc(plan.file.name)}</div>
    <div><b>Size</b>${plan.file.gb ? plan.file.gb.toFixed(2) + " GB" : "unknown"}</div>
    <div><b>On this computer</b><span class="pill ${plan.fit.level}">${esc(plan.fit.text)}</span></div>
    <div><b>Runs with</b>${{ ollama: "Ollama", whisper: "whisper.cpp", sd: "stable-diffusion.cpp" }[plan.runner]}</div>
  </div>`);
  if (plan.fit.level === "no") parts.push(`<div class="notice warn">This file is larger than the memory this computer has to spare. It may still download, but it will be slow or fail to load. A smaller model is a better first try.</div>`);
  parts.push(`<ol class="steps" id="steps">${plan.steps.map((s, i) => stepHtml(s, i)).join("")}</ol>`);
  parts.push(`<div class="try" id="try"></div>`);
  body.innerHTML = parts.join("");

  for (const btn of body.querySelectorAll(".go")) {
    btn.addEventListener("click", () => runStep(model, plan, Number(btn.dataset.index)));
  }
  renderTry(model, plan);
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
  if (plan.tryWith.kind === "chat") return renderChat(box, plan.tryWith.model);
  if (plan.tryWith.kind === "image") return renderImage(box, plan.tryWith);
  if (plan.tryWith.kind === "transcribe") return renderTranscribe(box, plan.tryWith);
}

function renderChat(box, modelName) {
  box.innerHTML = `<h3>Try it</h3>
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

function renderImage(box, t) {
  box.innerHTML = `<h3>Try it</h3>
    <div class="prompt-input">
      <textarea id="image-prompt" rows="2" placeholder="Describe a picture, for example: a lighthouse at dusk, oil painting"></textarea>
      <button class="primary" id="image-go">Generate</button>
    </div>
    <pre class="log" id="image-log" hidden></pre>
    <div id="image-out"></div>`;
  $("#image-go").addEventListener("click", async () => {
    const prompt = $("#image-prompt").value.trim();
    if (!prompt) return;
    const log = $("#image-log");
    log.hidden = false;
    log.textContent = "";
    $("#image-go").disabled = true;
    try {
      const { id } = await api.post("/api/run", { kind: "generate-image", args: { repo: t.repo, file: t.file, prompt } });
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
    ["stable-diffusion.cpp", r.sd.installed ? "installed" : "not installed"],
    ["ffmpeg", r.ffmpeg ? "installed" : "not installed (only needed for non-WAV recordings)"],
  ];
  $("#runner-list").innerHTML = rows.map(([k, v]) => `<li><span>${k}</span><span class="muted">${esc(v)}</span></li>`).join("");
}

$("#open-settings").addEventListener("click", () => ($("#settings").hidden = false));
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
$("#clear-token").addEventListener("click", async () => {
  await api.post("/api/settings", { HF_TOKEN: "" });
  await load();
});

load().catch((err) => notice(`HuggingFound could not start: ${err.message}`, "bad"));
