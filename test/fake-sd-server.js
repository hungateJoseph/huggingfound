#!/usr/bin/env node
// Stands in for stable-diffusion.cpp's sd-server in tests: takes the same
// flags, answers the model list once "loaded", accepts picture jobs and
// completes them with a tiny PNG. Each request body is appended to the file
// named by FAKE_SD_LOG so a test can see what the agent asked for.
import fs from "node:fs";
import http from "node:http";

const args = process.argv.slice(2);
const flag = (name) => args[args.indexOf(name) + 1];
const port = Number(flag("--listen-port"));
const model = flag("-m");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const jobs = new Map();
if (process.env.FAKE_SD_FAIL_LOAD) process.exit(3);

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/sdapi/v1/sd-models") return res.end(JSON.stringify([{ model_name: model.split("/").pop(), title: model }]));
    if (req.url === "/sdcpp/v1/img_gen" && req.method === "POST") {
      const data = JSON.parse(body);
      if (process.env.FAKE_SD_LOG) fs.appendFileSync(process.env.FAKE_SD_LOG, JSON.stringify({ ...data, init_image: data.init_image ? `${data.init_image.length} chars` : null }) + "\n");
      const id = `job_${jobs.size + 1}`;
      jobs.set(id, { polls: 0, fail: /fail please/.test(data.prompt) });
      res.statusCode = 202;
      return res.end(JSON.stringify({ id, kind: "img_gen", status: "queued", poll_url: `/sdcpp/v1/jobs/${id}` }));
    }
    const m = req.url.match(/^\/sdcpp\/v1\/jobs\/(.+)$/);
    if (m && jobs.has(m[1])) {
      const job = jobs.get(m[1]);
      job.polls++;
      if (job.fail) return res.end(JSON.stringify({ id: m[1], status: "failed", error: { message: "the model choked" } }));
      if (job.polls < 2) return res.end(JSON.stringify({ id: m[1], status: "generating" }));
      return res.end(JSON.stringify({ id: m[1], status: "completed", result: { images: [{ index: 0, b64_json: PNG }] } }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
});
server.listen(port, "127.0.0.1", () => console.log(`fake sd-server listening on ${port} with ${model}`));
