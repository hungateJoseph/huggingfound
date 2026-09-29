import assert from "node:assert/strict";
import { test } from "node:test";
import { describeMachine, fitFor, platformName } from "../src/machine.js";

test("describeMachine reports the essentials", () => {
  const m = describeMachine();
  assert.ok(m.ramGb > 0);
  assert.ok(m.cores > 0);
  assert.ok(m.comfortableGb >= 1 && m.comfortableGb < m.ramGb);
  assert.equal(typeof m.gpu, "string");
  assert.equal(m.os, platformName(process.platform));
});

test("fitFor grades a file against the memory to spare", () => {
  const machine = { comfortableGb: 10 };
  assert.equal(fitFor(2, machine).level, "good");
  assert.equal(fitFor(8, machine).level, "tight");
  assert.equal(fitFor(14, machine).level, "no");
  assert.equal(fitFor(null, machine).level, "unknown");
  assert.match(fitFor(14, machine).text, /room for about 10 GB/);
});

test("platformName is friendly", () => {
  assert.equal(platformName("darwin"), "macOS");
  assert.equal(platformName("win32"), "Windows");
  assert.equal(platformName("freebsd"), "freebsd");
});
