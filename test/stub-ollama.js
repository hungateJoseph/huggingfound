import http from "node:http";

// A stand-in for Ollama on another machine: it holds models, pulls new ones
// with progress lines, chats, deletes, loads a model on request, and can be
// taken down to play a machine that has not finished starting.
export function startStubOllama() {
  const state = { models: [{ name: "llama3.2:3b", size: 2 * 1024 ** 3 }], chats: [], pulls: [], deleted: [], loaded: [], origins: [], down: false };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      // Like Ollama with OLLAMA_ORIGINS set: pages from allowed sites may call it directly.
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
      if (req.url === "/api/version") return res.end(JSON.stringify({ version: "0.9.9" }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: state.models }));
      // The model most recently talked to counts as loaded.
      if (req.url === "/api/ps") return res.end(JSON.stringify({ models: state.chats.length ? state.models.filter((m) => m.name === state.chats.at(-1).model) : [] }));
      if (req.url === "/api/pull") {
        state.pulls.push(data.model);
        const total = 4 * 1024 ** 3;
        for (const line of [{ status: "pulling manifest" }, { status: "pulling 5ee4f07cdb9b", total, completed: total / 2 }, { status: "pulling 5ee4f07cdb9b", total, completed: total }, { status: "success" }]) {
          res.write(`${JSON.stringify(line)}\n`);
          await new Promise((r) => setTimeout(r, 5));
        }
        state.models.push({ name: data.model, size: total });
        return res.end();
      }
      if (req.url === "/api/generate") {
        state.loaded.push(data.model);
        return res.end(JSON.stringify({ model: data.model, done: true }));
      }
      if (req.url === "/api/chat") {
        state.chats.push(data);
        res.write(`${JSON.stringify({ message: { role: "assistant", content: "from the server" } })}\n`);
        return res.end(`${JSON.stringify({ done: true, eval_count: 10, eval_duration: 1e9 })}\n`);
      }
      if (req.url === "/api/delete") {
        state.deleted.push(data.model);
        state.models = state.models.filter((m) => m.name !== data.model);
        return res.end("{}");
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, url: `http://127.0.0.1:${server.address().port}` })));
}
