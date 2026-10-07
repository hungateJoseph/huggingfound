import http from "node:http";

// A stand-in for RunPod's API (api.runpod.io/v2): a GPU catalogue with
// prices and availability, and pods that are created, move from
// PROVISIONING through STARTING to RUNNING as they are polled, stop, start
// and are deleted. Every call needs the bearer key.

export const KEY = "rpa_testkey_0123456789abcdef";

export const GPUS = [
  { id: "NVIDIA RTX A5000", name: "RTX A5000", memory: 24, secure: true, price: { secure: 0.27 }, availability: "NONE" },
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
  const state = { pods: {}, created: [], actions: [], calls: [], nextId: 1, polls: 0, badKey: false };
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
      if (req.headers.authorization !== `Bearer ${KEY}` || state.badKey) return reply(401, { error: "Unauthorized" });
      const data = body ? JSON.parse(body) : {};
      if (req.method === "GET" && url.pathname === "/catalog/gpus") return reply(200, { gpus: GPUS });
      if (req.method === "POST" && url.pathname === "/pods") {
        const gpu = GPUS.find((g) => g.id === data.gpu?.id);
        if (!gpu) return reply(422, { message: "unknown gpu" });
        if (gpu.availability === "NONE") return reply(409, { message: "no capacity" });
        const id = `pod${state.nextId++}abc`;
        const pod = { id, name: data.name, image: data.image, status: "PROVISIONING", cost: gpu.price.secure, gpu: { id: gpu.id, count: data.gpu.count ?? 1, memory: gpu.memory }, ports: data.ports, env: data.env, mounts: data.mounts, disk: data.disk, dataCenterId: "US-KS-2", createdAt: new Date().toISOString(), startedAt: null, runtime: null, polls: 0 };
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
          pod.runtime = { uptime: 0 };
        } else if (pod.status === "RUNNING") pod.runtime = { uptime: (pod.runtime?.uptime ?? 0) + 900 };
        return reply(200, view(pod));
      }
      if (req.method === "POST" && m[2] === "action") {
        state.actions.push(`${pod.id}:${data.action}`);
        if (data.action === "stop") {
          if (pod.status === "EXITED") return reply(409, { message: "Action not valid for current pod status" });
          pod.status = "EXITED";
          pod.runtime = null;
          return reply(200, view(pod));
        }
        if (data.action === "start") {
          if (pod.status !== "EXITED" && pod.status !== "ERROR") return reply(409, { message: "Action not valid for current pod status" });
          pod.status = "STARTING";
          return reply(200, view(pod));
        }
        return reply(400, { message: "bad action" });
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
