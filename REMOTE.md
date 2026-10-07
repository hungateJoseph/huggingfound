# Running big chat models on a rented GPU

Some models are too big for a laptop: a 70B model is a 40 GB file and wants
a 48 GB GPU. HuggingFound can keep its window on your computer and hand the
heavy part to another machine. With a **chat server** set in Settings, chat
models are downloaded and run on that machine; your computer only sends and
receives text.

The server is just [Ollama](https://ollama.com) on a machine with a GPU.
There are two ways to get one: let HuggingFound rent it for you, or set one
up yourself and connect to it through a tunnel.

## Let HuggingFound rent it

This works in the app on your computer and, signed in, on huggingfound.com.
On the site your browser talks to the rented machine directly, so what you
say to a model never passes through the site.

HuggingFound can rent the machine at [RunPod](https://www.runpod.io), a GPU
cloud that bills by the hour, and manage it for you: start it, point the
chat server at it, stop it when it sits idle, and delete it when you are
done. You pay RunPod; HuggingFound charges nothing and never sees your card.

1. Make a RunPod account and add some credit (ten dollars goes a long way;
   see the prices below).
2. In RunPod, on the **Credentials** page (Account, Credentials, API Keys), create a key with read and
   write access. It has to make and stop machines.
3. In HuggingFound's **Settings**, under **Rent a GPU by the hour**, paste
   the key and save. The sizes on offer appear with the price an hour of the
   cheapest card that is free right now:

   | Size | Model files up to about | Examples | Typical price |
   | --- | --- | --- | --- |
   | 24 GB | 17 GB | 30B-class models at 4-bit | $0.30 to $0.70 an hour |
   | 48 GB | 34 GB | 70B-class models at 4-bit | $0.40 to $1.20 an hour |
   | 80 GB | 57 GB | 100B-class models, or 70B at higher quality | $1.60 to $3 an hour |
   | 141 GB | 100 GB | the biggest open models | $3 to $4 an hour |

4. Pick a size and a disk for its models (50 GB unless you plan to keep
   several big ones), and click **Rent it**. Every chat model's window also
   offers this: two buttons at the top choose between your computer and a
   rented GPU, and choosing the GPU without one asks whether you have a
   RunPod key, takes it, and opens this section with the right size chosen.

The machine takes two to four minutes to start. Meanwhile:

- A bar under the header shows what is rented, the price an hour, how long
  it has run and roughly what that has cost, with **Stop** right there.
- Every chat model's card and window shows whether it fits the rented GPU.
- A model's window has one step, "Download the model on the chat server".
  The machine fetches it straight from Hugging Face at data-centre speed,
  and loads it into the GPU so the first message is quick.
- The chat box, the saved conversation and "Ask Claude to check this" work
  as before.

### Stopping, starting and deleting

- **Stop** ends the hourly charge. The disk and the models on it stay, for
  a small charge a day (RunPod lists it per gigabyte a month). **Start**
  brings the machine back in a minute or two with the models still there;
  if RunPod has no card of that kind free at that moment, try again later.
- **Delete machine and models** removes everything. Nothing is charged after
  that.
- The machine **stops by itself** after 30 minutes without a chat or a
  download. Change the minutes under the rented machine in Settings; 0
  keeps it running until you stop it. A download in progress always keeps
  it awake.
- **Quitting HuggingFound stops it** too (Ctrl+C in the terminal, or
  closing the terminal). Untick "Stop it when HuggingFound quits" to keep
  it running without the app, and remember it is billing.
- If HuggingFound is not running, nothing watches the machine. Check the
  bar when you come back, or the pods page at runpod.io.

### What to know

- Ollama on the machine answers at a long random address RunPod makes for
  it (the machine's id and the port, on RunPod's proxy). Only this
  computer knows it, it is never shown on the hosted site, and it goes
  when the machine is deleted. Anyone who learned it could use the GPU, so
  keep the settings file to yourself.
- Gated models, and ones that need a file downloaded by hand, cannot be
  fetched by the machine through HuggingFound; their window says so.
- Fit and speed go by the card's memory; speed is a rough guess for a
  modern NVIDIA card.
- The key and the machine's id are kept in HuggingFound's settings file on
  this computer, next to the other keys.

## Set one up yourself

Any provider that gives you a Linux machine with an NVIDIA GPU and SSH
access works too. The rest of this page connects one of those safely.

### 1. Rent a machine

RunPod, Lambda, Vast.ai and others bill by the hour while the machine is on.
Pick the GPU by the size of the model file, which HuggingFound shows on every
card:

| GPU memory | Model files up to about | Examples |
| --- | --- | --- |
| 24 GB | 20 GB | 30B-class models at 4-bit |
| 48 GB | 40 GB | 70B-class models at 4-bit |
| 80 GB | 70 GB | 100B-class models, or 70B at higher quality |

Give it a disk larger than the models you plan to keep, since they are stored
there. On providers with a separate persistent volume, point Ollama at it so
the models survive a restart, for example `export OLLAMA_MODELS=/workspace/ollama`
before starting Ollama.

### 2. Install Ollama on it

Connect with the SSH command the provider shows, then:

```sh
curl -fsSL https://ollama.com/install.sh | sh
```

That installs Ollama and starts it, listening only on the machine itself
(`127.0.0.1:11434`). Leave it that way. If the provider's image has no service
manager, start it by hand with `ollama serve &`.

### 3. Open a tunnel from your computer

Ollama has no password, so it should never be opened to the internet. An SSH
tunnel carries it to your computer privately. In a terminal on your computer:

```sh
ssh -N -L 11435:127.0.0.1:11434 user@your-server-address
```

Use the user, address and any `-p PORT` or `-i KEY` the provider gave you for
SSH. The command prints nothing and stays running; that is the tunnel. Port
11435 is used on your side so an Ollama on your own computer can keep 11434.

### 4. Point HuggingFound at it

In **Settings**, under **Chat server**:

- Address: `http://127.0.0.1:11435`
- GPU memory on that server: the number from step 1, for example `48`

Save. The line underneath says "Connected to Ollama" with its version when the
tunnel is up.

From then on:

- Every chat, coding, math and vision model shows whether it fits the
  server's GPU, and its speed there, instead of on your computer.
- A model's window has one step, "Download the model on the chat server". The
  server fetches it straight from Hugging Face.
- The chat box, the saved conversation and "Ask Claude to check this" work as
  before.
- "Scan this computer" lists what the server holds, marked "on the chat
  server", with Remove to free its disk.

Image and speech models are not affected; they still run on your computer, or
on the image server if you set one.

### 5. When you are done

- Close the tunnel with Ctrl+C. HuggingFound will say the server is not
  answering until you open it again.
- **Stop the machine at the provider** to stop the hourly charge. Most keep
  charging a little for the disk while it is stopped; delete the machine to
  stop that too, and the models go with it.
- "Use this computer" in Settings switches chat models back to your own
  machine. Nothing on the server is touched.

### A private network instead of a tunnel

If the server and your computer are on the same private network, such as
Tailscale, start Ollama with `OLLAMA_HOST=0.0.0.0` on the server and use its
private address in Settings, for example `http://100.101.102.103:11434`. Only
do this on a network you control; anyone who can reach that port can use the
GPU and delete the models.

### Limits

- Gated models and models that need a file downloaded by hand cannot be
  fetched by the server through HuggingFound; their window says so.
- Ollama does not report its hardware, so fit and speed go by the GPU memory
  you entered. Speed is a rough guess for a modern NVIDIA card.
