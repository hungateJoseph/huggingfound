#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "../src/runners.js";
import { createServer } from "../src/server.js";

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};

if (args.includes("--help") || args.includes("-h")) {
  console.log(`huggingfound [--port 4188] [--browser] [--no-open]

Opens HuggingFound in its own window: scan Hugging Face for models, see
which ones this computer can run, and get them running step by step.
Models, settings and results live in ${tildify(DATA_DIR)}.

  --browser   open in the default browser instead of a window
  --no-open   just start the server and print the address
  --host      the address to listen on (127.0.0.1 unless hosted)

Set HUGGINGFOUND_HOSTED=1 to serve a public copy that only searches and
browses; it refreshes its catalogue every HUGGINGFOUND_REFRESH_HOURS (12).`);
  process.exit(0);
}

const port = Number(flag("--port", process.env.PORT || 4188));
const hosted = process.env.HUGGINGFOUND_HOSTED === "1";
// On a computer the server answers only that computer; the hosted copy
// answers the network it is deployed on.
const host = flag("--host", process.env.HOST || (hosted ? "0.0.0.0" : "127.0.0.1"));
const envFile = path.join(DATA_DIR, ".env");
const server = createServer({ envFile });

server.listen(port, host, () => {
  const url = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/`;
  console.log(`HuggingFound is running at ${url}${hosted ? " (hosted mode: nothing runs here; the catalogue refreshes on a timer)" : ""}`);
  console.log(`Files go to ${tildify(DATA_DIR)}`);
  if (args.includes("--no-open") || hosted) return;
  if (args.includes("--browser") || !openWindow(url)) openBrowser(url);
});

function openWindow(url) {
  const flags = [`--app=${url}`, "--window-size=1180,880", "--no-first-run", "--no-default-browser-check"];
  if (process.platform === "darwin") {
    for (const app of ["Google Chrome", "Microsoft Edge", "Brave Browser", "Chromium"]) {
      if (!fs.existsSync(`/Applications/${app}.app`)) continue;
      return launch("open", ["-na", app, "--args", ...flags]);
    }
    return false;
  }
  if (process.platform === "win32") {
    const roots = [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter(Boolean);
    const exe = roots
      .flatMap((r) => [path.join(r, "Google", "Chrome", "Application", "chrome.exe"), path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"), path.join(r, "BraveSoftware", "Brave-Browser", "Application", "brave.exe")])
      .find((c) => fs.existsSync(c));
    return exe ? launch(exe, flags) : false;
  }
  const dirs = (process.env.PATH || "").split(path.delimiter);
  for (const bin of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"]) {
    const found = dirs.map((d) => path.join(d, bin)).find((f) => fs.existsSync(f));
    if (found) return launch(found, flags);
  }
  return false;
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  launch(cmd, process.platform === "win32" ? ["/c", "start", "", url] : [url]);
}

function launch(cmd, cmdArgs) {
  try {
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function tildify(p) {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
