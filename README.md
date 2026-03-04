# 🧠 Minecraft AI — Reinforcement Learning System

A Minecraft reinforcement learning agent using **Mineflayer** (Node.js) as the environment body and **PPO via Stable-Baselines3** (Python) as the brain, connected by a WebSocket bridge.

```
Minecraft Server (flat world)
        │
   Mineflayer Bot (bot.js)   ← controls the player
        │
   WebSocket  (port 3001)    ← server.js bridges the gap
        │
   Python Gym Env (env.py)   ← standard Gymnasium interface
        │
   PPO Agent (train.py)      ← Stable-Baselines3 trains the brain
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | ≥ 18 | `node --version` |
| **npm** | ≥ 9 | comes with Node |
| **Python** | ≥ 3.10 | `python --version` |
| **pip** | latest | `pip --version` |
| **Minecraft Java Edition** | 1.21 recommended | Any version ≥ 1.16 works |

---

## Setup

### 1. Install Node.js dependencies
```powershell
cd c:\Users\shane\Desktop\minecraft_ai
npm install
```

### 2. Install Python dependencies
```powershell
pip install -r requirements.txt
```

---

## Running the System

> ⚠️ You must start components in order: Minecraft → Node server → Python trainer.

### Step 1 — Start a Minecraft Java server (or use Singleplayer LAN)

**Option A — Dedicated server (recommended)**
- Download [PaperMC](https://papermc.io/downloads) or the [official Minecraft server jar](https://www.minecraft.net/en-us/download/server)
- Create a `server.properties` with: `level-type=flat`, `online-mode=false`
- Run: `java -Xmx2G -jar server.jar nogui`

**Option B — Singleplayer LAN**
- Create a new flat world
- Open to LAN: `Escape → Open to LAN → Allow Cheats: ON → Start LAN World`
- Note the port it prints (usually `25565`); update `config.json` if different

### Step 2 — Start the WebSocket bridge
```powershell
# In Terminal 1
cd c:\Users\shane\Desktop\minecraft_ai
node server.js
```
Expected output:
```
[Server] Starting...
[Server] WebSocket listening on ws://localhost:3001
[Server] Connecting bot to Minecraft...
[Bot] Spawned at {"x":0,"y":64,"z":0}
[Server] Bot ready. Waiting for Python client...
```
You should also see a new player named `rl_agent` appear in your Minecraft world.

### Step 3 — Start training
```powershell
# In Terminal 2
cd c:\Users\shane\Desktop\minecraft_ai
python train.py
```
Expected output:
```
[Train] Initialising environment...
[Env] Connecting to ws://localhost:3001 ...
[Env] Connected.
[Train] Building PPO model...
[Train] Starting training for 500,000 timesteps...
```
PPO will then print rollout stats every 512 steps.

### Step 4 — (Optional) Monitor with TensorBoard
```powershell
# In Terminal 3
cd c:\Users\shane\Desktop\minecraft_ai
tensorboard --logdir ./logs
# Open http://localhost:6006 in your browser
```
Watch **`ep_rew_mean`** — it should climb as the agent learns to explore.

---

## Project Structure

```
minecraft_ai/
├── config.json       ← shared settings (ports, version, step timing)
├── package.json      ← Node.js project manifest
├── bot.js            ← Mineflayer bot: movement + observation builder
├── server.js         ← WebSocket server: reward logic + episode mgmt
├── requirements.txt  ← Python dependencies
├── env.py            ← Gymnasium environment wrapping the WebSocket
├── train.py          ← PPO training loop (Stable-Baselines3)
├── logs/             ← TensorBoard logs (created on first run)
└── models/           ← Saved checkpoints + final model (created on first run)
```

---

## Configuration (`config.json`)

| Key | Default | Description |
|-----|---------|-------------|
| `mcHost` | `localhost` | Minecraft server hostname |
| `mcPort` | `25565` | Minecraft server port |
| `mcVersion` | `1.21` | Minecraft protocol version |
| `wsPort` | `3001` | WebSocket server port |
| `stepMs` | `100` | Milliseconds per RL step |
| `maxSteps` | `2000` | Steps before episode truncation |
| `botUsername` | `rl_agent` | In-game player name |

---

## Observation & Action Space

### Observation vector (10 floats)
```
[x, y, z,             ← world position
 vx, vy, vz,          ← velocity (blocks/tick)
 onGround,            ← 1.0 if touching ground
 block_N, block_E, block_S]  ← nearby block type IDs (normalised)
```

### Actions (Discrete 4)
| ID | Action |
|----|--------|
| 0 | Move forward |
| 1 | Turn left + move forward |
| 2 | Turn right + move forward |
| 3 | Jump + move forward |

### Rewards
| Event | Reward |
|-------|--------|
| Alive per step | +0.01 |
| Visit new block | +0.10 |
| Death | -5.00 |
| Episode truncation | 0 |

---

## Troubleshooting

**Bot won't connect to Minecraft**
- Make sure `mcVersion` in `config.json` matches your server version exactly.
- For LAN, set `mcPort` to the port shown in chat (e.g. `53421`).

**Python can't connect to WebSocket**
- Make sure `node server.js` is running first.
- Check that nothing else is using port 3001.

**`mineflayer` module not found**
- Run `npm install` in the project directory.

**PPO training is very slow**
- Reduce `stepMs` in `config.json` to `50` for faster steps.
- Increase `N_STEPS` in `train.py` if you have more RAM.
