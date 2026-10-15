import crypto from "node:crypto";
import http from "node:http";

// A stand-in for the agent on a rented GPU (gpu/agent.js): it lists the
// image model files on the machine, downloads new ones with progress,
// removes them, and makes pictures as jobs that complete on the second
// poll. Like the real one it answers pages only from allowed origins, and
// it can be taken down to play a machine that is still starting.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function downloadSteps(route, data) {
  if (route === "/download") {
    const total = 1.1 * 1024 ** 3;
    return { lines: [{ status: "starting" }, { status: `downloading ${data.file}`, total, completed: total / 2 }, { status: `downloading ${data.file}`, total, completed: total }, { status: "success" }], done: () => data.__state.files.push({ repo: data.repo, file: data.file, gb: 1.1 }) };
  }
  if (route === "/download-addon") {
    return { lines: [{ status: `file 1 of ${data.files.length}: ${data.files[0]}` }, { status: "success" }], done: () => { for (const f of data.files) if (!data.__state.addons.some((a) => a.repo === data.repo && a.file === f)) data.__state.addons.push({ repo: data.repo, file: f, gb: 0.1 }); } };
  }
  if (route === "/download-repo") {
    const total = 0.5 * 1024 ** 3;
    return { lines: [{ status: `file 1 of ${data.files.length}: ${data.files[0]}` }, { status: `downloading ${data.files[0]}`, total, completed: total, file: data.files[0] }, { status: "success" }], done: () => data.__state.files.push({ repo: data.repo, file: "model_index.json", gb: 20.4, engine: "diffusers" }) };
  }
  const total = 1.3 * 1024 ** 3;
  return { lines: [{ status: `file 1 of ${data.files.length}: ${data.files[0].from}` }, { status: `downloading ${data.files[0].from}`, total, completed: total, file: data.files[0].from }, { status: "merging the parts into one checkpoint" }, { status: "success" }], done: () => data.__state.files.push({ repo: data.repo, file: data.into, gb: 6.5 }) };
}

export function startStubAgent() {
  const state = { files: [], addons: [], downloads: [], jobs: [], deleted: [], origins: [], leases: [], tasks: new Map(), down: false, loaded: null };
  const polls = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (req.headers.origin) {
        res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      }
      if (req.method === "OPTIONS") {
        res.statusCode = 204;
        return res.end();
      }
      state.origins.push(req.headers.origin ?? null);
      if (state.down) {
        res.statusCode = 502;
        return res.end("not yet");
      }
      const data = body ? JSON.parse(body) : {};
      if (["/download", "/download-addon", "/download-repo", "/download-folder"].includes(req.url)) {
        state.downloads.push(req.url === "/download" ? { repo: data.repo, file: data.file, token: data.token ?? null } : req.url === "/download-addon" ? { repo: data.repo, files: data.files, addon: true, token: data.token ?? null } : req.url === "/download-repo" ? { repo: data.repo, files: data.files, token: data.token ?? null } : { repo: data.repo, files: data.files, into: data.into, token: data.token ?? null });
        Object.defineProperty(data, "__state", { value: state, enumerable: false });
      }
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, version: String(state.version ?? 9), loaded: state.loaded, ready: Boolean(state.loaded), loading: false, models: state.files.length, busy: Boolean(state.busy) || state.jobs.some((j) => /slow please/.test(j.prompt) && !state.release), ...(state.diskFreeGb != null ? { diskFreeGb: state.diskFreeGb, diskTotalGb: state.diskTotalGb ?? 50 } : {}) }));
      if (req.url === "/models" && req.method === "GET") return res.end(JSON.stringify({ models: state.files, addons: state.addons }));
      if (req.url === "/lease") {
        state.leases.push(data.minutes ?? null);
        return res.end(JSON.stringify({ ok: true, leaseUntil: Date.now() + (data.minutes ?? 30) * 60e3 }));
      }
      if (req.url === "/models" && req.method === "DELETE" && data.addon) {
        const before = state.addons.length;
        state.addons = state.addons.filter((f) => !(f.repo === data.repo && f.file === data.file));
        state.deleted.push(`addon:${data.repo}/${data.file}`);
        if (state.addons.length === before) res.statusCode = 404;
        return res.end("{}");
      }
      if (req.url === "/models" && req.method === "DELETE") {
        const before = state.files.length;
        state.files = state.files.filter((f) => !(f.repo === data.repo && f.file === data.file));
        state.deleted.push(`${data.repo}/${data.file}`);
        if (state.files.length === before) res.statusCode = 404;
        return res.end("{}");
      }
      // The four download routes stream their lines, or run detached with
      // an id the site polls, as the real agent does.
      if (["/download", "/download-addon", "/download-repo", "/download-folder"].includes(req.url)) {
        const steps = downloadSteps(req.url, data);
        const run = async (write) => {
          for (const line of steps.lines) {
            write(line);
            await new Promise((r) => setTimeout(r, state.slowMs ?? 5));
          }
          steps.done();
        };
        if (data.detach) {
          const key = req.url === "/download" ? `/download|${data.repo}|${data.file}` : req.url === "/download-folder" ? `/download-folder|${data.repo}|${data.into}` : `${req.url}|${data.repo}`;
          const running = [...state.tasks.values()].find((t) => t.key === key && t.status === "running");
          res.statusCode = 202;
          if (running) return res.end(JSON.stringify({ id: running.id, status: "running", attached: true }));
          const id = crypto.randomBytes(8).toString("hex");
          const task = { id, key, status: "running", error: null, lines: [], startedAt: Date.now() };
          state.tasks.set(id, task);
          run((line) => task.lines.push(line)).then(() => (task.status = "done"));
          return res.end(JSON.stringify({ id, status: "running" }));
        }
        await run((line) => res.write(`${JSON.stringify(line)}\n`));
        return res.end();
      }
      if (req.url === "/downloads" && req.method === "GET") return res.end(JSON.stringify({ tasks: [...state.tasks.values()].map((t) => ({ id: t.id, key: t.key, status: t.status, error: t.error, startedAt: t.startedAt, last: t.lines.at(-1) ?? null })) }));
      const poll = req.url.match(/^\/downloads\/([a-f0-9]{16})(?:\?after=(\d+))?$/);
      if (poll && req.method === "GET") {
        const task = state.tasks.get(poll[1]);
        if (!task) {
          res.statusCode = 404;
          return res.end("{}");
        }
        const after = Number(poll[2] ?? 0);
        state.polls = (state.polls ?? 0) + 1;
        return res.end(JSON.stringify({ id: task.id, status: task.status, error: task.error, lines: task.lines.slice(after), cursor: task.lines.length }));
      }
      // Newer agents drop their model on request; older ones have no such route.
      if (req.url === "/unload" && req.method === "POST") {
        if (!state.unloadRoute) {
          res.statusCode = 404;
          return res.end("{}");
        }
        state.unloads = (state.unloads ?? 0) + 1;
        state.loaded = null;
        return res.end(JSON.stringify({ ok: true }));
      }
      if (req.url === "/jobs" && req.method === "POST") {
        const id = `${state.jobs.length + 1}`.padStart(16, "0");
        // A test that empties the job list reuses ids: a new job starts unpolled.
        polls.delete(id);
        state.jobs.push({ id, ...data });
        state.loaded = `${data.repo}/${data.file}`;
        res.statusCode = 202;
        return res.end(JSON.stringify({ id, status: "loading" }));
      }
      const m = req.url.match(/^\/jobs\/(\w+)(\/result)?(?:\?(.*))?$/);
      if (m) {
        const job = state.jobs.find((j) => j.id === m[1]);
        if (!job) {
          res.statusCode = 404;
          return res.end("{}");
        }
        const video = job.file === "model_index.json" && /wan|video/i.test(job.repo);
        // The result as bytes, as a newer agent serves it.
        if (m[2]) {
          state.results = (state.results ?? 0) + 1;
          const bytes = video ? Buffer.from("fake mp4") : Buffer.from(PNG, "base64");
          res.setHeader("Content-Type", video ? "video/mp4" : "image/png");
          return res.end(bytes);
        }
        // A lean poll leaves the result out, unless this stands in for an older agent.
        const lean = /\blean=1\b/.test(m[3] ?? "") && state.lean !== false;
        const n = (polls.get(m[1]) ?? 0) + 1;
        polls.set(m[1], n);
        if (/fail please/.test(job.prompt)) return res.end(JSON.stringify({ id: m[1], status: "failed", error: "the model choked", image: null }));
        // A newer agent says which seed it used; this stand-in does when asked to.
        const seed = state.seeds === false ? {} : { seed: job.seed ?? null };
        // A long clip: generating until the test releases it.
        if (/slow please/.test(job.prompt) && !state.release) return res.end(JSON.stringify({ id: m[1], status: "generating", kind: "image", progress: 0.27, error: null, image: null, video: null }));
        // An agent that believes its model loaded while the worker dropped it, until it is reset.
        if (/lost model/.test(job.prompt) && !state.lostOnce) {
          state.lostOnce = true;
          return res.end(JSON.stringify({ id: m[1], status: "failed", error: "ValueError: no model is loaded (at worker.py:546 generate < worker.py:727 main)", image: null }));
        }
        // A folder model of a video family answers with a clip.
        if (n < 2) return res.end(JSON.stringify({ id: m[1], status: "generating", kind: video ? "video" : "image", progress: 0.5, error: null, image: null, video: null }));
        if (lean) return res.end(JSON.stringify({ id: m[1], status: "completed", kind: video ? "video" : "image", error: null, image: null, video: null, result: true, bytes: video ? 8 : Buffer.from(PNG, "base64").length, ...seed }));
        return res.end(JSON.stringify(video ? { id: m[1], status: "completed", kind: "video", error: null, image: null, video: Buffer.from("fake mp4").toString("base64"), ...seed } : { id: m[1], status: "completed", kind: "image", error: null, image: PNG, video: null, ...seed }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}
