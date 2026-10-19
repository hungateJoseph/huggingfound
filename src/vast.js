// Vast.ai, the second place a GPU can be rented from. Its API
// (console.vast.ai/api/v0) lists offers, each one host's GPUs at a price
// an hour, rents one as an "instance" running a container image, and
// stops, starts and destroys it. Unlike RunPod it gives no HTTPS address
// for a port, only the host's IP and a mapped port; the machine image
// opens a Cloudflare tunnel for Ollama and for the agent, and says the
// tunnels' addresses on its /health, which the site asks at the mapped
// port (rent.js).
//
// This module speaks Vast's API and turns what it says into the shape
// rent.js already handles for RunPod: offers into cards, an instance into
// a pod.

export const VAST_BASE = "https://console.vast.ai/api/v0";
export const VAST_LABEL = "huggingfound";
const BACKOFF_MS = 30e3;

export class VastError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

// What Vast says about a host's internet and reliability, read the same
// way for an offer and a rented instance.
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// An instance in RunPod's words: RUNNING while its container runs,
// STARTING while the image is fetched or a stopped one waits for its
// host's GPU, EXITED once stopped. Vast says three things: what the
// container is doing (actual_status), what was asked of it
// (intended_status) and the state of the rental itself (cur_state).
export function instanceStatus(inst) {
  const actual = String(inst.actual_status ?? "").toLowerCase();
  const intended = String(inst.intended_status ?? "").toLowerCase();
  const cur = String(inst.cur_state ?? "").toLowerCase();
  if (intended === "stopped") return "EXITED";
  if (actual === "running") return "RUNNING";
  if (actual === "exited" || actual === "stopped") return intended === "running" && cur !== "stopped" ? "STARTING" : "EXITED";
  if (actual === "offline") return "UNKNOWN";
  if (!actual) return "PROVISIONING";
  return "STARTING";
}

// The port on the host that a container port is mapped to: Vast gives
// `{"7860/tcp": [{"HostIp": "0.0.0.0", "HostPort": "41234"}]}`.
export function hostPort(inst, port) {
  const list = inst?.ports?.[`${port}/tcp`];
  const p = Array.isArray(list) ? Number(list[0]?.HostPort) : NaN;
  return p > 0 ? p : null;
}

// An instance in the shape rent.js reads a RunPod pod in.
export function instanceToPod(inst) {
  const status = instanceStatus(inst);
  const why = String(inst.status_msg ?? "").trim();
  return {
    id: String(inst.id),
    status,
    cost: num(inst.dph_total),
    // The running time comes from rent.js, which notes when it was first seen running.
    runtime: status === "RUNNING" ? {} : null,
    gpu: { id: String(inst.gpu_name ?? ""), count: Number(inst.num_gpus) || 1 },
    mounts: { persistent: { size: num(inst.disk_space) } },
    dataCenterId: inst.geolocation ? String(inst.geolocation) : null,
    lastStatusChange: why ? why.slice(0, 200) : null,
    // Where the site reaches the agent itself, over plain HTTP, to learn the tunnels.
    ip: inst.public_ipaddr ? String(inst.public_ipaddr).trim() : null,
    // Waiting to start again on a host whose GPU someone else has taken meanwhile.
    waitingForGpu: String(inst.intended_status ?? "") === "running" && String(inst.cur_state ?? "") === "stopped",
    label: inst.label ?? null,
    createdAt: num(inst.start_date) ? new Date(num(inst.start_date) * 1000).toISOString() : null,
    storagePerGbMonth: num(inst.storage_cost),
    raw: inst,
  };
}

// The cards are NVIDIA ones; Vast also lists AMD and other accelerators by name only.
const NOT_NVIDIA = /\b(MI\d{2,3}X?|Radeon|RX \d|Instinct|Gaudi|Arc)\b/i;

export function createVast({ key, fetchImpl = fetch, base = VAST_BASE, now = Date.now, withinBudget = () => true, spend = () => {} }) {
  let throttledUntil = 0;
  let throttledKey = "";

  async function request(method, path, body) {
    if (!key()) throw new VastError("Add a Vast.ai API key in Settings to rent from Vast.ai.", 400);
    if (throttledKey === key() && now() < throttledUntil) throw new VastError(`Vast.ai has stopped answering this account for now; it accepts requests again in ${Math.ceil((throttledUntil - now()) / 1000)} seconds.`, 429);
    if (!withinBudget()) throw new VastError("HuggingFound has asked Vast.ai enough for the moment; it asks again in a minute.", 429);
    spend();
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new VastError(`Vast.ai did not answer (${err.name === "TimeoutError" ? "timed out" : err.message}).`, 502);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const said = describe(data);
    if (res.status === 401 || res.status === 403) throw new VastError("Vast.ai refused the API key. Check it in Settings.", 401);
    if (res.status === 404) throw new VastError(`Vast.ai has no such machine${said ? ` (${said})` : ""}.`, 404);
    if (res.status === 429) {
      const wait = Math.min((Number(res.headers.get("retry-after")) || 0) * 1000 || BACKOFF_MS, 3600e3);
      throttledUntil = now() + wait;
      throttledKey = key();
      throw new VastError(`Vast.ai has stopped answering this account for now; it accepts requests again in ${Math.ceil(wait / 1000)} seconds.`, 429);
    }
    if (!res.ok) throw new VastError(`Vast.ai answered HTTP ${res.status}${said ? `: ${said}` : ""}.`, res.status === 400 ? 400 : 502);
    // A refusal can come with a 200 and success: false.
    if (data && data.success === false) throw new VastError(`Vast.ai refused: ${said || "no reason given"}.`, 400);
    return data;
  }

  return {
    request,
    // Offers of `count` cards of at least `minGb` each on one host, the
    // cheapest first, from verified hosts that are free now, run CUDA 12.4
    // or newer on an x86 machine, can map the two ports, and download
    // models quickly. The price an hour includes a disk of `diskGb`.
    async offers({ count = 1, minGb = 20, diskGb = 50, minCuda = 12.4 } = {}) {
      const data = await request("POST", "/bundles/", {
        verified: { eq: true },
        external: { eq: false },
        rentable: { eq: true },
        rented: { eq: false },
        num_gpus: { eq: count },
        gpu_ram: { gte: Math.floor(minGb * 1000) },
        cuda_max_good: { gte: minCuda },
        direct_port_count: { gte: 2 },
        reliability: { gte: 0.95 },
        inet_down: { gte: 200 },
        disk_space: { gte: diskGb },
        cpu_arch: { eq: "amd64" },
        order: [["dph_total", "asc"]],
        type: "on-demand",
        allocated_storage: diskGb,
        limit: 300,
      });
      const list = Array.isArray(data?.offers) ? data.offers : [];
      return list
        .filter((o) => o && o.id != null && Number(o.dph_total) > 0 && !NOT_NVIDIA.test(String(o.gpu_name ?? "")) && (!o.cpu_arch || o.cpu_arch === "amd64"))
        .map((o) => ({
          offerId: String(o.id),
          name: String(o.gpu_name ?? "GPU"),
          count: Number(o.num_gpus) || count,
          // Vast gives each card's memory in MB as the card reports it (an
          // 80 GB card says 81559): GB to the thousand for the size it
          // belongs to, to the 1024 for its name.
          memoryMb: Number(o.gpu_ram) || 0,
          pricePerHour: Number(o.dph_total),
          cuda: num(o.cuda_max_good),
          reliability: num(o.reliability2 ?? o.reliability),
          location: o.geolocation ? String(o.geolocation) : "",
          storagePerGbMonth: num(o.storage_cost),
          // What the host charges for data downloaded, in dollars a TB.
          downloadPerTb: num(o.inet_down_cost) != null ? Math.round(num(o.inet_down_cost) * 1024 * 100) / 100 : null,
          inetDownMbps: num(o.inet_down),
        }));
    },
    // Rents an offer: the image, its environment, the two ports mapped,
    // and a disk of `diskGb` that lasts as long as the instance does.
    async create(offerId, { image, env = {}, diskGb = 50, ports = [], label = VAST_LABEL, imageLogin = "" }) {
      const envFlags = { ...Object.fromEntries(ports.map((p) => [`-p ${p}:${p}`, "1"])), ...env };
      const data = await request("PUT", `/asks/${encodeURIComponent(offerId)}/`, {
        client_id: "me",
        image,
        disk: diskGb,
        label,
        env: envFlags,
        // The image's own entrypoint starts Ollama, the agent and the tunnels.
        runtype: "args",
        ...(imageLogin ? { image_login: imageLogin } : {}),
        cancel_unavail: true,
      });
      const id = data?.new_contract;
      if (id == null) throw new VastError("Vast.ai did not return a machine id.", 502);
      return String(id);
    },
    // One instance, or null once it is gone (Vast answers a destroyed one
    // with `{"instances": null}`, not a 404).
    async instance(id) {
      try {
        const data = await request("GET", `/instances/${encodeURIComponent(id)}/?owner=me`);
        const inst = data?.instances;
        return inst && typeof inst === "object" && !Array.isArray(inst) ? inst : null;
      } catch (err) {
        if (err.status === 404) return null;
        throw err;
      }
    },
    // Every instance on the account.
    async list() {
      const data = await request("GET", "/instances/?owner=me");
      return Array.isArray(data?.instances) ? data.instances : [];
    },
    setState: (id, state) => request("PUT", `/instances/${encodeURIComponent(id)}/`, { state }),
    reboot: (id) => request("PUT", `/instances/reboot/${encodeURIComponent(id)}/`, {}),
    async destroy(id) {
      try {
        await request("DELETE", `/instances/${encodeURIComponent(id)}/`, {});
      } catch (err) {
        if (err.status !== 404) throw err;
      }
    },
  };
}

function describe(data) {
  if (!data) return "";
  if (typeof data === "string") return data.slice(0, 200);
  const m = data.msg ?? data.message ?? data.error ?? data.detail ?? "";
  return typeof m === "string" ? m.slice(0, 200) : "";
}
