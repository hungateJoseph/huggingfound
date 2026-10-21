"""Checks the worker's pass skipping (diffusers' first-block cache, after
TeaCache) on a tiny MiniMax-H3 transformer: with it on, a run of steps
whose inputs barely change skips the blocks after the first on most of
them and ends close to the plain run; with a zero threshold nothing is
skipped and the answer is the same. Needs torch and diffusers; run by
test/comfy-minimax.test.js when HF_TEST_PYTHON names a Python that has
them.
"""

import json
import os
import sys

import torch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "gpu"))
import worker  # noqa: E402

sys.stdout = sys.__stdout__
from diffusers import MiniMaxH3Transformer3DModel  # noqa: E402

torch.manual_seed(2)
CONFIG = dict(num_attention_heads=4, attention_head_dim=64, hidden_size=256, num_layers=4, num_refiner_layers=1, ffn_dim=512, in_channels=4, audio_in_channels=8, patch_size=[1, 2, 2], text_dim=64, freq_dim=256, time_embed_hidden_dim=64, time_embed_dim=32, rope_freq_dim=8)


class Pipe:
    def __init__(self, transformer):
        self.transformer = transformer


def inputs(t, noise):
    text, video, audio = 3, 4, 2
    n = text + video + audio
    return dict(hidden_states=noise, audio_hidden_states=torch.zeros(1, audio, 8), encoder_hidden_states=torch.ones(1, text, 64) * 0.1, timestep=torch.tensor([t, t]), timestep_indices=torch.tensor([0, 0, 0, 0, 1, 0, 1, 1, 0]), token_tags=torch.tensor([0, 0, 0, 1, 1, 1, 1, 2, 2]), position_ids=torch.arange(n * 3, dtype=torch.float32).reshape(n, 3) % 5, video_indices=torch.arange(text, text + video), audio_indices=torch.arange(text + video, n), text_indices=torch.arange(0, text))


def run(model, steps, cache):
    """A run of steps whose latent drifts a little each time, as a
    denoising loop's does; counts the steps the cache computed in full."""
    computed = 0
    torch.manual_seed(3)
    with worker.pass_skipping(Pipe(model), cache) as skipping:
        noise = torch.randn(1, 4, 16) * 0.05
        outs = []
        for i in range(steps):
            t = 1.0 - i / steps
            with torch.no_grad():
                out = model(**inputs(t, noise), return_dict=False)[0]
            outs.append(out)
            noise = noise + out * 0.01
            if skipping is None or skipping.computed_last():
                computed += 1
    return torch.stack(outs), computed


def main():
    model = MiniMaxH3Transformer3DModel(**CONFIG).eval()
    with torch.no_grad():
        for name, p in model.named_parameters():
            p.normal_(1.0 if "norm" in name and p.ndim == 1 else 0, 0.06)
    steps = 12
    plain, n_plain = run(model, steps, None)
    exact, n_exact = run(model, steps, 0.0)
    gentle, n_gentle = run(model, steps, 0.1)
    fast, n_fast = run(model, steps, 0.5)
    cos = lambda a, b: round(torch.nn.functional.cosine_similarity(a.flatten(), b.flatten(), dim=0).item(), 5)  # noqa: E731
    results = {"plain": n_plain, "threshold 0": n_exact, "same at 0": bool(torch.allclose(plain, exact, atol=1e-5)), "threshold 0.1 computed": n_gentle, "cos 0.1": cos(plain, gentle), "threshold 0.5 computed": n_fast, "cos 0.5": cos(plain, fast)}
    print(json.dumps(results))
    assert n_plain == steps and n_exact == steps, results
    assert results["same at 0"], "a zero threshold skips nothing and changes nothing"
    assert n_gentle < steps and results["cos 0.1"] > 0.98, ("the page's threshold skips some passes and stays close", results)
    assert n_fast <= n_gentle and n_fast < steps * 0.75, ("a looser threshold skips more", results)
    # Off again afterwards: the hooks are gone and the model answers as before.
    after, n_after = run(model, steps, None)
    results["after"] = {"computed": n_after, "max diff": round((after - plain).abs().max().item(), 6)}
    print(json.dumps(results["after"]))
    assert n_after == steps and torch.allclose(after, plain, atol=1e-5), ("the cache is removed after the run", results["after"])


if __name__ == "__main__":
    main()
