import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

// Turns a Stable Diffusion repository in the diffusers folder layout
// (unet/, vae/, text_encoder/, text_encoder_2/) into the single checkpoint
// file that stable-diffusion.cpp reads best. Only tensor names change; the
// weights are copied byte for byte. The name mappings mirror the reference
// scripts in the diffusers repository (convert_diffusers_to_original_*.py).

// ---- safetensors ---------------------------------------------------------------

export function readHeader(file) {
  const fd = fs.openSync(file, "r");
  try {
    const len = Buffer.alloc(8);
    fs.readSync(fd, len, 0, 8, 0);
    const n = Number(len.readBigUInt64LE(0));
    const raw = Buffer.alloc(n);
    fs.readSync(fd, raw, 0, n, 8);
    const header = JSON.parse(raw.toString("utf8"));
    const size = fs.fstatSync(fd).size;
    return { header, dataStart: 8 + n, dataLength: size - 8 - n };
  } finally {
    fs.closeSync(fd);
  }
}

export function writeHeaderBuffer(header) {
  let json = Buffer.from(JSON.stringify(header), "utf8");
  // The header is padded with spaces to a multiple of 8, as safetensors does.
  const pad = (8 - (json.length % 8)) % 8;
  if (pad) json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
  const len = Buffer.alloc(8);
  len.writeBigUInt64LE(BigInt(json.length), 0);
  return Buffer.concat([len, json]);
}

// ---- name conversion -------------------------------------------------------

const UNET_RESNET = [["in_layers.0", "norm1"], ["in_layers.2", "conv1"], ["out_layers.0", "norm2"], ["out_layers.3", "conv2"], ["emb_layers.1", "time_emb_proj"], ["skip_connection", "conv_shortcut"]];

const UNET_EXACT = new Map([
  ["time_embedding.linear_1.weight", "time_embed.0.weight"],
  ["time_embedding.linear_1.bias", "time_embed.0.bias"],
  ["time_embedding.linear_2.weight", "time_embed.2.weight"],
  ["time_embedding.linear_2.bias", "time_embed.2.bias"],
  ["conv_in.weight", "input_blocks.0.0.weight"],
  ["conv_in.bias", "input_blocks.0.0.bias"],
  ["conv_norm_out.weight", "out.0.weight"],
  ["conv_norm_out.bias", "out.0.bias"],
  ["conv_out.weight", "out.2.weight"],
  ["conv_out.bias", "out.2.bias"],
  ["add_embedding.linear_1.weight", "label_emb.0.0.weight"],
  ["add_embedding.linear_1.bias", "label_emb.0.0.bias"],
  ["add_embedding.linear_2.weight", "label_emb.0.2.weight"],
  ["add_embedding.linear_2.bias", "label_emb.0.2.bias"],
]);

function unetLayers(xl) {
  const blocks = xl ? 3 : 4;
  const upResnets = xl ? 4 : 3;
  const layers = [];
  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < 2; j++) {
      layers.push([`down_blocks.${i}.resnets.${j}.`, `input_blocks.${3 * i + j + 1}.0.`]);
      if (xl ? i > 0 : i < 3) layers.push([`down_blocks.${i}.attentions.${j}.`, `input_blocks.${3 * i + j + 1}.1.`]);
    }
    for (let j = 0; j < upResnets; j++) {
      layers.push([`up_blocks.${i}.resnets.${j}.`, `output_blocks.${3 * i + j}.0.`]);
      if (xl ? i < 2 : i > 0) layers.push([`up_blocks.${i}.attentions.${j}.`, `output_blocks.${3 * i + j}.1.`]);
    }
    if (i < 3) {
      layers.push([`down_blocks.${i}.downsamplers.0.conv.`, `input_blocks.${3 * (i + 1)}.0.op.`]);
      layers.push([`up_blocks.${i}.upsamplers.0.`, `output_blocks.${3 * i + 2}.${i === 0 ? 1 : 2}.`]);
    }
  }
  if (xl) layers.push(["output_blocks.2.1.conv.", "output_blocks.2.2.conv."]);
  layers.push(["mid_block.attentions.0.", "middle_block.1."]);
  for (let j = 0; j < 2; j++) layers.push([`mid_block.resnets.${j}.`, `middle_block.${2 * j}.`]);
  return layers;
}

const UNET_LAYERS = { sd1: unetLayers(false), xl: unetLayers(true) };

export function convertUnetName(name, xl) {
  if (UNET_EXACT.has(name)) return UNET_EXACT.get(name);
  let out = name;
  if (out.includes("resnets")) for (const [sd, hf] of UNET_RESNET) out = out.replace(hf, sd);
  for (const [hf, sd] of UNET_LAYERS[xl ? "xl" : "sd1"]) {
    if (out.includes(hf)) out = out.replace(hf, sd);
  }
  return out;
}

const VAE_BASE = [["conv_shortcut", "nin_shortcut"], ["conv_norm_out", "norm_out"], ["mid_block.attentions.0.", "mid.attn_1."]];
const VAE_LAYERS = (() => {
  const layers = [];
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 2; j++) layers.push([`encoder.down_blocks.${i}.resnets.${j}.`, `encoder.down.${i}.block.${j}.`]);
    if (i < 3) {
      layers.push([`down_blocks.${i}.downsamplers.0.`, `down.${i}.downsample.`]);
      layers.push([`up_blocks.${i}.upsamplers.0.`, `up.${3 - i}.upsample.`]);
    }
    for (let j = 0; j < 3; j++) layers.push([`decoder.up_blocks.${i}.resnets.${j}.`, `decoder.up.${3 - i}.block.${j}.`]);
  }
  for (let i = 0; i < 2; i++) layers.push([`mid_block.resnets.${i}.`, `mid.block_${i + 1}.`]);
  return layers;
})();
const VAE_ATTN = [["group_norm.", "norm."], ["query.", "q."], ["key.", "k."], ["value.", "v."], ["proj_attn.", "proj_out."]];
const VAE_ATTN_NEW = [["to_q", "q"], ["to_k", "k"], ["to_v", "v"], ["to_out.0", "proj_out"]];

export function convertVaeName(name) {
  let out = name;
  for (const [hf, sd] of VAE_BASE) if (out.includes(hf)) out = out.replace(hf, sd);
  for (const [hf, sd] of VAE_LAYERS) if (out.includes(hf)) out = out.replace(hf, sd);
  if (name.includes("attentions")) for (const [hf, sd] of VAE_ATTN) if (out.includes(hf)) out = out.replace(hf, sd);
  if (out.includes("mid.attn_1.")) for (const [hf, sd] of VAE_ATTN_NEW) if (out.includes(hf)) out = out.replace(hf, sd);
  return out;
}

// The prefixes a single-file checkpoint uses for each part.
export function partPrefix(part, xl) {
  if (part === "unet") return "model.diffusion_model.";
  if (part === "vae") return "first_stage_model.";
  if (part === "text_encoder") return xl ? "conditioner.embedders.0.transformer." : "cond_stage_model.transformer.";
  if (part === "text_encoder_2") return "conditioner.embedders.1.transformer.";
  throw new Error(`Unknown part ${part}`);
}

export function convertName(part, name, xl) {
  if (part === "unet") return partPrefix(part, xl) + convertUnetName(name, xl);
  if (part === "vae") return partPrefix(part, xl) + convertVaeName(name);
  return partPrefix(part, xl) + name;
}

// ---- the merge -----------------------------------------------------------------

export const PART_FILES = {
  unet: "unet/diffusion_pytorch_model.safetensors",
  vae: "vae/diffusion_pytorch_model.safetensors",
  text_encoder: "text_encoder/model.safetensors",
  text_encoder_2: "text_encoder_2/model.safetensors",
};

// Writes `outFile` from the parts under `dir`. Tensor bytes are copied in
// one pass per part, so only the small header is held in memory.
export async function convertDiffusersFolder(dir, outFile, emit = () => {}) {
  const parts = Object.entries(PART_FILES).filter(([, rel]) => fs.existsSync(path.join(dir, rel)));
  const names = parts.map(([p]) => p);
  if (!names.includes("unet") || !names.includes("text_encoder")) throw new Error("the folder is missing the unet or the text encoder");
  const xl = names.includes("text_encoder_2");
  const header = { __metadata__: { format: "pt", converted_by: "huggingfound", layout: "diffusers", model: xl ? "sdxl" : "sd1" } };
  let base = 0;
  const sources = [];
  for (const [part, rel] of parts) {
    const file = path.join(dir, rel);
    const { header: h, dataStart, dataLength } = readHeader(file);
    let count = 0;
    for (const [name, t] of Object.entries(h)) {
      if (name === "__metadata__") continue;
      // Position ids are bookkeeping, not weights; a checkpoint never has them.
      if (name.endsWith("position_ids")) continue;
      const newName = convertName(part, name, xl);
      if (header[newName]) throw new Error(`two tensors map to ${newName}`);
      header[newName] = { dtype: t.dtype, shape: t.shape, data_offsets: [t.data_offsets[0] + base, t.data_offsets[1] + base] };
      count++;
    }
    sources.push({ file, dataStart, dataLength, part, count });
    base += dataLength;
  }
  emit(`Merging ${sources.map((s) => `${s.part} (${s.count} tensors)`).join(", ")} into one ${xl ? "SDXL" : "SD 1.x"} checkpoint`);
  const tmp = `${outFile}.part`;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const out = fs.createWriteStream(tmp);
  await new Promise((resolve, reject) => out.write(writeHeaderBuffer(header), (err) => (err ? reject(err) : resolve())));
  for (const s of sources) {
    emit(`Copying ${s.part}`);
    await pipeline(fs.createReadStream(s.file, { start: s.dataStart, end: s.dataStart + s.dataLength - 1 }), out, { end: false });
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  fs.renameSync(tmp, outFile);
  return { xl, tensors: Object.keys(header).length - 1, parts: names };
}
