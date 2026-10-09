# The machine image HuggingFound rents at RunPod: Ollama for chat models and
# stable-diffusion.cpp for image models, with a small agent that downloads
# image models onto the machine and makes pictures on request. Built by
# GitHub Actions (.github/workflows/gpu-image.yml) and published as
# ghcr.io/hungatejoseph/huggingfound-gpu.
#
# stable-diffusion.cpp publishes no Linux CUDA build, so the first stage
# compiles it against the CUDA toolkit for the cards RunPod rents (Ampere,
# Ada, Hopper); the second stage is the official Ollama image plus those
# binaries, the CUDA runtime libraries they need, Node for the agent, and
# the agent itself.

FROM nvidia/cuda:12.4.1-devel-ubuntu22.04 AS build
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /src
RUN git clone --depth 1 --recursive https://github.com/leejet/stable-diffusion.cpp.git .
RUN cmake -B build -DSD_CUDA=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_CUDA_ARCHITECTURES="80;86;89;90" \
 && cmake --build build --config Release -j"$(nproc)"
# Every shared library the binaries need that the Ollama image will not
# have (the CUDA runtime, cuBLAS, NCCL and whatever else the toolkit linked
# in), found by asking the binaries themselves rather than by guessing.
RUN mkdir -p /out/lib \
 && for bin in build/bin/sd-server build/bin/sd-cli; do \
      ldd "$bin" | awk '$3 ~ /^\// && ($3 ~ /cuda|cublas|nccl|curand|cusparse|cudnn|nvrtc|nvJitLink/) {print $3}'; \
    done | sort -u | while read -r lib; do cp -L "$lib" /out/lib/; done \
 && ls -la /out/lib

FROM ollama/ollama:latest
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils libgomp1 && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://nodejs.org/dist/v22.23.3/node-v22.23.3-linux-x64.tar.xz | tar -xJ -C /opt \
 && mv /opt/node-v22.23.3-linux-x64 /opt/node
COPY --from=build /src/build/bin/sd-cli /src/build/bin/sd-server /opt/huggingfound/bin/
COPY --from=build /out/lib/ /opt/huggingfound/lib/
# Every library must resolve here, or the build fails now rather than on a
# rented machine. The one exception is libcuda.so.1, the NVIDIA driver
# library, which only a machine with a GPU has and the host supplies.
RUN LD_LIBRARY_PATH=/opt/huggingfound/lib ldd /opt/huggingfound/bin/sd-server /opt/huggingfound/bin/sd-cli \
 && ! (LD_LIBRARY_PATH=/opt/huggingfound/lib ldd /opt/huggingfound/bin/sd-server /opt/huggingfound/bin/sd-cli | grep "not found" | grep -v "libcuda.so.1")
# Built from the repository root (docker build -f gpu/Dockerfile .) so the
# agent can take the folder-layout merge from src/ rather than a copy.
COPY gpu/agent.js gpu/start.sh src/convert.js /opt/huggingfound/
RUN chmod +x /opt/huggingfound/start.sh /opt/huggingfound/bin/sd-cli /opt/huggingfound/bin/sd-server

ENV PATH=/opt/node/bin:/opt/huggingfound/bin:$PATH \
    LD_LIBRARY_PATH=/opt/huggingfound/lib:$LD_LIBRARY_PATH \
    OLLAMA_HOST=0.0.0.0 \
    HF_AGENT_PORT=7860 \
    HF_MODELS_DIR=/root/.ollama/huggingfound/models \
    SD_SERVER=/opt/huggingfound/bin/sd-server

EXPOSE 11434 7860
ENTRYPOINT ["/bin/sh", "/opt/huggingfound/start.sh"]
