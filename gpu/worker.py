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


state = {"pipe": None, "dir": None, "key": None, "kind": None, "offloaded": False, "adapters": [], "faces": None}


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
    state["key"] = None
    state["kind"] = None
    state["adapters"] = []
    gc.collect()
    with contextlib.suppress(Exception):
        import torch

        torch.cuda.empty_cache()


def load(req):
    import torch
    from diffusers import DiffusionPipeline

    model_dir = str(req.get("dir") or "")
    single = str(req.get("file") or "")
    adapters = req.get("adapters") or []
    key = json.dumps([model_dir or single, adapters], sort_keys=True)
    if state.get("key") == key and state["pipe"] is not None:
        return {"ok": True, "kind": state["kind"], "already": True}
    unload()
    dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
    if single:
        # A single checkpoint of the Stable Diffusion families, as an add-on's base.
        from diffusers import StableDiffusionPipeline, StableDiffusionXLPipeline

        xl = bool(req.get("xl")) or "xl" in os.path.basename(single).lower() or os.path.getsize(single) > 5 * 1024**3
        cls_single = StableDiffusionXLPipeline if xl else StableDiffusionPipeline
        pipe = cls_single.from_single_file(single, torch_dtype=dtype)
        kind = "image"
        weights = os.path.getsize(single) / 1024**3
    else:
        if not os.path.isfile(os.path.join(model_dir, "model_index.json")):
            raise ValueError("that folder has no model_index.json; it is not a diffusers model")
        with open(os.path.join(model_dir, "model_index.json"), encoding="utf-8") as f:
            index = json.load(f)
        cls = str(index.get("_class_name", ""))
        # Wan, LTX, Mochi and CogVideoX name their pipelines after themselves.
        kind = "video" if any(w in cls for w in ("Video", "Wan", "LTX", "Mochi", "CogVideoX", "Allegro", "Latte", "SkyReels", "Hunyuan")) else "image"
        pipe = DiffusionPipeline.from_pretrained(model_dir, torch_dtype=dtype, local_files_only=True)
        weights = folder_gb(model_dir)
    with contextlib.suppress(Exception):
        pipe.set_progress_bar_config(disable=True)
    for adapter in adapters:
        apply_adapter(pipe, adapter, dtype)
    # A model that fits the card goes onto it whole; a bigger one streams
    # its parts through the card as they are needed, slower but it runs.
    vram = torch.cuda.get_device_properties(0).total_memory / 1024**3 if torch.cuda.is_available() else 0
    offloaded = False
    if torch.cuda.is_available():
        if weights * 1.15 < vram:
            pipe.to("cuda")
        else:
            pipe.enable_model_cpu_offload()
            offloaded = True
    with contextlib.suppress(Exception):
        pipe.vae.enable_tiling()
    state.update(pipe=pipe, dir=model_dir or single, key=key, kind=kind, offloaded=offloaded, adapters=adapters)
    return {"ok": True, "kind": kind, "offloaded": offloaded, "weightsGb": round(weights, 1), "vramGb": round(vram, 1)}


# ---- add-ons -----------------------------------------------------------------------
# An IP-Adapter steers the picture with a reference image: the plain ones
# through a CLIP image encoder, the FaceID ones through a face embedding
# from insightface (with a CLIP encoder as well for the "plus" variants).
# A LoRA just changes the weights by a scale.


def apply_adapter(pipe, adapter, dtype):
    kind = adapter.get("kind") or "ip-adapter"
    path = str(adapter.get("path") or "")
    if not os.path.isfile(path):
        raise ValueError(f"add-on file missing: {path}")
    folder, name = os.path.split(path)
    scale = float(adapter.get("scale") or (0.8 if kind == "lora" else 0.6))
    if kind == "lora":
        pipe.load_lora_weights(folder, weight_name=name, adapter_name="addon")
        pipe.set_adapters(["addon"], adapter_weights=[scale])
        return
    faceid = bool(adapter.get("faceid"))
    plus = bool(adapter.get("plus"))
    if faceid:
        pipe.load_ip_adapter(folder, subfolder="", weight_name=name, image_encoder_folder=None)
        if plus:
            from transformers import CLIPVisionModelWithProjection

            pipe.image_encoder = CLIPVisionModelWithProjection.from_pretrained("laion/CLIP-ViT-H-14-laion2B-s32B-b79K", torch_dtype=dtype)
    else:
        # The plain adapters ship with their image encoder next to them
        # (models/image_encoder or sdxl_models/image_encoder).
        pipe.load_ip_adapter(os.path.dirname(folder), subfolder=os.path.basename(folder), weight_name=name)
    pipe.set_ip_adapter_scale(scale)
    lora = adapter.get("lora")
    if lora and os.path.isfile(str(lora)):
        lfolder, lname = os.path.split(str(lora))
        pipe.load_lora_weights(lfolder, weight_name=lname, adapter_name="faceid")
        pipe.set_adapters(["faceid"], adapter_weights=[0.7])


def face_embeds(pipe, image, adapter, dtype):
    """The insightface embedding of the first face in the picture, in the
    form the FaceID adapters take, plus the aligned crop the plus variants
    also want."""
    import numpy as np
    import torch

    try:
        from insightface.app import FaceAnalysis
        from insightface.utils import face_align
    except ImportError as err:
        raise ValueError("FaceID add-ons need the insightface library, which this machine image lacks; the plain IP-Adapter (h94/IP-Adapter) works without it") from err
    app = state.get("faces")
    if app is None:
        app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
        app.prepare(ctx_id=0, det_size=(640, 640))
        state["faces"] = app
    bgr = np.array(image)[:, :, ::-1]
    faces = app.get(bgr)
    if not faces:
        raise ValueError("no face was found in the reference picture")
    face = faces[0]
    ref = torch.from_numpy(face.normed_embedding).unsqueeze(0).unsqueeze(0)
    ids = torch.cat([torch.zeros_like(ref), ref]).to(dtype=dtype, device=pipe.device)
    if adapter.get("plus"):
        from PIL import Image

        crop = face_align.norm_crop(bgr, landmark=face.kps, image_size=224)
        crop_img = Image.fromarray(crop[:, :, ::-1])
        clip = pipe.prepare_ip_adapter_image_embeds([crop_img], None, torch.device(pipe.device), 1, True)[0]
        layer = pipe.unet.encoder_hid_proj.image_projection_layers[0]
        layer.clip_embeds = clip.to(dtype=dtype)
        layer.shortcut = "plusv2" in os.path.basename(str(adapter.get("path", ""))).lower()
    return [ids]


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

    # A reference picture for an IP-Adapter.
    ip_image = req.get("ipImage")
    adapters = state.get("adapters") or []
    ip_adapter = next((a for a in adapters if (a.get("kind") or "ip-adapter") == "ip-adapter"), None)
    if ip_adapter:
        if not ip_image:
            raise ValueError("this add-on needs a reference picture")
        reference = Image.open(io.BytesIO(base64.b64decode(ip_image))).convert("RGB")
        dtype = pipe.unet.dtype if hasattr(pipe, "unet") else torch.float16
        if ip_adapter.get("faceid"):
            kwargs["ip_adapter_image_embeds"] = face_embeds(pipe, reference, ip_adapter, dtype)
        else:
            kwargs["ip_adapter_image"] = reference

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
                say(load(req))
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
