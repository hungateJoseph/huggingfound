import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createStock } from "../src/stock.js";

const tier = (gb, available) => ({ gb, available, gpu: { name: "H200" } });

test("a size's stock over time: how long it has been sold out, and how long it took to come back before", () => {
  let t = 0;
  const min = 60e3;
  const stock = createStock({ now: () => t });
  assert.equal(stock.summary(141), null, "nothing seen yet");
  // Out from the first check: that stretch's start is unknown, so it is no measure.
  stock.record([tier(141, false)]);
  assert.deepEqual([stock.summary(141).free, stock.summary(141).outSinceKnown, stock.summary(141).lastFreeAt, stock.summary(141).typicalWaitMs], [false, false, null, null]);
  t = 30 * min;
  stock.record([tier(141, true)]);
  // Out for 40 minutes, then 20, then out again now for 10.
  t = 40 * min;
  stock.record([tier(141, false)]);
  t = 80 * min;
  stock.record([tier(141, true)]);
  t = 90 * min;
  stock.record([tier(141, false)]);
  t = 110 * min;
  stock.record([tier(141, true)]);
  t = 120 * min;
  stock.record([tier(141, false)]);
  t = 130 * min;
  stock.record([tier(141, false)]);
  const s = stock.summary(141);
  assert.equal(s.free, false);
  assert.equal(s.outSinceKnown, true);
  assert.equal(s.outSince, 120 * min, "sold out since the first check that found none");
  assert.equal(s.lastFreeAt, 110 * min);
  assert.deepEqual([s.waits, s.typicalWaitMs, s.longestWaitMs], [2, 20 * min, 40 * min]);
  assert.equal(s.checkedAt, 130 * min);
  // The same answer again within a minute adds nothing.
  t = 130 * min + 10e3;
  stock.record([tier(141, false)]);
  assert.equal(stock.summary(141).checkedAt, 130 * min);
  // A size not on offer at all (no card) is not recorded.
  stock.record([{ gb: 400, available: false, gpu: null }]);
  assert.equal(stock.summary(400), null);
  assert.deepEqual(Object.keys(stock.summaries([141, 400])), ["141"]);
});

test("the history is kept on disk, a week of it", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hf-stock-")), "stock.json");
  let t = 1e12;
  const a = createStock({ file, now: () => t });
  a.record([tier(80, true)]);
  t += 8 * 864e5;
  a.record([tier(80, false)]);
  await new Promise((r) => setTimeout(r, 2300));
  const b = createStock({ file, now: () => t });
  const s = b.summary(80);
  assert.equal(s.free, false);
  assert.equal(s.lastFreeAt, null, "older than a week is dropped");
});
