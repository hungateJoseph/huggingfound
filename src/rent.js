// Renting a GPU by the hour for the chat server, so nobody has to set one
// up by hand. HuggingFound asks RunPod for a machine with Ollama on it,
// points the chat server at it, stops it when it has sat idle, and deletes
// it on request. The user pays RunPod while it runs; nothing is billed
// through HuggingFound.

import crypto from "node:crypto";
import { AGENT_VERSION } from "./plans.js";
//
// Only RunPod is wired in. Its API (api.runpod.io/v2) creates a pod from a
// container image, reports its status and hourly cost, and exposes an HTTP
// port through a proxy address made from the pod's id.

export const RUNPOD_BASE = "https://api.runpod.io/v2";
// The machine image: Ollama for chat models plus stable-diffusion.cpp and
// the agent for image models (gpu/ in this repository). HUGGINGFOUND_GPU_IMAGE
// points at another build, such as a fork's.
export const GPU_IMAGE = process.env.HUGGINGFOUND_GPU_IMAGE || "ghcr.io/hungatejoseph/huggingfound-gpu:latest";
// The plain Ollama image, used when the full one cannot be pulled (not
// published yet, or the package not public): chat models only.
export const OLLAMA_IMAGE = "ollama/ollama";
// To keep the image private: a container registry login saved in the
// renter's own RunPod account (Settings, Container registry auth) and
// chosen in HuggingFound's Settings, passed with each pod so RunPod can
// pull the image with it. HUGGINGFOUND_GPU_REGISTRY sets it for a
// single-owner app without the Settings step.
export const GPU_REGISTRY_AUTH = process.env.HUGGINGFOUND_GPU_REGISTRY || "";
export const OLLAMA_PORT = 11434;
export const AGENT_PORT = 7860;

// Whether RunPod will be able to pull the full image: the registry has to
// hand out an anonymous token and the manifest. Checked before each rental,
// so image support appears by itself once the package is public.
export async function imagePullable(image = GPU_IMAGE, fetchImpl = fetch) {
  const m = /^ghcr\.io\/([^:]+):([^:]+)$/.exec(image);
  if (!m) return true;
  try {
    const token = await fetchImpl(`https://ghcr.io/token?scope=repository:${m[1]}:pull`, { signal: AbortSignal.timeout(6000) });
    if (!token.ok) return false;
    const { token: bearer } = await token.json();
    const res = await fetchImpl(`https://ghcr.io/v2/${m[1]}/manifests/${m[2]}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json" }, signal: AbortSignal.timeout(6000) });
    return res.ok;
  } catch {
    return false;
  }
}
// Where Ollama keeps its models inside the container; the rented disk is
// mounted there so models survive a stop and start.
const MODELS_PATH = "/root/.ollama";
const CONTAINER_DISK_GB = 20;
const OPTIONS_TTL = 15 * 60e3;
// What RunPod charges for a pod's volume disk, in dollars a GB a month:
// doubled while the pod is stopped, which is when it is easiest to forget.
export const DISK_RUNNING = 0.1;
export const DISK_STOPPED = 0.2;
export function diskPerDay(gb, running) {
  return Math.round(((Number(gb) || 0) * (running ? DISK_RUNNING : DISK_STOPPED) / 30) * 10000) / 10000;
}
// A machine at or above this price an hour gets the short idle default.
export const PRICEY = 2;
// Machines on the account other than this one, and the account's bill, are
// asked about this often at most.
const OTHERS_TTL = 5 * 60e3;
const SPEND_TTL = 10 * 60e3;
// After RunPod throttles the key, nothing is asked of it for this long;
// callers get what was last known instead of piling on.
const BACKOFF_MS = 30e3;
// What this app will ever ask of RunPod for one key, well under RunPod's
// own limits (180 a minute, 7,200 an hour, 86,400 a day): a page bug can
// make the app busy, but it cannot spend a person's key. A minute holds
// the status polls of a starting machine, a stop, and a look at the
// account's other machines and its bill with room to spare.
const BUDGET = { minute: 60, hour: 600 };

// The sizes offered, by GPU memory. `files` is the largest model file each
// one runs comfortably: a 4-bit model wants its own size plus room for the
// conversation. The thresholds match machine.js (90% of the memory is
// usable, 80% of that is a comfortable fit).
// The machine image's image server is compiled for NVIDIA Ampere, Ada and
// Hopper cards (compute 8.0 to 9.0) against CUDA 12.4. Newer Blackwell
// cards and older Turing or Volta ones would fail at the first picture, so
// they are never picked, and the host has to offer CUDA 12.4 or newer.
export const MIN_CUDA = "12.4";
const UNSUPPORTED_GPU = /\b(50\d0|B100|B200|B300|GB200|GB300|RTX PRO|V100|T4|P100|P40|A2|2080|2070|2060|TITAN)\b/i;
export function gpuSupported(gpu) {
  return (gpu.manufacturer ?? "NVIDIA") === "NVIDIA" && !UNSUPPORTED_GPU.test(String(gpu.id ?? "") + " " + String(gpu.name ?? ""));
}

export const TIERS = [
  { gb: 24, min: 20, max: 32, files: 17, examples: "30B-class models at 4-bit" },
  { gb: 48, min: 40, max: 64, files: 34, examples: "70B-class models at 4-bit" },
  { gb: 80, min: 80, max: 100, files: 57, examples: "100B-class models, or 70B at higher quality" },
  { gb: 141, min: 140, max: 200, files: 100, examples: "the biggest open models, such as 200B-class at 4-bit" },
  // Several cards in one machine, for the models no single card holds: the
  // Python worker spreads a model's parts across them.
  { gb: 282, count: 2, min: 140, max: 200, files: 200, examples: "two 141 GB cards: the largest video models in full precision" },
  { gb: 564, count: 4, min: 140, max: 200, files: 400, examples: "four 141 GB cards: the very largest models" },
];

// How a size reads: "48 GB GPU", or "2 × 141 GB GPUs".
export function tierLabel(t) {
  return t.count > 1 ? `${t.count} × ${t.gb / t.count} GB GPUs` : `${t.gb} GB GPU`;
}

export function tierFor(fileGb) {
  if (!fileGb) return null;
  return TIERS.find((t) => fileGb <= t.files) ?? null;
}

export class RentError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// `env()` reads the saved settings and `save(updates)` writes them: the
// RunPod key, the id of the pod HuggingFound made, and the chat server
// address, which the rental owns while a pod exists.
// The secret each rented machine's agent is started with, by the machine's
// address, so every call to it from this server carries the secret: the
// rental's own calls, and the ones runners.js makes on the site's behalf.
const agentTokens = new Map();
export function agentAuth(url) {
  for (const [agent, token] of agentTokens) if (url === agent || String(url).startsWith(`${agent}/`)) return { Authorization: `Bearer ${token}`, "X-Agent-Token": token };
  return {};
}
export function agentFetch(fetchImpl) {
  return (url, init = {}) => {
    const auth = agentAuth(String(url));
    return Object.keys(auth).length ? fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), ...auth } }) : fetchImpl(url, init);
  };
}

export function createRental({ env, save, fetchImpl = fetch, base = RUNPOD_BASE, proxyUrl = (id) => `https://${id}-${OLLAMA_PORT}.proxy.runpod.net`, agentUrl = (id) => `https://${id}-${AGENT_PORT}.proxy.runpod.net`, image = GPU_IMAGE, registry = GPU_REGISTRY_AUTH, imageCheck = (img) => imagePullable(img, fetchImpl), statusTtl = 4000, now = Date.now, budget = BUDGET }) {
  let options = { at: 0, key: "", tiers: null };
  let last = null;
  let lastAt = 0;
  let inFlight = null;
  let throttledUntil = 0;
  let throttledKey = "";
  const spent = [];
  // When the machine was last used, kept in the settings so a restart of
  // this server does not hand the machine another idle period.
  let lastActivity = Number(env().RUNPOD_LAST_ACTIVITY) || now();
  let lastActivitySaved = 0;
  let lastLease = 0;
  let lastSpendCheck = 0;
  // What today's machines have cost, in dollars, across stops, starts and
  // replaced machines: added up from the running time RunPod reports at each
  // look, kept in the settings so a restart of this server keeps the count,
  // and started afresh at midnight UTC.
  let meter = readMeter();
  let meterSaved = 0;
  function readMeter() {
    const [day, usd, id, seconds] = String(env().RUNPOD_SPENT ?? "").split("|");
    return { day: day || "", usd: Number(usd) || 0, id: id || "", seconds: Number(seconds) || 0 };
  }
  const today = () => new Date(now()).toISOString().slice(0, 10);
  function meterAdd(pod, uptime) {
    if (meter.day !== today()) meter = { day: today(), usd: 0, id: "", seconds: 0 };
    const cost = typeof pod.cost === "number" ? pod.cost : 0;
    // The running time counts from the last start; a restart begins at zero.
    const delta = meter.id === pod.id && uptime >= meter.seconds ? uptime - meter.seconds : uptime;
    meter.id = pod.id;
    meter.seconds = uptime;
    if (cost && delta > 0) meter.usd += (cost * delta) / 3600;
    if (now() - meterSaved > 60e3 || delta === uptime) saveMeter();
  }
  const spentToday = () => (meter.day === today() ? Math.round(meter.usd * 100) / 100 : 0);
  function saveMeter() {
    meterSaved = now();
    try {
      save({ RUNPOD_SPENT: `${meter.day}|${meter.usd.toFixed(4)}|${meter.id}|${Math.round(meter.seconds)}` });
    } catch {
      // the settings file is not essential here
    }
  }
  const noteActivity = () => {
    lastActivity = now();
    if (now() - lastActivitySaved > 60e3) {
      lastActivitySaved = now();
      try {
        save({ RUNPOD_LAST_ACTIVITY: String(lastActivity) });
      } catch {
        // the settings file is not essential here
      }
    }
    renewLease();
  };
  // Dollars a running session may cost before it is stopped; 0 for no cap.
  const maxSpend = () => {
    const raw = env().RUNPOD_MAX_SPEND;
    if (raw === undefined || raw === "") return 50;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 50;
  };
  // The machine keeps its own idle watch and stops itself unless the site
  // renews a lease; the site renews it while it sees activity, at most
  // once a minute, straight to the machine, never through RunPod.
  function renewLease() {
    const id = podId();
    if (!id || !hasAgent() || now() - lastLease < 60e3) return;
    lastLease = now();
    agentCall(`${agentFor(id)}/lease`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ minutes: idleMinutes() || 60 }), signal: AbortSignal.timeout(4000) }).catch(() => {});
  }
  // Whether the machine says it is working: a picture or clip the browser
  // asked it for directly, or a download of its own. Asked of the machine,
  // never of RunPod; a machine that does not answer is not working.
  // Whether the machine is working on something: true, false, or null when
  // it cannot be asked (a dropped link, a proxy hiccup), which is not idle.
  async function machineBusy() {
    const id = podId();
    if (!id || !hasAgent()) return false;
    try {
      const res = await agentCall(`${agentFor(id)}/health`, { signal: AbortSignal.timeout(4000) });
      if (!res.ok) return null;
      return Boolean((await res.json()).busy);
    } catch {
      return null;
    }
  }
  // Since when the machine could not be asked whether it is busy. Not
  // knowing holds an idle stop for a while; a machine unreachable for half
  // an hour is taken at its idle clock after all.
  let busyUnknownSince = 0;
  // Since when the day's cap has been reached with someone at the site: the
  // stop is announced first, and comes ten minutes later unless the cap is
  // raised meanwhile. Nobody there, it comes at once.
  let capGraceSince = 0;
  const CAP_GRACE_MS = 10 * 60e3;
  // Downloads in progress, each with when it began: one that never ends
  // (a stuck connection, a lost page) cannot keep the machine awake and
  // billing for ever.
  let holdList = [];
  const HOLD_MAX_MS = 6 * 3600e3;
  const holds = () => (holdList = holdList.filter((h) => now() - h.at < HOLD_MAX_MS)).length;
  let watching = null;

  const key = () => env().RUNPOD_API_KEY || "";
  const podId = () => env().RUNPOD_POD_ID || "";
  // The registry login for this rental: the one chosen in Settings, or the app-wide one.
  const registryAuth = () => env().RUNPOD_REGISTRY_AUTH || registry || "";
  // The machine's price an hour, saved when it was rented, for the defaults
  // that depend on it.
  const pricePerHour = () => Number(env().RUNPOD_POD_COST) || last?.costPerHour || 0;
  // Minutes without a chat or download before the machine is stopped; 0
  // never stops it. Unset, half an hour on a cheap machine and ten minutes
  // on one costing PRICEY dollars an hour or more, where half an hour
  // forgotten is real money.
  // Half an hour, whatever the card costs: a dear machine mid-clip is worth
  // more than the minutes saved, and the idle watch never stops a working one.
  const idleDefault = () => 30;
  const idleMinutes = () => {
    const raw = env().RUNPOD_IDLE_MINUTES;
    if (raw === undefined || raw === "") return idleDefault(pricePerHour());
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : idleDefault(pricePerHour());
  };
  const urlFor = (id) => proxyUrl(id);
  const agentFor = (id) => agentUrl(id);
  // The machine's secret, kept with the rental and known by address.
  const agentToken = () => env().RUNPOD_AGENT_TOKEN || "";
  const registerToken = () => {
    const id = podId();
    if (id && agentToken()) agentTokens.set(agentFor(id), agentToken());
  };
  registerToken();
  const agentCall = (url, init = {}) => fetchImpl(url, { ...init, headers: { ...(init.headers ?? {}), ...agentAuth(url) } });

  // Whether another call to RunPod is allowed right now, within the budget.
  function withinBudget() {
    const t = now();
    while (spent.length && spent[0] < t - 3600e3) spent.shift();
    return spent.filter((at) => at > t - 60e3).length < budget.minute && spent.length < budget.hour;
  }

  async function request(method, path, body) {
    if (!key()) {
      if (podId()) throw new RentError(`The RunPod key is gone but a machine is still rented. Enter the key of the account that rented it, in Settings, to stop or delete it. Meanwhile it stops by itself after ${idleMinutes() || 1440} minutes without use.`, 400);
      throw new RentError("Add a RunPod API key in Settings to rent a GPU.", 400);
    }
    // A back-off belongs to the key that was throttled; a fresh key starts clean.
    if (throttledKey === key() && now() < throttledUntil) throw new RentError(`RunPod has stopped answering this account for now; it accepts requests again in ${waitText(throttledUntil - now())}. The daily allowance is shared by every key on the account.`, 429);
    if (!withinBudget()) throw new RentError("HuggingFound has asked RunPod enough for the moment; it asks again in a minute.", 429);
    spent.push(now());
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new RentError(`RunPod did not answer (${err.name === "TimeoutError" ? "timed out" : err.message}).`, 502);
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.status === 401 || res.status === 403) throw new RentError("RunPod refused the API key. Check it in Settings; it needs permission to manage pods.", 401);
    if (res.status === 404) throw new RentError("RunPod has no such machine any more.", 404);
    if (res.status === 429) {
      // RunPod says how long to wait; otherwise half a minute. Logged with
      // its policy, so a server's log shows what tripped it.
      const retryAfter = Number(res.headers.get("retry-after")) || 0;
      const reset = Number(res.headers.get("ratelimit-reset") || res.headers.get("x-ratelimit-reset")) || 0;
      // A spent daily allowance means hours; the wait is honoured up to a day.
      const waitMs = Math.min((retryAfter || reset) * 1000 || BACKOFF_MS, 86400e3);
      throttledUntil = now() + waitMs;
      throttledKey = key();
      console.error(`RunPod rate limited ${method} ${path}: retry-after=${res.headers.get("retry-after") ?? "-"} ratelimit=${res.headers.get("ratelimit") ?? res.headers.get("x-ratelimit-remaining") ?? "-"} policy=${res.headers.get("ratelimit-policy") ?? "-"}`);
      throw new RentError(`RunPod has stopped answering this account for now; it accepts requests again in ${waitText(waitMs)}. The daily allowance is shared by every key on the account.`, 429);
    }
    if (!res.ok) throw new RentError(`RunPod answered HTTP ${res.status}${describe(data) ? `: ${describe(data)}` : ""}.`, 502);
    return data;
  }

  // The GPUs on offer right now, folded into the tiers: for each size, the
  // cards with free capacity for that many of them on one host, cheapest
  // first, with their price an hour. RunPod's stock is per count and per
  // CUDA floor: a card free on its own may have no host with two free, and
  // the machine image needs CUDA 12.4, so the catalogue is asked exactly
  // what renting will ask, once per card count.
  async function catalog(count) {
    return request("GET", `/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE&count=${count}&minCudaVersion=${MIN_CUDA}`);
  }
  async function tiers({ fresh = false } = {}) {
    if (!fresh && options.tiers && options.key === key() && now() - options.at < OPTIONS_TTL) return options.tiers;
    const lists = {};
    try {
      for (const count of [...new Set(TIERS.map((t) => t.count ?? 1))]) lists[count] = (await catalog(count))?.gpus ?? [];
    } catch (err) {
      // Throttled: yesterday's prices beat no prices.
      if (err.status === 429 && options.tiers && options.key === key()) return options.tiers;
      throw err;
    }
    const byPrice = (a, b) => a.price.secure - b.price.secure;
    const out = TIERS.map((tier) => {
      const count = tier.count ?? 1;
      const gpus = lists[count].filter((g) => g.secure !== false && Number(g.memory) > 0 && gpuSupported(g));
      // A host holds at most so many of a card; a size asking for more than that is not on offer.
      const inTier = gpus.filter((g) => g.memory >= tier.min && g.memory <= tier.max && typeof g.price?.secure === "number" && !(Number(g.maxCount?.secure) >= 1 && g.maxCount.secure < count));
      const free = inTier.filter((g) => g.availability && g.availability !== "NONE").sort(byPrice);
      const pick = free[0] ?? inTier.sort(byPrice)[0] ?? null;
      const card = (g) => ({ id: g.id, name: g.name || g.id, memory: g.memory, availability: g.availability ?? "UNKNOWN", pricePerHour: g.price.secure * count });
      return {
        gb: tier.gb,
        count,
        label: tierLabel(tier),
        files: tier.files,
        examples: tier.examples,
        gpu: pick ? card(pick) : null,
        pricePerHour: pick ? pick.price.secure * count : null,
        available: Boolean(free.length),
        cards: free.map(card),
      };
    });
    options = { at: now(), key: key(), tiers: out };
    return out;
  }

  function summarize(pod, ready, imagesReady = false, counts = {}) {
    const cost = typeof pod.cost === "number" ? pod.cost : null;
    const uptime = pod.runtime?.uptime ?? (pod.status === "RUNNING" && pod.startedAt ? Math.max(0, (now() - new Date(pod.startedAt).getTime()) / 1000) : 0);
    // The pod's own gpu.memory is the machine's system RAM, not the card's;
    // the card's memory was saved from the catalogue when it was rented.
    const gb = Number(env().RUNPOD_POD_GB) || null;
    const diskGb = pod.mounts?.persistent?.size ?? (Number(env().RUNPOD_POD_DISK_GB) || null);
    const running = pod.status === "RUNNING";
    if (running) meterAdd(pod, uptime);
    return {
      rented: true,
      id: pod.id,
      status: pod.status ?? "UNKNOWN",
      ready: Boolean(ready),
      gpu: pod.gpu?.id ?? "",
      gpuCount: pod.gpu?.count ?? 1,
      gb,
      diskGb,
      // What the disk costs a day in the machine's present state: RunPod
      // charges twice as much for it while the machine is stopped.
      diskPerDay: diskGb ? diskPerDay(diskGb, running) : null,
      costPerHour: cost,
      uptimeSeconds: Math.round(uptime),
      spent: cost != null ? Math.round(cost * (uptime / 3600) * 100) / 100 : null,
      spentToday: spentToday(),
      url: urlFor(pod.id),
      agent: hasAgent() ? agentFor(pod.id) : null,
      // The secret the page sends with every call to the agent; the owner's alone.
      agentToken: hasAgent() ? agentToken() || null : null,
      images: hasAgent(),
      imagesReady: Boolean(imagesReady),
      agentRefused: Boolean(counts.agentRefused),
      // When the announced stop at the cap comes, if one is announced.
      capGraceUntil: capGraceSince && pod.status === "RUNNING" ? capGraceSince + CAP_GRACE_MS : null,
      // How many models the machine holds, so the page can say so at a glance.
      chatModels: counts.chat ?? 0,
      imageModels: counts.images ?? 0,
      // Set when the agent reports its image server cannot start on this machine.
      imageProblem: counts.imageProblem ?? "",
      agentVersion: counts.agentVersion ?? null,
      agentCurrent: AGENT_VERSION,
      idleMinutes: idleMinutes(),
      idleSeconds: Math.round((now() - lastActivity) / 1000),
      maxSpend: maxSpend(),
      // Why it last stopped by itself: "idle:30", "cap:50", "away:10" or "done".
      stopReason: pod.status === "EXITED" ? env().RUNPOD_LAST_STOP || null : null,
      dataCenter: pod.dataCenterId ?? null,
      startedAt: pod.startedAt ?? null,
    };
  }

  // Asks the machine's Ollama or agent; the parsed answer, or null when it does not answer.
  // Whether the agent last answered the site's secret with a refusal: then
  // the machine is up and reachable, and waiting for it would be for ever.
  let agentRefused = false;
  async function probe(url, path = "/api/tags") {
    try {
      const res = await fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(4000) });
      if (path === "/health") agentRefused = res.status === 401;
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  }

  // Clears every trace of the pod from the settings, including the chat
  // server address when it is the pod's.
  // Whether the machine was made from the full image, with the image agent.
  const hasAgent = () => env().RUNPOD_POD_AGENT === "1";

  function forget(id) {
    const updates = { RUNPOD_POD_ID: "", RUNPOD_POD_GB: "", RUNPOD_POD_DISK_GB: "", RUNPOD_POD_AGENT: "", RUNPOD_POD_COST: "", RUNPOD_AGENT_TOKEN: "" };
    if (id) agentTokens.delete(agentFor(id));
    if (id && env().OLLAMA_SERVER === urlFor(id)) {
      updates.OLLAMA_SERVER = "";
      updates.OLLAMA_SERVER_GB = "";
    }
    if (id && env().GPU_AGENT === agentFor(id)) updates.GPU_AGENT = "";
    save(updates);
    last = null;
    // The account's picture has changed: the other machines are asked for afresh.
    othersCache = { at: 0, key: "", list: null };
  }

  // While the machine runs, chat models go to its Ollama and image models
  // to its agent; both settings are the rental's to set and clear.
  function point(id, gb) {
    save({ OLLAMA_SERVER: urlFor(id), OLLAMA_SERVER_GB: String(gb), GPU_AGENT: hasAgent() ? agentFor(id) : "" });
  }

  function unpoint(id) {
    const updates = {};
    if (env().OLLAMA_SERVER === urlFor(id)) Object.assign(updates, { OLLAMA_SERVER: "", OLLAMA_SERVER_GB: "" });
    if (env().GPU_AGENT === agentFor(id)) updates.GPU_AGENT = "";
    if (Object.keys(updates).length) save(updates);
  }

  // The other HuggingFound machines on the same RunPod account: ones this
  // site no longer tracks (rented in an earlier session, under a key since
  // removed, or by a guest whose time ran out), each still charging for its
  // disk while it sits stopped.
  let othersCache = { at: 0, key: "", list: null };
  function describeOther(p) {
    const running = ["RUNNING", "STARTING", "PROVISIONING"].includes(p.status);
    const gb = p.mounts?.persistent?.size ?? 0;
    return { id: p.id, status: p.status ?? "UNKNOWN", gpu: p.gpu?.id ?? "", gpuCount: p.gpu?.count ?? 1, diskGb: gb, costPerHour: typeof p.cost === "number" ? p.cost : null, running, diskPerDay: diskPerDay(gb, running), createdAt: p.createdAt ?? null };
  }
  async function others({ fresh = false } = {}) {
    if (!key()) return [];
    if (!fresh && othersCache.list && othersCache.key === key() && now() - othersCache.at < OTHERS_TTL) return othersCache.list;
    let data;
    try {
      data = await request("GET", "/pods?limit=200");
    } catch (err) {
      if (err.status === 429 && othersCache.list && othersCache.key === key()) return othersCache.list;
      throw err;
    }
    const pods = Array.isArray(data) ? data : data?.pods ?? [];
    const list = pods.filter((p) => p?.name === "huggingfound" && p.id !== podId() && p.status !== "TERMINATED").map(describeOther);
    othersCache = { at: now(), key: key(), list };
    return list;
  }
  // The account's pod bill from RunPod, by day and by machine, for the last
  // week: GPU time apart from disks, so it is plain where the money went.
  let spendCache = { at: 0, key: "", data: null };
  async function spend() {
    if (spendCache.data && spendCache.key === key() && now() - spendCache.at < SPEND_TTL) return spendCache.data;
    let data;
    try {
      data = await request("GET", "/billing/pods?lastN=7&bucketSize=day");
    } catch (err) {
      if (err.status === 429 && spendCache.data && spendCache.key === key()) return spendCache.data;
      throw err;
    }
    const zero = () => ({ total: 0, gpu: 0, disk: 0 });
    const days = new Map();
    const pods = new Map();
    const add = (m, k, r) => {
      const cur = m.get(k) ?? zero();
      cur.total += Number(r.totalAmount) || 0;
      cur.gpu += Number(r.gpuAmount) || 0;
      cur.disk += Number(r.diskAmount) || 0;
      m.set(k, cur);
    };
    for (const r of data?.records ?? []) {
      add(days, String(r.startTime ?? "").slice(0, 10), r);
      add(pods, String(r.podId ?? ""), r);
    }
    const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 1000) / 1000]));
    const total = zero();
    for (const v of days.values()) {
      total.total += v.total;
      total.gpu += v.gpu;
      total.disk += v.disk;
    }
    const out = {
      days: [...days].map(([day, v]) => ({ day, ...round(v) })).sort((a, b) => (a.day < b.day ? 1 : -1)),
      pods: [...pods].map(([id, v]) => ({ id, ours: Boolean(id) && id === podId(), ...round(v) })).sort((a, b) => b.total - a.total),
      total: round(total),
      today: round(days.get(today()) ?? zero()),
      metered: spentToday(),
    };
    spendCache = { at: now(), key: key(), data: out };
    return out;
  }

  const self = {
    configured: () => Boolean(key()),
    others,
    spend,
    spentToday,
    pricePerHour,
    // Deletes the other machines on the account (the given ids, or all of
    // them), disks and models included; nothing is charged for them after.
    async removeOthers(ids = null) {
      const list = await others({ fresh: true });
      const gone = [];
      for (const o of list) {
        if (ids && !ids.includes(o.id)) continue;
        try {
          await request("DELETE", `/pods/${encodeURIComponent(o.id)}`);
        } catch (err) {
          if (err.status !== 404) throw err;
        }
        gone.push(o.id);
      }
      othersCache = { at: 0, key: "", list: null };
      spendCache = { at: 0, key: "", data: null };
      return gone;
    },
    // The registry logins saved in the RunPod account, by name, for Settings to offer.
    async registries() {
      const data = await request("GET", "/registries");
      return (data?.registries ?? []).map((r) => ({ id: String(r.id), name: String(r.name ?? r.id) }));
    },
    rentedUrl: () => (podId() ? urlFor(podId()) : ""),
    rentedAgent: () => (podId() ? agentFor(podId()) : ""),
    // Whether the chat server (or image agent) in use is the rented machine.
    owns: (url) => Boolean(url) && Boolean(podId()) && (url === urlFor(podId()) || url === agentFor(podId())),
    tiers,
    // What was last learned from RunPod, with the settings that can change
    // without asking RunPod (the idle time) read live.
    cached: () => (podId() ? { ...(last ?? { rented: true, id: podId(), status: "UNKNOWN", ready: false, images: hasAgent(), imagesReady: false, gb: Number(env().RUNPOD_POD_GB) || null, url: urlFor(podId()), agent: hasAgent() ? agentFor(podId()) : null, agentToken: hasAgent() ? agentToken() || null : null }), idleMinutes: idleMinutes(), idleSeconds: Math.round((now() - lastActivity) / 1000) } : { rented: false }),
    touch() {
      noteActivity();
    },
    idleMinutes,
    maxSpend,
    // A download in progress keeps the machine awake however long it takes (within the hold limit).
    hold() {
      const h = { at: now() };
      holdList.push(h);
      noteActivity();
      return () => {
        holdList = holdList.filter((x) => x !== h);
        noteActivity();
      };
    },

    async status({ probe: wantProbe = true } = {}) {
      const id = podId();
      if (!id) return { rented: false };
      // Several parts of a page ask at once; one answer serves them all,
      // and a fresh one is not fetched again within a few seconds.
      if (last && last.id === id && now() - lastAt < statusTtl && (last.ready || !wantProbe)) return last;
      if (inFlight) return inFlight;
      inFlight = fetchStatus(id, wantProbe).finally(() => (inFlight = null));
      return inFlight;
    },
  };

  async function fetchStatus(id, wantProbe) {
    {
      let pod;
      try {
        pod = await request("GET", `/pods/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err.status === 404) {
          forget(id);
          return { rented: false, gone: true };
        }
        // A key problem or an outage: say so, but keep what was known.
        return { ...(last ?? { rented: true, id, status: "UNKNOWN", url: urlFor(id), gb: Number(env().RUNPOD_POD_GB) || null, diskGb: Number(env().RUNPOD_POD_DISK_GB) || null, idleMinutes: idleMinutes() }), error: err.message };
      }
      if (pod.status === "TERMINATED") {
        forget(id);
        return { rented: false, gone: true };
      }
      const running = pod.status === "RUNNING";
      let ready = Boolean(last?.ready) && running;
      let imagesReady = Boolean(last?.imagesReady) && running;
      let counts = { chat: last?.chatModels ?? 0, images: last?.imageModels ?? 0, imageProblem: last?.imageProblem ?? "", agentVersion: last?.agentVersion ?? null, agentRefused: last?.agentRefused ?? false };
      if (running && wantProbe) {
        const [tags, health] = await Promise.all([probe(urlFor(id)), hasAgent() ? probe(agentFor(id), "/health") : null]);
        ready = Boolean(tags);
        imagesReady = Boolean(health?.ok);
        counts = { chat: tags?.models?.length ?? 0, images: health?.models ?? 0, imageProblem: health && health.sdOk === false ? String(health.sdProblem || "the image server cannot start") : "", agentVersion: health ? Number(health.version) || 1 : null, agentRefused };
      }
      last = summarize(pod, ready, imagesReady, counts);
      lastAt = now();
      return last;
    }
  }

  Object.assign(self, {
    // Rents a machine of the given size with Ollama on it and makes it the
    // chat server. The disk holds the models; it must be bigger than them.
    async rent({ gb, diskGb = 50, origins = [] } = {}) {
      const tier = TIERS.find((t) => t.gb === Number(gb));
      if (!tier) throw new RentError(`Pick a size: ${TIERS.map((t) => `${t.gb} GB`).join(", ")}.`);
      const disk = Math.round(Number(diskGb));
      if (!(disk >= 10 && disk <= 4000)) throw new RentError("The disk must be between 10 and 4000 GB.");
      if (podId()) {
        const current = await this.status({ probe: false });
        if (current.rented) throw new RentError("A machine is already rented. Stop or delete it first.", 409);
      }
      // One machine at a time on the account: another HuggingFound machine
      // running there, from an earlier session or another key, would bill
      // alongside this one. It is stopped or deleted first, from Settings.
      const running = (await others({ fresh: true }).catch(() => [])).filter((o) => o.running);
      if (running.length) throw new RentError(`Another HuggingFound machine is already running on this RunPod account (${running.map((o) => `${o.gpu || "GPU"}, ${o.costPerHour != null ? `$${o.costPerHour.toFixed(2)} an hour` : "billing"}, ${o.id}`).join("; ")}). One machine at a time: stop or delete it under Settings first.`, 409);
      let offer = (await tiers()).find((t) => t.gb === tier.gb);
      if (!offer?.gpu) throw new RentError(`RunPod lists no ${tier.gb} GB card right now.`, 503);
      if (!offer.available) throw new RentError(`Every ${tierLabel(tier)} at RunPod is taken right now. Try another size or try again later.`, 503);
      // Browsers may talk to the machine directly from these origins (the
      // hosted site's address, or the app's own); Ollama and the agent
      // refuse other sites' pages.
      // The machine's own idle watch gets the same idle time, which for an
      // unset setting depends on this machine's price.
      const raw = env().RUNPOD_IDLE_MINUTES;
      const machineIdle = raw === undefined || raw === "" || !(Number(raw) >= 0) ? idleDefault(offer.pricePerHour ?? 0) : Math.round(Number(raw));
      // A secret of this machine's own: its agent answers nobody without it.
      const secret = crypto.randomBytes(24).toString("hex");
      const podEnv = { OLLAMA_HOST: "0.0.0.0", OLLAMA_KEEP_ALIVE: "1h", HF_IDLE_MINUTES: String(machineIdle), HF_AGENT_TOKEN: secret };
      const allowed = origins.filter((o) => /^https?:\/\/[\w.-]+(?::\d+|:\*)?$/.test(String(o)));
      if (allowed.length) {
        podEnv.OLLAMA_ORIGINS = allowed.join(",");
        podEnv.HF_ORIGINS = allowed.join(",");
      }
      // The full image when it can be pulled, otherwise plain Ollama: a
      // machine for chat models only, rather than no machine. With a
      // registry credential the image is private and RunPod pulls it with
      // that, so the public check is skipped.
      const auth = registryAuth();
      const full = auth ? true : await imageCheck(image);
      const count = tier.count ?? 1;
      // Stock moves between the listing and the request. A card RunPod has
      // just run out of is answered with a 400; the catalogue is asked
      // again and the next free card of the size is tried, a few times.
      const tried = [];
      let pod = null;
      let pick = null;
      while (!pod && tried.length < 3) {
        pick = (offer?.cards ?? [offer?.gpu]).find((c) => c && !tried.some((t) => t.id === c.id)) ?? null;
        if (!pick) break;
        tried.push(pick);
        try {
          pod = await request("POST", "/pods", {
            name: "huggingfound",
            image: full ? image : OLLAMA_IMAGE,
            ...(full && auth ? { registry: auth } : {}),
            gpu: { id: pick.id, count, minCudaVersion: MIN_CUDA },
            cloud: "SECURE",
            disk: CONTAINER_DISK_GB,
            ports: full ? [`${OLLAMA_PORT}/http`, `${AGENT_PORT}/http`] : [`${OLLAMA_PORT}/http`],
            env: podEnv,
            mounts: { persistent: { size: disk, path: MODELS_PATH } },
          });
        } catch (err) {
          if (!(err.status === 502 && /no longer any instances|not enough free|no capacity|out of stock|not available/i.test(err.message))) throw err;
          offer = (await tiers({ fresh: true }).catch(() => null))?.find((t) => t.gb === tier.gb) ?? offer;
        }
      }
      if (!pod) {
        throw new RentError(`RunPod ran out of ${tierLabel(tier)} hosts between listing them and renting one${tried.length ? ` (tried ${tried.map((t) => t.name).join(", ")})` : ""}. The sizes have been refreshed: pick again, or try in a few minutes${disk > 200 ? "; a very large disk also narrows the hosts that qualify" : ""}.`, 503);
      }
      if (!pod?.id) throw new RentError("RunPod did not return a machine id.", 502);
      const totalGb = (pick.memory || tier.gb / count) * count;
      lastActivity = now();
      save({ RUNPOD_POD_ID: pod.id, RUNPOD_POD_GB: String(totalGb), RUNPOD_POD_DISK_GB: String(disk), RUNPOD_POD_AGENT: full ? "1" : "", RUNPOD_POD_COST: String(pick.pricePerHour ?? offer?.pricePerHour ?? pod.cost ?? ""), RUNPOD_AGENT_TOKEN: secret, RUNPOD_LAST_STOP: "", RUNPOD_LAST_ACTIVITY: String(now()) });
      registerToken();
      othersCache = { at: 0, key: "", list: null };
      point(pod.id, totalGb);
      lastActivity = now();
      last = summarize(pod, false);
      return last;
    },

    // Stops the machine: the hourly charge ends, the disk and its models
    // stay (for a small charge), and Start brings it back.
    async stop({ reason = "" } = {}) {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
      // The page's still-there check stops a machine nobody is watching;
      // one at work on a request (asked from this window or another) is
      // not that machine, and stays up until the request is done.
      if (reason.startsWith("away") && (await machineBusy()) === true) {
        const e = new RentError("The machine is working on a request, so it stays up; the still-there check never stops one mid-request. It stops when idle, or from the bar.", 409);
        e.busy = true;
        throw e;
      }
      if (reason) save({ RUNPOD_LAST_STOP: reason });
      try {
        await request("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "stop" });
      } catch (err) {
        if (err.status === 404) {
          forget(id);
          return { rented: false, gone: true };
        }
        // Already stopped is fine.
        if (!/HTTP 409/.test(err.message)) throw err;
      }
      unpoint(id);
      saveMeter();
      return this.status({ probe: false });
    },

    async start() {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
      save({ RUNPOD_LAST_STOP: "", RUNPOD_LAST_ACTIVITY: String(now()) });
      lastActivity = now();
      try {
        await request("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "start" });
      } catch (err) {
        if (err.status === 404) {
          forget(id);
          return { rented: false, gone: true };
        }
        // A stopped machine's disk lives on one host; starting needs a free
        // card of its kind on that very host, which RunPod may not have.
        if (/not enough free GPUs|no free GPU|insufficient.*GPU/i.test(err.message)) {
          const e = new RentError("No free GPU on this machine's host right now: a stopped machine's disk is pinned to one host, and its card is taken. Try Start again in a while, or replace the machine with a fresh one of the same size; its models download again.", 503);
          e.noGpu = true;
          throw e;
        }
        if (!/HTTP 409/.test(err.message)) throw err;
      }
      point(id, Number(env().RUNPOD_POD_GB) || 24);
      lastActivity = now();
      return this.status({ probe: false });
    },

    // Restarts the machine's container in place: the same host, card and
    // disk, with a fresh agent. For a machine whose agent has lost track of
    // what its worker holds. A stopped machine is started instead.
    async restart() {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
      save({ RUNPOD_LAST_STOP: "", RUNPOD_LAST_ACTIVITY: String(now()) });
      lastActivity = now();
      try {
        await request("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "restart" });
      } catch (err) {
        if (err.status === 404) {
          forget(id);
          return { rented: false, gone: true };
        }
        if (/HTTP 409/.test(err.message)) return this.start();
        throw err;
      }
      point(id, Number(env().RUNPOD_POD_GB) || 24);
      last = null;
      return this.status({ probe: false });
    },

    // Grows the machine's disk; RunPod never shrinks one. A model bigger
    // than the disk is then fetched onto the same machine, with what the
    // disk already holds kept.
    async grow(diskGb) {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
      const disk = Math.round(Number(diskGb));
      const have = Number(env().RUNPOD_POD_DISK_GB) || 0;
      if (!(disk >= 10 && disk <= 4000)) throw new RentError("The disk must be between 10 and 4000 GB.");
      if (disk <= have) throw new RentError(`The disk is ${have} GB already; RunPod grows a disk but never shrinks one.`);
      let pod;
      try {
        pod = await request("PATCH", `/pods/${encodeURIComponent(id)}`, { mounts: { persistent: { size: disk, path: MODELS_PATH } } });
      } catch (err) {
        if (err.status === 404) {
          forget(id);
          return { rented: false, gone: true };
        }
        throw err;
      }
      save({ RUNPOD_POD_DISK_GB: String(Number(pod?.mounts?.persistent?.size) || disk) });
      last = null;
      return this.status({ probe: false });
    },

    // Deletes the machine and its disk; the models on it go with it.
    async remove() {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
      try {
        await request("DELETE", `/pods/${encodeURIComponent(id)}`);
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      forget(id);
      return { rented: false };
    },

    // Stops a machine nobody has used for the idle time. Called on a timer;
    // a download in progress, work the machine itself reports, or an idle
    // time of 0 keeps it running.
    async checkIdle() {
      const minutes = idleMinutes();
      if (!podId()) return false;
      let active = holds() > 0 || (minutes ? now() - lastActivity < minutes * 60e3 : true);
      // A session costing more than the cap stops whether or not it is in
      // use, but never in the middle of a picture, clip or download: it
      // stops as soon as that work ends. Looked at every few minutes, on
      // what RunPod last said.
      const cap = maxSpend();
      if (cap && now() - lastSpendCheck > 5 * 60e3 && (!last || last.id !== podId() || ["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(last.status))) {
        lastSpendCheck = now();
        const current = await this.status({ probe: false }).catch(() => null);
        const overCap = current?.rented && current.status === "RUNNING" && Math.max(current.spentToday ?? 0, current.spent ?? 0) >= cap;
        if (!overCap) capGraceSince = 0;
        if (overCap) {
          const busy = await machineBusy();
          if (busy === null) busyUnknownSince ||= now();
          else busyUnknownSince = 0;
          // Working, or not known to be idle for less than half an hour: asked
          // again at the next tick, not in five minutes.
          const present = now() - lastActivity < 10 * 60e3;
          if (present) capGraceSince ||= now();
          if (holds() > 0 || busy === true || (busy === null && now() - busyUnknownSince < 30 * 60e3) || (present && now() - capGraceSince < CAP_GRACE_MS)) {
            lastSpendCheck = now() - 4 * 60e3;
          } else {
            save({ RUNPOD_LAST_STOP: `cap:${cap}` });
            capGraceSince = 0;
            await this.stop();
            return true;
          }
        }
      }
      if (!active && minutes && !(last && last.id === podId() && !["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(last.status))) {
        const busy = await machineBusy();
        if (busy === true) {
          // The machine is working on something the site did not see start
          // (the browser asks it for pictures and clips directly): that is
          // activity, and the idle clock starts over.
          noteActivity();
          active = true;
          busyUnknownSince = 0;
        } else if (busy === null) {
          // Not known: a machine that may be mid-clip is not stopped on a
          // dropped link. Only one unreachable for half an hour is.
          busyUnknownSince ||= now();
          if (now() - busyUnknownSince < 30 * 60e3) return false;
        } else busyUnknownSince = 0;
      }
      if (active) {
        // In use: the machine's own watch is told so.
        renewLease();
        return false;
      }
      if (!minutes) return false;
      // A machine last seen stopped has nothing to stop; asking RunPod about
      // it every minute would only spend the account's allowance. It is
      // looked at again now and then, in case it was started elsewhere.
      if (last && last.id === podId() && !["RUNNING", "STARTING", "PROVISIONING", "UNKNOWN"].includes(last.status) && now() - lastAt < 15 * 60e3) return false;
      const current = await this.status({ probe: false }).catch(() => null);
      if (!current?.rented || current.status !== "RUNNING") return false;
      save({ RUNPOD_LAST_STOP: `idle:${minutes}` });
      await this.stop();
      return true;
    },

    watch(everyMs = 60e3) {
      if (watching) return;
      watching = setInterval(() => this.checkIdle().catch(() => {}), everyMs);
      watching.unref?.();
    },

    // When HuggingFound quits, a running machine is stopped so it does not
    // bill all night; its disk and models stay for next time.
    async stopOnQuit() {
      if (!podId() || env().RUNPOD_STOP_ON_QUIT === "0") return false;
      const current = await this.status({ probe: false }).catch(() => null);
      if (!current?.rented || !["RUNNING", "STARTING", "PROVISIONING"].includes(current.status)) return false;
      await this.stop();
      return true;
    },
  });
  return self;
}

// "40 seconds", "12 minutes" or "6 hours", for a wait.
function waitText(ms) {
  const s = Math.ceil(ms / 1000);
  if (s < 120) return `${s} seconds`;
  if (s < 7200) return `${Math.ceil(s / 60)} minutes`;
  return `${Math.ceil(s / 3600)} hours`;
}

function describe(data) {
  if (!data) return "";
  if (typeof data === "string") return data.slice(0, 200);
  const m = data.message ?? data.error ?? data.detail ?? "";
  return typeof m === "string" ? m.slice(0, 200) : "";
}
