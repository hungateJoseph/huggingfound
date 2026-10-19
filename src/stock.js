// RunPod's stock of each GPU size, as this site has seen it over time.
// RunPod says only whether a card is free right now, never when one will
// be; what it says each time it is asked is kept here, by size, so the
// page can tell how long a size has been sold out and how long it took to
// come back the times before. Only the size, the time and free-or-not are
// kept: nothing about whose key asked. Shared by every account, since the
// stock is RunPod's and the same for all.
import fs from "node:fs";
import path from "node:path";

const KEEP_MS = 7 * 864e5;
// A size asked about again within a minute, with no change, adds nothing.
const MIN_GAP_MS = 60e3;
const MAX_PER_SIZE = 5000;

export function createStock({ file = null, now = Date.now } = {}) {
  let samples = {};
  if (file) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && typeof data === "object") samples = data.samples ?? {};
    } catch {
      samples = {};
    }
  }
  let writing = null;
  const save = () => {
    if (!file || writing) return;
    writing = setTimeout(() => {
      writing = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ samples }));
      } catch {
        // the history is a nicety; a disk that refuses it costs nothing else
      }
    }, 2000);
    writing.unref?.();
  };

  // What RunPod said about each size just now.
  function record(tiers) {
    const at = now();
    for (const t of tiers ?? []) {
      if (!t?.gb || !t.gpu) continue;
      const free = t.available ? 1 : 0;
      const list = (samples[t.gb] ??= []);
      const last = list.at(-1);
      if (last && at - last[0] < MIN_GAP_MS && last[1] === free) continue;
      list.push([at, free]);
      while (list.length && (at - list[0][0] > KEEP_MS || list.length > MAX_PER_SIZE)) list.shift();
    }
    save();
  }

  // For one size: whether it was free when last seen, since when it has
  // been sold out, when it was last free, and how long the sold-out
  // stretches lasted before (from the first check that found none to the
  // first that found one again: a stretch starting before the history did
  // has no known length and is left out).
  function summary(gb) {
    const list = samples[gb];
    if (!list?.length) return null;
    const [checkedAt, freeNow] = list.at(-1);
    let lastFreeAt = null;
    const waits = [];
    let outSince = null;
    let seenFree = false;
    for (const [at, free] of list) {
      if (free) {
        if (outSince != null && seenFree) waits.push(at - outSince);
        outSince = null;
        seenFree = true;
        lastFreeAt = at;
      } else if (outSince == null) outSince = at;
    }
    const sorted = [...waits].sort((a, b) => a - b);
    const day = list.filter(([at]) => checkedAt - at <= 864e5);
    return {
      checkedAt,
      free: Boolean(freeNow),
      lastFreeAt,
      // Sold out since: known only when a free check came before it.
      outSince: freeNow ? null : outSince,
      outSinceKnown: !freeNow && lastFreeAt != null,
      historySince: list[0][0],
      waits: waits.length,
      typicalWaitMs: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
      longestWaitMs: sorted.length ? sorted.at(-1) : null,
      freeShareDay: day.length ? day.filter(([, f]) => f).length / day.length : null,
    };
  }

  function summaries(gbs) {
    return Object.fromEntries(gbs.map((gb) => [gb, summary(gb)]).filter(([, s]) => s));
  }

  return { record, summary, summaries };
}
