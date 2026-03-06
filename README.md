# 🧠 DIDDYBOT — Autonomous Minecraft AI Agent

An autonomous Minecraft survival agent powered by a **local LLM** (Ollama). DIDDYBOT perceives its world through an advanced environmental scanner, makes decisions via LLM reasoning, learns from every action it takes, and progressively masters Minecraft's full survival tech tree — from punching its first tree to crafting diamond gear.

> **What makes this different from a scripted bot?** DIDDYBOT uses a hybrid architecture: deterministic goal-driven behavior for reliability (pathfinding, inventory management, combat) with a local LLM layer for decision-making, planning, and in-game chat personality. It learns from its own successes and failures across sessions.

```
Minecraft Server (Java Edition 1.21)
        │
   Mineflayer Bot (bot.js)        ← controls the player in-game
        │
   AgentBrain (brain.js)          ← hybrid LLM + deterministic decision engine
   ├── Scanner (scanner.js)       ← 8-dir terrain analysis, mob tracking, resource radar
   ├── Navigator (navigation.js)  ← A* pathfinding + reactive movement fallback
   ├── RecipePlanner (planner.js) ← recursive dependency resolver (craft/mine/smelt)
   ├── SkillLibrary (skills.js)   ← 20+ reusable survival actions
   ├── GoalSystem (goals.js)      ← 50-milestone tech tree progression
   ├── Experience (experience.js) ← action timing, success rate tracking
   ├── Strategy (strategy.js)     ← aggregated gameplay lessons
   ├── Curriculum (curriculum.js) ← skill mastery tracking, auto-difficulty
   ├── GameKnowledge (game_knowledge.js) ← registry-driven tool/block knowledge
   ├── SkillManager (skill_manager.js)   ← Voyager-style LLM code generation
   └── Ollama (local LLM)        ← reasoning, planning, chat
```

---

## ✨ Features

### Intelligence
- 🧠 **LLM-Powered Reasoning** — local Ollama model (`llama3.1:8b`) for decision-making, planning, and natural chat
- 🔄 **Action Feedback Loop** — LLM sees exact results of its last action (success/fail, items gained/lost, duration) and self-corrects
- 📚 **Persistent Memory** — survives restarts: resource locations, gameplay knowledge, chest contents, home base
- 📈 **Self-Improving** — extracts lessons from every action, tracks mastery per skill, adjusts strategy over sessions

### Survival
- ⛏️ **Full Crafting System** — knows every vanilla recipe via `bot.recipesFor()`, smelting (80+ recipes), mining drops (800+ blocks from registry)
- 🎯 **50-Milestone Tech Tree** — Wood Age → Stone → Coal & Torches → Iron → Diamond → Enchanting → Nether → End
- 📦 **Chest Storage** — detects full inventory, crafts/places chests, remembers locations and contents, retrieves items later
- 🏠 **Home Base** — auto-sets home when building shelter or sleeping, returns home at night

### Combat & Survival
- ⚡ **Reactive Combat (2.5s)** — fast threat scanner interrupts any task when hostiles approach, auto-equips weapons, fights or flees based on confidence
- 🛡️ **Threat Assessment** — scores fight confidence based on health, food, weapons, armor, enemy type/count
- 🍖 **Auto-Eat & Auto-Armor** — eats when hungry, equips best armor automatically
- 🏃 **Smart Fleeing** — runs opposite direction from threats, sprints + jumps

### Perception
- 🔍 **8-Direction Terrain Scanner** — elevation classification, slope detection, cliff warnings
- 🗺️ **A* Pathfinding** — `mineflayer-pathfinder` with cliff avoidance, water swimming, door opening
- 🎯 **Resource Radar** — tracks nearby ores, wood, food animals, hostile mobs, dropped items
- 🧭 **Exploration System** — avoids revisiting areas, scores directions by recency and position history

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | ≥ 18 | `node --version` |
| **Ollama** | latest | [ollama.com](https://ollama.com) |
| **Minecraft Java Edition** | 1.21 | Any version ≥ 1.16 should work |

---

## Quick Start

### 1. Install dependencies
```bash
cd minecraft_ai
npm install
```

### 2. Start Ollama
```bash
ollama pull llama3.1:8b
ollama serve
```

### 3. Start Minecraft
- Create a new world → Open to LAN → Allow Cheats: ON → Start
- Note the port (update `config.json` if not `25565`)

### 4. Launch the agent
```bash
node server.js
```

The agent will immediately start playing — gathering wood, crafting tools, building shelter, and progressing through the tech tree.

---

## Project Structure

```
minecraft_ai/
├── config.json          ← server connection settings
├── server.js            ← WebSocket server, bot lifecycle, episode management
├── bot.js               ← Mineflayer bot setup (pathfinder, auto-eat, armor)
├── brain.js             ← core decision engine (LLM + deterministic hybrid)
├── scanner.js           ← environmental perception (terrain, mobs, resources)
├── navigation.js        ← reactive movement fallback (stuck detection, swimming)
├── planner.js           ← recursive recipe dependency resolver
├── skills.js            ← 20+ reusable survival skills (mine, craft, smelt, build...)
├── goals.js             ← 50-milestone progression system
├── game_knowledge.js    ← registry-driven tool/block knowledge (zero hardcoding)
├── experience.js        ← action timing and success rate tracking
├── strategy.js          ← aggregated lessons and strategy adjustment
├── curriculum.js        ← skill mastery tracking with auto-difficulty
├── skill_manager.js     ← Voyager-style LLM code generation for novel tasks
├── logger.js            ← structured logging (steps, episodes, deaths, chat)
├── agent_memory.json    ← persistent memory (auto-created)
├── train.py             ← PPO reinforcement learning training script
├── env.py               ← Gym environment wrapper for RL training
└── logs/                ← training logs, step data, episodes
```

---

## Configuration (`config.json`)

```json
{
  "mcHost": "localhost",
  "mcPort": 25565,
  "mcVersion": "1.21",
  "wsPort": 3001,
  "stepMs": 50,
  "maxSteps": 2000,
  "botUsername": "DIDDYBOT"
}
```

---

## Architecture

### Decision Loop (every 30 seconds)
```
1. Build Context    → scanner reads world, inventory, health, time
2. Threat Check     → reactive combat if hostiles < 8 blocks (2.5s fast-loop)
3. LLM Decision     → Ollama receives full context, returns action + reasoning
4. Goal Fallback    → if LLM is slow, use deterministic tech tree progression
5. Execute Action   → route to skill handler (mine, craft, explore, fight...)
6. Verify Result    → compare inventory before/after, detect false positives
7. Feedback Loop    → store result for next LLM prompt, extract lessons
```

### Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| LLM fires non-blocking | Bot keeps moving during 2-5s inference time |
| Craft verified by inventory diff | Prevents false positive reporting |
| Combat on 2.5s timer | 30s think cycle too slow for mob threats |
| Crafting checked before mining | Prevents mining dead bushes for sticks |
| Registry-driven knowledge | Zero hardcoded block/tool data — works with any MC version |
| Memory persists to disk | Agent remembers across restarts (home base, chest contents, lessons) |

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Bot won't connect | Ensure `mcVersion` matches your server exactly |
| Bot sits idle | Check Ollama is running: `ollama serve` |
| `mineflayer` not found | Run `npm install` |
| Bot dies constantly at night | Wait for it to build shelter — it learns to go home |

---

## License

MIT
