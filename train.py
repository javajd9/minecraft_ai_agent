from __future__ import annotations
"""
train.py — PPO training loop using Stable-Baselines3

Usage:
    python train.py

Prerequisites:
    1. Minecraft server running on localhost:25565 (flat world, no mobs)
    2. node server.js running in another terminal

Outputs:
    ./logs/         TensorBoard logs  (run: tensorboard --logdir ./logs)
    ./models/       Checkpoint files every 10,000 steps
    ./models/ppo_minecraft_final.zip   Final saved model
"""

import os
import glob
from collections import deque
from stable_baselines3 import PPO
from stable_baselines3.common.callbacks import CheckpointCallback, BaseCallback
from stable_baselines3.common.monitor import Monitor
from env import MinecraftEnv


import json

class ReadableStatsCallback(BaseCallback):
    """
    Beginner-friendly TensorBoard metrics, organized into 4 groups.
    Groups use '/' so TensorBoard shows them as collapsible folders:

      [1 - Score]         how well is the agent scoring?
      [2 - Survival]      is the agent staying alive longer?
      [3 - Exploration]   is the agent discovering the world?
      [4 - Training Speed] how fast is it training?
    """

    WORLD_MEMORY_FILE = os.path.join("logs", "world_memory.json")

    def __init__(self):
        super().__init__(verbose=0)
        self.episode_rewards = deque(maxlen=20)
        self.total_deaths    = 0
        self.total_episodes  = 0
        self.best_score      = float("-inf")
        self._current_ep_rew = 0.0
        self._session_blocks = 0

    def _read_lifetime_blocks(self) -> int:
        try:
            if os.path.exists(self.WORLD_MEMORY_FILE):
                data = json.loads(open(self.WORLD_MEMORY_FILE).read())
                return data.get("totalBlocksExplored", 0)
        except Exception:
            pass
        return 0

    def _on_step(self) -> bool:
        reward = float(self.locals["rewards"][0])
        self._current_ep_rew += reward

        done = self.locals["dones"][0]
        if done:
            info = self.locals["infos"][0]
            died = info.get("reason") == "death" or reward <= -4.0

            if died:
                self.total_deaths += 1
            self.total_episodes += 1

            ep_len = info.get("episode", {}).get("l", 0)
            self.episode_rewards.append(self._current_ep_rew)
            avg_score = sum(self.episode_rewards) / len(self.episode_rewards)
            self.best_score = max(self.best_score, self._current_ep_rew)

            # ── 1 - Score ────────────────────────────────────────────────────
            # Higher = better. Watch "Average" to see the trend.
            self.logger.record("1 - Score/Score This Episode",    round(self._current_ep_rew, 2))
            self.logger.record("1 - Score/Average Score (Last 20 Episodes)", round(avg_score, 2))
            self.logger.record("1 - Score/Best Score Ever",       round(self.best_score, 2))

            # ── 2 - Survival ─────────────────────────────────────────────────
            # Is the bot lasting longer before dying?
            self.logger.record("2 - Survival/Steps Survived This Episode", ep_len)
            self.logger.record("2 - Survival/Total Episodes Completed",    self.total_episodes)
            self.logger.record("2 - Survival/Total Deaths",                self.total_deaths)
            self.logger.record("2 - Survival/Survived Without Dying (1=yes 0=no)", 0 if died else 1)

            # ── 3 - Exploration ───────────────────────────────────────────────
            # Is the bot actually exploring and seeing new places?
            lifetime = self._read_lifetime_blocks()
            self.logger.record("3 - Exploration/New Places Found This Session", self._session_blocks)
            self.logger.record("3 - Exploration/Total Places Explored (All Time)", lifetime)

            self._current_ep_rew = 0.0

        # ── 4 - Training Speed ────────────────────────────────────────────────
        # How fast is the AI learning?
        self.logger.record("4 - Training Speed/Steps Per Second", 
                           self.model.logger.name_to_value.get("time/fps", 0))
        self.logger.record("4 - Training Speed/Total Steps Trained So Far", self.num_timesteps)

        return True


# ── Config ────────────────────────────────────────────────────────────────────

TOTAL_TIMESTEPS  = 500_000
N_STEPS          = 512       # rollout buffer size (steps before each PPO update)
BATCH_SIZE       = 64        # mini-batch size for gradient updates
N_EPOCHS         = 10        # PPO update epochs per rollout
LEARNING_RATE    = 3e-4
GAMMA            = 0.99
ENT_COEF         = 0.001     # reduced entropy → makes bot less "random" and aimless
CHECKPOINT_FREQ  = 10_000    # save a checkpoint every N steps
LOG_DIR          = "./logs"
MODEL_DIR        = "./models"

# ── Setup ─────────────────────────────────────────────────────────────────────

os.makedirs(LOG_DIR,   exist_ok=True)
os.makedirs(MODEL_DIR, exist_ok=True)

print("[Train] Initialising environment...")
env = Monitor(MinecraftEnv(), filename=os.path.join(LOG_DIR, "monitor"))


def find_latest_checkpoint(model_dir: str) -> str | None:
    """Return the path of the most recently saved checkpoint, or None."""
    checkpoints = glob.glob(os.path.join(model_dir, "ppo_minecraft_*_steps.zip"))
    if not checkpoints:
        return None
    # Sort by the step number embedded in the filename
    checkpoints.sort(key=lambda p: int(p.split("_steps")[0].split("_")[-1]))
    return checkpoints[-1]


latest = find_latest_checkpoint(MODEL_DIR)

if latest:
    print(f"[Train] Resuming from checkpoint: {latest}")
    model = PPO.load(
        latest,
        env             = env,
        tensorboard_log = LOG_DIR,
    )
else:
    print("[Train] No checkpoint found — starting fresh.")
    model = PPO(
        policy          = "MlpPolicy",
        env             = env,
        verbose         = 1,
        n_steps         = N_STEPS,
        batch_size      = BATCH_SIZE,
        n_epochs        = N_EPOCHS,
        learning_rate   = LEARNING_RATE,
        gamma           = GAMMA,
        ent_coef        = ENT_COEF,
        tensorboard_log = LOG_DIR,
    )

# Save a checkpoint every CHECKPOINT_FREQ steps
checkpoint_cb = CheckpointCallback(
    save_freq   = CHECKPOINT_FREQ,
    save_path   = MODEL_DIR,
    name_prefix = "ppo_minecraft",
    verbose     = 1,
)
readable_cb = ReadableStatsCallback()

# ── Training ──────────────────────────────────────────────────────────────────

print(f"[Train] Starting training for {TOTAL_TIMESTEPS:,} timesteps...")
print("[Train] Watch TensorBoard: tensorboard --logdir ./logs")
print()

model.learn(
    total_timesteps = TOTAL_TIMESTEPS,
    callback        = [checkpoint_cb, readable_cb],
)

# ── Save final model ──────────────────────────────────────────────────────────

final_path = os.path.join(MODEL_DIR, "ppo_minecraft_final")
model.save(final_path)
print(f"\n[Train] Training complete! Model saved to {final_path}.zip")

env.close()
