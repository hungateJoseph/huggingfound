import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { convertDiffusersFolder, convertName, convertUnetName, convertVaeName, readHeader } from "../src/convert.js";
import { TINY_PARTS, tinySafetensors } from "./stub-hub.js";

test("unet names follow the reference SDXL and SD 1.x mappings", () => {
  assert.equal(convertUnetName("conv_in.weight", true), "input_blocks.0.0.weight");
  assert.equal(convertUnetName("add_embedding.linear_2.bias", true), "label_emb.0.2.bias");
  assert.equal(convertUnetName("down_blocks.1.attentions.0.transformer_blocks.1.attn1.to_k.weight", true), "input_blocks.4.1.transformer_blocks.1.attn1.to_k.weight");
  assert.equal(convertUnetName("down_blocks.0.resnets.1.time_emb_proj.weight", true), "input_blocks.2.0.emb_layers.1.weight");
  assert.equal(convertUnetName("down_blocks.0.downsamplers.0.conv.weight", true), "input_blocks.3.0.op.weight");
  assert.equal(convertUnetName("up_blocks.0.upsamplers.0.conv.weight", true), "output_blocks.2.2.conv.weight");
  assert.equal(convertUnetName("up_blocks.1.upsamplers.0.conv.weight", true), "output_blocks.5.2.conv.weight");
  assert.equal(convertUnetName("up_blocks.2.resnets.2.conv_shortcut.weight", true), "output_blocks.8.0.skip_connection.weight");
  assert.equal(convertUnetName("mid_block.attentions.0.proj_in.weight", true), "middle_block.1.proj_in.weight");
  assert.equal(convertUnetName("mid_block.resnets.1.conv2.weight", true), "middle_block.2.out_layers.3.weight");
  // SD 1.x has four blocks, attention in the first three down blocks and the last three up blocks
  assert.equal(convertUnetName("down_blocks.0.attentions.1.proj_out.weight", false), "input_blocks.2.1.proj_out.weight");
  assert.equal(convertUnetName("up_blocks.0.upsamplers.0.conv.weight", false), "output_blocks.2.1.conv.weight");
  assert.equal(convertUnetName("up_blocks.3.attentions.2.norm.weight", false), "output_blocks.11.1.norm.weight");
  assert.equal(convertUnetName("down_blocks.3.resnets.0.norm2.weight", false), "input_blocks.10.0.out_layers.0.weight");
});

test("vae names follow the reference mapping, including the newer attention names", () => {
  assert.equal(convertVaeName("encoder.mid_block.attentions.0.to_q.weight"), "encoder.mid.attn_1.q.weight");
  assert.equal(convertVaeName("decoder.mid_block.attentions.0.group_norm.bias"), "decoder.mid.attn_1.norm.bias");
  assert.equal(convertVaeName("decoder.mid_block.attentions.0.to_out.0.weight"), "decoder.mid.attn_1.proj_out.weight");
  assert.equal(convertVaeName("decoder.up_blocks.0.resnets.1.conv1.weight"), "decoder.up.3.block.1.conv1.weight");
  assert.equal(convertVaeName("encoder.down_blocks.2.downsamplers.0.conv.weight"), "encoder.down.2.downsample.conv.weight");
  assert.equal(convertVaeName("decoder.up_blocks.1.upsamplers.0.conv.weight"), "decoder.up.2.upsample.conv.weight");
  assert.equal(convertVaeName("encoder.conv_norm_out.weight"), "encoder.norm_out.weight");
  assert.equal(convertVaeName("decoder.mid_block.resnets.0.conv_shortcut.weight"), "decoder.mid.block_1.nin_shortcut.weight");
});

test("each part gets the prefix a single-file checkpoint uses", () => {
  assert.equal(convertName("unet", "conv_in.weight", true), "model.diffusion_model.input_blocks.0.0.weight");
  assert.equal(convertName("vae", "encoder.conv_in.weight", true), "first_stage_model.encoder.conv_in.weight");
  assert.equal(convertName("text_encoder", "text_model.final_layer_norm.weight", false), "cond_stage_model.transformer.text_model.final_layer_norm.weight");
  assert.equal(convertName("text_encoder", "text_model.final_layer_norm.weight", true), "conditioner.embedders.0.transformer.text_model.final_layer_norm.weight");
  assert.equal(convertName("text_encoder_2", "text_projection.weight", true), "conditioner.embedders.1.transformer.text_projection.weight");
});

test("a folder merges into one checkpoint with the bytes intact and the parts renamed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-convert-"));
  for (const [rel, names] of Object.entries(TINY_PARTS)) {
    const dest = path.join(dir, rel.replace(".fp16", ""));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, tinySafetensors(names));
  }
  const out = path.join(dir, "merged.safetensors");
  const lines = [];
  const result = await convertDiffusersFolder(dir, out, (l) => lines.push(l));
  assert.equal(result.xl, true);
  assert.deepEqual(result.parts, ["unet", "vae", "text_encoder", "text_encoder_2"]);
  const { header, dataStart } = readHeader(out);
  const names = Object.keys(header).filter((n) => n !== "__metadata__");
  assert.equal(names.length, 9, "position ids are dropped, everything else kept");
  assert.ok(names.includes("model.diffusion_model.input_blocks.4.1.transformer_blocks.1.attn1.to_k.weight"));
  assert.ok(names.includes("first_stage_model.encoder.mid.attn_1.q.weight"));
  assert.ok(names.includes("conditioner.embedders.1.transformer.text_projection.weight"));
  assert.ok(!names.some((n) => n.includes("position_ids")));
  // the unet's second tensor was filled with 2s; find it through the new header
  const t = header["model.diffusion_model.input_blocks.4.1.transformer_blocks.1.attn1.to_k.weight"];
  const fd = fs.openSync(out, "r");
  const buf = Buffer.alloc(t.data_offsets[1] - t.data_offsets[0]);
  fs.readSync(fd, buf, 0, buf.length, dataStart + t.data_offsets[0]);
  fs.closeSync(fd);
  assert.ok(buf.every((b) => b === 2));
  assert.deepEqual(t.shape, [2, 4]);
  assert.equal(t.dtype, "F16");
  assert.match(lines[0], /SDXL checkpoint/);
  assert.ok(!fs.existsSync(`${out}.part`));
});

test("a folder without the unet is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "huggingfound-convert-"));
  fs.mkdirSync(path.join(dir, "vae"));
  fs.writeFileSync(path.join(dir, "vae", "diffusion_pytorch_model.safetensors"), tinySafetensors(["encoder.conv_in.weight"]));
  await assert.rejects(convertDiffusersFolder(dir, path.join(dir, "x.safetensors")), /missing the unet/);
});
