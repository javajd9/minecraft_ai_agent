from __future__ import annotations
"""
env.py — Gymnasium environment wrapping the WebSocket connection to the Mineflayer bot.

Observation space (10 floats):
  [x, y, z, vx, vy, vz, onGround, block_N, block_E, block_S]

Action space (4 discrete):
  0 = forward
  1 = turn left  (+ move forward)
  2 = turn right (+ move forward)
  3 = jump       (+ move forward)
"""

import json
import time
import threading
import numpy as np
import gymnasium as gym
from gymnasium import spaces
import websocket


# ── Constants ─────────────────────────────────────────────────────────────────

WS_URL       = "ws://localhost:3001"
OBS_DIM      = 15     # 3 pos + 3 vel + 1 ground + 4 compass + 3 forward-raycast + 1 stuck
ACT_DIM      = 4       # number of discrete actions
TIMEOUT_S    = 10.0    # seconds to wait for an observation before giving up
MAX_BLOCK_ID = 1000    # normalization divisor for block type IDs


# ── Environment ───────────────────────────────────────────────────────────────

class MinecraftEnv(gym.Env):
    """
    Thin Gymnasium wrapper around the Node.js Mineflayer WebSocket server.

    The server drives the bot; we just send actions and receive (obs, reward, done).
    """

    metadata = {"render_modes": []}

    def __init__(self, ws_url: str = WS_URL):
        super().__init__()
        self.ws_url = ws_url

        # Observation: bounded floats for position, velocity, onGround, 3 block IDs
        self.observation_space = spaces.Box(
            low=-np.inf,
            high=np.inf,
            shape=(OBS_DIM,),
            dtype=np.float32,
        )
        self.action_space = spaces.Discrete(ACT_DIM)

        self._ws = None  # websocket.WebSocket | None
        self._pending_obs: dict | None = None
        self._obs_event = threading.Event()
        self._lock = threading.Lock()
        self._connected = False

    # ── Connection helpers ────────────────────────────────────────────────

    def _connect(self):
        """Open a WebSocket connection (blocking until connected)."""
        print(f"[Env] Connecting to {self.ws_url} ...")
        for attempt in range(10):
            try:
                ws = websocket.WebSocket()
                ws.connect(self.ws_url)
                self._ws = ws
                self._connected = True
                # Start background receiver thread
                t = threading.Thread(target=self._recv_loop, daemon=True)
                t.start()
                print("[Env] Connected.")
                return
            except Exception as e:
                print(f"[Env] Connection attempt {attempt+1}/10 failed: {e}")
                time.sleep(2)
        raise ConnectionError(f"Could not connect to {self.ws_url} after 10 attempts.")

    def _recv_loop(self):
        """Background thread: read messages from the WebSocket and store them."""
        try:
            while self._connected:
                raw = self._ws.recv()
                if not raw:
                    break
                msg = json.loads(raw)
                if msg.get("type") == "obs":
                    with self._lock:
                        self._pending_obs = msg
                    self._obs_event.set()
        except Exception as e:
            print(f"[Env] Receiver thread exiting: {e}")
            self._connected = False
            self._obs_event.set()   # unblock any waiting step()

    def _send(self, data: dict):
        if self._ws and self._connected:
            self._ws.send(json.dumps(data))

    def _wait_for_obs(self) -> dict | None:
        """Block until an 'obs' message arrives or timeout."""
        self._obs_event.clear()
        got = self._obs_event.wait(timeout=TIMEOUT_S)
        if not got:
            print("[Env] Timed out waiting for observation.")
            return None
        with self._lock:
            obs = self._pending_obs
            self._pending_obs = None
        return obs

    # ── Gymnasium API ─────────────────────────────────────────────────────

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)

        if not self._connected:
            self._connect()

        self._send({"type": "reset"})
        msg = self._wait_for_obs()

        if msg is None:
            # Return a zero observation if we timed out
            obs_vec = np.zeros(OBS_DIM, dtype=np.float32)
            return obs_vec, {}

        obs_vec = self._encode_obs(msg["obs"])
        return obs_vec, {}

    def step(self, action: int):
        assert self.action_space.contains(action), f"Invalid action: {action}"

        self._send({"type": "action", "action": int(action)})
        msg = self._wait_for_obs()

        if msg is None:
            # Treat timeout as done
            obs_vec = np.zeros(OBS_DIM, dtype=np.float32)
            return obs_vec, -1.0, True, False, {"timeout": True}

        obs_vec  = self._encode_obs(msg["obs"])
        reward   = float(msg.get("reward", 0.0))
        done     = bool(msg.get("done", False))
        info     = msg.get("info", {})

        return obs_vec, reward, done, False, info

    def close(self):
        self._connected = False
        if self._ws:
            try:
                self._ws.close()
            except Exception:
                pass
            self._ws = None

    # ── Observation encoding ──────────────────────────────────────────────

    @staticmethod
    def _encode_obs(obs: dict) -> np.ndarray:
        """Convert the raw JSON observation into a flat 14-float32 vector."""
        pos  = obs.get("pos",          {"x": 0, "y": 0, "z": 0})
        vel  = obs.get("velocity",     {"x": 0, "y": 0, "z": 0})
        gnd  = float(obs.get("onGround", False))
        blks = obs.get("nearbyBlocks", [0, 0, 0, 0])
        fwd  = obs.get("forwardBlocks", [0, 0, 0])
        stk  = float(obs.get("isStuck", False))

        vec = np.array([
            pos["x"], pos["y"], pos["z"],         # 0-2  position
            vel["x"], vel["y"], vel["z"],         # 3-5  velocity
            gnd,                                  # 6    on ground
            blks[0] / MAX_BLOCK_ID,               # 7    block North
            blks[1] / MAX_BLOCK_ID,               # 8    block East
            blks[2] / MAX_BLOCK_ID,               # 9    block South
            blks[3] / MAX_BLOCK_ID,               # 10   block West
            float(fwd[0] > 0),                    # 11   wall 1 step ahead (0/1)
            float(fwd[1] > 0),                    # 12   wall 2 steps ahead (0/1)
            float(fwd[2] > 0),                    # 13   wall 3 steps ahead (0/1)
            stk,                                  # 14   stuck flag
        ], dtype=np.float32)

        return vec


# ── Quick smoke test ──────────────────────────────────────────────────────────

if __name__ == "__main__":
    env = MinecraftEnv()
    obs, info = env.reset()
    print("Reset obs:", obs)
    for _ in range(5):
        action = env.action_space.sample()
        obs, reward, done, truncated, info = env.step(action)
        print(f"  action={action}  reward={reward:.3f}  done={done}  obs={obs}")
        if done:
            obs, info = env.reset()
    env.close()
