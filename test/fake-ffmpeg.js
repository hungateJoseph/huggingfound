#!/usr/bin/env node
// Stands in for ffmpeg in tests: a concat of the files named in the list
// after -i, written to the last argument, byte for byte.
import fs from "node:fs";

const args = process.argv.slice(2);
const list = args[args.indexOf("-i") + 1];
const out = args.at(-1);
const files = fs.readFileSync(list, "utf8").split("\n").filter(Boolean).map((l) => /^file '(.+)'$/.exec(l)[1]);
fs.writeFileSync(out, Buffer.concat(files.map((f) => fs.readFileSync(f))));
