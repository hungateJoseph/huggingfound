// LoRAs and fine-tunes for a video model on the rented GPU, found where
// people publish them: Hugging Face (repositories that name the model as
// their base, which the Hub files under base_model:adapter: and
// base_model:finetune:) and Civitai (models filed under the base model's
// name there). Nothing is downloaded here; the page picks one and the
// machine fetches it. Civitai is asked for its safe-for-work listings unless
// the person asks for adult ones too, which are then marked as such. A link
// pasted in (a PromptHero model page, a Civitai page, a Hugging Face
// repository) is read the same way; PromptHero's model pages are copies of
// Civitai's, named with the Civitai model's number.

// A Hugging Face model and what Civitai calls the same base, for the
// families whose LoRAs the machine can apply.
export const CIVITAI_BASES = {
  "MiniMaxAI/MiniMax-H3": ["MiniMax H3"],
};

// A Civitai download address: the one form the machine fetches from there.
export const CIVITAI_DOWNLOAD = /^https:\/\/civitai\.com\/api\/download\/models\/\d+(\?(type=\w+&)?(format=\w+&)?fileId=\d+)?$/;
const UA = "huggingfound (+https://huggingfound.com)";
const CACHE_MS = 30 * 60e3;
// A LoRA for these models is a few hundred MB to a couple of GB; a whole
// transformer is tens of GB.
const FINETUNE_GB = 4;
// Precisions the machine reads a fine-tune in, best first: the smaller of
// the full-quality ones. 4-bit packs and GGUF files are not read yet.
const FINETUNE_PREFERENCE = ["int8", "fp8", "bf16", "fp16", "fp32"];

export function createLoraFinder({ fetchImpl = fetch, hubBase = "https://huggingface.co", civitaiBase = "https://civitai.com", now = Date.now } = {}) {
  const cache = new Map();
  const cached = async (key, make) => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const value = await make();
    cache.set(key, { at: now(), value });
    return value;
  };
  const getJson = async (url, what) => {
    const res = await fetchImpl(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${what} replied HTTP ${res.status}`);
    return res.json();
  };

  async function fromHub(base) {
    const ask = async (relation, limit) => {
      const url = new URL("/api/models", hubBase);
      url.searchParams.set("filter", `base_model:${relation}:${base}`);
      url.searchParams.set("sort", "downloads");
      url.searchParams.set("direction", "-1");
      url.searchParams.set("limit", String(limit));
      return (await getJson(url, "Hugging Face")) ?? [];
    };
    const [adapters, finetunes] = await Promise.all([ask("adapter", 40), ask("finetune", 20)]);
    const out = [];
    for (const [list, kind] of [[adapters, "lora"], [finetunes, "finetune"]]) {
      for (const m of list) {
        if (!m?.id || m.id === base || out.some((o) => o.id === m.id)) continue;
        out.push({ source: "hf", id: m.id, name: m.id.split("/").pop(), creator: m.id.split("/")[0], url: `https://huggingface.co/${m.id}`, kind, downloads: m.downloads ?? 0, likes: m.likes ?? 0 });
      }
    }
    return out;
  }

  async function fromCivitai(base, adult = false) {
    const names = CIVITAI_BASES[base];
    if (!names) return [];
    const out = [];
    for (const [type, kind] of [["LORA", "lora"], ["Checkpoint", "finetune"]]) {
      const url = new URL("/api/v1/models", civitaiBase);
      url.searchParams.set("types", type);
      for (const n of names) url.searchParams.append("baseModels", n);
      url.searchParams.set("sort", "Most Downloaded");
      url.searchParams.set("nsfw", adult ? "true" : "false");
      url.searchParams.set("limit", adult ? "50" : "30");
      const data = await getJson(url, "Civitai");
      for (const m of data?.items ?? []) {
        if (m.nsfw && !adult) continue;
        const files = civitaiFiles(m, kind);
        if (!files.length) continue;
        out.push(civitaiItem(m, kind, files));
      }
    }
    return out;
  }

  return {
    // Everything found for a base model, Hugging Face's and Civitai's, each
    // with an error of its own when it did not answer.
    async find(base, { adult = false } = {}) {
      return cached(`find|${base}|${adult ? "adult" : "sfw"}`, async () => {
        const [hf, civitai] = await Promise.allSettled([fromHub(base), fromCivitai(base, adult)]);
        return {
          base,
          civitaiKnown: Boolean(CIVITAI_BASES[base]),
          adult,
          items: [...(hf.status === "fulfilled" ? hf.value : []), ...(civitai.status === "fulfilled" ? civitai.value : [])],
          hfError: hf.status === "rejected" ? hf.reason.message : null,
          civitaiError: civitai.status === "rejected" ? civitai.reason.message : null,
        };
      });
    },
    // A link pasted in, read as one item for this base model: a PromptHero
    // model page or a Civitai page (its model, or the version it names),
    // or a Hugging Face repository. Something made for another model is
    // refused with the reason.
    async fromLink(base, link) {
      const where = parseLink(link);
      if (!where) throw new Error("That is not a link HuggingFound reads: paste a PromptHero model page, a Civitai model page or a Hugging Face repository");
      if (where.source === "hf") {
        const info = await getJson(new URL(`/api/models/${where.id}`, hubBase), "Hugging Face").catch((err) => {
          throw new Error(/404/.test(err.message) ? `Hugging Face has no repository ${where.id}` : err.message);
        });
        const tags = (info?.tags ?? []).map((t) => String(t));
        const bases = tags.filter((t) => t.startsWith("base_model:")).map((t) => t.split(":").pop());
        if (bases.length && !bases.includes(base)) throw new Error(`${where.id} was made for ${bases[0]}, not ${base}`);
        const files = await this.hubFiles(where.id);
        const kind = files.some((f) => f.kind === "lora") ? "lora" : "finetune";
        return { source: "hf", id: where.id, name: where.id.split("/").pop(), creator: where.id.split("/")[0], url: `https://huggingface.co/${where.id}`, kind, downloads: info?.downloads ?? 0, likes: info?.likes ?? 0, adult: tags.includes("not-for-all-audiences") || tags.includes("nsfw"), files, via: where.via };
      }
      const m = await getJson(new URL(`/api/v1/models/${where.id}`, civitaiBase), "Civitai").catch((err) => {
        throw new Error(/404/.test(err.message) ? `Civitai has no model ${where.id}${where.via === "prompthero" ? " (the number in the PromptHero link)" : ""}` : err.message);
      });
      const kind = m.type === "LORA" || m.type === "LoCon" || m.type === "DoRA" ? "lora" : m.type === "Checkpoint" ? "finetune" : null;
      if (!kind) throw new Error(`${m.name ?? "That model"} is a Civitai ${m.type ?? "model"}, not a LoRA or a fine-tuned checkpoint`);
      const version = (m.modelVersions ?? []).find((v) => String(v.id) === String(where.version)) ?? (m.modelVersions ?? [])[0];
      const names = CIVITAI_BASES[base] ?? [];
      if (version?.baseModel && !names.includes(version.baseModel)) throw new Error(`${m.name} was made for ${version.baseModel}, not ${base.split("/").pop()}`);
      const files = civitaiFiles(m, kind, version?.id);
      if (!files.length) throw new Error(`${m.name} has no .safetensors file the machine can use`);
      return { ...civitaiItem(m, kind, files), via: where.via };
    },
    // How the creator of a LoRA or fine-tune got their showcase clips: from
    // the Civitai model's version (the one on the machine, else the newest
    // for this base) with the clips ranked by the creator's own posts'
    // reactions, or from a Hugging Face repository's model card.
    async recipe(base, { id, version = null }, { adult = false } = {}) {
      return cached(`recipe|${id}|${version ?? ""}|${adult ? "adult" : "sfw"}`, async () => {
        if (id.startsWith("civitai/")) {
          const m = await getJson(new URL(`/api/v1/models/${id.slice(8)}`, civitaiBase), "Civitai").catch((err) => {
            throw new Error(/404/.test(err.message) ? `Civitai has no model ${id.slice(8)}` : err.message);
          });
          const names = CIVITAI_BASES[base] ?? [];
          const versions = m.modelVersions ?? [];
          const picked = versions.find((v) => version != null && String(v.id) === String(version)) ?? versions.find((v) => !names.length || names.includes(v.baseModel)) ?? versions[0];
          if (!picked) throw new Error(`${m.name ?? "That model"} has no version on Civitai`);
          const full = await getJson(new URL(`/api/v1/model-versions/${picked.id}`, civitaiBase), "Civitai").catch(() => picked);
          const stats = new Map();
          if (m.creator?.username) {
            const u = new URL("/api/v1/images", civitaiBase);
            u.searchParams.set("modelVersionId", String(picked.id));
            u.searchParams.set("username", m.creator.username);
            u.searchParams.set("sort", "Most Reactions");
            u.searchParams.set("limit", "50");
            u.searchParams.set("nsfw", "X");
            const d = await getJson(u, "Civitai").catch(() => null);
            for (const it of d?.items ?? []) stats.set(String(it.id), reactionsOf(it.stats));
          }
          return civitaiRecipe(m, { ...picked, ...full }, { stats, adult });
        }
        const res = await fetchImpl(new URL(`/${id}/raw/main/README.md`, hubBase), { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
        if (res.status === 404) return hubRecipe(id, "", { hubBase });
        if (!res.ok) throw new Error(`Hugging Face replied HTTP ${res.status}`);
        return hubRecipe(id, await res.text(), { hubBase });
      });
    },
    // A Hugging Face repository's weight files, each called a LoRA or a fine-tune by its size.
    async hubFiles(repo) {
      return cached(`files|${repo}`, async () => {
        const url = new URL(`/api/models/${repo}/tree/main`, hubBase);
        url.searchParams.set("recursive", "1");
        const tree = await getJson(url, "Hugging Face");
        return (Array.isArray(tree) ? tree : [])
          .filter((f) => f.type === "file" && /\.safetensors$/i.test(f.path) && !/^(media|images?|assets?|examples?|samples?)\//i.test(f.path) && !/(^|\/)(vae|text_?encoder|tokenizer)\b/i.test(f.path))
          .map((f) => {
            const gb = Math.round(((f.lfs?.size ?? f.size ?? 0) / 1024 ** 3) * 100) / 100;
            return { file: f.path, label: f.path.split("/").pop(), gb, kind: gb > FINETUNE_GB ? "finetune" : "lora" };
          });
      });
    },
  };
}

function civitaiItem(m, kind, files) {
  return { source: "civitai", id: `civitai/${m.id}`, name: String(m.name ?? "").trim(), creator: m.creator?.username ?? "", url: `https://civitai.com/models/${m.id}`, kind, downloads: m.stats?.downloadCount ?? 0, likes: m.stats?.thumbsUpCount ?? 0, adult: Boolean(m.nsfw), files };
}

// Where a pasted link points: a Civitai model (from a Civitai page or a
// PromptHero copy of one) with the version it names, or a Hugging Face
// repository. Null for anything else.
export function parseLink(link) {
  let u;
  try {
    u = new URL(String(link).trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (/^civitai\.(com|red|green)$/.test(host)) {
    const m = /^\/models\/(\d+)/.exec(u.pathname);
    return m ? { source: "civitai", id: m[1], version: u.searchParams.get("modelVersionId") || null, via: "civitai" } : null;
  }
  if (host === "prompthero.com") {
    // /ai-models/minimax-h3-nsfw-unlocked-2925727-download: the Civitai model's number.
    const m = /^\/ai-models\/[\w-]*?-?(\d{4,})(?:-download)?\/?$/.exec(u.pathname);
    return m ? { source: "civitai", id: m[1], version: null, via: "prompthero" } : null;
  }
  if (host === "huggingface.co" || host === "hf.co") {
    const m = /^\/([\w.-]+)\/([\w.-]+)/.exec(u.pathname);
    return m && !["models", "datasets", "spaces", "docs", "blog"].includes(m[1]) ? { source: "hf", id: `${m[1]}/${m[2]}`, via: "huggingface" } : null;
  }
  return null;
}

// The files of a Civitai model's newest version the machine can use, each
// kept on the machine under a plain name of its own (Civitai's names hold
// spaces and other scripts). A fine-tune's best precision comes first.
export function civitaiFiles(m, kind, versionId = null) {
  const v = (m.modelVersions ?? []).find((x) => versionId != null && String(x.id) === String(versionId)) ?? (m.modelVersions ?? [])[0];
  if (!v) return [];
  const files = (v.files ?? [])
    .filter((f) => /\.safetensors$/i.test(String(f.name ?? "")) && ["Model", "Pruned Model"].includes(f.type ?? "Model") && CIVITAI_DOWNLOAD.test(String(f.downloadUrl ?? "")))
    .filter((f) => kind !== "finetune" || !/vae|text_?encoder|clip|audio/i.test(String(f.name)))
    .map((f) => {
      const fp = String(f.metadata?.fp ?? "").toLowerCase();
      const gb = Math.round(((Number(f.sizeKB) || 0) / 1024 / 1024) * 100) / 100;
      const unreadable = kind === "finetune" && /int4|nf4|fp4/.test(fp);
      return { file: `v${v.id}_f${f.id}.safetensors`, label: String(f.name), gb, fp: fp || null, url: String(f.downloadUrl), version: String(v.name ?? ""), trigger: (v.trainedWords ?? []).filter((w) => typeof w === "string").slice(0, 6), kind: kind === "finetune" || gb > FINETUNE_GB ? "finetune" : "lora", ...(unreadable ? { unreadable: "a 4-bit file, which the machine cannot read yet" } : {}) };
    })
    .filter((f) => f.kind === kind || kind === "lora");
  if (kind === "finetune") files.sort((a, b) => Boolean(a.unreadable) - Boolean(b.unreadable) || rank(a.fp) - rank(b.fp));
  return files;
}

function rank(fp) {
  const i = FINETUNE_PREFERENCE.indexOf(fp ?? "");
  return i < 0 ? FINETUNE_PREFERENCE.length : i;
}

// How a LoRA's creator got the clips that show it off: their notes on the
// page (a strength, the words to use, what to pair it with), the trigger
// words, and the showcase clips themselves with the prompt each was made
// from and, where the upload kept them, its settings (steps, guidance, the
// workflow's LoRA strengths and the checkpoint under it). Civitai keeps
// these on the model version; a Hugging Face repository keeps them in its
// model card. Nothing here needs Claude: it is read off the page.

// A sentence with something to act on in it.
const TIP = /\b(strength|weight|recommend|suggest|cfg|guidance|steps?|shift|sampler|scheduler|turbo|lightning|distill\w*|lightx2v|trigger|keywords?|prompt\w*|resolution|\d+(?:\.\d+)?\s*mp\b|megapixels?|fps|frames?|seconds?|negative|works (?:best|well|great)|best (?:with|at)|use (?:it )?(?:at|with)|i2v|t2v|ref2va?|fl2va?)\b/i;
const SAMPLE_LIMIT = 8;

// Plain text from the HTML Civitai pages are written in.
export function textOf(html) {
  return String(html ?? "")
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The creator's tips out of their notes, and the strength they name.
export function creatorNotes(text) {
  const plain = String(text ?? "");
  const seen = new Set();
  const tips = [];
  for (const raw of plain.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])|\n+/)) {
    const s = raw.replace(/\s+/g, " ").trim();
    if (s.length < 8 || s.length > 400 || !TIP.test(s)) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tips.push(s);
    if (tips.length >= 12) break;
  }
  return { tips, strength: strengthIn(plain) };
}

// "strength 0.7", "weight of 0.5 - 0.9", "0.8 strength": a range or one value, within what a LoRA takes.
export function strengthIn(text) {
  const plain = String(text ?? "");
  const ok = (n) => Number.isFinite(n) && n > 0 && n <= 2;
  for (const re of [/\b(?:strength|weight)s?\b[^.\d\n]{0,40}?(\d(?:\.\d+)?)(?:\s*(?:-|–|to|and)\s*(\d(?:\.\d+)?))?/i, /(\d\.\d+)(?:\s*(?:-|–|to)\s*(\d\.\d+))?\s*(?:strength|weight)\b/i]) {
    const m = re.exec(plain);
    if (!m) continue;
    const low = Number(m[1]);
    const high = m[2] != null ? Number(m[2]) : low;
    if (ok(low) && ok(high)) return { low: Math.min(low, high), high: Math.max(low, high), from: "notes", text: m[0].replace(/\s+/g, " ").trim() };
  }
  return null;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : null);
const plainName = (s) => String(s ?? "").split(/[\\/]/).pop().replace(/\.(safetensors|pt|ckpt|bin)$/i, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// The settings an upload kept with a showcase clip (Civitai's image meta):
// the prompt and the plain fields, and the ComfyUI workflow walked for the
// LoRA strengths, the checkpoint and the sampler's numbers. Which LoRA
// strength is this LoRA's own is told by its file names.
export function sampleSettings(meta, { fileNames = [], versionId = null, modelName = "" } = {}) {
  const m = meta && typeof meta === "object" ? meta : {};
  const mine = new Set(fileNames.map(plainName).filter((n) => n.length >= 4));
  const slug = plainName(modelName);
  const isMine = (name) => {
    const p = plainName(name);
    return p.length >= 4 && (mine.has(p) || [...mine].some((n) => n.includes(p) || p.includes(n)) || (slug.length >= 6 && (p.includes(slug) || slug.includes(p))));
  };
  const out = { prompt: typeof m.prompt === "string" ? m.prompt.trim() : "", negative: typeof m.negativePrompt === "string" ? m.negativePrompt.trim() : "", steps: num(m.steps), cfg: num(m.cfgScale), sampler: typeof m.sampler === "string" ? m.sampler : null, scheduler: typeof m.scheduler === "string" ? m.scheduler : null, seed: num(m.seed), width: null, height: null, frames: null, fps: null, shift: num(m.shift), strength: null, with: [], checkpoint: typeof m.Model === "string" ? m.Model.split(/[\\/]/).pop() : null };
  const size = /^(\d+)x(\d+)$/.exec(String(m.Size ?? ""));
  if (size) [out.width, out.height] = [Number(size[1]), Number(size[2])];
  const lora = (name, weight) => {
    if (!name) return;
    if (isMine(name)) out.strength = out.strength ?? weight;
    else if (!out.with.some((w) => w.name === name)) out.with.push({ name: String(name).split(/[\\/]/).pop(), strength: weight });
  };
  for (const r of Array.isArray(m.resources) ? m.resources : []) {
    if (String(r?.type).toLowerCase() === "lora") lora(r.name, num(r.weight));
    else if (/checkpoint|model/i.test(String(r?.type)) && r?.name && !out.checkpoint) out.checkpoint = String(r.name);
  }
  for (const r of Array.isArray(m.civitaiResources) ? m.civitaiResources : []) {
    const name = [r?.modelName, r?.versionName].filter(Boolean).join(" ") || null;
    if (String(r?.type).toLowerCase() === "lora") {
      if (versionId != null && String(r.modelVersionId) === String(versionId)) out.strength = out.strength ?? num(r.weight);
      else lora(name, num(r.weight));
    } else if (/checkpoint/i.test(String(r?.type)) && name && !out.checkpoint) out.checkpoint = name;
  }
  if (typeof m.comfy === "string" && m.comfy.length < 2e6) {
    try {
      const flow = JSON.parse(m.comfy);
      const nodes = flow && typeof flow === "object" ? Object.values(flow.prompt && typeof flow.prompt === "object" ? flow.prompt : flow) : [];
      for (const node of nodes) {
        const ins = node && typeof node === "object" && node.inputs && typeof node.inputs === "object" ? node.inputs : null;
        if (!ins) continue;
        // A list is a link to another node, not a value.
        const v = (k) => (Array.isArray(ins[k]) ? null : ins[k]);
        if (typeof v("lora_name") === "string") lora(v("lora_name"), num(v("strength_model") ?? v("strength")));
        for (const k of ["unet_name", "ckpt_name"]) if (typeof v(k) === "string" && !out.checkpoint) out.checkpoint = v(k).split(/[\\/]/).pop();
        if (num(v("steps")) != null && out.steps == null) out.steps = num(v("steps"));
        if (num(v("cfg")) != null && out.cfg == null) out.cfg = num(v("cfg"));
        if (typeof v("sampler_name") === "string" && !out.sampler) out.sampler = v("sampler_name");
        if (typeof v("scheduler") === "string" && !out.scheduler) out.scheduler = v("scheduler");
        if (num(v("shift")) != null && out.shift == null) out.shift = num(v("shift"));
        if (num(v("width")) != null && num(v("height")) != null && out.width == null && (num(v("length")) != null || num(v("num_frames")) != null || num(v("frames")) != null || /latent/i.test(String(node.class_type ?? "")))) {
          [out.width, out.height] = [num(v("width")), num(v("height"))];
          out.frames = num(v("length")) ?? num(v("num_frames")) ?? num(v("frames"));
        }
        for (const k of ["fps", "frame_rate"]) if (num(v(k)) != null && out.fps == null) out.fps = num(v(k));
      }
    } catch {
      // not a workflow this reads
    }
  }
  return out;
}

const reactionsOf = (stats) => (stats && typeof stats === "object" ? ["likeCount", "heartCount", "laughCount", "cryCount"].reduce((n, k) => n + (Number(stats[k]) || 0), 0) : null);
// Civitai's levels: numbers (1 PG, 2 PG-13, 4 R, 8 X, 16 XXX) or their names.
const adultLevel = (level) => (typeof level === "number" ? level >= 4 : !["none", "soft", "pg", "pg13", ""].includes(String(level ?? "").toLowerCase()));
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round(((s[s.length / 2 - 1] + s[s.length / 2]) / 2) * 100) / 100) : null;
};
const mostCommon = (xs) => {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
};

// A Civitai model and the version of it on the machine, read as a recipe.
// `stats` maps a showcase image's number to its reactions, so the clip
// people liked most comes first; without them the creator's order holds.
export function civitaiRecipe(model, version, { stats = new Map(), adult = false } = {}) {
  const fileNames = (version.files ?? []).map((f) => String(f.name ?? ""));
  let hidden = 0;
  const samples = (version.images ?? [])
    .map((im, order) => {
      const id = /\/(\d+)\.\w+(?:\?.*)?$/.exec(String(im.url ?? ""))?.[1] ?? null;
      const s = sampleSettings(im.meta, { fileNames, versionId: version.id, modelName: model.name });
      return { id, url: String(im.url ?? ""), type: im.type === "video" ? "video" : "image", width: num(im.width), height: num(im.height), seconds: num(im.metadata?.duration), adult: adultLevel(im.nsfwLevel), reactions: id != null && stats.has(id) ? stats.get(id) : null, order, ...s };
    })
    .filter((s) => s.prompt)
    .filter((s) => {
      if (adult || !s.adult) return true;
      hidden += 1;
      return false;
    })
    .sort((a, b) => (b.reactions ?? -1) - (a.reactions ?? -1) || a.order - b.order)
    .slice(0, SAMPLE_LIMIT);
  const notesText = [textOf(version.description), textOf(model.description)].filter(Boolean).join("\n\n");
  const notes = creatorNotes(notesText);
  const used = samples.map((s) => s.strength).filter((x) => x != null);
  const strength = notes.strength ?? (used.length ? { low: median(used), high: median(used), from: "showcase" } : null);
  return {
    source: "civitai",
    id: `civitai/${model.id}`,
    name: String(model.name ?? "").trim(),
    version: { id: version.id, name: String(version.name ?? "") },
    creator: model.creator?.username ?? "",
    url: `https://civitai.com/models/${model.id}?modelVersionId=${version.id}`,
    trigger: (version.trainedWords ?? []).filter((w) => typeof w === "string").slice(0, 8),
    tips: notes.tips,
    strength,
    settings: samples.length ? { steps: mostCommon(samples.map((s) => s.steps).filter((x) => x != null)), cfg: mostCommon(samples.map((s) => s.cfg).filter((x) => x != null)) } : null,
    notesText: notesText.slice(0, 6000),
    samples,
    hidden,
  };
}

// A Hugging Face repository's model card as a recipe: the instance prompt
// and the widget's examples from the front matter (each with the clip it
// made, when the card shows one), a "Recommended settings" table and the
// prompt the card says to use, and the sentences with advice in them.
export function hubRecipe(repo, readme, { hubBase = "https://huggingface.co" } = {}) {
  const text = String(readme ?? "").replace(/\r\n/g, "\n");
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  const front = fm ? fm[1] : "";
  const body = fm ? text.slice(fm[0].length) : text;
  const scalar = (key) => {
    const m = new RegExp(`^${key}:[ \\t]*(.*)$`, "m").exec(front);
    if (!m) return "";
    if (!/^[>|]-?$/.test(m[1].trim())) return m[1].trim().replace(/^["']|["']$/g, "");
    const lines = [];
    for (const line of front.slice(m.index + m[0].length + 1).split("\n")) {
      if (!/^\s+\S/.test(line)) break;
      lines.push(line.trim());
    }
    return lines.join(m[1].trim().startsWith("|") ? "\n" : " ").trim();
  };
  const instance = scalar("instance_prompt");
  const samples = [];
  const widget = /^widget:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(front)?.[1] ?? "";
  for (const block of widget.split(/^\s*-\s+(?=text:)/m).slice(1)) {
    const t = /^text:[ \t]*(.*)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    const u = /^\s*url:[ \t]*(.*)$/m.exec(block)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    if (!t) continue;
    const url = u ? (/^https?:/.test(u) ? u : `${hubBase}/${repo}/resolve/main/${u.replace(/^\.?\//, "")}`) : "";
    samples.push({ prompt: t, url, type: /\.(mp4|webm|mov)(\?|$)/i.test(url) ? "video" : url ? "image" : null, negative: "", steps: null, cfg: null, strength: null, with: [], checkpoint: null, width: null, height: null, frames: null, fps: null, reactions: null, adult: false });
  }
  // The prompt the card says to use, in a text block.
  for (const m of body.matchAll(/```(?:text|txt|plaintext|prompt)?\n([\s\S]*?)```/g)) {
    const p = m[1].trim();
    if (p.length >= 40 && p.length <= 4000 && !/[{};=<>]|^\s*(pip|python|import|from|git|huggingface-cli)\b/m.test(p) && !samples.some((s) => s.prompt === p)) samples.push({ prompt: p, url: "", type: null, negative: "", steps: null, cfg: null, strength: null, with: [], checkpoint: null, width: null, height: null, frames: null, fps: null, reactions: null, adult: false });
  }
  // Tables as "setting: value" lines, so the advice in them reads as sentences.
  const rows = [];
  const prose = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .split("\n")
    .map((line) => {
      const cells = /^\s*\|(.+)\|\s*$/.exec(line)?.[1].split("|").map((c) => c.trim());
      if (!cells) return line.replace(/^#+\s*/, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "");
      if (cells.length < 2 || cells.every((c) => /^:?-+:?$/.test(c)) || /^(setting|parameter|name|key)$/i.test(cells[0])) return "";
      const row = `${cells[0].replace(/[*_`]+/g, "")}: ${cells.slice(1).map((c) => c.replace(/[*_`]+/g, "")).join(", ")}.`;
      rows.push(row);
      return row;
    })
    .join("\n");
  const notes = creatorNotes(prose);
  const steps = rows.map((r) => /\bsteps?\b[^\d]{0,12}(\d{1,3})\b/i.exec(r)?.[1]).find(Boolean) ?? null;
  const cfg = rows.map((r) => /\b(?:cfg|guidance)\b[^\d]{0,16}(\d+(?:\.\d+)?)\b/i.exec(r)?.[1]).find(Boolean) ?? null;
  const strength = notes.strength ?? (() => {
    const m = rows.map((r) => /\b(?:strength|weight|scale)\b[^\d]{0,16}(\d(?:\.\d+)?)\b/i.exec(r)?.[1]).find(Boolean);
    return m ? { low: Number(m), high: Number(m), from: "notes", text: rows.find((r) => r.includes(m)) } : null;
  })();
  const trigger = instance && instance.length <= 60 ? [instance] : [];
  if (instance && instance.length > 60 && !samples.some((s) => s.prompt === instance)) samples.unshift({ prompt: instance, url: "", type: null, negative: "", steps: null, cfg: null, strength: null, with: [], checkpoint: null, width: null, height: null, frames: null, fps: null, reactions: null, adult: false });
  return {
    source: "hf",
    id: repo,
    name: repo.split("/").pop(),
    version: null,
    creator: repo.split("/")[0],
    url: `https://huggingface.co/${repo}`,
    trigger,
    tips: notes.tips,
    strength,
    settings: steps != null || cfg != null ? { steps: steps != null ? Number(steps) : null, cfg: cfg != null ? Number(cfg) : null } : null,
    notesText: prose.replace(/\n{3,}/g, "\n\n").trim().slice(0, 6000),
    samples: samples.slice(0, SAMPLE_LIMIT),
    hidden: 0,
  };
}
