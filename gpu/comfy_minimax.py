"""A MiniMax-H3 transformer published for ComfyUI, loaded into the diffusers
transformer the MiniMax-H3 pipeline runs.

Fine-tunes of MiniMax-H3 (DaSiWa's among them) come as one .safetensors file
in ComfyUI's layout rather than the diffusers folder the pipeline loads:

- the original names: `blocks.N.attn.qkv_proj` (query, key and value in one
  matrix), `blocks.N.mlp.fc1` (the gated feed-forward's two halves as
  [gate | up], where diffusers keeps [up | gate]), `video_patch_proj`,
  `final_layer.video_out` and so on;
- often stored at 8 bits: each row's integers times its scale, with the
  input channels turned by a ConvRot rotation (a normalised Hadamard matrix
  over groups of 256) that has to be turned back;
- often in the "curve" form of ComfyUI's pruned MiniMax-H3, where the time
  embedder and the 2688-wide AdaLN projections are replaced by a table of
  a few coordinates per timestep (`adaln_t_table`, 1025 rows) and AdaLN
  projections that read those coordinates with no activation in between.

`load_transformer` builds the diffusers transformer from the base model's
own config, takes the file's weights in, and for the curve form swaps the
time embedding for the table and the AdaLN projections for the narrow ones.
Every rename and the rotation were checked against the published weights
(Comfy-Org/MiniMax-H3's files against MiniMaxAI/MiniMax-H3's).
"""

import json
import math

import torch
from torch import nn

QKV = "attn.qkv_proj"
# Kept at float32, as the base model keeps them.
FP32 = ("proj_in.", "audio_proj_in.", "proj_out.", "audio_proj_out.", "time_embedder.")


def is_comfy_minimax(path):
    """Whether a .safetensors file is a MiniMax-H3 transformer in ComfyUI's layout."""
    from safetensors import safe_open

    try:
        with safe_open(path, framework="pt") as f:
            keys = set(f.keys())
    except Exception:  # noqa: BLE001
        return False
    return f"blocks.0.{QKV}.weight" in keys and ("video_patch_proj.weight" in keys or "final_layer.video_out.weight" in keys)


def hadamard(size, device="cpu"):
    """The normalised regular Hadamard matrix ConvRot uses (size a power of 4)."""
    if size < 4 or size & (size - 1) or round(math.log(size, 4)) != math.log(size, 4):
        raise ValueError(f"a ConvRot group of {size} is not a power of 4")
    h4 = torch.tensor([[1, 1, 1, -1], [1, 1, -1, 1], [1, -1, 1, 1], [-1, 1, 1, 1]], dtype=torch.float32, device=device)
    h = h4
    while h.shape[0] < size:
        h = torch.kron(h, h4)
    return h / math.sqrt(size)


def layer_quant(f, layer, meta_layers):
    """How a layer is stored: its own `comfy_quant` note (JSON in bytes), else the file's metadata."""
    key = f"{layer}.comfy_quant"
    if key in f.keys():
        with_note = f.get_tensor(key)
        try:
            return json.loads(bytes(with_note.to(torch.uint8).tolist()).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            pass
    return meta_layers.get(layer) or {}


def weight_of(f, layer, meta_layers):
    """A linear layer's weight as float32, turned back from 8 bits and ConvRot where stored so."""
    w = f.get_tensor(f"{layer}.weight")
    if w.dtype == torch.int8:
        conf = layer_quant(f, layer, meta_layers)
        fmt = conf.get("format", "int8_tensorwise")
        if fmt != "int8_tensorwise":
            raise ValueError(f"the file stores {layer} as {fmt}, which HuggingFound cannot read yet; use the file's int8, fp8 or bf16 version")
        scale = f.get_tensor(f"{layer}.weight_scale").float()
        if scale.ndim > 2:
            raise ValueError(f"the file stores {layer} with grouped scales, which HuggingFound cannot read yet; use the file's int8 (row-wise), fp8 or bf16 version")
        x = w.float() * scale
        if conf.get("convrot"):
            group = int(conf.get("convrot_groupsize", 256))
            out_f, in_f = x.shape
            x = (x.reshape(out_f, in_f // group, group) @ hadamard(group).T).reshape(out_f, in_f)
        return x
    if w.dtype in (getattr(torch, "float8_e4m3fn", None), getattr(torch, "float8_e5m2", None)):
        x = w.float()
        if f"{layer}.weight_scale" in f.keys():
            x = x * f.get_tensor(f"{layer}.weight_scale").float()
        return x
    if w.dtype == torch.uint8:
        raise ValueError(f"the file packs {layer} at 4 bits, which HuggingFound cannot read yet; use the file's int8, fp8 or bf16 version")
    return w.float()


def convert(path):
    """The file's weights in the diffusers transformer's names, as float32,
    with the curve table (or None for a file that keeps its time embedder)."""
    from safetensors import safe_open

    with safe_open(path, framework="pt") as f:
        keys = set(f.keys())
        meta = f.metadata() or {}
        try:
            meta_layers = json.loads(meta.get("_quantization_metadata") or "{}").get("layers", {})
        except ValueError:
            meta_layers = {}
        out = {}
        table = f.get_tensor("adaln_t_table").float() if "adaln_t_table" in keys else None

        def take(src, dst):
            if f"{src}.weight" in keys:
                out[f"{dst}.weight"] = weight_of(f, src, meta_layers)
            if f"{src}.bias" in keys:
                out[f"{dst}.bias"] = f.get_tensor(f"{src}.bias").float()

        def inner(src, dst):
            qkv = weight_of(f, f"{src}.{QKV}", meta_layers)
            q, k, v = qkv.chunk(3, dim=0)
            out[f"{dst}.attn.to_q.weight"], out[f"{dst}.attn.to_k.weight"], out[f"{dst}.attn.to_v.weight"] = q, k, v
            take(f"{src}.attn.out_proj", f"{dst}.attn.to_out.0")
            take(f"{src}.attn.q_norm", f"{dst}.attn.norm_q")
            take(f"{src}.attn.k_norm", f"{dst}.attn.norm_k")
            gate, up = weight_of(f, f"{src}.mlp.fc1", meta_layers).chunk(2, dim=0)
            out[f"{dst}.ff.net.0.proj.weight"] = torch.cat([up, gate], dim=0)
            take(f"{src}.mlp.fc2", f"{dst}.ff.net.2")
            take(f"{src}.norm1", f"{dst}.norm1")
            take(f"{src}.norm2", f"{dst}.norm2")

        blocks = sorted({int(k.split(".")[1]) for k in keys if k.startswith("blocks.") and k.split(".")[1].isdigit()})
        for i in blocks:
            inner(f"blocks.{i}", f"transformer_blocks.{i}")
            take(f"blocks.{i}.adaln_proj.linear", f"transformer_blocks.{i}.adaln_proj.linear")
        refiners = sorted({int(k.split(".")[2]) for k in keys if k.startswith("token_refiner.blocks.")})
        for i in refiners:
            inner(f"token_refiner.blocks.{i}", f"token_refiner.refiner_blocks.{i}")
        take("token_refiner.final_norm", "token_refiner.final_norm")
        take("video_patch_proj", "proj_in")
        take("audio_patch_proj", "audio_proj_in")
        take("condition_proj", "context_embedder")
        take("final_layer.norm", "norm_out.norm")
        take("final_layer.adaln_proj.linear", "norm_out.linear")
        take("final_layer.video_out", "proj_out")
        take("final_layer.audio_out", "audio_proj_out")
        take("time_embedder.proj_in", "time_embedder.linear_1")
        take("time_embedder.proj_out", "time_embedder.linear_2")
    return out, table, len(blocks)


class _Passthrough(nn.Module):
    """Stands in for the sinusoid: the curve table is read at the timestep itself."""

    def forward(self, timestep):
        return timestep.float().reshape(-1, 1)


class _CurveTime(nn.Module):
    """The time embedding as the curve form has it: the table's rows
    interpolated at t in [0, 1], as ComfyUI reads them."""

    def __init__(self, table):
        super().__init__()
        self.table = nn.Parameter(table.float(), requires_grad=False)

    def forward(self, t):
        table = self.table
        pos = t.reshape(-1).float().clamp(0.0, 1.0) * (table.shape[0] - 1)
        i0 = pos.floor().long().clamp(max=table.shape[0] - 2)
        return torch.lerp(table[i0], table[i0 + 1], (pos - i0).unsqueeze(1))


def _curve_modulation(cls):
    class CurveModulation(cls):
        # No activation between the table and the projection; the result
        # comes back at the block's own precision.
        def forward(self, temb):
            temb = self.linear(temb.to(self.linear.weight.dtype)).to(self.out_dtype)
            return temb.view(-1, 6 * self.hidden_size).chunk(6, dim=-1)

    return CurveModulation


def _curve_out(cls):
    class CurveOut(cls):
        def forward(self, hidden_states, temb, timestep_indices):
            shift, scale = self.linear(temb.to(self.linear.weight.dtype)).to(self.out_dtype).chunk(2, dim=-1)
            hidden_states = self.norm(hidden_states)
            return hidden_states * (1.0 + scale.index_select(0, timestep_indices)) + shift.index_select(0, timestep_indices)

    return CurveOut


def load_transformer(path, config_dir, dtype=torch.bfloat16):
    """The diffusers MiniMax-H3 transformer with the file's weights, built
    from the base model's config (`config_dir`, its transformer folder).
    Raises a ValueError that says what does not fit."""
    from diffusers import MiniMaxH3Transformer3DModel
    from diffusers.models.transformers.transformer_minimax_h3 import MiniMaxH3RotaryPosEmbed

    sd, table, blocks = convert(path)
    config = MiniMaxH3Transformer3DModel.load_config(config_dir)
    if blocks != config.get("num_layers"):
        raise ValueError(f"the file has {blocks} blocks where the base MiniMax-H3 has {config.get('num_layers')}; it is not a MiniMax-H3 transformer")
    width = sd.get("proj_out.weight")
    patch = config["in_channels"] * math.prod(config["patch_size"])
    if width is not None and width.shape[0] != patch:
        raise ValueError(f"the file's video head has {width.shape[0]} outputs where MiniMax-H3 has {patch} (a several-head distilled checkpoint); HuggingFound cannot run that kind yet")
    with torch.device("meta"):
        model = MiniMaxH3Transformer3DModel.from_config(config)
    if table is not None:
        rank = table.shape[1]
        model.time_proj = _Passthrough()
        with torch.device("meta"):
            model.time_embedder = _CurveTime(torch.empty_like(table, device="meta"))
            for block in model.transformer_blocks:
                block.adaln_proj.linear = nn.Linear(rank, block.adaln_proj.linear.out_features, bias=True)
                block.adaln_proj.__class__ = _curve_modulation(type(block.adaln_proj))
                block.adaln_proj.out_dtype = dtype
            model.norm_out.linear = nn.Linear(rank, model.norm_out.linear.out_features, bias=True)
            model.norm_out.__class__ = _curve_out(type(model.norm_out))
            model.norm_out.out_dtype = dtype
        sd["time_embedder.table"] = table
    # Each weight at the precision the model keeps it: the heads, the time
    # embedder and (for the curve form) its narrow projections at float32.
    for k in list(sd):
        keep32 = k.startswith(FP32) or k == "time_embedder.table" or (table is not None and (".adaln_proj.linear." in k or k.startswith("norm_out.linear.")))
        sd[k] = sd[k].to(torch.float32 if keep32 else dtype)
    wanted = {k for k, _ in model.named_parameters()}
    missing = sorted(wanted - set(sd))
    if missing:
        raise ValueError(f"the file has no weights for {len(missing)} of the transformer's parts ({', '.join(missing[:4])}{'…' if len(missing) > 4 else ''})")
    extra = sorted(set(sd) - wanted)
    model.load_state_dict({k: v for k, v in sd.items() if k in wanted}, strict=False, assign=True)
    # The rotary frequencies are a buffer computed from the config, not stored.
    model.rope = MiniMaxH3RotaryPosEmbed(rope_freq_dim=config.get("rope_freq_dim", 16), rope_theta=config.get("rope_theta", 10000.0))
    still = [n for n, t in list(model.named_parameters()) + list(model.named_buffers()) if t.device.type == "meta"]
    if still:
        raise ValueError(f"parts of the transformer were left without weights: {', '.join(still[:4])}")
    model.eval()
    gb = sum(p.numel() * p.element_size() for p in model.parameters()) / 1024**3
    return model, {"blocks": blocks, "curve": table is not None, "extra": extra, "gb": gb}
