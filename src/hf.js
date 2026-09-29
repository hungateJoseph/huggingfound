import { categorize, describe } from "./categorize.js";

// Talks to the Hugging Face Hub API. `fetchImpl` and `base` are injectable so
// tests can point the client at a local stub.

export function createHub({ fetchImpl = fetch, base = "https://huggingface.co", token = "" } = {}) {
  const headers = () => {
    const h = { Accept: "application/json", "User-Agent": "huggingfound" };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  };

  async function list(params) {
    const url = new URL("/api/models", base);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetchImpl(url, { headers: headers() });
    if (!res.ok) throw new Error(`Hugging Face replied HTTP ${res.status} for ${url.pathname}${url.search}`);
    return res.json();
  }

  // The scan: several listings merged, so every category has candidates
  // even when the overall trending list is dominated by one kind of model.
  // Coding, math and classic image models get their own searches because
  // the trending list rarely surfaces them.
  async function scan() {
    const queries = [
      { sort: "trendingScore", direction: "-1", limit: "60" },
      { sort: "trendingScore", direction: "-1", limit: "40", filter: "gguf", pipeline_tag: "text-generation" },
      { sort: "createdAt", direction: "-1", limit: "30", filter: "gguf", pipeline_tag: "text-generation" },
      { sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf", pipeline_tag: "image-text-to-text" },
      { sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf", pipeline_tag: "text-generation", search: "coder" },
      { sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf", pipeline_tag: "text-generation", search: "math" },
      { sort: "trendingScore", direction: "-1", limit: "20", pipeline_tag: "text-to-image" },
      { sort: "trendingScore", direction: "-1", limit: "20", pipeline_tag: "text-to-image", search: "stable-diffusion" },
      { sort: "trendingScore", direction: "-1", limit: "20", pipeline_tag: "automatic-speech-recognition" },
      { sort: "likes", direction: "-1", limit: "30", filter: "gguf", pipeline_tag: "text-generation" },
      { sort: "likes", direction: "-1", limit: "20", pipeline_tag: "text-to-image" },
      { sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf", pipeline_tag: "text-generation", search: "uncensored" },
      { sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf", pipeline_tag: "text-generation", search: "roleplay" },
      { sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf,not-for-all-audiences", pipeline_tag: "text-generation" },
      { sort: "trendingScore", direction: "-1", limit: "20", pipeline_tag: "text-to-image", search: "nsfw" },
      { sort: "trendingScore", direction: "-1", limit: "20", pipeline_tag: "text-to-image", filter: "not-for-all-audiences" },
    ];
    const seen = new Map();
    for (const q of queries) {
      let items = [];
      try {
        items = await list(q);
      } catch (err) {
        // One listing failing should not empty the whole scan.
        if (seen.size === 0 && q === queries[queries.length - 1]) throw err;
        continue;
      }
      for (const m of items) if (!seen.has(m.id)) seen.set(m.id, m);
    }
    return [...seen.values()].map(summarize);
  }

  // A free-text search for the traits someone wants ("uncensored roleplay
  // 7b", "japanese", "medical"): the plain Hub search plus the same search
  // narrowed to GGUF, so runnable models are never crowded out.
  async function search(q) {
    const terms = String(q).trim().slice(0, 120);
    if (!terms) return [];
    const queries = [
      { search: terms, sort: "trendingScore", direction: "-1", limit: "30" },
      { search: terms, sort: "trendingScore", direction: "-1", limit: "30", filter: "gguf" },
      { search: terms, sort: "likes", direction: "-1", limit: "20" },
    ];
    const seen = new Map();
    const collect = async (query, required) => {
      let items = [];
      try {
        items = await list(query);
      } catch (err) {
        if (required && seen.size === 0) throw err;
        return;
      }
      for (const m of items) if (!seen.has(m.id)) seen.set(m.id, m);
    };
    for (const query of queries) await collect(query, query === queries[queries.length - 1]);

    // The Hub matches every word against the repository name, so several
    // traits at once often find nothing. Then each word is searched on its
    // own and the models matching the most words come first.
    const words = terms.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    if (seen.size < 10 && words.length > 1) {
      for (const w of words) {
        await collect({ search: w, sort: "trendingScore", direction: "-1", limit: "20", filter: "gguf" });
        await collect({ search: w, sort: "trendingScore", direction: "-1", limit: "15" });
      }
    }
    const matches = (m) => words.filter((w) => m.id.toLowerCase().includes(w)).length;
    return [...seen.values()].sort((a, b) => matches(b) - matches(a)).map(summarize);
  }

  // Full details for one model, including file names and sizes.
  async function model(id) {
    const res = await fetchImpl(new URL(`/api/models/${id}?blobs=true`, base), { headers: headers() });
    if (res.status === 401 || res.status === 403) return { id, gatedBlocked: true };
    if (!res.ok) throw new Error(`Hugging Face replied HTTP ${res.status} for ${id}`);
    const m = await res.json();
    const files = (m.siblings ?? []).map((s) => ({ name: s.rfilename, gb: s.size ? s.size / 1024 ** 3 : null }));
    return { ...summarize(m), files, cardData: m.cardData ?? {} };
  }

  return { scan, search, model, list };
}

// The slice of a Hub model record the app shows and reasons about.
export function summarize(m) {
  const { categories, runner, gguf, adult } = categorize(m);
  return {
    adult,
    fast: categories.includes("images") && /turbo|lightning|lcm|hyper/i.test(m.id),
    id: m.id,
    name: m.id.split("/").pop(),
    author: m.id.split("/")[0],
    pipeline: m.pipeline_tag ?? null,
    library: m.library_name ?? null,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    createdAt: m.createdAt ?? null,
    gated: Boolean(m.gated),
    tags: (m.tags ?? []).filter((t) => !t.includes(":")).slice(0, 12),
    categories,
    runner,
    gguf,
    summary: describe(m, categories),
    url: `https://huggingface.co/${m.id}`,
  };
}

// Picks the file to download for a model on a given runner. Text models on
// Ollama want one GGUF around 4-bit; the smallest file that is still a
// sensible quantization wins. Images and speech have their own rules.
export function chooseFile(files, runnerId) {
  if (runnerId === "ollama" || runnerId === "sd") {
    const ggufs = files.filter((f) => /\.gguf$/i.test(f.name) && !/mmproj/i.test(f.name) && (runnerId !== "sd" || (f.gb ?? 1) >= 0.8));
    // Chat models are fine around 4 bits. Image models lose detail below 8.
    const preferred = runnerId === "sd" ? ["Q8_0", "F16", "f16", "Q5_0", "Q4_0"] : ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "IQ4_XS", "Q8_0", "F16", "f16"];
    for (const q of preferred) {
      const hit = ggufs.find((f) => f.name.includes(q));
      if (hit) return hit;
    }
    if (ggufs.length) return ggufs.sort((a, b) => (a.gb ?? 0) - (b.gb ?? 0))[0];
    if (runnerId === "sd") {
      // A checkpoint with the encoders and decoder inside is never small:
      // 2 GB for SD 1.5 in half precision, 6.5 GB for SDXL. Anything under
      // that at the top level is an add-on (a LoRA, an embedding, a hands
      // fix) and would only fail to load.
      const single = files.filter((f) => /\.safetensors$/i.test(f.name) && !f.name.includes("/") && !/lora|vae|refiner|embedding|fix|lycoris/i.test(f.name) && (f.gb ?? 0) >= 1.5);
      const named = single.filter((f) => /^(model|checkpoint|sd|v\d)/i.test(f.name));
      const pool = named.length ? named : single;
      return pool.sort((a, b) => (a.gb ?? 0) - (b.gb ?? 0))[0] ?? diffusersFolder(files);
    }
    return null;
  }

  if (runnerId === "whisper") {
    const bins = files.filter((f) => /^ggml-.*\.bin$/.test(f.name));
    return bins.find((f) => f.name === "ggml-base.en.bin") ?? bins.find((f) => f.name === "ggml-base.bin") ?? bins[0] ?? null;
  }
  return null;
}

// A repository in the diffusers folder layout (unet/, vae/, text_encoder/,
// text_encoder_2/) loads in stable-diffusion.cpp as a folder, as long as the
// four weight files sit under their plain names. The half-precision variant
// is taken when the repository has one; it is the same model at half the size.
export function diffusersFolder(files) {
  const want = [
    ["unet/diffusion_pytorch_model", true],
    ["vae/diffusion_pytorch_model", false],
    ["text_encoder/model", false],
    ["text_encoder_2/model", false],
  ];
  const parts = [];
  for (const [base, required] of want) {
    const fp16 = files.find((f) => f.name === `${base}.fp16.safetensors`);
    const full = files.find((f) => f.name === `${base}.safetensors`);
    const pick = fp16 ?? full;
    if (!pick) {
      if (required) return null;
      continue;
    }
    parts.push({ from: pick.name, to: `${base}.safetensors`, gb: pick.gb ?? 0 });
  }
  if (!parts.some((p) => p.to.startsWith("text_encoder/"))) return null;
  return { name: "diffusers folder", folder: true, xl: parts.some((p) => p.to.startsWith("text_encoder_2/")), parts, gb: parts.reduce((t, p) => t + p.gb, 0) || null };
}

// The quantization suffix Ollama wants after `hf.co/user/repo:`.
export function quantTag(fileName) {
  const m = /[-.]((?:I?Q\d[_A-Z0-9]*)|F16|BF16|f16|bf16)\.gguf$/i.exec(fileName);
  return m ? m[1] : null;
}
