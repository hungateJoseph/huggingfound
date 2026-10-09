#!/bin/sh
# Starts what a rented HuggingFound machine runs: Ollama for chat models and
# the agent for image models, both reached from the person's browser through
# RunPod's proxy. OLLAMA_HOST, OLLAMA_ORIGINS and HF_ORIGINS come from the
# pod's environment, set when HuggingFound rents the machine.
set -e
mkdir -p /root/.ollama/huggingfound/models /root/.ollama/huggingfound/addons /root/.ollama/huggingfound/hf-cache
# Encoders the Python side fetches by itself (a CLIP for the FaceID plus
# adapters, insightface's face models) stay on the persistent disk.
export HF_HOME=/root/.ollama/huggingfound/hf-cache
export INSIGHTFACE_HOME=/root/.ollama/huggingfound/hf-cache/insightface
ollama serve > /root/.ollama/huggingfound/ollama.log 2>&1 &
exec node /opt/huggingfound/agent.js
