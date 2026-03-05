/**
 * bot.js — Mineflayer bot controller
 *
 * Provides:
 *   createBot(config)  → returns a bot instance with movement helpers
 *   bot.getObservation()  → structured observation object
 *   Movement: moveForward / turnLeft / turnRight / jump / stop
 */

'use strict';

const mineflayer = require('mineflayer');

// ── Mineflayer plugins ──────────────────────────────────────────────────────
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const autoEat = require('mineflayer-auto-eat').loader;
const armorManager = require('mineflayer-armor-manager');
const collectBlock = require('mineflayer-collectblock').plugin;
const toolPlugin = require('mineflayer-tool').plugin;

/**
 * Block IDs that are considered "interesting" for the observation vector.
 * We encode nearby block types as small integers.
 */
const AIR_ID = 0;

function createBot(config) {
  const bot = mineflayer.createBot({
    host: config.mcHost,
    port: config.mcPort,
    version: config.mcVersion,
    username: config.botUsername,
    auth: 'offline',
  });

  // ── Load plugins ──────────────────────────────────────────────────────
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(pvp);
  bot.loadPlugin(autoEat);
  bot.loadPlugin(armorManager);
  bot.loadPlugin(collectBlock);
  bot.loadPlugin(toolPlugin);

  // ── State tracking ────────────────────────────────────────────────────
  bot.visitedChunks = new Set();   // "chunk-key" strings for exploration reward
  bot.stepCount = 0;
  bot.isReady = false;
  bot.isDead = false;
  bot._currentAction = null;       // track what key is held down

  // ── Spawn / ready ─────────────────────────────────────────────────────
  bot.once('spawn', () => {
    bot.isReady = true;
    bot.isDead = false;
    console.log(`[Bot] Spawned at ${JSON.stringify(bot.entity.position)}`);

    // Configure pathfinder
    try {
      const mcData = require('minecraft-data')(bot.version);
      const movements = new Movements(bot, mcData);
      movements.allowSprinting = true;
      movements.canDig = true;
      movements.allow1by1towers = false;   // don't pillar up
      movements.allowFreeMotion = false;
      movements.scaffoldingBlocks = [];    // don't bridge
      bot.pathfinder.setMovements(movements);
      console.log('[Bot] ✅ Pathfinder configured');
    } catch (e) {
      console.warn('[Bot] Pathfinder init error:', e.message);
    }

    // Configure auto-eat: eat when food drops below 14
    try {
      bot.autoEat.options = {
        priority: 'foodPoints',
        startAt: 14,
        bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'],
      };
      bot.autoEat.enable();
      console.log('[Bot] ✅ Auto-eat enabled (triggers at 14 food)');
    } catch (e) {
      console.warn('[Bot] Auto-eat init error:', e.message);
    }

    // Armor manager auto-equips best armor
    try {
      if (bot.armorManager) {
        console.log('[Bot] ✅ Armor manager active');
      }
    } catch { }
  });

  bot.on('death', () => {
    bot.isDead = true;
    bot.isReady = false;
    console.log('[Bot] Died.');
    stopAll();
  });

  bot.on('respawn', () => {
    bot.isDead = false;
    bot.isReady = true;
    bot.stepCount = 0;
    console.log('[Bot] Respawned.');
  });

  bot.on('error', (err) => console.error('[Bot] Error:', err.message));
  bot.on('kicked', (reason) => console.warn('[Bot] Kicked:', reason));
  bot.on('end', () => console.log('[Bot] Connection ended.'));

  // ── Movement helpers ──────────────────────────────────────────────────

  function stopAll() {
    bot.clearControlStates();
    bot._currentAction = null;
  }

  function moveForward() {
    stopAll();
    bot.setControlState('forward', true);
    bot._currentAction = 'forward';
  }

  function turnLeft() {
    // Rotate the bot's yaw left (−15°) then walk forward
    stopAll();
    const yaw = bot.entity.yaw + (Math.PI / 12); // 15°
    bot.look(yaw, bot.entity.pitch, false);
    bot.setControlState('forward', true);
    bot._currentAction = 'left';
  }

  function turnRight() {
    stopAll();
    const yaw = bot.entity.yaw - (Math.PI / 12); // 15°
    bot.look(yaw, bot.entity.pitch, false);
    bot.setControlState('forward', true);
    bot._currentAction = 'right';
  }

  function jump() {
    stopAll();
    bot.setControlState('forward', true);
    bot.setControlState('jump', true);
    bot._currentAction = 'jump';
    // Auto-release jump after 200ms so we don't fly
    setTimeout(() => {
      bot.setControlState('jump', false);
    }, 200);
  }

  function stop() {
    stopAll();
  }

  // ── Observation builder ───────────────────────────────────────────────

  /**
   * Computes the unit forward vector from the bot's current yaw.
   * Mineflayer yaw: 0 = South, increasing counter-clockwise.
   */
  function getForwardVector() {
    const yaw = bot.entity.yaw;
    return { dx: -Math.sin(yaw), dz: -Math.cos(yaw) };
  }

  /**
   * Returns a plain JS object describing the current state.
   * The Python side converts this to a 14-float numeric vector.
   *
   * {
   *   pos:           {x, y, z}       — world coords
   *   velocity:      {x, y, z}       — blocks/tick
   *   onGround:      bool
   *   nearbyBlocks:  [id,id,id,id]   — N/E/S/W foot-level block IDs
   *   forwardBlocks: [b1, b2, b3]    — block IDs 1/2/3 steps in facing direction
   *   isStuck:       bool            — true if horizontal speed ≈ 0 while moving
   *   isNewBlock:    bool
   *   stepCount:     int
   * }
   */
  function getObservation() {
    const e = bot.entity;
    const pos = e.position;
    const vel = e.velocity;
    const fwd = getForwardVector();

    // ── Compass sensors (N / E / S / W at foot level) ─────────────────────
    const compassOffsets = [
      { dx: 0, dz: -1 },
      { dx: 1, dz: 0 },
      { dx: 0, dz: 1 },
      { dx: -1, dz: 0 },
    ];
    const nearbyBlocks = compassOffsets.map(({ dx, dz }) => {
      try {
        const block = bot.blockAt(pos.offset(dx, 0, dz));
        return block ? block.type : AIR_ID;
      } catch { return AIR_ID; }
    });

    // ── Forward raycast (1, 2, 3 blocks in facing direction) ──────────────
    const forwardBlocks = [1, 2, 3].map(dist => {
      try {
        const bx = Math.round(pos.x + fwd.dx * dist);
        const bz = Math.round(pos.z + fwd.dz * dist);
        const block = bot.blockAt(bot.vec3(bx, Math.floor(pos.y), bz));
        return block ? block.type : 0;
      } catch { return 0; }
    });

    // ── Stuck detection ────────────────────────────────────────────────────
    const horizSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
    const isStuck = horizSpeed < 0.02 && bot._currentAction === 'forward';

    // ── New-block exploration signal ───────────────────────────────────────
    const chunkKey = `${Math.floor(pos.x)},${Math.floor(pos.z)}`;
    const isNewBlock = !bot.visitedChunks.has(chunkKey);
    if (isNewBlock) bot.visitedChunks.add(chunkKey);

    return {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      velocity: { x: vel.x, y: vel.y, z: vel.z },
      onGround: e.onGround,
      nearbyBlocks,
      forwardBlocks,
      isStuck,
      isNewBlock,
      stepCount: bot.stepCount,
    };
  }


  // Attach helpers to bot object for external use
  bot.moveForward = moveForward;
  bot.turnLeft = turnLeft;
  bot.turnRight = turnRight;
  bot.jump = jump;
  bot.stop = stop;
  bot.getObservation = getObservation;

  return bot;
}

module.exports = { createBot, Movements, goals };
