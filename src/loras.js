// LoRAs and fine-tunes for a video model on the rented GPU, found where
// people publish them: Hugging Face (repositories that name the model as
// their base, which the Hub files under base_model:adapter: and
// base_model:finetune:) and Civitai (models filed under the base model's
// name there). Nothing is downloaded here; the page picks one and the
// machine fetches it. Civitai is asked for its safe-for-work listings only.

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

  async function fromCivitai(base) {
    const names = CIVITAI_BASES[base];
    if (!names) return [];
    const out = [];
    for (const [type, kind] of [["LORA", "lora"], ["Checkpoint", "finetune"]]) {
      const url = new URL("/api/v1/models", civitaiBase);
      url.searchParams.set("types", type);
      for (const n of names) url.searchParams.append("baseModels", n);
      url.searchParams.set("sort", "Most Downloaded");
      url.searchParams.set("nsfw", "false");
      url.searchParams.set("limit", "30");
      const data = await getJson(url, "Civitai");
      for (const m of data?.items ?? []) {
        if (m.nsfw) continue;
        const files = civitaiFiles(m, kind);
        if (!files.length) continue;
        out.push({ source: "civitai", id: `civitai/${m.id}`, name: String(m.name ?? "").trim(), creator: m.creator?.username ?? "", url: `https://civitai.com/models/${m.id}`, kind, downloads: m.stats?.downloadCount ?? 0, likes: m.stats?.thumbsUpCount ?? 0, files });
      }
    }
    return out;
  }

  return {
    // Everything found for a base model, Hugging Face's and Civitai's, each
    // with an error of its own when it did not answer.
    async find(base) {
      return cached(`find|${base}`, async () => {
        const [hf, civitai] = await Promise.allSettled([fromHub(base), fromCivitai(base)]);
        return {
          base,
          civitaiKnown: Boolean(CIVITAI_BASES[base]),
          items: [...(hf.status === "fulfilled" ? hf.value : []), ...(civitai.status === "fulfilled" ? civitai.value : [])],
          hfError: hf.status === "rejected" ? hf.reason.message : null,
          civitaiError: civitai.status === "rejected" ? civitai.reason.message : null,
        };
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

// The files of a Civitai model's newest version the machine can use, each
// kept on the machine under a plain name of its own (Civitai's names hold
// spaces and other scripts). A fine-tune's best precision comes first.
export function civitaiFiles(m, kind) {
  const v = (m.modelVersions ?? [])[0];
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
