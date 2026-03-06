/**
 * server.js — WebSocket server bridging Mineflayer bot ↔ Python PPO brain
 *
 * Protocol (JSON over WebSocket):
 *
 * Python → Node:
 *   { type: "reset" }
 *   { type: "action", action: 0|1|2|3 }   // 0=forward 1=left 2=right 3=jump
 *
 * Node → Python:
 *   { type: "obs", obs: {...}, reward: float, done: bool, info: {...} }
 *   { type: "ready" }   // sent once bot has spawned and episode can begin
 */

'use strict';

// ── Suppress known deprecation warnings from dependencies ─────────────────────
// MUST be before any require() calls to catch punycode warnings
process.noDeprecation = true;  // Suppresses DeprecationWarning output

const _origWarn = console.warn;
console.warn = (...args) => {
    const msg = args[0]?.toString?.() || '';
    if (msg.includes('physicTick')) return;        // mineflayer-pvp noise
    if (msg.includes('punycode')) return;           // Node.js internal noise
    _origWarn.apply(console, args);
};


const WebSocket = require('ws');
const { createBot } = require('./bot');
const config = require('./config.json');
const logger = require('./logger');
const { AgentBrain } = require('./brain');

// ── Suppress PartialReadError spam (protodef/MC 1.21 noise — non-fatal) ───────
process.on('uncaughtException', (err) => {
    if (err.name === 'PartialReadError') return; // silence protocol noise
    console.error('[Server] Uncaught:', err);
    process.exit(1);
});


// ── Bot lifecycle ─────────────────────────────────────────────────────────────

let bot = null;
let brain = null;   // LLM agent brain — started after bot spawns
let episodeActive = false;
let stepTimer = null;
let episodeCount = 0;
let episodeTotalReward = 0;


function spawnBot() {
    if (bot) {
        try { bot.quit(); } catch (_) { }
        bot = null;
    }

    console.log('[Server] Connecting bot to Minecraft...');
    bot = createBot(config);

    bot.once('spawn', () => {
        console.log('[Server] Bot ready. Waiting for Python client...');
        if (currentClient && currentClient.readyState === WebSocket.OPEN) {
            sendToClient(currentClient, { type: 'ready' });
        }

        // Start the LLM agent brain now that the bot is in the world
        if (brain) brain.stop();
        brain = new AgentBrain(bot, config);
        brain.start();
    });

    bot.on('death', () => {
        if (episodeActive && currentClient) {
            const obs = buildSafeObs();
            // Log the death before sending done signal
            logger.logDeath({
                pos: obs.pos,
                episode: episodeCount,
                stepCount: bot.stepCount,
                cause: 'unknown',
            });
            sendToClient(currentClient, {
                type: 'obs',
                obs,
                reward: -5.0,
                done: true,
                info: { reason: 'death' },
            });
            endEpisode();
        }
    });

    // Log incoming player chat for future LLM training
    bot.on('chat', (username, message) => {
        if (username === config.botUsername) return; // ignore own messages
        logger.logChat({
            type: 'incoming',
            username,
            message,
            episode: episodeCount,
            stepCount: bot ? bot.stepCount : 0,
        });
    });
}

// ── Reward & observation helpers ──────────────────────────────────────────────

function buildSafeObs() {
    if (!bot || !bot.isReady) {
        // Return a zero observation if bot isn't ready yet
        return {
            pos: { x: 0, y: 0, z: 0 },
            velocity: { x: 0, y: 0, z: 0 },
            onGround: false,
            nearbyBlocks: [0, 0, 0, 0],
            isNewBlock: false,
            stepCount: 0,
        };
    }
    return bot.getObservation();
}

function computeReward(obs, action) {
    let reward = 0.01; // alive bonus per step
    if (obs.isNewBlock) reward += 0.1;   // exploration bonus
    if (action === 3) reward -= 0.02;  // jump penalty
    if (obs.isStuck) reward -= 0.05;  // stuck penalty: don't press into walls
    return reward;
}

function executeAction(action) {
    if (!bot || !bot.isReady) return;
    switch (action) {
        case 0: bot.moveForward(); break;
        case 1: bot.turnLeft(); break;
        case 2: bot.turnRight(); break;
        case 3: bot.jump(); break;
        default: bot.stop();
    }
}

// ── Episode management ────────────────────────────────────────────────────────

function startEpisode(client) {
    episodeActive = true;
    episodeCount++;
    episodeTotalReward = 0;
    if (bot) {
        bot.stepCount = 0;
        bot.visitedChunks = new Set();
        bot.stop();
    }
    logger.logEpisode({ type: 'start', episode: episodeCount, stepCount: 0, totalReward: null });
    console.log(`[Server] Episode ${episodeCount} started.`);
}

function endEpisode() {
    logger.logEpisode({
        type: 'end',
        episode: episodeCount,
        stepCount: bot ? bot.stepCount : 0,
        totalReward: episodeTotalReward,
    });
    episodeActive = false;
    clearTimeout(stepTimer);
    if (bot) bot.stop();
    console.log(`[Server] Episode ${episodeCount} ended. Total reward: ${episodeTotalReward.toFixed(2)}`);
}

// ── WebSocket server ──────────────────────────────────────────────────────────

let currentClient = null;

const wss = new WebSocket.Server({ port: config.wsPort }, () => {
    console.log(`[Server] WebSocket listening on ws://localhost:${config.wsPort}`);
});

function sendToClient(client, data) {
    if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
    }
}

wss.on('connection', (ws) => {
    console.log('[Server] Python client connected.');
    currentClient = ws;

    // If bot is already ready, tell client immediately
    if (bot && bot.isReady) {
        sendToClient(ws, { type: 'ready' });
    }

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            console.error('[Server] Bad JSON from client:', raw.toString());
            return;
        }

        if (msg.type === 'reset') {
            handleReset(ws);
        } else if (msg.type === 'action') {
            handleAction(ws, msg.action);
        } else {
            console.warn('[Server] Unknown message type:', msg.type);
        }
    });

    ws.on('close', () => {
        console.log('[Server] Python client disconnected.');
        endEpisode();
        currentClient = null;
    });

    ws.on('error', (err) => {
        console.error('[Server] WS client error:', err.message);
    });
});

// ── Message handlers ──────────────────────────────────────────────────────────

function handleReset(client) {
    console.log('[Server] Reset received.');
    endEpisode();

    if (!bot || !bot.isReady) {
        // Bot not yet connected — spawn and wait
        spawnBot();
        bot.once('spawn', () => {
            startEpisode(client);
            const obs = buildSafeObs();
            sendToClient(client, {
                type: 'obs',
                obs,
                reward: 0,
                done: false,
                info: { reset: true },
            });
        });
    } else {
        // Respawn: teleport back to spawn
        try {
            bot.chat('/kill @s');
        } catch (_) { }

        setTimeout(() => {
            startEpisode(client);
            const obs = buildSafeObs();
            sendToClient(client, {
                type: 'obs',
                obs,
                reward: 0,
                done: false,
                info: { reset: true },
            });
        }, 1500); // wait for respawn
    }
}

function handleAction(client, action) {
    if (!episodeActive) return;

    executeAction(action);
    bot.stepCount++;

    setTimeout(() => {
        if (!episodeActive) return;

        const obs = buildSafeObs();
        const reward = computeReward(obs, action);
        const done = bot.isDead || obs.stepCount >= config.maxSteps;

        episodeTotalReward += reward;

        // Log this step to disk (smart filtering inside logStep)
        logger.logStep({
            pos: obs.pos,
            action,
            reward,
            stepCount: bot.stepCount,
            episode: episodeCount,
        });

        sendToClient(client, {
            type: 'obs',
            obs,
            reward,
            done,
            info: {},
        });

        if (done) endEpisode();
    }, config.stepMs);
}

// ── Boot ──────────────────────────────────────────────────────────────────────

console.log('[Server] Starting...');
spawnBot();
