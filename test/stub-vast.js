import http from "node:http";

// A stand-in for Vast.ai's API (console.vast.ai/api/v0): offers searched
// by card count and memory, instances rented from an offer that move from
// no status through "loading" to "running" as they are polled, stop,
// start, reboot and are destroyed. A destroyed instance reads as
// `{"instances": null}`, as Vast.ai answers. Every call needs the key.

export const VAST_KEY = "vast_testkey_0123456789abcdef0123456789";

// gpu_ram in MB as Vast.ai reports it.
export const OFFERS = [
  { id: 1001, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24564, dph_total: 0.35, cuda_max_good: 12.6, reliability2: 0.99, geolocation: "Norway, NO", storage_cost: 0.15, inet_down_cost: 0.004, inet_down: 800, cpu_arch: "amd64" },
  { id: 1002, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24564, dph_total: 0.39, cuda_max_good: 12.6, reliability2: 0.99, geolocation: "Texas, US", storage_cost: 0.1, inet_down_cost: 0, inet_down: 900, cpu_arch: "amd64" },
  // Older cards the image is not built for, and a Blackwell card whose host has too old a CUDA: never offered.
  { id: 1003, gpu_name: "Tesla V100", num_gpus: 1, gpu_ram: 32768, dph_total: 0.12, cuda_max_good: 12.4, reliability2: 0.99, geolocation: "Ohio, US", storage_cost: 0.1, cpu_arch: "amd64" },
  { id: 1004, gpu_name: "RTX 5090", num_gpus: 1, gpu_ram: 32607, dph_total: 0.2, cuda_max_good: 12.4, reliability2: 0.99, geolocation: "Ohio, US", storage_cost: 0.1, cpu_arch: "amd64" },
  { id: 1005, gpu_name: "MI300X", num_gpus: 1, gpu_ram: 196608, dph_total: 1.5, cuda_max_good: 12.4, reliability2: 0.99, geolocation: "Ohio, US", storage_cost: 0.1, cpu_arch: "amd64" },
  { id: 1010, gpu_name: "H100 SXM", num_gpus: 1, gpu_ram: 81559, dph_total: 1.89, cuda_max_good: 12.8, reliability2: 0.995, geolocation: "Quebec, CA", storage_cost: 0.2, inet_down_cost: 0.002, inet_down: 2000, cpu_arch: "amd64" },
  { id: 1011, gpu_name: "H100 SXM", num_gpus: 1, gpu_ram: 81559, dph_total: 2.05, cuda_max_good: 12.8, reliability2: 0.995, geolocation: "Oregon, US", storage_cost: 0.2, inet_down_cost: 0, inet_down: 2000, cpu_arch: "amd64" },
  { id: 1020, gpu_name: "H200", num_gpus: 2, gpu_ram: 143771, dph_total: 5.2, cuda_max_good: 12.8, reliability2: 0.99, geolocation: "Utah, US", storage_cost: 0.25, inet_down_cost: 0, inet_down: 5000, cpu_arch: "amd64" },
];

export function startStubVast({ agentPort = () => 1, ollamaPort = () => 1 } = {}) {
  const state = { instances: {}, created: [], calls: [], queries: [], stateChanges: [], reboots: [], destroyed: [], nextId: 5000, offers: OFFERS.map((o) => ({ ...o })), taken: new Set(), badKey: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      state.calls.push(`${req.method} ${url.pathname}`);
      const reply = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (bearer !== VAST_KEY || state.badKey) return reply(401, { success: false, error: "auth", msg: "invalid api key" });
      const data = body ? JSON.parse(body) : {};
      const p = url.pathname.replace(/^\/api\/v0/, "");
      if (req.method === "POST" && p === "/bundles/") {
        state.queries.push(data);
        // A host's free disk is `disk_space`; one unsaid has room for anything.
        const offers = state.offers.filter((o) => (!data.num_gpus?.eq || o.num_gpus === data.num_gpus.eq) && (!data.gpu_ram?.gte || o.gpu_ram >= data.gpu_ram.gte) && (!data.disk_space?.gte || (o.disk_space ?? Infinity) >= data.disk_space.gte) && !state.taken.has(o.id));
        return reply(200, { offers });
      }
      let m = /^\/asks\/(\d+)\/$/.exec(p);
      if (req.method === "PUT" && m) {
        const offer = state.offers.find((o) => o.id === Number(m[1]));
        if (!offer || state.taken.has(offer.id)) return reply(400, { success: false, error: "no_such_ask", msg: `Instance type by id ${m[1]} is not available.` });
        state.taken.add(offer.id);
        const id = state.nextId++;
        state.created.push({ offerId: offer.id, ...data });
        // A host gives its free disk at most, whatever was asked for (`givesDisk` for one that says more than it has).
        state.instances[id] = { id, label: data.label, image: data.image, disk_space: Math.min(data.disk, offer.givesDisk ?? offer.disk_space ?? data.disk), gpu_name: offer.gpu_name, num_gpus: offer.num_gpus, gpu_ram: offer.gpu_ram, dph_total: offer.dph_total, storage_cost: offer.storage_cost, geolocation: offer.geolocation, actual_status: null, intended_status: "running", cur_state: "running", status_msg: "", public_ipaddr: "127.0.0.1", env: data.env, start_date: Date.now() / 1000, polls: 0, fresh: true };
        return reply(200, { success: true, new_contract: id });
      }
      const view = (inst) => {
        const { polls, env, fresh, ...rest } = inst;
        const running = inst.actual_status === "running";
        return { ...rest, extra_env: Object.entries(env ?? {}), ports: running ? { "7860/tcp": [{ HostIp: "0.0.0.0", HostPort: String(agentPort()) }], "11434/tcp": [{ HostIp: "0.0.0.0", HostPort: String(ollamaPort()) }] } : {} };
      };
      if (req.method === "GET" && p === "/instances/") return reply(200, { instances: Object.values(state.instances).map(view) });
      m = /^\/instances\/(\d+)\/$/.exec(p);
      if (m) {
        const inst = state.instances[m[1]];
        if (req.method === "GET") {
          if (!inst) return reply(200, { instances: null });
          // Read straight after the rent (the site checks the disk it got): no status yet.
          if (inst.fresh) {
            inst.fresh = false;
            return reply(200, { instances: view(inst) });
          }
          // A fresh or started instance comes up one step per poll: no status, loading, running.
          if (inst.intended_status === "running" && inst.actual_status !== "running" && !inst.hold) {
            inst.polls++;
            inst.actual_status = inst.polls === 1 ? "loading" : "running";
            if (inst.actual_status === "running") inst.status_msg = "success, running";
          }
          return reply(200, { instances: view(inst) });
        }
        if (!inst) return reply(404, { success: false, error: "not_found", msg: "no such instance" });
        if (req.method === "PUT") {
          state.stateChanges.push({ id: inst.id, state: data.state });
          if (data.state === "stopped") Object.assign(inst, { intended_status: "stopped", actual_status: "exited", cur_state: "stopped", polls: 0 });
          if (data.state === "running") Object.assign(inst, { intended_status: "running", actual_status: "exited", cur_state: inst.gpuTaken ? "stopped" : "running", polls: 0, hold: Boolean(inst.gpuTaken) });
          return reply(200, { success: true });
        }
        if (req.method === "DELETE") {
          delete state.instances[m[1]];
          state.destroyed.push(Number(m[1]));
          return reply(200, { success: true });
        }
      }
      m = /^\/instances\/reboot\/(\d+)\/$/.exec(p);
      if (req.method === "PUT" && m && state.instances[m[1]]) {
        state.reboots.push(Number(m[1]));
        Object.assign(state.instances[m[1]], { actual_status: "loading", polls: 1 });
        return reply(200, { success: true });
      }
      reply(404, { success: false, msg: `no route ${req.method} ${p}` });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}/api/v0` })));
}
