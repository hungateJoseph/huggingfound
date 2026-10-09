import http from "node:http";

// A tiny stand-in for the Hugging Face Hub: answers the listings the scan
// asks for, model details with file sizes, a gated model, and file downloads.

export const MODELS = [
  { id: "bartowski/Llama-3.2-3B-Instruct-GGUF", pipeline_tag: "text-generation", library_name: "gguf", tags: ["gguf", "text-generation", "conversational"], downloads: 250000, likes: 400, createdAt: "2024-09-25T00:00:00.000Z" },
  { id: "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF", pipeline_tag: "text-generation", library_name: "gguf", tags: ["gguf", "code", "conversational"], downloads: 90000, likes: 120, createdAt: "2024-11-12T00:00:00.000Z" },
  { id: "bartowski/Qwen2.5-Math-7B-Instruct-GGUF", pipeline_tag: "text-generation", library_name: "gguf", tags: ["gguf", "math"], downloads: 12000, likes: 30, createdAt: "2024-10-01T00:00:00.000Z" },
  { id: "meta-llama/Llama-3.1-8B-Instruct", pipeline_tag: "text-generation", library_name: "transformers", tags: ["transformers", "safetensors", "conversational"], gated: "manual", downloads: 5000000, likes: 4000, createdAt: "2024-07-23T00:00:00.000Z" },
  { id: "unsloth/gemma-3-4b-it-GGUF", pipeline_tag: "image-text-to-text", library_name: "transformers", tags: ["gguf", "image-text-to-text"], downloads: 80000, likes: 200, createdAt: "2025-03-12T00:00:00.000Z" },
  { id: "Qwen/Qwen-Image", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "text-to-image"], downloads: 300000, likes: 2500, createdAt: "2025-08-04T00:00:00.000Z" },
  { id: "Wan-AI/Wan2.2-TI2V-5B-Diffusers", pipeline_tag: "text-to-video", library_name: "diffusers", tags: ["diffusers", "text-to-video"], downloads: 50000, likes: 400, createdAt: "2025-07-28T00:00:00.000Z" },
  { id: "Wan-AI/Wan2.2-T2V-A14B", pipeline_tag: "text-to-video", library_name: "diffusers", tags: ["diffusers", "text-to-video"], downloads: 40000, likes: 700, createdAt: "2025-07-28T00:00:00.000Z" },
  { id: "stabilityai/stable-video-diffusion-img2vid", pipeline_tag: "image-to-video", library_name: "diffusers", tags: ["diffusers", "image-to-video"], downloads: 200000, likes: 3000, createdAt: "2023-11-21T00:00:00.000Z" },
  { id: "second-state/stable-diffusion-v1-5-GGUF", pipeline_tag: "text-to-image", library_name: null, tags: ["gguf", "text-to-image"], downloads: 3000, likes: 20, createdAt: "2024-08-20T00:00:00.000Z" },
  { id: "black-forest-labs/FLUX.1-dev", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "text-to-image"], gated: "auto", downloads: 900000, likes: 9000, createdAt: "2024-08-01T00:00:00.000Z" },
  { id: "ggerganov/whisper.cpp", pipeline_tag: "automatic-speech-recognition", library_name: null, tags: ["automatic-speech-recognition"], downloads: 400000, likes: 900, createdAt: "2023-03-01T00:00:00.000Z" },
  { id: "openai/whisper-large-v3", pipeline_tag: "automatic-speech-recognition", library_name: "transformers", tags: ["transformers", "safetensors"], downloads: 3000000, likes: 3000, createdAt: "2023-11-07T00:00:00.000Z" },
  { id: "TheDrummer/Cydonia-24B-v2-GGUF", pipeline_tag: "text-generation", library_name: "gguf", tags: ["gguf", "not-for-all-audiences", "conversational"], downloads: 40000, likes: 350, createdAt: "2026-09-20T00:00:00.000Z" },
  { id: "polite/Polite-Chat-7B-GGUF", pipeline_tag: "text-generation", library_name: "gguf", tags: ["gguf", "conversational"], downloads: 5000, likes: 900, createdAt: "2025-05-01T00:00:00.000Z" },
  { id: "John6666/pony-realism-v23-sdxl", pipeline_tag: "text-to-image", library_name: "diffusers", tags: ["diffusers", "stable-diffusion-xl", "not-for-all-audiences", "diffusers:StableDiffusionXLPipeline"], downloads: 25000, likes: 90, createdAt: "2026-08-01T00:00:00.000Z" },
];

export const FILES = {
  "bartowski/Llama-3.2-3B-Instruct-GGUF": [
    { rfilename: "README.md", size: 12000 },
    { rfilename: "Llama-3.2-3B-Instruct-Q8_0.gguf", size: 3.4 * 1024 ** 3 },
    { rfilename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf", size: 2.0 * 1024 ** 3 },
    { rfilename: "Llama-3.2-3B-Instruct-f16.gguf", size: 6.4 * 1024 ** 3 },
  ],
  "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF": [{ rfilename: "Qwen2.5-Coder-7B-Instruct-Q4_K_M.gguf", size: 4.7 * 1024 ** 3 }],
  "bartowski/Qwen2.5-Math-7B-Instruct-GGUF": [{ rfilename: "Qwen2.5-Math-7B-Instruct-Q4_K_M.gguf", size: 4.7 * 1024 ** 3 }],
  "unsloth/gemma-3-4b-it-GGUF": [
    { rfilename: "gemma-3-4b-it-Q4_K_M.gguf", size: 2.5 * 1024 ** 3 },
    { rfilename: "mmproj-F16.gguf", size: 0.8 * 1024 ** 3 },
  ],
  "second-state/stable-diffusion-v1-5-GGUF": [
    { rfilename: "stable-diffusion-v1-5-pruned-emaonly-Q4_0.gguf", size: 1.1 * 1024 ** 3 },
    { rfilename: "stable-diffusion-v1-5-pruned-emaonly-Q8_0.gguf", size: 1.76 * 1024 ** 3 },
  ],
  "ggerganov/whisper.cpp": [
    { rfilename: "ggml-tiny.bin", size: 75 * 1024 ** 2 },
    { rfilename: "ggml-base.en.bin", size: 148 * 1024 ** 2 },
    { rfilename: "ggml-large-v3.bin", size: 3.1 * 1024 ** 3 },
  ],
  "openai/whisper-large-v3": [{ rfilename: "model.safetensors", size: 3.1 * 1024 ** 3 }],
  "TheDrummer/Cydonia-24B-v2-GGUF": [{ rfilename: "Cydonia-24B-v2-Q8_0.gguf", size: 25.6 * 1024 ** 3 }],
  "Qwen/Qwen-Image": [
    { rfilename: "README.md", size: 9000 },
    { rfilename: "model_index.json", size: 500 },
    { rfilename: "assets/demo.png", size: 2000000 },
    { rfilename: "scheduler/scheduler_config.json", size: 300 },
    { rfilename: "text_encoder/config.json", size: 1200 },
    { rfilename: "text_encoder/model-00001-of-00002.safetensors", size: 9 * 1024 ** 3 },
    { rfilename: "text_encoder/model-00002-of-00002.safetensors", size: 7.4 * 1024 ** 3 },
    { rfilename: "text_encoder/model.safetensors.index.json", size: 60000 },
    { rfilename: "tokenizer/tokenizer.json", size: 7000000 },
    { rfilename: "tokenizer/tokenizer_config.json", size: 4000 },
    { rfilename: "transformer/config.json", size: 600 },
    { rfilename: "transformer/diffusion_pytorch_model-00001-of-00002.safetensors", size: 20 * 1024 ** 3 },
    { rfilename: "transformer/diffusion_pytorch_model-00002-of-00002.safetensors", size: 20.9 * 1024 ** 3 },
    { rfilename: "transformer/diffusion_pytorch_model.safetensors.index.json", size: 90000 },
    { rfilename: "vae/config.json", size: 800 },
    { rfilename: "vae/diffusion_pytorch_model.safetensors", size: 0.25 * 1024 ** 3 },
  ],
  "Wan-AI/Wan2.2-TI2V-5B-Diffusers": [
    { rfilename: "model_index.json", size: 500 },
    { rfilename: "scheduler/scheduler_config.json", size: 300 },
    { rfilename: "text_encoder/config.json", size: 1200 },
    { rfilename: "text_encoder/model.safetensors", size: 11.4 * 1024 ** 3 },
    { rfilename: "tokenizer/spiece.model", size: 800000 },
    { rfilename: "transformer/config.json", size: 600 },
    { rfilename: "transformer/diffusion_pytorch_model.safetensors", size: 10 * 1024 ** 3 },
    { rfilename: "vae/config.json", size: 800 },
    { rfilename: "vae/diffusion_pytorch_model.safetensors", size: 1.4 * 1024 ** 3 },
  ],
  "John6666/pony-realism-v23-sdxl": [
    { rfilename: "model_index.json", size: 600 },
    { rfilename: "unet/config.json", size: 1800 },
    { rfilename: "unet/diffusion_pytorch_model.safetensors", size: 9.56 * 1024 ** 3 },
    { rfilename: "unet/diffusion_pytorch_model.fp16.safetensors", size: 4.78 * 1024 ** 3 },
    { rfilename: "vae/diffusion_pytorch_model.fp16.safetensors", size: 0.16 * 1024 ** 3 },
    { rfilename: "text_encoder/model.fp16.safetensors", size: 0.23 * 1024 ** 3 },
    { rfilename: "text_encoder_2/model.fp16.safetensors", size: 1.29 * 1024 ** 3 },
    { rfilename: "tokenizer/vocab.json", size: 1000000 },
  ],
};

// Small but real safetensors files for the diffusers parts, so the merge
// step has something to convert.
export const TINY_PARTS = {
  "unet/diffusion_pytorch_model.fp16.safetensors": ["conv_in.weight", "down_blocks.1.attentions.0.transformer_blocks.1.attn1.to_k.weight", "up_blocks.0.resnets.2.norm1.weight", "add_embedding.linear_1.bias"],
  "vae/diffusion_pytorch_model.fp16.safetensors": ["encoder.mid_block.attentions.0.to_q.weight", "decoder.up_blocks.0.resnets.1.conv1.weight"],
  "text_encoder/model.fp16.safetensors": ["text_model.embeddings.token_embedding.weight", "text_model.embeddings.position_ids"],
  "text_encoder_2/model.fp16.safetensors": ["text_model.final_layer_norm.weight", "text_projection.weight"],
};

export function tinySafetensors(names) {
  const header = {};
  let offset = 0;
  const chunks = [];
  for (const [i, name] of names.entries()) {
    const data = Buffer.alloc(16, i + 1);
    header[name] = { dtype: "F16", shape: [2, 4], data_offsets: [offset, offset + data.length] };
    chunks.push(data);
    offset += data.length;
  }
  let json = Buffer.from(JSON.stringify(header));
  const pad = (8 - (json.length % 8)) % 8;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length));
  return Buffer.concat([len, json, ...chunks]);
}

export const CARDS = {
  "bartowski/Llama-3.2-3B-Instruct-GGUF": "---\nlicense: llama3.2\ntags:\n- llama\n---\n# Llama 3.2 3B Instruct\n\nA small assistant that is **great for quick answers** and summaries. Runs on a laptop.\n\n```sh\nollama run x\n```\n",
  "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF": "# Qwen2.5 Coder\n\nTrained on code. People use it for [coding help](https://example.com) and refactoring.",
  "ggerganov/whisper.cpp": "# whisper.cpp models\n\nggml files for whisper.cpp. Transcribes recordings offline.",
};

export const DISCUSSIONS = {
  "polite/Polite-Chat-7B-GGUF": [{ num: 1, title: "Refuses to write anything spicy, says it is against its guidelines", status: "open", numComments: 6, isPullRequest: false }],
  "bartowski/Llama-3.2-3B-Instruct-GGUF": [
    { num: 3, title: "Works well for roleplay and story writing", status: "open", numComments: 4, isPullRequest: false },
    { num: 2, title: "Add Q3 quants", status: "open", numComments: 0, isPullRequest: true },
    { num: 1, title: "Context length?", status: "closed", numComments: 2, isPullRequest: false },
  ],
  "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF": [{ num: 1, title: "Best local model for Rust coding help", status: "open", numComments: 7, isPullRequest: false }],
};

const THREADS = {
  "bartowski/Llama-3.2-3B-Instruct-GGUF/3": { num: 3, title: "Works well for roleplay and story writing", status: "open", events: [{ type: "comment", author: { name: "sam" }, data: { latest: { raw: "Tried it for **roleplay** and it keeps characters straight.\nNice." } } }, { type: "title-change" }, { type: "comment", author: { name: "kit" }, data: { latest: { raw: "Same here, good story writing." } } }] },
  "bartowski/Llama-3.2-3B-Instruct-GGUF/1": { num: 1, title: "Context length?", status: "closed", events: [{ type: "comment", author: { name: "jo" }, data: { latest: { raw: "128k." } } }] },
  "bartowski/Qwen2.5-Coder-7B-Instruct-GGUF/1": { num: 1, title: "Best local model for Rust coding help", status: "open", events: [{ type: "comment", author: { name: "ada" }, data: { latest: { raw: "It explains borrow checker errors better than the 3B." } } }] },
};

export function startStubHub({ extraModels = [] } = {}) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://stub");
    requests.push({ path: url.pathname + url.search, auth: req.headers.authorization ?? null });
    const all = [...MODELS, ...extraModels];

    if (url.pathname === "/api/models") {
      let items = all;
      const pipeline = url.searchParams.get("pipeline_tag");
      if (pipeline) items = items.filter((m) => m.pipeline_tag === pipeline);
      const filters = (url.searchParams.get("filter") ?? "").split(",").filter(Boolean);
      for (const f of filters) items = items.filter((m) => m.tags.includes(f));
      const search = (url.searchParams.get("search") ?? "").toLowerCase();
      if (search) items = items.filter((m) => search.split(/\s+/).every((t) => m.id.toLowerCase().includes(t)));
      return json(res, 200, items.slice(0, Number(url.searchParams.get("limit") || 100)));
    }
    const disc = /^\/api\/models\/([^/]+\/[^/]+)\/discussions(?:\/(\d+))?$/.exec(url.pathname);
    if (disc) {
      if (disc[2]) {
        const t = THREADS[`${disc[1]}/${disc[2]}`];
        return t ? json(res, 200, t) : json(res, 404, { error: "not found" });
      }
      return json(res, 200, { discussions: DISCUSSIONS[disc[1]] ?? [], count: (DISCUSSIONS[disc[1]] ?? []).length });
    }
    const raw = /^\/([^/]+\/[^/]+)\/raw\/main\/README\.md$/.exec(url.pathname);
    if (raw) {
      const card = CARDS[raw[1]];
      if (card === undefined) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(card);
    }
    const detail = /^\/api\/models\/([^/]+\/[^/]+)$/.exec(url.pathname);
    if (detail) {
      const m = all.find((x) => x.id === detail[1]);
      if (!m) return json(res, 404, { error: "not found" });
      if (m.gated && !req.headers.authorization) return json(res, 401, { error: "gated" });
      return json(res, 200, { ...m, siblings: FILES[m.id] ?? [], cardData: {} });
    }
    const dl = /^\/([^/]+\/[^/]+)\/resolve\/main\/(.+)$/.exec(url.pathname);
    if (dl) {
      const m = all.find((x) => x.id === dl[1]);
      if (!m) return json(res, 404, { error: "not found" });
      if (m.gated && !req.headers.authorization) return json(res, 401, { error: "gated" });
      // A diffusers index names the pipeline class, which says image or video.
      const body = dl[2] === "model_index.json" ? Buffer.from(JSON.stringify({ _class_name: /wan|video/i.test(dl[1]) ? "WanPipeline" : "QwenImagePipeline", _diffusers_version: "0.33.0" })) : TINY_PARTS[dl[2]] ? tinySafetensors(TINY_PARTS[dl[2]]) : Buffer.alloc(64 * 1024, dl[2]);
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length });
      return res.end(body);
    }
    json(res, 404, { error: "not found" });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, base: `http://127.0.0.1:${server.address().port}`, requests }));
  });
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
