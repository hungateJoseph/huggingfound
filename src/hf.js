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

  // Full details for one model, including file names and sizes.
  async function model(id) {
    const res = await fetchImpl(new URL(`/api/models/${id}?blobs=true`, base), { headers: headers() });
    if (res.status === 401 || res.status === 403) return { id, gatedBlocked: true };
    if (!res.ok) throw new Error(`Hugging Face replied HTTP ${res.status} for ${id}`);
    const m = await res.json();
    const files = (m.siblings ?? []).map((s) => ({ name: s.rfilename, gb: s.size ? s.size / 1024 ** 3 : null }));
    return { ...summarize(m), files, cardData: m.cardData ?? {} };
  }

  return { scan, model, list };
}

// The slice of a Hub model record the app shows and reasons about.
export function summarize(m) {
  const { categories, runner, gguf } = categorize(m);
  return {
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
    const ggufs = files.filter((f) => /\.gguf$/i.test(f.name) && !/mmproj/i.test(f.name));
    // Chat models are fine around 4 bits. Image models lose detail below 8.
    const preferred = runnerId === "sd" ? ["Q8_0", "F16", "f16", "Q5_0", "Q4_0"] : ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "IQ4_XS", "Q8_0", "F16", "f16"];
    for (const q of preferred) {
      const hit = ggufs.find((f) => f.name.includes(q));
      if (hit) return hit;
    }
    if (ggufs.length) return ggufs.sort((a, b) => (a.gb ?? 0) - (b.gb ?? 0))[0];
    if (runnerId === "sd") {
      const single = files.filter((f) => /\.safetensors$/i.test(f.name) && !f.name.includes("/") && !/lora|vae|refiner/i.test(f.name));
      return single.sort((a, b) => (a.gb ?? 0) - (b.gb ?? 0))[0] ?? null;
    }
    return null;
  }
  if (runnerId === "whisper") {
    const bins = files.filter((f) => /^ggml-.*\.bin$/.test(f.name));
    return bins.find((f) => f.name === "ggml-base.en.bin") ?? bins.find((f) => f.name === "ggml-base.bin") ?? bins[0] ?? null;
  }
  return null;
}

// The quantization suffix Ollama wants after `hf.co/user/repo:`.
export function quantTag(fileName) {
  const m = /[-.]((?:I?Q\d[_A-Z0-9]*)|F16|BF16|f16|bf16)\.gguf$/i.exec(fileName);
  return m ? m[1] : null;
}
