import fs from "node:fs";
import path from "node:path";

// Reads and writes a .env file without disturbing lines it does not own:
// comments, blank lines and unrelated keys stay where they are.

export function envPath(dir = process.cwd()) {
  return path.join(dir, ".env");
}

export function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = unquote(m[2]);
  }
  return out;
}

export function writeEnv(file, updates) {
  const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
  const remaining = new Map(Object.entries(updates));
  const next = lines.map((line) => {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!m || !remaining.has(m[1])) return line;
    const value = remaining.get(m[1]);
    remaining.delete(m[1]);
    return value === "" ? null : `${m[1]}=${quote(value)}`;
  }).filter((l) => l !== null);
  while (next.length && next[next.length - 1] === "") next.pop();
  for (const [key, value] of remaining) {
    if (value !== "") next.push(`${key}=${quote(value)}`);
  }
  fs.writeFileSync(file, next.join("\n") + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows has no mode bits; the file is still only readable by the user.
  }
}

export function mask(value) {
  if (!value) return "";
  if (value.length <= 8) return "*".repeat(value.length);
  return value.slice(0, 4) + "*".repeat(Math.min(value.length - 8, 12)) + value.slice(-4);
}

function quote(value) {
  return /[\s#"'$]/.test(value) ? JSON.stringify(value) : value;
}

function unquote(raw) {
  const v = raw.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v.replace(/\s+#.*$/, "");
}
