#!/usr/bin/env python3
"""The Python side of the rented machine: runs image and video models that
only the diffusers library loads (FLUX, Qwen-Image, Wan, Hunyuan and the
rest of the folder-layout families). The agent starts one of these, keeps
it alive, and talks to it over stdin and stdout, one JSON object per line:

  {"op": "check"}                              -> torch and the GPU
  {"op": "load", "dir": "/path/to/model"}      -> loads a pipeline
  {"op": "generate", "prompt": ..., ...}       -> a picture or a clip
  {"op": "unload"}                             -> frees the GPU

Every answer is one line: {"ok": true, ...} or {"ok": false, "error": ...}.
Progress during a generation is reported as {"progress": 0.4} lines. Only
this protocol goes to stdout; libraries' own chatter goes to stderr.
"""

import base64
import contextlib
import gc
import inspect
import io
import json
import os
import sys
import tempfile

# Nothing but protocol lines on stdout: the libraries print to stderr.
_out = sys.stdout
sys.stdout = sys.stderr


def say(obj):
    _out.write(json.dumps(obj) + "\n")
    _out.flush()


state = {"pipe": None, "dir": None, "kind": None, "offloaded": False}


def check():
    try:
        import torch
        import diffusers

        cuda = torch.cuda.is_available()
        info = {"ok": True, "torch": torch.__version__, "diffusers": diffusers.__version__, "cuda": cuda}
        if cuda:
            props = torch.cuda.get_device_properties(0)
            info["gpu"] = props.name
            info["vramGb"] = round(props.total_memory / 1024**3, 1)
        return info
    except Exception as err:  # noqa: BLE001
        return {"ok": False, "error": f"{type(err).__name__}: {err}"}


def folder_gb(path):
    total = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            with contextlib.suppress(OSError):
                total += os.path.getsize(os.path.join(root, f))
    return total / 1024**3


def unload():
    state["pipe"] = None
    state["dir"] = None
    state["kind"] = None
    gc.collect()
    with contextlib.suppress(Exception):
        import torch

        torch.cuda.empty_cache()


def load(model_dir):
    import torch
    from diffusers import DiffusionPipeline

    if not os.path.isfile(os.path.join(model_dir, "model_index.json")):
        raise ValueError("that folder has no model_index.json; it is not a diffusers model")
    if state["dir"] == model_dir and state["pipe"] is not None:
        return {"ok": True, "kind": state["kind"], "already": True}
    unload()
    with open(os.path.join(model_dir, "model_index.json"), encoding="utf-8") as f:
        index = json.load(f)
    cls = str(index.get("_class_name", ""))
    # Wan, LTX, Mochi and CogVideoX name their pipelines after themselves.
    kind = "video" if any(w in cls for w in ("Video", "Wan", "LTX", "Mochi", "CogVideoX", "Allegro", "Latte", "SkyReels", "Hunyuan")) else "image"
    dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
    pipe = DiffusionPipeline.from_pretrained(model_dir, torch_dtype=dtype, local_files_only=True)
    with contextlib.suppress(Exception):
        pipe.set_progress_bar_config(disable=True)
    # A model that fits the card goes onto it whole; a bigger one streams
    # its parts through the card as they are needed, slower but it runs.
    vram = torch.cuda.get_device_properties(0).total_memory / 1024**3 if torch.cuda.is_available() else 0
    weights = folder_gb(model_dir)
    offloaded = False
    if torch.cuda.is_available():
        if weights * 1.15 < vram:
            pipe.to("cuda")
        else:
            pipe.enable_model_cpu_offload()
            offloaded = True
    with contextlib.suppress(Exception):
        pipe.vae.enable_tiling()
    state.update(pipe=pipe, dir=model_dir, kind=kind, offloaded=offloaded)
    return {"ok": True, "kind": kind, "offloaded": offloaded, "weightsGb": round(weights, 1), "vramGb": round(vram, 1)}


def accepted(pipe):
    try:
        return set(inspect.signature(pipe.__call__).parameters)
    except (TypeError, ValueError):
        return set()


def generate(req):
    import torch
    from PIL import Image

    pipe = state["pipe"]
    if pipe is None:
        raise ValueError("no model is loaded")
    kind = state["kind"]
    params = accepted(pipe)
    steps = int(req.get("steps") or 28)
    kwargs = {"prompt": req.get("prompt", ""), "num_inference_steps": steps}
    if "negative_prompt" in params and req.get("negative"):
        kwargs["negative_prompt"] = req["negative"]
    if "guidance_scale" in params and req.get("cfg") is not None:
        kwargs["guidance_scale"] = float(req["cfg"])
    if "width" in params and req.get("width"):
        kwargs["width"] = int(req["width"])
    if "height" in params and req.get("height"):
        kwargs["height"] = int(req["height"])
    if kind == "video" and "num_frames" in params and req.get("frames"):
        kwargs["num_frames"] = int(req["frames"])
    seed = req.get("seed")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    kwargs["generator"] = torch.Generator(device=device).manual_seed(int(seed)) if seed is not None else None

    init = req.get("init")
    if init:
        image = Image.open(io.BytesIO(base64.b64decode(init))).convert("RGB")
        if "image" in params:
            kwargs["image"] = image
            if "strength" in params:
                kwargs["strength"] = float(req.get("strength") or 0.55)
        else:
            # The loaded pipeline draws from words only; its image-to-image
            # twin shares the weights, so nothing is loaded twice.
            from diffusers import AutoPipelineForImage2Image

            try:
                twin = AutoPipelineForImage2Image.from_pipe(pipe)
            except Exception as err:  # noqa: BLE001
                raise ValueError(f"this model cannot paint over a picture ({err})") from err
            pipe = twin
            params = accepted(pipe)
            kwargs["image"] = image
            kwargs["strength"] = float(req.get("strength") or 0.55)
            for k in ("width", "height"):
                kwargs.pop(k, None)

    if "callback_on_step_end" in params:

        def on_step(_pipe, step, _t, cb_kwargs):
            say({"progress": round((step + 1) / max(steps, 1), 3)})
            return cb_kwargs

        kwargs["callback_on_step_end"] = on_step

    with torch.inference_mode():
        result = pipe(**kwargs)

    if getattr(result, "frames", None) is not None:
        from diffusers.utils import export_to_video

        frames = result.frames[0]
        fps = int(req.get("fps") or 16)
        with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
            path = tmp.name
        try:
            export_to_video(frames, path, fps=fps)
            with open(path, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
        finally:
            with contextlib.suppress(OSError):
                os.remove(path)
        return {"ok": True, "video": data, "frames": len(frames), "fps": fps}
    image = result.images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"ok": True, "image": base64.b64encode(buf.getvalue()).decode("ascii"), "width": image.width, "height": image.height}


def main():
    if "--check" in sys.argv:
        say(check())
        return
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            op = req.get("op")
            if op == "check":
                say(check())
            elif op == "load":
                say(load(str(req.get("dir", ""))))
            elif op == "generate":
                say(generate(req))
            elif op == "unload":
                unload()
                say({"ok": True})
            else:
                say({"ok": False, "error": f"unknown op {op!r}"})
        except Exception as err:  # noqa: BLE001
            msg = f"{type(err).__name__}: {err}"
            if "out of memory" in msg.lower():
                msg = "the GPU ran out of memory for this model at this size; try a smaller picture, fewer frames, or a bigger card"
                unload()
            say({"ok": False, "error": msg})


if __name__ == "__main__":
    main()
