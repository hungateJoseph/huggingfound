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
import math
import os
import subprocess
import sys
import tempfile

# Nothing but protocol lines on stdout: the libraries print to stderr.
_out = sys.stdout
sys.stdout = sys.stderr


def say(obj):
    _out.write(json.dumps(obj) + "\n")
    _out.flush()


state = {"pipe": None, "dir": None, "key": None, "kind": None, "offloaded": False, "adapters": [], "faces": None, "mode": None}


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
    state["modular"] = False
    state["workflow"] = None
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
        kind = "video" if any(w in cls for w in ("Video", "Wan", "LTX", "Mochi", "CogVideoX", "Allegro", "Latte", "SkyReels", "Hunyuan", "MiniMax")) else "image"
        weights = folder_gb(model_dir)
        pipe, mode = load_folder(model_dir, dtype, weights)
    with contextlib.suppress(Exception):
        pipe.set_progress_bar_config(disable=True)
    for adapter in adapters:
        apply_adapter(pipe, adapter, dtype)
    vram = torch.cuda.get_device_properties(0).total_memory / 1024**3 if torch.cuda.is_available() else 0
    if single:
        mode = place(pipe, weights, vram)
    with contextlib.suppress(Exception):
        pipe.vae.enable_tiling()
    state.update(pipe=pipe, dir=model_dir or single, key=key, kind=kind, offloaded=mode == "offload", adapters=adapters, mode=mode)
    return {"ok": True, "kind": kind, "mode": mode, "note": MODE_NOTES.get(mode, ""), "offloaded": mode == "offload", "weightsGb": round(weights, 1), "vramGb": round(vram, 1), "gpus": torch.cuda.device_count() if torch.cuda.is_available() else 0}


MODE_NOTES = {
    "gpu": "",
    "multi-gpu": "Spread across the machine's cards.",
    "8-bit": "Loaded at 8 bits to fit the card: a little lower quality than full precision.",
    "4-bit": "Loaded at 4 bits to fit the card: noticeably lower quality and slower; a bigger card would do better.",
    "offload": "Bigger than the card: streamed through it from the machine's memory, slowly.",
    "turns": "Bigger than the card: its models take turns on it, each moved in from the machine's memory as its step comes.",
}


def gpu_memory():
    import torch

    if not torch.cuda.is_available():
        return 0, 0, 0
    n = torch.cuda.device_count()
    each = [torch.cuda.get_device_properties(i).total_memory / 1024**3 for i in range(n)]
    return n, each[0], sum(each)


def place(pipe, weights, vram):
    """Where a loaded pipeline goes: the card whole, or streamed through it."""
    import torch

    if not torch.cuda.is_available():
        return "cpu"
    if weights * 1.15 < vram:
        pipe.to("cuda")
        return "gpu"
    pipe.enable_model_cpu_offload()
    return "offload"


def load_folder(model_dir, dtype, weights):
    """Loads a folder model the way its size allows: whole on one card,
    spread over several, at 8 or 4 bits when it would not fit otherwise,
    or streamed from the machine's memory as a last resort. Pipelines a
    repository ships its own code for load with that code, which runs on
    the rented machine only."""
    from diffusers import DiffusionPipeline

    n, first, total = gpu_memory()
    common = {"torch_dtype": dtype, "local_files_only": True, "trust_remote_code": True}
    with open(os.path.join(model_dir, "model_index.json"), encoding="utf-8") as f:
        cls = str(json.load(f).get("_class_name", ""))
    # The newer "modular" pipelines (MiniMax-H3 among them) load through
    # their own class and take their inputs by name.
    if "Modular" in cls:
        return load_modular(model_dir, dtype, weights, n, first, total)
    if n and weights * 1.15 < first:
        pipe = DiffusionPipeline.from_pretrained(model_dir, **common)
        pipe.to("cuda")
        return pipe, "gpu"
    if n > 1 and weights * 1.15 < total:
        # One component per card, as whole as they come.
        pipe = DiffusionPipeline.from_pretrained(model_dir, device_map="balanced", **common)
        return pipe, "multi-gpu"
    quant = None
    if n and weights * 0.6 < total:
        quant = ("bitsandbytes_8bit", {"load_in_8bit": True})
    elif n and weights * 0.35 < total:
        quant = ("bitsandbytes_4bit", {"load_in_4bit": True, "bnb_4bit_quant_type": "nf4", "bnb_4bit_compute_dtype": dtype})
    if quant:
        try:
            from diffusers import PipelineQuantizationConfig

            cfg = PipelineQuantizationConfig(quant_backend=quant[0], quant_kwargs=quant[1], components_to_quantize=["transformer", "transformer_2", "unet", "text_encoder", "text_encoder_2", "text_encoder_3"])
            pipe = DiffusionPipeline.from_pretrained(model_dir, quantization_config=cfg, **common)
            if n > 1:
                pipe.enable_model_cpu_offload()
            else:
                pipe.to("cuda")
            return pipe, "8-bit" if quant[0].endswith("8bit") else "4-bit"
        except Exception as err:  # noqa: BLE001
            say({"progress": 0, "note": f"quantised load failed ({type(err).__name__}: {str(err)[:200]}); streaming instead"})
    pipe = DiffusionPipeline.from_pretrained(model_dir, **common)
    if n:
        pipe.enable_model_cpu_offload()
        return pipe, "offload"
    return pipe, "cpu"


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
    if state.get("modular"):
        names = set()
        for attr in ("input_names", "intermediate_input_names"):
            with contextlib.suppress(Exception):
                names |= set(getattr(pipe, attr) or [])
        with contextlib.suppress(Exception):
            names |= {p.name for p in pipe.blocks.inputs}
        # Without a list of inputs, everything common is offered and the
        # pipeline takes what it knows.
        return names or {"prompt", "negative_prompt", "num_inference_steps", "guidance_scale", "width", "height", "num_frames", "generator", "image", "strength"}
    try:
        return set(inspect.signature(pipe.__call__).parameters)
    except (TypeError, ValueError):
        return set()


# The workflow a modular pipeline is loaded for when it offers several.
# The try box makes clips from words or from a first picture, never from
# reference media, so MiniMax-H3's keyframe workflow is all it needs: its
# second transformer partition (62 GB, reference-to-video) stays unloaded.
PREFERRED_WORKFLOWS = ("fl2va", "i2v", "t2v")


def workflows(pipe):
    with contextlib.suppress(Exception):
        w = pipe.blocks.available_workflows
        return list(w() if callable(w) else w)
    return []


def load_modular(model_dir, dtype, weights, n, first, total):
    """A modular pipeline: the blocks come from the library or from the
    repository's own code, and the components are loaded afterwards, each
    from the model's own folder whatever repository the index names. Whole
    on the card when it fits; otherwise a components manager keeps the
    weights in the machine's memory and moves each model onto the card as
    its step comes, which is how the library runs the big ones itself. A
    component that fails to load is reported with the library's reason
    now, instead of failing later inside a block with a bare error."""
    import logging

    from diffusers import ComponentsManager, ModularPipeline

    notes = []

    class Catch(logging.Handler):
        def emit(self, record):
            if record.levelno >= logging.WARNING:
                notes.append(record.getMessage())

    catcher = Catch()
    for lib in ("diffusers", "transformers"):
        logging.getLogger(lib).addHandler(catcher)
    try:
        manager = ComponentsManager()
        pipe = ModularPipeline.from_pretrained(model_dir, trust_remote_code=True, local_files_only=True, components_manager=manager)
        workflow = next((w for w in PREFERRED_WORKFLOWS if w in workflows(pipe)), None)
        specs = getattr(pipe, "_component_specs", None) or {}
        names = [name for name, spec in specs.items() if getattr(spec, "default_creation_method", "from_pretrained") == "from_pretrained"]
        if workflow:
            with contextlib.suppress(Exception):
                wanted = {s.name for s in pipe.blocks.get_workflow(workflow).expected_components}
                names = [name for name in names if name in wanted]
        folders = {name: os.path.join(model_dir, str(getattr(specs.get(name), "subfolder", "") or "")) for name in names}
        local = {name: model_dir for name, folder in folders.items() if os.path.isdir(folder)}
        needed = sum(folder_gb(folders[name]) for name in local) or weights
        loaded = {"torch_dtype": dtype, "local_files_only": True, "trust_remote_code": True}
        if local:
            loaded["pretrained_model_name_or_path"] = local
        if names:
            pipe.load_components(names=names, **loaded)
        else:
            pipe.load_components(**loaded)
        missing = [name for name in (names or list(getattr(pipe, "component_names", []) or [])) if getattr(pipe, name, None) is None]
        if missing:
            # The library's reason follows a line break; the whole note comes along.
            why = " | ".join(" ".join(note.split())[:400] for note in notes if any(m in note for m in missing)) or "the library gave no reason"
            raise ValueError(f"the model's {', '.join(missing)} did not load: {why}")
        if n and needed * 1.15 < first:
            pipe.to("cuda")
            mode = "gpu"
        elif n:
            manager.enable_auto_cpu_offload(device="cuda", memory_reserve_margin="12GB")
            mode = "turns"
        else:
            mode = "cpu"
    finally:
        for lib in ("diffusers", "transformers"):
            logging.getLogger(lib).removeHandler(catcher)
    state["modular"] = True
    state["workflow"] = workflow
    if workflow:
        say({"progress": 0, "note": f"loaded for the {workflow} workflow: {needed:.0f} GB of {weights:.0f}"})
    return pipe, mode


def modular_facts(pipe):
    """What a modular pipeline says about the clips it makes, where it says
    anything: its frame rate, the clip lengths it allows, the grain of its
    canvas and the frame counts its video VAE can decode."""
    facts = {}
    for key, attr in (("fps", "fps"), ("lo", "min_duration"), ("hi", "max_duration"), ("grain", "canvas_multiple"), ("chunk", "vae_frames_per_chunk"), ("keep", "vae_latents_per_chunk")):
        with contextlib.suppress(Exception):
            v = getattr(pipe, attr, None)
            if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
                facts[key] = v
    return facts


def fit_modular_request(pipe, kwargs, kind, fps):
    """Puts a request within what a modular pipeline makes: MiniMax-H3, for
    one, makes 5 to 15 seconds at 24 fps on a canvas of multiples of 32,
    with frame counts of 17n + 5. Returns the frame rate the clip plays at
    and what was changed, if anything."""
    facts = modular_facts(pipe)
    notes = []
    fps = int(facts.get("fps") or fps)
    grain = int(facts.get("grain") or 0)
    image = kwargs.get("image")
    if grain > 1 and kwargs.get("width") and kwargs.get("height") and getattr(image, "width", 0) and getattr(image, "height", 0):
        # A starting picture is stretched onto the canvas, so the canvas
        # keeps the preset's area but follows the picture's shape.
        area = int(kwargs["width"]) * int(kwargs["height"])
        ratio = image.width / image.height
        w, h = math.sqrt(area * ratio), math.sqrt(area / ratio)
        w, h = max(grain, round(w / grain) * grain), max(grain, round(h / grain) * grain)
        if (w, h) != (kwargs["width"], kwargs["height"]):
            notes.append(f"canvas {kwargs['width']} by {kwargs['height']} to {w} by {h}, the picture's shape")
            kwargs["width"], kwargs["height"] = w, h
    if grain > 1:
        for k in ("width", "height"):
            if kwargs.get(k):
                v = max(grain, round(int(kwargs[k]) / grain) * grain)
                if v != kwargs[k]:
                    notes.append(f"{k} {kwargs[k]} to {v}")
                    kwargs[k] = v
    if kind == "video" and kwargs.get("num_frames"):
        asked = int(kwargs["num_frames"])
        frames = asked
        lo, hi = facts.get("lo"), facts.get("hi")
        chunk, keep = int(facts.get("chunk") or 0), int(facts.get("keep") or 0)
        if lo:
            frames = max(frames, math.ceil(lo * fps))
        if chunk > 0:
            while frames % chunk != keep:
                frames += 1
            while hi and frames / fps > hi and frames - chunk > 0:
                frames -= chunk
        if frames != asked:
            notes.append(f"{asked} frames to {frames} ({frames / fps:.1f} s at {fps} fps)")
            kwargs["num_frames"] = frames
    return fps, notes


def modular_outputs(pipe):
    with contextlib.suppress(Exception):
        return {str(getattr(o, "name", o)) for o in pipe.blocks.outputs}
    return set()


def run_modular(pipe, kwargs, kind):
    """Calls a modular pipeline and finds its pictures or frames in what
    comes back, whichever name the blocks gave them, and the soundtrack
    with its sample rate when the model makes one."""
    outs = modular_outputs(pipe)
    wanted = ["videos"] if kind == "video" else ["images"]
    if kind == "video" and "audio" in outs:
        wanted += ["audio", "sampling_rate"]
    result = pipe(**kwargs, output=wanted)
    frames = images = audio = rate = None
    values = {}
    if isinstance(result, dict):
        values = result
    elif hasattr(result, "values") and not isinstance(result, (list, tuple)):
        values = result.values if isinstance(result.values, dict) else {}
    if values:
        for key in ("videos", "frames", "video"):
            if values.get(key) is not None:
                frames = values[key]
                break
        for key in ("images", "image"):
            if images is None and values.get(key) is not None:
                images = values[key]
        audio = values.get("audio")
        rate = values.get("sampling_rate")
    elif kind == "video":
        frames = result
    else:
        images = result
    return frames, images, audio, rate


def write_clip(frames, fps, audio=None, rate=None):
    """The clip as MP4 bytes, with its soundtrack muxed in when the model
    made one (ffmpeg from imageio-ffmpeg; the picture alone if that fails)."""
    from diffusers.utils import export_to_video

    with tempfile.NamedTemporaryFile(suffix=".mp4", delete=False) as tmp:
        path = tmp.name
    paths = [path]
    try:
        export_to_video(frames, path, fps=fps)
        if audio is not None and rate:
            try:
                import wave

                import imageio_ffmpeg
                import numpy as np

                a = np.asarray(as_array(audio), dtype="float32")
                while a.ndim > 2:
                    a = a[0]
                if a.ndim == 1:
                    a = a[None, :]
                if a.shape[0] > a.shape[1]:
                    a = a.T
                pcm = (np.clip(a.T, -1, 1) * 32767).astype("<i2")
                wav = path + ".wav"
                out = path + ".sound.mp4"
                paths += [wav, out]
                with wave.open(wav, "wb") as w:
                    w.setnchannels(a.shape[0])
                    w.setsampwidth(2)
                    w.setframerate(int(rate))
                    w.writeframes(pcm.tobytes())
                subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", path, "-i", wav, "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", out], check=True, timeout=600)
                with open(out, "rb") as f:
                    return f.read(), True
            except Exception as err:  # noqa: BLE001
                say({"progress": 1, "note": f"the soundtrack could not be added ({type(err).__name__}: {str(err)[:160]}); the clip is silent"})
        with open(path, "rb") as f:
            return f.read(), False
    finally:
        for p in paths:
            with contextlib.suppress(OSError):
                os.remove(p)


def step_counter(pipe, steps):
    """Progress for a pipeline without a step callback: a hook on the
    denoiser that reports each forward pass as a step. Returns the hook to
    remove, or None when there is no denoiser to watch."""
    denoiser = next((getattr(pipe, n, None) for n in ("transformer", "unet", "transformer_ref") if getattr(pipe, n, None) is not None), None)
    if denoiser is None or not hasattr(denoiser, "register_forward_pre_hook"):
        return None
    count = {"n": 0}

    def before(_module, _args):
        count["n"] += 1
        say({"progress": round(min(count["n"] / max(steps, 1), 0.99), 3)})

    try:
        return denoiser.register_forward_pre_hook(before)
    except Exception:  # noqa: BLE001
        return None


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

    fps = int(req.get("fps") or 16)
    audio = rate = None
    with torch.inference_mode():
        if state.get("modular"):
            fps, changed = fit_modular_request(pipe, kwargs, kind, fps)
            if changed:
                say({"progress": 0, "note": f"within what this model makes: {', '.join(changed)}"})
            # Modular blocks take no step callback; the denoiser's forward
            # passes count the steps instead.
            hook = step_counter(pipe, steps)
            try:
                frames_out, images_out, audio, rate = run_modular(pipe, kwargs, kind)
            finally:
                if hook:
                    hook.remove()
            if frames_out is None and images_out is None:
                raise ValueError("the pipeline returned neither pictures nor frames")
            result = type("Out", (), {})()
            result.frames = [first_clip(frames_out)] if frames_out is not None else None
            result.images = [first_image(images_out)] if images_out is not None else None
        else:
            result = pipe(**kwargs)

    if getattr(result, "frames", None) is not None:
        frames = result.frames[0]
        data, sound = write_clip(frames, fps, audio, rate)
        # The last frame apart, as a picture: the next piece of a longer
        # clip, or a continuation, starts from it.
        last = None
        try:
            buf = io.BytesIO()
            frame_to_pil(frames[-1]).convert("RGB").save(buf, format="PNG")
            last = base64.b64encode(buf.getvalue()).decode("ascii")
        except Exception:  # noqa: BLE001
            last = None
        return {"ok": True, "video": base64.b64encode(data).decode("ascii"), "frames": len(frames), "fps": fps, "sound": sound, "last": last}
    image = result.images[0]
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"ok": True, "image": base64.b64encode(buf.getvalue()).decode("ascii"), "width": image.width, "height": image.height}


def as_array(x):
    """A tensor becomes an array; anything else is returned as it is."""
    with contextlib.suppress(Exception):
        import torch

        if isinstance(x, torch.Tensor):
            return x.detach().float().cpu().numpy()
    return x


def first_clip(x):
    """The first clip of a batch as a list of frames, whatever container
    it came in: an array (B, F, H, W, C) or (F, H, W, C), a list of clips
    each a list of frames, or a single list of frames."""
    import numpy as np

    x = as_array(x)
    if isinstance(x, np.ndarray):
        if x.ndim == 5:
            x = x[0]
        if x.ndim == 4:
            return [frame_to_pil(f) for f in x]
        raise ValueError(f"unexpected clip shape {x.shape}")
    if isinstance(x, (list, tuple)) and x:
        inner = as_array(x[0])
        if isinstance(inner, (list, tuple)):
            return [frame_to_pil(f) for f in inner]
        if isinstance(inner, np.ndarray) and inner.ndim == 4:
            return [frame_to_pil(f) for f in inner]
        return [frame_to_pil(f) for f in x]
    raise ValueError("no frames in the result")


def first_image(x):
    """The first picture of a batch as a PIL image."""
    import numpy as np

    x = as_array(x)
    if isinstance(x, np.ndarray):
        if x.ndim == 4:
            x = x[0]
        return frame_to_pil(x)
    if isinstance(x, (list, tuple)) and x:
        return first_image(x[0])
    return frame_to_pil(x)


def frame_to_pil(f):
    import numpy as np
    from PIL import Image

    if hasattr(f, "save"):
        return f
    arr = np.asarray(as_array(f))
    # Channels first (C, H, W) becomes channels last.
    if arr.ndim == 3 and arr.shape[0] in (1, 3, 4) and arr.shape[-1] not in (1, 3, 4):
        arr = np.moveaxis(arr, 0, -1)
    if arr.dtype != np.uint8:
        lo = float(arr.min()) if arr.size else 0.0
        # Values in -1..1 are shifted; values in 0..1 are scaled.
        if lo < 0:
            arr = (arr + 1) / 2
        arr = (np.clip(arr, 0, 1) * 255).round().astype(np.uint8)
    if arr.ndim == 3 and arr.shape[-1] == 1:
        arr = arr[..., 0]
    return Image.fromarray(arr)


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
            import traceback

            msg = f"{type(err).__name__}: {err}"
            # The model is dropped after an out-of-memory failure, and the
            # answer says so, so the agent loads it again for the next job.
            unloaded = False
            if "out of memory" in msg.lower():
                msg = "the GPU ran out of memory for this model at this size; try a smaller picture, fewer frames, or a bigger card"
                unload()
                unloaded = True
            else:
                # Where it broke, so a failure inside a model's own code can be followed.
                frames = traceback.extract_tb(err.__traceback__)[-3:]
                where = " < ".join(f"{os.path.basename(f.filename)}:{f.lineno} {f.name}" for f in reversed(frames))
                if where:
                    msg = f"{msg} (at {where})"
            traceback.print_exc()
            say({"ok": False, "error": msg, "unloaded": unloaded})


if __name__ == "__main__":
    main()
