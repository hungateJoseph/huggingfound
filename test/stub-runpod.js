import http from "node:http";

// A stand-in for RunPod's API (api.runpod.io/v2): a GPU catalogue with
// prices and availability, and pods that are created, move from
// PROVISIONING through STARTING to RUNNING as they are polled, stop, start
// and are deleted. Every call needs the bearer key.

export const KEY = "rpa_testkey_0123456789abcdef";

export const GPUS = [
  { id: "NVIDIA RTX A5000", name: "RTX A5000", memory: 24, secure: true, price: { secure: 0.27 }, availability: "NONE" },
  // Cheap and free, but the image server is not compiled for these: never picked.
  { id: "NVIDIA GeForce RTX 5090", name: "RTX 5090", memory: 32, secure: true, manufacturer: "NVIDIA", price: { secure: 0.2 }, availability: "HIGH" },
  { id: "Tesla V100-SXM2-32GB", name: "V100", memory: 32, secure: true, manufacturer: "NVIDIA", price: { secure: 0.19 }, availability: "HIGH" },
  { id: "NVIDIA RTX PRO 6000 Blackwell", name: "RTX PRO 6000", memory: 96, secure: true, manufacturer: "NVIDIA", price: { secure: 0.9 }, availability: "HIGH" },
  { id: "NVIDIA GeForce RTX 4090", name: "RTX 4090", memory: 24, secure: true, price: { secure: 0.44 }, availability: "HIGH" },
  { id: "NVIDIA L4", name: "L4", memory: 24, secure: true, price: { secure: 0.48 }, availability: "HIGH" },
  { id: "NVIDIA A40", name: "A40", memory: 48, secure: true, price: { secure: 0.4 }, availability: "MEDIUM" },
  { id: "NVIDIA L40S", name: "L40S", memory: 48, secure: true, price: { secure: 0.86 }, availability: "HIGH" },
  { id: "NVIDIA A100 80GB PCIe", name: "A100 PCIe", memory: 80, secure: true, price: { secure: 1.64 }, availability: "LOW" },
  { id: "NVIDIA H100 80GB HBM3", name: "H100 SXM", memory: 80, secure: true, price: { secure: 2.69 }, availability: "HIGH" },
  { id: "NVIDIA H200", name: "H200 SXM", memory: 141, secure: true, price: { secure: 3.59 }, availability: "NONE" },
  { id: "AMD MI300X", name: "MI300X", memory: 192, secure: false, price: { secure: 2.49 }, availability: "HIGH" },
];

export function startStubRunpod() {
  const state = { pods: {}, created: [], actions: [], calls: [], catalogQueries: [], patched: [], nextId: 1, polls: 0, badKey: false, rateLimited: false, stock: {}, refuse: new Set() };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url, "http://x");
      state.calls.push(`${req.method} ${url.pathname}`);
      const reply = (status, data) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if ((bearer !== KEY && !(state.extraKeys ?? []).includes(bearer)) || state.badKey) return reply(401, { error: "Unauthorized" });
      if (state.rateLimited) return reply(429, { error: "Too Many Requests" });
      const data = body ? JSON.parse(body) : {};
      // Stock is per card count: `state.stock[id][count]` overrides a card's
      // availability for that many on one host.
      const count = Number(url.searchParams.get("count") || 1);
      const stocked = (g, n = count) => ({ ...g, availability: state.stock?.[g.id]?.[n] ?? g.availability });
      if (req.method === "GET" && url.pathname === "/catalog/gpus") {
        state.catalogQueries.push(url.search);
        return reply(200, { gpus: GPUS.map((g) => stocked(g)) });
      }
      // Every pod on the account, as RunPod lists them (deleted ones included, as TERMINATED).
      if (req.method === "GET" && url.pathname === "/pods") return reply(200, { pods: Object.values(state.pods).map(view), pagination: { nextCursor: null } });
      // The pod bill: what each pod has run so far at its price, as today's
      // GPU amount, plus a disk amount for its volume; one record a pod.
      if (req.method === "GET" && url.pathname === "/billing/pods") {
        const day = new Date().toISOString().slice(0, 10);
        const records = Object.values(state.pods).map((pod) => {
          const gpuAmount = Math.round((pod.cost * ((pod.runtime?.uptime ?? 0) + (pod.pastUptime ?? 0))) / 3600 * 1000) / 1000;
          const diskAmount = Math.round(((pod.mounts?.persistent?.size ?? 0) * 0.2) / 30 * 1000) / 1000;
          return { startTime: `${day}T00:00:00Z`, endTime: `${day}T23:59:59Z`, podId: pod.id, totalAmount: gpuAmount + diskAmount, gpuAmount, cpuAmount: 0, diskAmount };
        });
        return reply(200, { records, metadata: { recordCount: records.length } });
      }
      if (req.method === "GET" && url.pathname === "/registries") return reply(200, { registries: [{ id: "reg_abc123", name: "GitHub packages" }, { id: "reg_other", name: "Docker Hub" }] });
      if (req.method === "POST" && url.pathname === "/pods") {
        const gpu = GPUS.find((g) => g.id === data.gpu?.id);
        if (!gpu) return reply(422, { message: "unknown gpu" });
        if (gpu.availability === "NONE") return reply(409, { message: "no capacity" });
        // Gone between the listing and the request, as RunPod says it.
        if (state.refuse?.has(gpu.id) || stocked(gpu, data.gpu?.count ?? 1).availability === "NONE") return reply(400, { message: "There are no longer any instances available with the requested specifications. Please refresh and try again." });
        const id = `pod${state.nextId++}abc`;
        const pod = { id, name: data.name, image: data.image, status: "PROVISIONING", cost: gpu.price.secure * (data.gpu.count ?? 1), gpu: { id: gpu.id, count: data.gpu.count ?? 1, memory: gpu.memory }, ports: data.ports, env: data.env, mounts: data.mounts, disk: data.disk, dataCenterId: "US-KS-2", createdAt: new Date().toISOString(), startedAt: null, runtime: null, polls: 0 };
        state.pods[id] = pod;
        state.created.push(data);
        return reply(201, view(pod));
      }
      const m = url.pathname.match(/^\/pods\/([^/]+)(?:\/(action))?$/);
      if (!m || !state.pods[m[1]] || state.pods[m[1]].status === "TERMINATED") return reply(404, { message: "not found" });
      const pod = state.pods[m[1]];
      if (req.method === "GET" && !m[2]) {
        // Each poll moves a new or restarted machine along.
        state.polls++;
        if (pod.status === "PROVISIONING") pod.status = "STARTING";
        else if (pod.status === "STARTING") {
          pod.status = "RUNNING";
          pod.startedAt = new Date().toISOString();
          // A host that never starts the container: listed as running, no runtime.
          pod.runtime = state.noContainer ? null : { uptime: 0 };
          if (state.noContainer) pod.lastStatusChange = "Pulling image: 23%";
        } else if (pod.status === "RUNNING" && !state.noContainer) pod.runtime = { uptime: (pod.runtime?.uptime ?? 0) + 900 };
        return reply(200, view(pod));
      }
      if (req.method === "POST" && m[2] === "action") {
        state.actions.push(`${pod.id}:${data.action}`);
        if (data.action === "stop") {
          if (pod.status === "EXITED") return reply(409, { message: "Action not valid for current pod status" });
          pod.status = "EXITED";
          pod.pastUptime = (pod.pastUptime ?? 0) + (pod.runtime?.uptime ?? 0);
          pod.runtime = null;
          return reply(200, view(pod));
        }
        if (data.action === "start") {
          if (pod.status !== "EXITED" && pod.status !== "ERROR") return reply(409, { message: "Action not valid for current pod status" });
          if (state.noGpu) return reply(400, { message: "There are not enough free GPUs on the host machine to start this pod." });
          pod.status = "STARTING";
          return reply(200, view(pod));
        }
        // A restart keeps the host, card and disk; the container comes back
        // through STARTING, where the polls move it along.
        if (data.action === "restart") {
          if (pod.status !== "RUNNING") return reply(409, { message: "Action not valid for current pod status" });
          pod.pastUptime = (pod.pastUptime ?? 0) + (pod.runtime?.uptime ?? 0);
          pod.runtime = null;
          pod.status = "STARTING";
          return reply(200, view(pod));
        }
        return reply(400, { message: "bad action" });
      }
      // Only the fields sent change; a persistent disk grows, never shrinks.
      if (req.method === "PATCH" && !m[2]) {
        state.patched.push({ id: pod.id, ...data });
        if (data.mounts?.persistent) {
          if (!(data.mounts.persistent.size >= (pod.mounts?.persistent?.size ?? 0))) return reply(400, { message: "Volume size can only be increased" });
          pod.mounts = { persistent: { ...pod.mounts?.persistent, ...data.mounts.persistent } };
        }
        if (data.name) pod.name = data.name;
        return reply(200, view(pod));
      }
      if (req.method === "DELETE" && !m[2]) {
        pod.status = "TERMINATED";
        return reply(204);
      }
      reply(404, { message: "not found" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, base: `http://127.0.0.1:${server.address().port}` })));
}

function view(pod) {
  const { polls, ...rest } = pod;
  return rest;
}
