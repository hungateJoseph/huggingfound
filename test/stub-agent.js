import http from "node:http";

// A stand-in for the agent on a rented GPU (gpu/agent.js): it lists the
// image model files on the machine, downloads new ones with progress,
// removes them, and makes pictures as jobs that complete on the second
// poll. Like the real one it answers pages only from allowed origins, and
// it can be taken down to play a machine that is still starting.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export function startStubAgent() {
  const state = { files: [], downloads: [], jobs: [], deleted: [], origins: [], down: false, loaded: null };
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
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/health") return res.end(JSON.stringify({ ok: true, version: "1", loaded: state.loaded, ready: Boolean(state.loaded), loading: false, models: state.files.length }));
      if (req.url === "/models" && req.method === "GET") return res.end(JSON.stringify({ models: state.files }));
      if (req.url === "/models" && req.method === "DELETE") {
        const before = state.files.length;
        state.files = state.files.filter((f) => !(f.repo === data.repo && f.file === data.file));
        state.deleted.push(`${data.repo}/${data.file}`);
        if (state.files.length === before) res.statusCode = 404;
        return res.end("{}");
      }
      if (req.url === "/download") {
        state.downloads.push({ repo: data.repo, file: data.file, token: data.token ?? null });
        const total = 1.1 * 1024 ** 3;
        for (const line of [{ status: "starting" }, { status: `downloading ${data.file}`, total, completed: total / 2 }, { status: `downloading ${data.file}`, total, completed: total }, { status: "success" }]) {
          res.write(`${JSON.stringify(line)}\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        state.files.push({ repo: data.repo, file: data.file, gb: 1.1 });
        return res.end();
      }
      if (req.url === "/download-repo") {
        state.downloads.push({ repo: data.repo, files: data.files, token: data.token ?? null });
        const total = 0.5 * 1024 ** 3;
        for (const line of [{ status: `file 1 of ${data.files.length}: ${data.files[0]}` }, { status: `downloading ${data.files[0]}`, total, completed: total, file: data.files[0] }, { status: "success" }]) {
          res.write(`${JSON.stringify(line)}\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        state.files.push({ repo: data.repo, file: "model_index.json", gb: 20.4, engine: "diffusers" });
        return res.end();
      }
      if (req.url === "/download-folder") {
        state.downloads.push({ repo: data.repo, files: data.files, into: data.into, token: data.token ?? null });
        const total = 1.3 * 1024 ** 3;
        for (const line of [{ status: `file 1 of ${data.files.length}: ${data.files[0].from}` }, { status: `downloading ${data.files[0].from}`, total, completed: total, file: data.files[0].from }, { status: "merging the parts into one checkpoint" }, { status: "success" }]) {
          res.write(`${JSON.stringify(line)}\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        state.files.push({ repo: data.repo, file: data.into, gb: 6.5 });
        return res.end();
      }
      if (req.url === "/jobs" && req.method === "POST") {
        const id = `${state.jobs.length + 1}`.padStart(16, "0");
        state.jobs.push({ id, ...data });
        state.loaded = `${data.repo}/${data.file}`;
        res.statusCode = 202;
        return res.end(JSON.stringify({ id, status: "loading" }));
      }
      const m = req.url.match(/^\/jobs\/(\w+)$/);
      if (m) {
        const n = (polls.get(m[1]) ?? 0) + 1;
        polls.set(m[1], n);
        const job = state.jobs.find((j) => j.id === m[1]);
        if (!job) {
          res.statusCode = 404;
          return res.end("{}");
        }
        if (/fail please/.test(job.prompt)) return res.end(JSON.stringify({ id: m[1], status: "failed", error: "the model choked", image: null }));
        // A folder model of a video family answers with a clip.
        const video = job.file === "model_index.json" && /wan|video/i.test(job.repo);
        if (n < 2) return res.end(JSON.stringify({ id: m[1], status: "generating", kind: video ? "video" : "image", progress: 0.5, error: null, image: null, video: null }));
        return res.end(JSON.stringify(video ? { id: m[1], status: "completed", kind: "video", error: null, image: null, video: Buffer.from("fake mp4").toString("base64") } : { id: m[1], status: "completed", kind: "image", error: null, image: PNG, video: null }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}
