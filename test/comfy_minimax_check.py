"""Checks gpu/comfy_minimax.py end to end on a tiny MiniMax-H3: a diffusers
transformer with random weights is written out in ComfyUI's layout the way
DaSiWa's file is (the original names, query, key and value in one matrix,
the feed-forward halves as [gate | up], the block linears at 8 bits with
ConvRot, and the curve form's time table), read back by load_transformer,
and both are run on the same inputs at the table's timesteps. Needs torch,
diffusers and safetensors; run by test/comfy-minimax.test.js when
HF_TEST_PYTHON names a Python that has them.
"""

import json
import os
import sys
import tempfile

import torch
from safetensors.torch import save_file

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gpu"))
from comfy_minimax import hadamard, is_comfy_minimax, load_transformer  # noqa: E402

from diffusers import MiniMaxH3Transformer3DModel  # noqa: E402

torch.manual_seed(0)
CONFIG = dict(num_attention_heads=4, attention_head_dim=64, hidden_size=256, num_layers=2, num_refiner_layers=1, ffn_dim=512, in_channels=4, audio_in_channels=8, patch_size=[1, 2, 2], text_dim=64, freq_dim=256, time_embed_hidden_dim=64, time_embed_dim=32, rope_freq_dim=8)
GRID = 5  # table rows: t = 0, 0.25, 0.5, 0.75, 1


def int8_convrot(w, group=256):
    """A weight the way the quantiser stores it: rotated, then row-wise int8."""
    out_f, in_f = w.shape
    rot = (w.reshape(out_f, in_f // group, group) @ hadamard(group).T).reshape(out_f, in_f)
    scale = (rot.abs().amax(dim=1, keepdim=True) / 127.0).clamp(min=1e-30)
    q = torch.round(rot / scale).clamp(-127, 127).to(torch.int8)
    note = torch.tensor(list(json.dumps({"format": "int8_tensorwise", "orig_dtype": "torch.bfloat16", "convrot": True, "convrot_groupsize": group}).encode()), dtype=torch.uint8)
    return q, scale.float(), note


def to_comfy(model, swap=True):
    """The model's weights in ComfyUI's curve-form layout (`swap=False`
    leaves the feed-forward halves as diffusers has them: a wrong file, for
    the check that a mistake shows)."""
    sd = {k: v.detach().clone() for k, v in model.state_dict().items()}
    out = {}

    def linear(dst, w, quant=True):
        if quant and w.shape[1] % 256 == 0:
            q, s, note = int8_convrot(w.float())
            out[f"{dst}.weight"], out[f"{dst}.weight_scale"], out[f"{dst}.comfy_quant"] = q, s, note
        else:
            out[f"{dst}.weight"] = w.to(torch.bfloat16)

    def inner(src, dst):
        linear(f"{dst}.attn.qkv_proj", torch.cat([sd[f"{src}.attn.to_q.weight"], sd[f"{src}.attn.to_k.weight"], sd[f"{src}.attn.to_v.weight"]]))
        linear(f"{dst}.attn.out_proj", sd[f"{src}.attn.to_out.0.weight"])
        up, gate = sd[f"{src}.ff.net.0.proj.weight"].chunk(2)
        linear(f"{dst}.mlp.fc1", torch.cat([gate, up]) if swap else torch.cat([up, gate]))
        linear(f"{dst}.mlp.fc2", sd[f"{src}.ff.net.2.weight"])
        out[f"{dst}.attn.q_norm.weight"] = sd[f"{src}.attn.norm_q.weight"]
        out[f"{dst}.attn.k_norm.weight"] = sd[f"{src}.attn.norm_k.weight"]
        out[f"{dst}.norm1.weight"] = sd[f"{src}.norm1.weight"]
        out[f"{dst}.norm2.weight"] = sd[f"{src}.norm2.weight"]

    # The curve: the activated time embedding at each grid point, so the
    # AdaLN projections read it with no activation, as the curve form does.
    with torch.no_grad():
        t = torch.linspace(0, 1, GRID)
        table = torch.nn.functional.silu(model.time_embedder(model.time_proj(t).float()))
    out["adaln_t_table"] = table.float()
    for i in range(CONFIG["num_layers"]):
        inner(f"transformer_blocks.{i}", f"blocks.{i}")
        out[f"blocks.{i}.adaln_proj.linear.weight"] = sd[f"transformer_blocks.{i}.adaln_proj.linear.weight"].to(torch.bfloat16)
        out[f"blocks.{i}.adaln_proj.linear.bias"] = sd[f"transformer_blocks.{i}.adaln_proj.linear.bias"].to(torch.float16)
    for i in range(CONFIG["num_refiner_layers"]):
        inner(f"token_refiner.refiner_blocks.{i}", f"token_refiner.blocks.{i}")
    out["token_refiner.final_norm.weight"] = sd["token_refiner.final_norm.weight"]
    for a, b in (("proj_in", "video_patch_proj"), ("audio_proj_in", "audio_patch_proj"), ("context_embedder", "condition_proj"), ("norm_out.linear", "final_layer.adaln_proj.linear"), ("proj_out", "final_layer.video_out"), ("audio_proj_out", "final_layer.audio_out")):
        out[f"{b}.weight"] = sd[f"{a}.weight"].float()
        out[f"{b}.bias"] = sd[f"{a}.bias"].float()
    out["final_layer.norm.weight"] = sd["norm_out.norm.weight"]
    out["rope.inv_freq"] = model.rope.inv_freq.clone()
    return {k: v.contiguous() for k, v in out.items()}


def inputs():
    text, video, audio = 3, 4, 2
    n = text + video + audio
    return dict(
        hidden_states=torch.randn(1, video, 16),
        audio_hidden_states=torch.randn(1, audio, 8),
        encoder_hidden_states=torch.randn(1, text, 64),
        timestep=torch.tensor([0.25, 0.75]),
        timestep_indices=torch.tensor([0, 0, 0, 0, 1, 0, 1, 1, 0]),
        token_tags=torch.tensor([0, 0, 0, 1, 1, 1, 1, 2, 2]),
        position_ids=torch.arange(n * 3, dtype=torch.float32).reshape(n, 3) % 5,
        video_indices=torch.arange(text, text + video),
        audio_indices=torch.arange(text + video, n),
        text_indices=torch.arange(0, text),
    )


def main():
    model = MiniMaxH3Transformer3DModel(**CONFIG).eval()
    # Weights of a realistic spread: norms near one, the AdaLN projections
    # strong enough that every block's gates matter, so a wrong rename or a
    # wrong half shows in the output.
    with torch.no_grad():
        for name, p in model.named_parameters():
            if "norm" in name and name.endswith("weight") and p.ndim == 1:
                p.normal_(1.0, 0.1)
            elif "adaln_proj" in name or "norm_out.linear" in name:
                p.normal_(0, 0.3)
            elif "time_embedder" in name:
                p.normal_(0, 0.2)
            else:
                p.normal_(0, 0.06)
    with tempfile.TemporaryDirectory() as tmp:
        config_dir = os.path.join(tmp, "transformer")
        model.save_config(config_dir)
        path = os.path.join(tmp, "comfy.safetensors")
        save_file(to_comfy(model), path, metadata={"quantization.tool": "test"})
        assert is_comfy_minimax(path), "the ComfyUI layout is recognised"
        loaded, info = load_transformer(path, config_dir, dtype=torch.float32)
        assert info["curve"] and info["blocks"] == CONFIG["num_layers"], info
        x = inputs()
        with torch.no_grad():
            want = model(**x, return_dict=False)
            got = loaded(**x, return_dict=False)
        results = {}
        for name, a, b in (("video", want[0], got[0]), ("audio", want[1], got[1])):
            cos = torch.nn.functional.cosine_similarity(a.flatten(), b.flatten(), dim=0).item()
            rel = ((a - b).norm() / a.norm()).item()
            results[name] = {"cos": round(cos, 6), "rel": round(rel, 5)}
        # Between grid points the table is interpolated: close, not exact.
        x2 = inputs()
        x2["timestep"] = torch.tensor([0.3, 0.6])
        with torch.no_grad():
            a, b = model(**x2, return_dict=False)[0], loaded(**x2, return_dict=False)[0]
        results["between"] = {"cos": round(torch.nn.functional.cosine_similarity(a.flatten(), b.flatten(), dim=0).item(), 6)}
        # The same file at bfloat16, as the machine loads it.
        half, _ = load_transformer(path, config_dir, dtype=torch.bfloat16)
        with torch.no_grad():
            c = half(**{k: (v.to(torch.bfloat16) if v.is_floating_point() and k.endswith("states") else v) for k, v in x.items()}, return_dict=False)[0]
        # A file with the feed-forward halves the wrong way round gives another answer.
        wrong = os.path.join(tmp, "wrong.safetensors")
        save_file(to_comfy(model, swap=False), wrong)
        bad, _ = load_transformer(wrong, config_dir, dtype=torch.float32)
        with torch.no_grad():
            d = bad(**x, return_dict=False)[0]
        results["wrong"] = {"cos": round(torch.nn.functional.cosine_similarity(want[0].flatten(), d.flatten(), dim=0).item(), 6)}
        results["bf16"] = {"cos": round(torch.nn.functional.cosine_similarity(want[0].flatten(), c.float().flatten(), dim=0).item(), 6), "dtype": str(c.dtype)}
    print(json.dumps(results))
    assert results["video"]["cos"] > 0.999 and results["audio"]["cos"] > 0.999, results
    assert results["video"]["rel"] > 0, "8 bits lose a little: an exact match means the blocks did not count"
    assert results["wrong"]["cos"] < results["video"]["cos"] - 0.01, results
    assert results["between"]["cos"] > 0.98, results
    assert results["bf16"]["cos"] > 0.99, results


if __name__ == "__main__":
    main()
