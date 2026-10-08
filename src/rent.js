// Renting a GPU by the hour for the chat server, so nobody has to set one
// up by hand. HuggingFound asks RunPod for a machine with Ollama on it,
// points the chat server at it, stops it when it has sat idle, and deletes
// it on request. The user pays RunPod while it runs; nothing is billed
// through HuggingFound.
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
// After RunPod throttles the key, nothing is asked of it for this long;
// callers get what was last known instead of piling on.
const BACKOFF_MS = 30e3;
// What this app will ever ask of RunPod for one key, well under RunPod's
// own limits (180 a minute, 7,200 an hour, 86,400 a day): a page bug can
// make the app busy, but it cannot spend a person's key.
const BUDGET = { minute: 30, hour: 600 };

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
];

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
export function createRental({ env, save, fetchImpl = fetch, base = RUNPOD_BASE, proxyUrl = (id) => `https://${id}-${OLLAMA_PORT}.proxy.runpod.net`, agentUrl = (id) => `https://${id}-${AGENT_PORT}.proxy.runpod.net`, image = GPU_IMAGE, registry = GPU_REGISTRY_AUTH, imageCheck = (img) => imagePullable(img, fetchImpl), statusTtl = 4000, now = Date.now }) {
  let options = { at: 0, key: "", tiers: null };
  let last = null;
  let lastAt = 0;
  let inFlight = null;
  let throttledUntil = 0;
  let throttledKey = "";
  const spent = [];
  let lastActivity = now();
  let holds = 0;
  let watching = null;

  const key = () => env().RUNPOD_API_KEY || "";
  const podId = () => env().RUNPOD_POD_ID || "";
  // Minutes without a chat or download before the machine is stopped; 0 never stops it.
  // The registry login for this rental: the one chosen in Settings, or the app-wide one.
  const registryAuth = () => env().RUNPOD_REGISTRY_AUTH || registry || "";
  const idleMinutes = () => {
    const raw = env().RUNPOD_IDLE_MINUTES;
    if (raw === undefined || raw === "") return 30;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : 30;
  };
  const urlFor = (id) => proxyUrl(id);
  const agentFor = (id) => agentUrl(id);

  // Whether another call to RunPod is allowed right now, within the budget.
  function withinBudget() {
    const t = now();
    while (spent.length && spent[0] < t - 3600e3) spent.shift();
    return spent.filter((at) => at > t - 60e3).length < BUDGET.minute && spent.length < BUDGET.hour;
  }

  async function request(method, path, body) {
    if (!key()) throw new RentError("Add a RunPod API key in Settings to rent a GPU.", 400);
    // A back-off belongs to the key that was throttled; a fresh key starts clean.
    if (throttledKey === key() && now() < throttledUntil) throw new RentError(`RunPod is rate limiting this key; it accepts requests again in ${waitText(throttledUntil - now())}. A new key at RunPod works at once.`, 429);
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
      throw new RentError(`RunPod is rate limiting this key; it accepts requests again in ${waitText(waitMs)}. A new key at RunPod works at once.`, 429);
    }
    if (!res.ok) throw new RentError(`RunPod answered HTTP ${res.status}${describe(data) ? `: ${describe(data)}` : ""}.`, 502);
    return data;
  }

  // The GPUs on offer right now, folded into the tiers: the cheapest card
  // with free capacity in each size, with its price an hour.
  async function tiers() {
    if (options.tiers && options.key === key() && now() - options.at < OPTIONS_TTL) return options.tiers;
    let data;
    try {
      data = await request("GET", "/catalog/gpus?include=AVAILABILITY&product=POD&cloud=SECURE");
    } catch (err) {
      // Throttled: yesterday's prices beat no prices.
      if (err.status === 429 && options.tiers && options.key === key()) return options.tiers;
      throw err;
    }
    const gpus = (data?.gpus ?? []).filter((g) => g.secure !== false && Number(g.memory) > 0 && gpuSupported(g));
    const out = TIERS.map((tier) => {
      const inTier = gpus.filter((g) => g.memory >= tier.min && g.memory <= tier.max && typeof g.price?.secure === "number");
      const free = inTier.filter((g) => g.availability && g.availability !== "NONE").sort((a, b) => a.price.secure - b.price.secure);
      const pick = free[0] ?? inTier.sort((a, b) => a.price.secure - b.price.secure)[0] ?? null;
      return {
        gb: tier.gb,
        files: tier.files,
        examples: tier.examples,
        gpu: pick ? { id: pick.id, name: pick.name || pick.id, memory: pick.memory, availability: pick.availability ?? "UNKNOWN" } : null,
        pricePerHour: pick ? pick.price.secure : null,
        available: Boolean(free.length),
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
    return {
      rented: true,
      id: pod.id,
      status: pod.status ?? "UNKNOWN",
      ready: Boolean(ready),
      gpu: pod.gpu?.id ?? "",
      gpuCount: pod.gpu?.count ?? 1,
      gb,
      diskGb: pod.mounts?.persistent?.size ?? (Number(env().RUNPOD_POD_DISK_GB) || null),
      costPerHour: cost,
      uptimeSeconds: Math.round(uptime),
      spent: cost != null ? Math.round(cost * (uptime / 3600) * 100) / 100 : null,
      url: urlFor(pod.id),
      agent: hasAgent() ? agentFor(pod.id) : null,
      images: hasAgent(),
      imagesReady: Boolean(imagesReady),
      // How many models the machine holds, so the page can say so at a glance.
      chatModels: counts.chat ?? 0,
      imageModels: counts.images ?? 0,
      // Set when the agent reports its image server cannot start on this machine.
      imageProblem: counts.imageProblem ?? "",
      idleMinutes: idleMinutes(),
      idleSeconds: Math.round((now() - lastActivity) / 1000),
      dataCenter: pod.dataCenterId ?? null,
      startedAt: pod.startedAt ?? null,
    };
  }

  // Asks the machine's Ollama or agent; the parsed answer, or null when it does not answer.
  async function probe(url, path = "/api/tags") {
    try {
      const res = await fetchImpl(`${url}${path}`, { signal: AbortSignal.timeout(4000) });
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
    const updates = { RUNPOD_POD_ID: "", RUNPOD_POD_GB: "", RUNPOD_POD_DISK_GB: "", RUNPOD_POD_AGENT: "" };
    if (id && env().OLLAMA_SERVER === urlFor(id)) {
      updates.OLLAMA_SERVER = "";
      updates.OLLAMA_SERVER_GB = "";
    }
    if (id && env().GPU_AGENT === agentFor(id)) updates.GPU_AGENT = "";
    save(updates);
    last = null;
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

  const self = {
    configured: () => Boolean(key()),
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
    cached: () => (podId() ? { ...(last ?? { rented: true, id: podId(), status: "UNKNOWN", ready: false, images: hasAgent(), imagesReady: false, gb: Number(env().RUNPOD_POD_GB) || null, url: urlFor(podId()), agent: hasAgent() ? agentFor(podId()) : null }), idleMinutes: idleMinutes(), idleSeconds: Math.round((now() - lastActivity) / 1000) } : { rented: false }),
    touch() {
      lastActivity = now();
    },
    // A download in progress keeps the machine awake however long it takes.
    hold() {
      holds++;
      lastActivity = now();
      return () => {
        holds = Math.max(0, holds - 1);
        lastActivity = now();
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
        return { ...(last ?? { rented: true, id, status: "UNKNOWN", url: urlFor(id), gb: Number(env().RUNPOD_POD_GB) || null, idleMinutes: idleMinutes() }), error: err.message };
      }
      if (pod.status === "TERMINATED") {
        forget(id);
        return { rented: false, gone: true };
      }
      const running = pod.status === "RUNNING";
      let ready = Boolean(last?.ready) && running;
      let imagesReady = Boolean(last?.imagesReady) && running;
      let counts = { chat: last?.chatModels ?? 0, images: last?.imageModels ?? 0, imageProblem: last?.imageProblem ?? "" };
      if (running && wantProbe) {
        const [tags, health] = await Promise.all([probe(urlFor(id)), hasAgent() ? probe(agentFor(id), "/health") : null]);
        ready = Boolean(tags);
        imagesReady = Boolean(health?.ok);
        counts = { chat: tags?.models?.length ?? 0, images: health?.models ?? 0, imageProblem: health && health.sdOk === false ? String(health.sdProblem || "the image server cannot start") : "" };
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
      const offer = (await tiers()).find((t) => t.gb === tier.gb);
      if (!offer?.gpu) throw new RentError(`RunPod lists no ${tier.gb} GB card right now.`, 503);
      if (!offer.available) throw new RentError(`Every ${tier.gb} GB card at RunPod is taken right now. Try another size or try again later.`, 503);
      // Browsers may talk to the machine directly from these origins (the
      // hosted site's address, or the app's own); Ollama and the agent
      // refuse other sites' pages.
      const env = { OLLAMA_HOST: "0.0.0.0", OLLAMA_KEEP_ALIVE: "1h" };
      const allowed = origins.filter((o) => /^https?:\/\/[\w.-]+(?::\d+|:\*)?$/.test(String(o)));
      if (allowed.length) {
        env.OLLAMA_ORIGINS = allowed.join(",");
        env.HF_ORIGINS = allowed.join(",");
      }
      // The full image when it can be pulled, otherwise plain Ollama: a
      // machine for chat models only, rather than no machine. With a
      // registry credential the image is private and RunPod pulls it with
      // that, so the public check is skipped.
      const auth = registryAuth();
      const full = auth ? true : await imageCheck(image);
      const pod = await request("POST", "/pods", {
        name: "huggingfound",
        image: full ? image : OLLAMA_IMAGE,
        ...(full && auth ? { registry: auth } : {}),
        gpu: { id: offer.gpu.id, count: 1, minCudaVersion: MIN_CUDA },
        cloud: "SECURE",
        disk: CONTAINER_DISK_GB,
        ports: full ? [`${OLLAMA_PORT}/http`, `${AGENT_PORT}/http`] : [`${OLLAMA_PORT}/http`],
        env,
        mounts: { persistent: { size: disk, path: MODELS_PATH } },
      });
      if (!pod?.id) throw new RentError("RunPod did not return a machine id.", 502);
      save({ RUNPOD_POD_ID: pod.id, RUNPOD_POD_GB: String(offer.gpu.memory || tier.gb), RUNPOD_POD_DISK_GB: String(disk), RUNPOD_POD_AGENT: full ? "1" : "" });
      point(pod.id, offer.gpu.memory || tier.gb);
      lastActivity = now();
      last = summarize(pod, false);
      return last;
    },

    // Stops the machine: the hourly charge ends, the disk and its models
    // stay (for a small charge), and Start brings it back.
    async stop() {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
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
      return this.status({ probe: false });
    },

    async start() {
      const id = podId();
      if (!id) throw new RentError("Nothing is rented.", 404);
      try {
        await request("POST", `/pods/${encodeURIComponent(id)}/action`, { action: "start" });
      } catch (err) {
        if (err.status === 404) {
          forget(id);
          return { rented: false, gone: true };
        }
        if (!/HTTP 409/.test(err.message)) throw err;
      }
      point(id, Number(env().RUNPOD_POD_GB) || 24);
      lastActivity = now();
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
    // a download in progress or an idle time of 0 keeps it running.
    async checkIdle() {
      const minutes = idleMinutes();
      if (!podId() || !minutes || holds > 0) return false;
      if (now() - lastActivity < minutes * 60e3) return false;
      const current = await this.status({ probe: false }).catch(() => null);
      if (!current?.rented || current.status !== "RUNNING") return false;
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
