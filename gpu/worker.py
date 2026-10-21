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
import re
import shutil
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
    """What the Python side has: the libraries and their versions, the
    cards and their memory, so a machine report says it all in one place."""
    try:
        import torch
        import diffusers

        cuda = torch.cuda.is_available()
        info = {"ok": True, "torch": torch.__version__, "diffusers": diffusers.__version__, "cuda": cuda, "python": sys.version.split()[0]}
        for lib in ("transformers", "peft", "av", "accelerate", "bitsandbytes", "safetensors"):
            try:
                info[lib] = __import__(lib).__version__
            except Exception:  # noqa: BLE001
                info[lib] = None
        if cuda:
            props = torch.cuda.get_device_properties(0)
            info["gpu"] = props.name
            info["vramGb"] = round(props.total_memory / 1024**3, 1)
            info["cudaVersion"] = torch.version.cuda
            info["bf16"] = bool(torch.cuda.is_bf16_supported())
            major, minor = torch.cuda.get_device_capability(0)
            info["capability"] = f"{major}.{minor}"
            info["gpus"] = [{"name": torch.cuda.get_device_properties(i).name, "gb": round(torch.cuda.get_device_properties(i).total_memory / 1024**3, 1)} for i in range(torch.cuda.device_count())]
        try:
            info["torchao"] = __import__("torchao").__version__
        except Exception:  # noqa: BLE001
            info["torchao"] = None
        ok, why = fp8_ready()
        info["fp8"] = ok
        info["fp8Why"] = why
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
    state["loras"] = []
    state["loraWeights"] = {}
    state["modular"] = False
    state["workflow"] = None
    state["fp8"] = False
    state["compiled"] = False
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
    # The workflow a modular model is loaded for: its keyframe one unless a
    # request wants its reference one (MiniMax-H3's ref2va, another 62 GB
    # transformer), which means loading again.
    workflow = str(req.get("workflow") or "") or None
    # Weights in fp8 are a way of loading; the compiled blocks can be set
    # and unset on a loaded model, so only the first is part of the key.
    fp8 = bool(req.get("fp8"))
    compiled = bool(req.get("compile"))
    key = json.dumps([model_dir or single, adapters, workflow] + ([True] if fp8 else []), sort_keys=True)
    if state.get("key") == key and state["pipe"] is not None:
        return {"ok": True, "kind": state["kind"], "already": True, "fp8": bool(state.get("fp8")), "compiled": want_compiled(state["pipe"], compiled)}
    # The same modular model with other LoRAs (or none): swapped on the
    # loaded transformer rather than loading 130 GB again.
    # A fine-tune that stays the same is kept as it is; only its LoRAs change.
    def not_loras(items):
        return [a for a in items if (a.get("kind") or "lora") != "lora"]

    if state["pipe"] is not None and state.get("modular") and state.get("dir") == model_dir and model_dir and bool(state.get("fp8")) == fp8 and not_loras(adapters) == not_loras(state.get("adapters") or []) and all((a.get("kind") or "lora") in ("lora", "transformer") for a in adapters):
        swap_loras(state["pipe"], [a for a in adapters if (a.get("kind") or "lora") == "lora"], dtype_of(state["pipe"]))
        state.update(adapters=adapters, key=key)
        return {"ok": True, "kind": state["kind"], "already": True, "mode": state.get("mode"), "note": MODE_NOTES.get(state.get("mode"), ""), "fp8": bool(state.get("fp8")), "compiled": want_compiled(state["pipe"], compiled)}
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
        # A fine-tuned transformer from a single file (DaSiWa's MiniMax-H3)
        # takes the base transformer's place as the pipeline loads.
        swap = next((a for a in adapters if a.get("kind") == "transformer"), None)
        pipe, mode = load_folder(model_dir, dtype, weights, workflow, swap)
    with contextlib.suppress(Exception):
        pipe.set_progress_bar_config(disable=True)
    for adapter in adapters:
        if adapter.get("kind") != "transformer":
            apply_adapter(pipe, adapter, dtype)
    vram = torch.cuda.get_device_properties(0).total_memory / 1024**3 if torch.cuda.is_available() else 0
    if single:
        mode = place(pipe, weights, vram)
    with contextlib.suppress(Exception):
        pipe.vae.enable_tiling()
    # A video VAE that can decode a clip in batches of frames does so:
    # LTX-2's decoder, given all 121 frames of a clip at once, wants tens
    # of gigabytes beyond the weights, and the library leaves the
    # batch-wise way off unless asked.
    for flag in ("use_framewise_decoding", "use_framewise_encoding"):
        with contextlib.suppress(Exception):
            if hasattr(pipe.vae, flag):
                setattr(pipe.vae, flag, True)
    # LTX-2's parts take the card in turn: the text encoder and connectors
    # (30 GB) go back to the machine's memory once the words are read, so
    # the passes have the card's memory for the clip; a first clip from a
    # picture at 121 frames ran a 141 GB card out with everything resident.
    if mode == "gpu" and type(pipe).__name__.startswith("LTX2") and torch.cuda.is_available():
        try:
            pipe.enable_model_cpu_offload()
            mode = "staged"
        except Exception as err:  # noqa: BLE001
            say({"progress": 0, "note": f"the parts could not be staged ({type(err).__name__}: {str(err)[:160]}); all on the card"})
    # The passes' matrix products in fp8 on a card with fp8 units, and the
    # blocks compiled, when asked: each says what it did or why not.
    extra = []
    state["fp8"] = False
    if fp8:
        try:
            layers, saved = fp8_weights(pipe)
            state["fp8"] = True
            extra.append(f"{layers} layers hold fp8 weights ({saved:.1f} GB less in memory).")
            say({"progress": 0, "note": f"fp8 weights: {layers} linear layers of the transformer blocks, {saved:.1f} GB saved"})
        except Exception as err:  # noqa: BLE001
            extra.append(f"fp8 weights were not used: {err}.")
            say({"progress": 0, "note": f"fp8 weights were not used ({type(err).__name__}: {str(err)[:200]})"})
    state.update(pipe=pipe, dir=model_dir or single, key=key, kind=kind, offloaded=mode == "offload", adapters=adapters, mode=mode, phase=None, weightsGb=round(weights, 1))
    if want_compiled(pipe, compiled):
        extra.append("The blocks are compiled: the first clip waits for it.")
    # What the model's parts weigh in memory, at which precision: the
    # answer to "where did the card's memory go" when a clip does not fit.
    sizes = component_sizes(pipe)
    if sizes:
        state["onCard"] = sum(gb for _, gb, _ in sizes)
        say({"progress": 0, "note": f"the model in memory: {', '.join(f'{name} {gb:.1f} GB {dt}' for name, gb, dt in sizes)}; {state['onCard']:.1f} GB in all"})
    return {"ok": True, "kind": kind, "mode": mode, "note": " ".join(filter(None, [MODE_NOTES.get(mode, ""), *extra])), "offloaded": mode == "offload", "weightsGb": round(weights, 1), "vramGb": round(vram, 1), "gpus": torch.cuda.device_count() if torch.cuda.is_available() else 0, "fp8": bool(state.get("fp8")), "compiled": bool(state.get("compiled"))}


MODE_NOTES = {
    "gpu": "",
    "staged": "Its parts take the card in turn: the words are read, then the passes run, then the frames are decoded, so the card's memory goes to the clip.",
    "multi-gpu": "Spread across the machine's cards.",
    "two-cards": "Spread over the machine's two cards: the words are read on the second, and every pass runs whole on the first, with nothing swapped from the machine's memory.",
    "8-bit": "Loaded at 8 bits to fit the card: a little lower quality than full precision.",
    "4-bit": "Loaded at 4 bits to fit the card: noticeably lower quality and slower; a bigger card would do better.",
    "offload": "Bigger than the card: streamed through it from the machine's memory, slowly.",
    "turns": "Bigger than the card: its models take turns on it, each moved in from the machine's memory as its step comes.",
}


def component_sizes(pipe):
    """Each component with weights: its name, gigabytes and precision."""
    import torch

    out = []
    with contextlib.suppress(Exception):
        for name, m in pipe.components.items():
            if not isinstance(m, torch.nn.Module):
                continue
            params = list(m.parameters())
            if not params:
                continue
            gb = sum(p.numel() * p.element_size() for p in params) / 1024**3
            dtypes = sorted({str(p.dtype).replace("torch.", "") for p in params})
            devices = sorted({str(p.device) for p in params})
            out.append((name, gb, f"{'/'.join(dtypes)} on {'/'.join(devices)}"))
    return out


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


def load_folder(model_dir, dtype, weights, workflow=None, swap=None):
    """Loads a folder model the way its size allows: whole on one card,
    spread over several, at 8 or 4 bits when it would not fit otherwise,
    or streamed from the machine's memory as a last resort. Pipelines a
    repository ships its own code for load with that code, which runs on
    the rented machine only."""
    from diffusers import DiffusionPipeline

    n, first, total = gpu_memory()
    common = {"torch_dtype": dtype, "local_files_only": True, "trust_remote_code": True}
    with open(os.path.join(model_dir, "model_index.json"), encoding="utf-8") as f:
        index = json.load(f)
    cls = str(index.get("_class_name", ""))
    # The newer "modular" pipelines (MiniMax-H3 among them) load through
    # their own class and take their inputs by name.
    if "Modular" in cls:
        return load_modular(model_dir, dtype, weights, n, first, total, workflow, swap)
    if swap:
        raise ValueError("a transformer from a single file takes the place of a MiniMax-H3 transformer only")
    # Components the index names whose folders were left on the Hub (LTX-2.5's
    # prompt-enhancing Gemma, which the app has Claude for): passed as absent,
    # and marked absent in the index on the disk as well, which every loader
    # honours; otherwise the library looks for them in the folder's root and
    # fails on "no file named model.safetensors". Said in the log, with any
    # folder that is there but holds no weights, so a failed load names its cause.
    absent = [name for name, spec in index.items() if isinstance(spec, list) and spec and spec[0] and not os.path.isdir(os.path.join(model_dir, name))]
    # A scheduler, a tokenizer or a processor is configuration alone; any
    # other component's folder should hold weights.
    configured = ("Scheduler", "Tokenizer", "Processor", "FeatureExtractor")
    weightfile = (".safetensors", ".bin", ".ckpt", ".pt", ".pth", ".gguf", ".msgpack")
    hollow = [name for name, spec in index.items() if isinstance(spec, list) and len(spec) > 1 and spec[0] and name not in absent and not any(w in str(spec[1]) for w in configured) and not any(f.endswith(weightfile) for f in os.listdir(os.path.join(model_dir, name)))]
    if absent or hollow:
        say({"progress": 0, "note": f"components the index names: {', '.join(k for k, v in index.items() if isinstance(v, list))}" + (f"; left on the Hub, not loaded: {', '.join(absent)}" if absent else "") + (f"; folders without weights: {', '.join(hollow)}" if hollow else "")})
    if absent:
        for name in absent:
            common[name] = None
        try:
            index_path = os.path.join(model_dir, "model_index.json")
            backup = os.path.join(model_dir, "model_index.json.hub")
            if not os.path.exists(backup):
                shutil.copyfile(index_path, backup)
            with open(index_path, "w", encoding="utf-8") as f:
                json.dump({**index, **{name: [None, None] for name in absent}}, f, indent=2)
        except OSError as err:
            say({"progress": 0, "note": f"the index could not be marked ({err}); loading all the same"})
    if hollow:
        raise ValueError(f"the model's folder is missing weights for {', '.join(hollow)}; run the download again and it fetches what is missing")
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
        if state.get("modular") or not hasattr(pipe, "load_lora_weights"):
            apply_transformer_lora(pipe, path, scale)
            return
        # Several at once, each under a name of its own and at its own strength.
        taken = state.setdefault("loras", [])
        adapter_name = f"addon{len(taken)}"
        pipe.load_lora_weights(folder, weight_name=name, adapter_name=adapter_name)
        taken.append(adapter_name)
        state.setdefault("loraWeights", {})[adapter_name] = scale
        pipe.set_adapters(taken, adapter_weights=[state["loraWeights"].get(n, 1.0) for n in taken])
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


# ---- LoRAs on a video model's transformer ------------------------------------------
# LoRAs for MiniMax-H3 name their modules as ComfyUI does: "diffusion_model.
# blocks.N.attn.qkv_proj" (ai-toolkit, most of Hugging Face and Civitai),
# sometimes with an ".alpha" per module (a strength that scales the LoRA by
# alpha / rank), or in Kohya's spelling "lora_unet_blocks_N_attn_qkv_proj"
# with lora_down / lora_up. The transformer the library loads names them
# "transformer_blocks.N.attn.to_q" with the three projections apart and the
# gated feed-forward's halves as [up | gate] where ComfyUI has [gate | up].
# The tensors are renamed, the fused projection split in three, the
# feed-forward's halves swapped, the alpha folded in, and the adapters set
# on the transformer itself, which takes LoRAs whatever pipeline wraps it.
LORA_RENAMES = (
    (".attn.out_proj", ".attn.to_out.0"),
    (".mlp.fc1", ".ff.net.0.proj"),
    (".mlp.fc2", ".ff.net.2"),
)
KOHYA_LORA = re.compile(r"^lora_unet_(token_refiner_)?blocks_(\d+)_(attn_qkv_proj|attn_out_proj|mlp_fc1|mlp_fc2|attn_q_norm|attn_k_norm)\.(.+)$")


def dtype_of(pipe):
    import torch

    with contextlib.suppress(Exception):
        return next(pipe.transformer.parameters()).dtype
    return torch.bfloat16


def convert_video_lora(sd):
    """A LoRA state dict in the transformer's own names, with how many
    tensors were left aside (none, when every tensor is a LoRA's)."""
    import torch

    # Kohya's spelling first, into ComfyUI's.
    plain = {}
    for key, value in sd.items():
        m = KOHYA_LORA.match(key)
        if m:
            refiner, n, module, rest = m.groups()
            key = f"{'token_refiner.' if refiner else ''}blocks.{n}.{module.replace('_', '.', 1)}.{rest}"
        plain[key] = value
    # Each module's A, B and alpha together.
    modules = {}
    foreign = 0
    for key, value in plain.items():
        k = key[len("diffusion_model.") :] if key.startswith("diffusion_model.") else key
        k = k.replace(".lora_down.weight", ".lora_A.weight").replace(".lora_up.weight", ".lora_B.weight")
        for tail, part in ((".lora_A.weight", "A"), (".lora_B.weight", "B"), (".alpha", "alpha")):
            if k.endswith(tail):
                modules.setdefault(k[: -len(tail)], {})[part] = value
                break
        else:
            foreign += 1
    out = {}
    for name, parts in modules.items():
        a, b = parts.get("A"), parts.get("B")
        if a is None or b is None:
            foreign += len(parts)
            continue
        if "alpha" in parts:
            b = b * (float(parts["alpha"]) / a.shape[0])
        k = name
        if k.startswith("blocks."):
            k = "transformer_blocks." + k[len("blocks.") :]
        if k.startswith("token_refiner.blocks."):
            k = "token_refiner.refiner_blocks." + k[len("token_refiner.blocks.") :]
        if k.endswith(".mlp.fc1"):
            # [gate | up] in ComfyUI's order, [up | gate] in the library's.
            gate, up = torch.chunk(b, 2, dim=0)
            b = torch.cat([up, gate], dim=0)
        for x, y in LORA_RENAMES:
            k = k.replace(x, y)
        if k.endswith(".attn.qkv_proj"):
            for part, piece in zip(("to_q", "to_k", "to_v"), torch.chunk(b, 3, dim=0)):
                out[f"{k[: -len('qkv_proj')]}{part}.lora_A.weight"] = a
                out[f"{k[: -len('qkv_proj')]}{part}.lora_B.weight"] = piece.contiguous()
            continue
        out[f"{k}.lora_A.weight"] = a
        out[f"{k}.lora_B.weight"] = b.contiguous()
    return out, foreign


def apply_transformer_lora(pipe, path, scale, name="addon"):
    import torch
    from safetensors.torch import load_file

    # The library sets LoRAs through peft; an image without it says so plainly.
    try:
        import peft  # noqa: F401
    except ImportError as err:
        raise ValueError("this machine image lacks the peft library that LoRAs need; a machine on the current image has it") from err

    transformer = getattr(pipe, "transformer", None)
    if transformer is None or not hasattr(transformer, "load_lora_adapter"):
        raise ValueError("this model's transformer takes no LoRA")
    sd, foreign = convert_video_lora(load_file(path))
    if not sd:
        raise ValueError(f"{os.path.basename(path)} holds no tensors in a layout this model's transformer takes")
    known = {n for n, _ in transformer.named_modules()}
    wanted = {k.rsplit(".lora_", 1)[0] for k in sd if ".lora_" in k}
    missing = sorted(m for m in wanted if m not in known)
    if missing:
        raise ValueError(f"{os.path.basename(path)} names {len(missing)} of {len(wanted)} modules this model does not have ({', '.join(missing[:3])}…); it was made for another model or layout")
    device = next(transformer.parameters()).device
    sd = {k: v.to(device=device, dtype=next(transformer.parameters()).dtype) for k, v in sd.items()}
    # Several LoRAs at once, each under a name of its own and at its own strength.
    taken = state.setdefault("loras", [])
    while name in taken:
        name = f"{name}_"
    transformer.load_lora_adapter(sd, adapter_name=name, prefix=None)
    # On fp8 blocks the library would cast the LoRA's own small matrices to
    # the base weight's fp8; they work in the model's working precision.
    if state.get("fp8"):
        working = dtype_of(pipe)
        with torch.no_grad():
            for pname, p in transformer.named_parameters():
                if ".lora_" in pname and p.dtype != working:
                    p.data = p.data.to(working)
    taken.append(name)
    state.setdefault("loraWeights", {})[name] = scale
    transformer.set_adapters(taken, weights=[state["loraWeights"].get(n, 1.0) for n in taken])
    say({"progress": 0, "note": f"LoRA {os.path.basename(path)} on the transformer at strength {scale:g}: {len(wanted)} modules{f', {foreign} tensors not of a LoRA left aside' if foreign else ''}"})


def swap_loras(pipe, adapters, dtype):
    """The LoRAs on a loaded transformer replaced by these, without a reload."""
    transformer = getattr(pipe, "transformer", None)
    names = state.get("loras") or []
    if transformer is not None and names:
        with contextlib.suppress(Exception):
            transformer.delete_adapters(names)
    state["loras"] = []
    state["loraWeights"] = {}
    for adapter in adapters:
        apply_adapter(pipe, adapter, dtype)


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


def load_modular(model_dir, dtype, weights, n, first, total, wanted_workflow=None, swap=None):
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
        offered = workflows(pipe)
        if wanted_workflow and wanted_workflow not in offered:
            raise ValueError(f"this model has no {wanted_workflow} workflow (it offers {', '.join(offered) or 'none by name'})")
        workflow = wanted_workflow or next((w for w in PREFERRED_WORKFLOWS if w in offered), None)
        specs = getattr(pipe, "_component_specs", None) or {}
        names = [name for name, spec in specs.items() if getattr(spec, "default_creation_method", "from_pretrained") == "from_pretrained"]
        if workflow:
            with contextlib.suppress(Exception):
                wanted = {s.name for s in pipe.blocks.get_workflow(workflow).expected_components}
                names = [name for name in names if name in wanted]
        folders = {name: os.path.join(model_dir, str(getattr(specs.get(name), "subfolder", "") or "")) for name in names}
        # The transformer a single file replaces is never read from the disk:
        # the one the workflow uses, built from its config with the file's weights.
        swapped = None
        if swap:
            swapped = next((name for name in ("transformer", "transformer_ref") if name in names), None)
            if not swapped:
                raise ValueError("this model's workflow has no transformer for the fine-tune to replace")
            names = [name for name in names if name != swapped]
        local = {name: model_dir for name, folder in folders.items() if os.path.isdir(folder) and name != swapped}
        needed = sum(folder_gb(folders[name]) for name in local) or weights
        loaded = {"torch_dtype": dtype, "local_files_only": True, "trust_remote_code": True}
        if local:
            loaded["pretrained_model_name_or_path"] = local
        if names:
            pipe.load_components(names=names, **loaded)
        else:
            pipe.load_components(**loaded)
        if swapped:
            from comfy_minimax import load_transformer

            say({"progress": 0, "note": f"reading {os.path.basename(str(swap['path']))} in place of the base {swapped}"})
            model, info = load_transformer(str(swap["path"]), folders[swapped], dtype)
            pipe.update_components(**{swapped: model})
            needed += info["gb"]
            unused = f"; {len(info['extra'])} tensors not used" if info["extra"] else ""
            say({"progress": 0, "note": f"{os.path.basename(str(swap['path']))}: {info['blocks']} blocks{', the curve form' if info['curve'] else ''}, {info['gb']:.1f} GB at {str(dtype).replace('torch.', '')}{unused}"})
        missing = [name for name in (names or list(getattr(pipe, "component_names", []) or [])) if getattr(pipe, name, None) is None]
        if missing:
            # The library's reason follows a line break; the whole note comes along.
            why = " | ".join(" ".join(note.split())[:400] for note in notes if any(m in note for m in missing)) or "the library gave no reason"
            raise ValueError(f"the model's {', '.join(missing)} did not load: {why}")
        if n and needed * 1.15 < first:
            pipe.to("cuda")
            mode = "gpu"
        elif n > 1 and on_two_cards(pipe, first):
            mode = "two-cards"
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


def on_two_cards(pipe, first):
    """A modular pipeline too big for one card, on a machine with two: the
    text encoder, which reads the words once per clip, goes whole on the
    second card; the transformer and the decoders go whole on the first,
    where every pass then runs at full speed with nothing swapped in from
    the machine's memory (MiniMax-H3: a 62 GB encoder beside 72 GB of the
    rest, where one 141 GB card holds neither set with room to work).

    The blocks build the encoder's inputs on the pipeline's device and
    call the encoder's inner model directly, so hooks on the encoder move
    whatever arrives onto its own card, and a top-level call's answers
    back; the pipeline is made to keep reporting the first card as its
    device, so latents, noise and timesteps are made there. Anything that
    goes wrong leaves the pipeline as it was, for the next way of loading."""
    import torch

    te = getattr(pipe, "text_encoder", None)
    if not isinstance(te, torch.nn.Module) or torch.cuda.device_count() < 2:
        return False

    def gb(module):
        return sum(p.numel() * p.element_size() for p in module.parameters()) / 1024**3

    rest = [m for name, m in pipe.components.items() if isinstance(m, torch.nn.Module) and m is not te]
    second = torch.cuda.get_device_properties(1).total_memory / 1024**3
    if sum(gb(m) for m in rest) * 1.15 >= first or gb(te) * 1.1 >= second:
        return False
    main, other = torch.device("cuda:0"), torch.device("cuda:1")

    def move(x, device):
        if torch.is_tensor(x):
            return x.to(device)
        if isinstance(x, tuple):
            return tuple(move(v, device) for v in x)
        if isinstance(x, list):
            return [move(v, device) for v in x]
        if isinstance(x, dict):
            for k in list(x.keys()):
                x[k] = move(x[k], device)
            return x
        return x

    def inputs_over(module, args, kwargs):
        return move(args, other), move(kwargs, other)

    def answers_back(module, args, output):
        return move(output, main)

    try:
        te.to(other)
        for m in rest:
            m.to(main)
        inner = getattr(te, "model", None)
        te.register_forward_pre_hook(inputs_over, with_kwargs=True)
        te.register_forward_hook(answers_back)
        if isinstance(inner, torch.nn.Module) and inner is not te:
            inner.register_forward_pre_hook(inputs_over, with_kwargs=True)
        pipe.__class__ = type(f"{type(pipe).__name__}OnTwoCards", (type(pipe),), {"device": property(lambda self: main), "_execution_device": property(lambda self: main)})
        return True
    except Exception as err:  # noqa: BLE001
        say({"progress": 0, "note": f"could not spread the model over the two cards ({type(err).__name__}: {str(err)[:160]}); its models take turns on one instead"})
        with contextlib.suppress(Exception):
            te.to("cpu")
            for m in rest:
                m.to("cpu")
            torch.cuda.empty_cache()
        return False


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
        # A LoRA trained on shorter clips than the model's own floor (the
        # orbit LoRA, 73 frames) is taken at its word.
        if lo and not state.get("loras"):
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


# ---- LTX-2 ---------------------------------------------------------------------------
# Lightricks' LTX-2 and 2.5 make clips with sound through a plain pipeline:
# 8n + 1 frames at 24 fps on a canvas of multiples of 32, the soundtrack
# as a tensor beside the frames with the vocoder's rate. LTX-2.5's
# repository ships its distilled transformer as the one that loads: that
# runs a fixed schedule of eight sigmas, unguided and without a negative
# prompt, whatever step count is asked.


def ltx_distilled():
    d = str(state.get("dir") or "").lower()
    return "ltx-2.5" in d or "ltx2.5" in d or "distill" in d


def ltx_rate(pipe):
    with contextlib.suppress(Exception):
        return int(pipe.vocoder.config.output_sampling_rate)
    return None


def ltx_twin(pipe):
    """The image-to-video pipeline over the loaded one's components, made once."""
    if state.get("twin_of") is pipe and state.get("twin") is not None:
        return state["twin"]
    from diffusers import LTX2ImageToVideoPipeline

    twin = LTX2ImageToVideoPipeline.from_pipe(pipe)
    with contextlib.suppress(Exception):
        twin.set_progress_bar_config(disable=True)
    if state.get("mode") == "staged":
        twin.enable_model_cpu_offload()
    state["twin"], state["twin_of"] = twin, pipe
    return twin


def fit_ltx_request(kwargs, params, fps, image=None):
    """Puts a request within what LTX-2 makes and returns the step count
    the progress line should expect."""
    notes = []
    grain = 32
    w, h = int(kwargs.get("width") or 1280), int(kwargs.get("height") or 704)
    if image is not None and getattr(image, "width", 0) and getattr(image, "height", 0):
        # A starting picture is stretched onto the canvas, so the canvas
        # keeps the preset's area but follows the picture's shape.
        area, ratio = w * h, image.width / image.height
        w, h = math.sqrt(area * ratio), math.sqrt(area / ratio)
    w, h = max(grain, round(w / grain) * grain), max(grain, round(h / grain) * grain)
    if (w, h) != (kwargs.get("width"), kwargs.get("height")):
        notes.append(f"canvas {kwargs.get('width')} by {kwargs.get('height')} to {w} by {h}" + (", the picture's shape" if image is not None else ""))
        kwargs["width"], kwargs["height"] = w, h
    if "num_frames" in params:
        frames = int(kwargs.get("num_frames") or 121)
        snapped = max(9, ((frames - 1 + 4) // 8) * 8 + 1)
        if snapped != frames:
            notes.append(f"{frames} frames to {snapped} ({snapped / fps:.1f} s at {fps} fps)")
        kwargs["num_frames"] = snapped
    if "frame_rate" in params:
        kwargs["frame_rate"] = float(fps)
    steps = int(kwargs.get("num_inference_steps") or 30)
    if ltx_distilled() and "sigmas" in params:
        from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES

        kwargs.pop("num_inference_steps", None)
        kwargs.pop("negative_prompt", None)
        kwargs["sigmas"] = list(DISTILLED_SIGMA_VALUES)
        kwargs["guidance_scale"] = 1.0
        steps = len(DISTILLED_SIGMA_VALUES)
    if notes:
        say({"progress": 0, "note": f"within what this model makes: {', '.join(notes)}"})
    return steps


class _Skipping:
    """What the pass skipping did on the last forward: computed in full, or
    skipped the blocks after the first and reused the last full pass."""

    def __init__(self, denoiser, head):
        self.denoiser = denoiser
        self.head = head

    def computed_last(self):
        try:
            with self.denoiser.cache_context("cond"):
                return bool(self.head.state_manager.get_state().should_compute)
        except Exception:  # noqa: BLE001
            return True


@contextlib.contextmanager
def pass_skipping(pipe, threshold):
    """Skips the denoiser's passes that would barely change anything, the
    way TeaCache does and diffusers' first-block cache after it: each
    pass runs the first block, compares its change with the pass before,
    and when the two are within the threshold reuses the rest of the last
    full pass instead of running the other blocks. Nothing is kept in the
    model afterwards. Yields a record of what it did, or None when the
    model has no denoiser this works on, which is said as a note."""
    denoiser = next((getattr(pipe, n, None) for n in ("transformer", "transformer_ref") if getattr(pipe, n, None) is not None), None)
    if not threshold or denoiser is None or not hasattr(denoiser, "enable_cache"):
        yield None
        return
    try:
        from diffusers.hooks import FirstBlockCacheConfig, HookRegistry
        from diffusers.hooks._helpers import TransformerBlockMetadata, TransformerBlockRegistry

        blocks = getattr(denoiser, "transformer_blocks", None)
        if blocks is None or len(blocks) < 3:
            raise ValueError("the model's denoiser has no run of blocks to skip")
        # Blocks the library does not list yet (MiniMax-H3's) are described
        # to it: one tensor in, the same tensor back.
        for block in blocks:
            try:
                TransformerBlockRegistry.get(type(block))
            except Exception:  # noqa: BLE001
                TransformerBlockRegistry.register(type(block), TransformerBlockMetadata(return_hidden_states_index=0, return_encoder_hidden_states_index=None))
            break
        denoiser.enable_cache(FirstBlockCacheConfig(threshold=float(threshold)))
        head = HookRegistry.check_if_exists_or_initialize(blocks[0]).get_hook("fbc_leader_block_hook")
        if head is None:
            raise ValueError("the cache put no hook on the first block")
        # The hooks keep their state under a named context the denoising
        # loop is meant to open; this model's loop opens none, so every
        # forward is wrapped in one here. One pass a step, so one name.
        original_forward = denoiser.forward

        def forward_in_context(*args, **kwargs):
            with denoiser.cache_context("cond"):
                return original_forward(*args, **kwargs)

        denoiser.forward = forward_in_context
    except Exception as err:  # noqa: BLE001
        say({"progress": 0, "note": f"passes are not skipped for this model ({type(err).__name__}: {err})"})
        with contextlib.suppress(Exception):
            denoiser.disable_cache()
        yield None
        return
    try:
        yield _Skipping(denoiser, head)
    finally:
        with contextlib.suppress(Exception):
            del denoiser.forward
        with contextlib.suppress(Exception):
            denoiser.disable_cache()


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


def denoiser_of(pipe):
    return next((getattr(pipe, n, None) for n in ("transformer", "transformer_ref", "unet") if getattr(pipe, n, None) is not None), None)


def fp8_ready():
    """Whether the passes' matrix products can run in fp8 here: a card with
    fp8 units (Ada, Hopper, Blackwell: compute capability 8.9 and up) and
    the torchao library on the image. Returns (yes, why not)."""
    try:
        import torch

        if not torch.cuda.is_available():
            return False, "no card"
        major, minor = torch.cuda.get_device_capability(0)
        if (major, minor) < (8, 9):
            return False, f"the card (compute capability {major}.{minor}) has no fp8 units; Ada, Hopper and Blackwell cards (L40S, RTX 4090 and 5090, H100, H200, B200) do"
        from torchao.quantization import Float8DynamicActivationFloat8WeightConfig, quantize_  # noqa: F401

        return True, ""
    except ImportError:
        return False, "this machine image lacks the torchao library; a machine on the current image has it"
    except Exception as err:  # noqa: BLE001
        return False, f"{type(err).__name__}: {err}"


def fp8_weights(pipe):
    """The linear layers of the denoiser's blocks quantised to fp8, weights
    and activations, so their matrix products run on the card's fp8 units
    at about twice the rate of bf16 and the weights take half the memory.
    Returns (layers, GB saved). The LoRA matrices peft adds later are kept
    out of it. Raises with the plain reason when it cannot be done."""
    import torch
    from torch import nn

    ok, why = fp8_ready()
    if not ok:
        raise ValueError(why)
    from torchao.quantization import Float8DynamicActivationFloat8WeightConfig, quantize_

    denoiser = denoiser_of(pipe)
    blocks = getattr(denoiser, "transformer_blocks", None) if denoiser is not None else None
    if blocks is None:
        raise ValueError("this model has no transformer blocks to quantise")

    def wanted(module, name):
        return isinstance(module, nn.Linear) and ".lora_" not in name and module.in_features % 16 == 0 and module.out_features % 16 == 0

    before = sum(p.numel() * p.element_size() for p in blocks.parameters())
    layers = sum(1 for name, module in blocks.named_modules() if wanted(module, name))
    if not layers:
        raise ValueError("the blocks have no linear layers of a shape fp8 takes")
    try:
        from torchao.quantization import PerRow

        config = Float8DynamicActivationFloat8WeightConfig(granularity=PerRow())
    except Exception:  # noqa: BLE001
        config = Float8DynamicActivationFloat8WeightConfig()
    quantize_(blocks, config, filter_fn=wanted)
    after = sum(p.numel() * p.element_size() for p in blocks.parameters())
    with contextlib.suppress(Exception):
        torch.cuda.empty_cache()
    return layers, max(0.0, (before - after) / 1024**3)


def want_compiled(pipe, on):
    """The denoiser's blocks compiled with torch.compile, or set back to
    plain: each block's forward is compiled on its own, and as they share
    one code the compiler does the work once, at the first pass. Returns
    whether the blocks are compiled now."""
    denoiser = denoiser_of(pipe)
    blocks = getattr(denoiser, "transformer_blocks", None) if denoiser is not None else None
    if not blocks:
        state["compiled"] = False
        return False
    now = bool(state.get("compiled"))
    if on == now:
        return now
    import torch

    try:
        if on:
            # Several shapes of clip, and LoRAs swapped under the compiled
            # blocks, each mean a new compile; the limit leaves room.
            for name in ("cache_size_limit", "recompile_limit"):
                with contextlib.suppress(Exception):
                    setattr(torch._dynamo.config, name, max(getattr(torch._dynamo.config, name, 0) or 0, 64))
            for block in blocks:
                block.forward = torch.compile(block.forward)
        else:
            for block in blocks:
                if "forward" in block.__dict__:
                    del block.forward
            with contextlib.suppress(Exception):
                torch._dynamo.reset()
        state["compiled"] = on
    except Exception as err:  # noqa: BLE001
        say({"progress": 0, "note": f"the blocks could not be {'compiled' if on else 'set back'} ({type(err).__name__}: {str(err)[:200]})"})
        for block in blocks:
            if "forward" in block.__dict__:
                del block.forward
        state["compiled"] = False
    return bool(state.get("compiled"))


def generate(req):
    import torch
    from PIL import Image

    pipe = state["pipe"]
    if pipe is None:
        raise ValueError("no model is loaded")
    kind = state["kind"]
    params = accepted(pipe)
    ltx2 = type(pipe).__name__.startswith("LTX2")
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

    # Reference pictures (MiniMax-H3's ref2va): the people and things the
    # clip is to show, each as the library's image reference; that workflow
    # takes no keyframes, so a starting picture is left aside with a note.
    references = req.get("references") or []
    if references and "references" in params:
        from diffusers.modular_pipelines.minimax_h3 import MiniMaxH3ImageReference

        kwargs["references"] = [MiniMaxH3ImageReference(image=Image.open(io.BytesIO(base64.b64decode(r))).convert("RGB")) for r in references]
        if req.get("init"):
            say({"progress": 0, "note": "the reference workflow takes no starting picture; the clip comes from the references and the words"})
            req = {**req, "init": None, "lastInit": None}
    elif references:
        raise ValueError("this model takes no reference pictures")
    # A picture the clip ends on, for a keyframe workflow (MiniMax-H3's
    # fl2va): an orbit LoRA ends where it began, on the same picture.
    last_init = req.get("lastInit")
    if last_init and "last_image" in params:
        kwargs["last_image"] = Image.open(io.BytesIO(base64.b64decode(last_init))).convert("RGB")
    init = req.get("init")
    if init:
        image = Image.open(io.BytesIO(base64.b64decode(init))).convert("RGB")
        if "image" in params:
            kwargs["image"] = image
            if "strength" in params:
                kwargs["strength"] = float(req.get("strength") or 0.55)
        elif ltx2:
            # LTX-2 animates a picture through its image-to-video pipeline,
            # which shares every component with the loaded one.
            pipe = ltx_twin(pipe)
            params = accepted(pipe)
            kwargs["image"] = image
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
            # Where the work is, for a failure to name: the passes, then the decode.
            state["phase"] = "decoding the frames" if step + 1 >= steps else f"pass {step + 2} of {steps}"
            return cb_kwargs

        kwargs["callback_on_step_end"] = on_step

    fps = int(req.get("fps") or 16)
    audio = rate = None
    state["phase"] = "pass 1" if "callback_on_step_end" in params else None
    if ltx2:
        fps = int(req.get("fps") or 24)
        steps = fit_ltx_request(kwargs, params, fps, image if init else None)
    with torch.inference_mode():
        if state.get("modular"):
            fps, changed = fit_modular_request(pipe, kwargs, kind, fps)
            if changed:
                say({"progress": 0, "note": f"within what this model makes: {', '.join(changed)}"})
            # Modular blocks take no step callback; the denoiser's forward
            # passes count the steps instead.
            hook = step_counter(pipe, steps)
            try:
                # Passes that would barely change anything are skipped when asked.
                with pass_skipping(pipe, req.get("cache")) as skipping:
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
            if ltx2:
                audio = getattr(result, "audio", None)
                rate = ltx_rate(pipe)

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
                phase = state.get("phase")
                numbers = ""
                with contextlib.suppress(Exception):
                    import torch

                    numbers = f" (the model's parts weigh {state.get('onCard', 0):.0f} GB, {torch.cuda.memory_allocated() / 1024**3:.0f} GB was in use on the card, the most at any point {torch.cuda.max_memory_allocated() / 1024**3:.0f} GB)"
                msg = f"the GPU ran out of memory for this model at this size{f' while {phase}' if phase else ''}{numbers}; try a smaller picture, fewer frames, or a bigger card"
                unload()
                unloaded = True
            else:
                # Where it broke, so a failure inside a model's own code can be followed.
                frames = traceback.extract_tb(err.__traceback__)[-3:]
                where = " < ".join(f"{os.path.basename(f.filename)}:{f.lineno} {f.name}" for f in reversed(frames))
                if where:
                    msg = f"{msg} (at {where})"
            traceback.print_exc()
            # The traceback goes along in the answer, for the machine's journal and the page's details.
            say({"ok": False, "error": msg, "unloaded": unloaded, "trace": traceback.format_exc()[-6000:], "phase": state.get("phase")})


if __name__ == "__main__":
    main()
