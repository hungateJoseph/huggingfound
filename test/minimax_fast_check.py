"""Checks the worker's two further speed settings on a tiny MiniMax-H3
transformer: the blocks compiled with torch.compile give the same answer
as plain, pass skipping still works on top of them and leaves them
compiled when it is removed, setting them back restores the plain
forwards; and fp8 weights, which need a card with fp8 units, say so
plainly on a machine without one. Needs torch and diffusers; run by
test/comfy-minimax.test.js when HF_TEST_PYTHON names a Python that has
them.
"""

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


def run(model, steps, cache=None):
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
    pipe = Pipe(model)
    plain, _ = run(model, 6)

    # fp8 weights go only with the whole model on the card: a model whose
    # parts move between the machine's memory and the card fails at the
    # first move, so those modes are refused with the reason.
    assert worker.fp8_allowed("gpu") == (True, "")
    assert worker.fp8_allowed("two-cards")[0] is True
    for mode in ("turns", "offload", "staged", "cpu"):
        ok, why = worker.fp8_allowed(mode)
        assert ok is False and "cannot move between" in why, (mode, why)
    assert "take turns on the card" in worker.fp8_allowed("turns")[1]

    # Compiled: the same numbers, and each block's own forward is the compiled one.
    assert worker.want_compiled(pipe, True) is True
    assert worker.state["compiled"] is True
    assert all("forward" in b.__dict__ for b in model.transformer_blocks), "each block's forward is compiled"
    compiled, _ = run(model, 6)
    assert torch.allclose(plain, compiled, atol=1e-4, rtol=1e-4), f"compiled differs by {(plain - compiled).abs().max():.2e}"
    # Asked again: nothing to do, still compiled.
    assert worker.want_compiled(pipe, True) is True

    # Pass skipping on top of the compiled blocks skips as before, and
    # leaves the compiled forwards in place when it is removed.
    before = [b.__dict__["forward"] for b in model.transformer_blocks]
    skipped, computed = run(model, 12, 0.1)
    assert 2 <= computed <= 9, f"{computed} of 12 computed with the threshold at 0.1"
    assert [b.__dict__.get("forward") for b in model.transformer_blocks] == before, "the compiled forwards are back after skipping"
    assert worker.state["compiled"] is True

    # Set back: plain forwards, the same answer as before any of it.
    assert worker.want_compiled(pipe, False) is False
    assert not any("forward" in b.__dict__ for b in model.transformer_blocks), "the blocks' own forwards are gone"
    again, _ = run(model, 6)
    assert torch.equal(plain, again), "plain again"

    # fp8 weights want a card with fp8 units; here there is none, and the reason is plain.
    ok, why = worker.fp8_ready()
    assert ok is False and why, (ok, why)
    try:
        worker.fp8_weights(pipe)
    except ValueError as err:
        assert str(err) == why, str(err)
    else:
        raise AssertionError("fp8_weights did not refuse without a card")
    print(f"ok: compiled blocks match to 1e-4, {computed} of 12 passes computed with skipping on top, plain again after; fp8 refused: {why}")


if __name__ == "__main__":
    main()
