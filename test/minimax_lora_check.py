"""Checks the worker's LoRAs for MiniMax-H3 on a tiny transformer: LoRAs in
the three spellings found on Hugging Face and Civitai (ComfyUI's, ComfyUI's
with an alpha per module, Kohya's) are applied through the worker, two at
once, and the result compared with the same changes merged into the
weights by hand in the library's layout (query, key and value apart, the
feed-forward's halves as [up | gate]). Needs torch, diffusers, peft and
safetensors; run by test/comfy-minimax.test.js when HF_TEST_PYTHON names a
Python that has them.
"""

import json
import os
import sys
import tempfile

import torch
from safetensors.torch import save_file

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gpu"))
import worker  # noqa: E402

sys.stdout = sys.__stdout__
from diffusers import MiniMaxH3Transformer3DModel  # noqa: E402

torch.manual_seed(1)
CONFIG = dict(num_attention_heads=4, attention_head_dim=64, hidden_size=256, num_layers=2, num_refiner_layers=1, ffn_dim=512, in_channels=4, audio_in_channels=8, patch_size=[1, 2, 2], text_dim=64, freq_dim=256, time_embed_hidden_dim=64, time_embed_dim=32, rope_freq_dim=8)
RANK = 4


class Pipe:
    def __init__(self, transformer):
        self.transformer = transformer


def model():
    m = MiniMaxH3Transformer3DModel(**CONFIG).eval()
    with torch.no_grad():
        for name, p in m.named_parameters():
            if "norm" in name and name.endswith("weight") and p.ndim == 1:
                p.normal_(1.0, 0.1)
            elif "adaln_proj" in name or "norm_out.linear" in name:
                p.normal_(0, 0.3)
            else:
                p.normal_(0, 0.06)
    return m


def lora_parts():
    """Random LoRA factors for each kind of module, in ComfyUI's layout (out rows as ComfyUI orders them)."""
    hidden, inner, ffn = 256, 256, 512
    shapes = {"attn.qkv_proj": (3 * inner, hidden), "attn.out_proj": (hidden, inner), "mlp.fc1": (2 * ffn, hidden), "mlp.fc2": (hidden, ffn)}
    parts = {}
    for where in ("blocks.0", "blocks.1", "token_refiner.blocks.0"):
        for mod, (o, i) in shapes.items():
            parts[f"{where}.{mod}"] = (torch.randn(RANK, i) * 0.3, torch.randn(o, RANK) * 0.3)
    return parts


def write(parts, style, path, alpha=None):
    sd = {}
    for name, (a, b) in parts.items():
        if style == "kohya":
            refiner = name.startswith("token_refiner.")
            n = name.split(".")[2 if refiner else 1]
            mod = name.split(".", 3 if refiner else 2)[-1].replace(".", "_")
            key = f"lora_unet_{'token_refiner_' if refiner else ''}blocks_{n}_{mod}"
            sd[f"{key}.lora_down.weight"], sd[f"{key}.lora_up.weight"] = a, b
            if alpha is not None:
                sd[f"{key}.alpha"] = torch.tensor(float(alpha))
        else:
            sd[f"diffusion_model.{name}.lora_A.weight"], sd[f"diffusion_model.{name}.lora_B.weight"] = a, b
            if alpha is not None:
                sd[f"diffusion_model.{name}.alpha"] = torch.tensor(float(alpha))
    save_file({k: v.contiguous() for k, v in sd.items()}, path)


def merge(m, parts, scale):
    """The LoRA merged by hand into the library's layout."""
    with torch.no_grad():
        for name, (a, b) in parts.items():
            delta = scale * (b @ a)
            dst = name.replace("token_refiner.blocks.", "token_refiner.refiner_blocks.") if name.startswith("token_refiner.") else name.replace("blocks.", "transformer_blocks.", 1)
            mods = dict(m.named_modules())
            if dst.endswith("attn.qkv_proj"):
                base = dst[: -len("qkv_proj")]
                for part, piece in zip(("to_q", "to_k", "to_v"), delta.chunk(3)):
                    mods[base + part].weight += piece
            elif dst.endswith("mlp.fc1"):
                gate, up = delta.chunk(2)
                mods[dst.replace("mlp.fc1", "ff.net.0.proj")].weight += torch.cat([up, gate])
            else:
                mods[dst.replace("attn.out_proj", "attn.to_out.0").replace("mlp.fc2", "ff.net.2")].weight += delta


def inputs():
    text, video, audio = 3, 4, 2
    n = text + video + audio
    return dict(hidden_states=torch.randn(1, video, 16), audio_hidden_states=torch.randn(1, audio, 8), encoder_hidden_states=torch.randn(1, text, 64), timestep=torch.tensor([0.25, 0.75]), timestep_indices=torch.tensor([0, 0, 0, 0, 1, 0, 1, 1, 0]), token_tags=torch.tensor([0, 0, 0, 1, 1, 1, 1, 2, 2]), position_ids=torch.arange(n * 3, dtype=torch.float32).reshape(n, 3) % 5, video_indices=torch.arange(text, text + video), audio_indices=torch.arange(text + video, n), text_indices=torch.arange(0, text))


def cos(a, b):
    return torch.nn.functional.cosine_similarity(a.flatten(), b.flatten(), dim=0).item()


def main():
    base = model()
    x = inputs()
    results = {}
    with tempfile.TemporaryDirectory() as tmp:
        for style, alpha in (("comfy", None), ("comfy", 2), ("kohya", 8)):
            parts = lora_parts()
            path = os.path.join(tmp, f"{style}{alpha}.safetensors")
            write(parts, style, path, alpha)
            strength = 0.7
            applied = model()
            applied.load_state_dict(base.state_dict())
            worker.unload()
            worker.apply_transformer_lora(Pipe(applied), path, strength)
            merged = model()
            merged.load_state_dict(base.state_dict())
            merge(merged, parts, strength * ((alpha / RANK) if alpha else 1.0))
            with torch.no_grad():
                got, want, plain = applied(**x, return_dict=False)[0], merged(**x, return_dict=False)[0], base(**x, return_dict=False)[0]
            results[f"{style}{'' if alpha is None else f' alpha {alpha}'}"] = {"matches": round(cos(got, want), 6), "vs without": round(cos(got, plain), 4)}
        # Two LoRAs at once, each at its own strength.
        one, two = lora_parts(), lora_parts()
        p1, p2 = os.path.join(tmp, "one.safetensors"), os.path.join(tmp, "two.safetensors")
        write(one, "comfy", p1)
        write(two, "kohya", p2)
        applied = model()
        applied.load_state_dict(base.state_dict())
        worker.unload()
        worker.apply_transformer_lora(Pipe(applied), p1, 0.5)
        worker.apply_transformer_lora(Pipe(applied), p2, 0.9)
        merged = model()
        merged.load_state_dict(base.state_dict())
        merge(merged, one, 0.5)
        merge(merged, two, 0.9)
        with torch.no_grad():
            results["two at once"] = {"matches": round(cos(applied(**x, return_dict=False)[0], merged(**x, return_dict=False)[0]), 6)}
    print(json.dumps(results))
    for name, r in results.items():
        assert r["matches"] > 0.9999, (name, r)
        if "vs without" in r:
            assert r["vs without"] < 0.999, ("the LoRA changed nothing", name, r)


if __name__ == "__main__":
    main()
