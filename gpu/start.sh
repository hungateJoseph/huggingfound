#!/bin/sh
# Starts what a rented HuggingFound machine runs: Ollama for chat models and
# the agent for image models, both reached from the person's browser through
# RunPod's proxy, or on Vast.ai through Cloudflare tunnels opened here. OLLAMA_HOST, OLLAMA_ORIGINS and HF_ORIGINS come from the
# pod's environment, set when HuggingFound rents the machine.
set -e
mkdir -p /root/.ollama/huggingfound/models /root/.ollama/huggingfound/addons /root/.ollama/huggingfound/hf-cache
# Encoders the Python side fetches by itself (a CLIP for the FaceID plus
# adapters, insightface's face models) stay on the persistent disk.
export HF_HOME=/root/.ollama/huggingfound/hf-cache
export INSIGHTFACE_HOME=/root/.ollama/huggingfound/hf-cache/insightface
ollama serve > /root/.ollama/huggingfound/ollama.log 2>&1 &
# On Vast.ai (HF_TUNNEL=1) there is no HTTPS proxy in front of the ports:
# a Cloudflare quick tunnel for each gives the browser an HTTPS address.
# A tunnel that drops is opened again, with a new address; the agent says
# the latest one on /health, where the site picks it up.
if [ "$HF_TUNNEL" = "1" ] && command -v cloudflared > /dev/null 2>&1; then
  for pair in ollama:11434 agent:7860; do
    name=${pair%%:*}
    port=${pair##*:}
    ( while true; do cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:$port" >> "${HF_TUNNEL_DIR:-/tmp}/hf-tunnel-$name.log" 2>&1; sleep 5; done ) &
  done
fi
exec node /opt/huggingfound/agent.js
