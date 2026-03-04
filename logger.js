/**
 * logger.js — Structured event logger for LLM training data
 *
 * Writes three persistent log files:
 *
 *   logs/agent_events.jsonl  — one JSON object per line, every notable event
 *   logs/world_memory.json   — map of all explored positions (persists across runs)
 *   logs/chat_history.jsonl  — all chat messages in/out
 *
 * These files are the raw training material for a future LLM brain.
 * Every agent decision, discovery, death, and conversation is captured here.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, 'logs');
const EVENTS_FILE = path.join(LOG_DIR, 'agent_events.jsonl');
const WORLD_FILE = path.join(LOG_DIR, 'world_memory.json');
const CHAT_FILE = path.join(LOG_DIR, 'chat_history.jsonl');

// Ensure logs directory exists
fs.mkdirSync(LOG_DIR, { recursive: true });

// ── World memory: persists explored positions across sessions ─────────────────

let worldMemory = {
    exploredPositions: {},   // "x,z" → { firstVisited, visitCount, y }
    totalBlocksExplored: 0,
    sessions: 0,
};

// Load existing world memory if it exists
if (fs.existsSync(WORLD_FILE)) {
    try {
        worldMemory = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
        console.log(`[Logger] Loaded world memory: ${worldMemory.totalBlocksExplored} blocks explored across ${worldMemory.sessions} sessions`);
    } catch (e) {
        console.warn('[Logger] Could not parse world_memory.json, starting fresh.');
    }
}

worldMemory.sessions++;

function saveWorldMemory() {
    fs.writeFileSync(WORLD_FILE, JSON.stringify(worldMemory, null, 2));
}

// ── Core logging function ─────────────────────────────────────────────────────

function writeEvent(type, data) {
    const entry = {
        t: new Date().toISOString(),  // timestamp
        type,
        ...data,
    };
    fs.appendFileSync(EVENTS_FILE, JSON.stringify(entry) + '\n');
    return entry;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called every RL step. Logs position and tracks world exploration.
 * Returns { isNewBlock, lifetimeBlockCount } for use in rewards.
 */
function logStep({ pos, action, reward, stepCount, episode }) {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.z)}`;
    let isNewLifetimeBlock = false;

    if (!worldMemory.exploredPositions[key]) {
        worldMemory.exploredPositions[key] = {
            firstVisited: new Date().toISOString(),
            visitCount: 1,
            y: Math.floor(pos.y),
        };
        worldMemory.totalBlocksExplored++;
        isNewLifetimeBlock = true;

        // Cap at 50K positions — prune oldest 10K when exceeded
        const posKeys = Object.keys(worldMemory.exploredPositions);
        if (posKeys.length > 50000) {
            const sorted = posKeys.sort((a, b) =>
                worldMemory.exploredPositions[a].firstVisited.localeCompare(worldMemory.exploredPositions[b].firstVisited)
            );
            for (let i = 0; i < 10000; i++) delete worldMemory.exploredPositions[sorted[i]];
            console.log('[Logger] Pruned 10K oldest positions from world memory');
        }

        // Throttle saves — every 50 new blocks instead of every single one
        if (worldMemory.totalBlocksExplored % 50 === 0) saveWorldMemory();
    } else {
        worldMemory.exploredPositions[key].visitCount++;
    }

    // Only write to event log on notable steps (new block or every 100 steps)
    if (isNewLifetimeBlock || stepCount % 100 === 0) {
        writeEvent('step', {
            episode,
            step: stepCount,
            action,
            reward,
            pos: { x: Math.round(pos.x, 2), y: Math.round(pos.y, 2), z: Math.round(pos.z, 2) },
            newBlock: isNewLifetimeBlock,
            totalBlocksExplored: worldMemory.totalBlocksExplored,
        });
    }

    return {
        isNewLifetimeBlock,
        totalBlocksExplored: worldMemory.totalBlocksExplored,
    };
}

/**
 * Log a death event — important signal for future LLM training.
 */
function logDeath({ pos, episode, stepCount, cause = 'unknown' }) {
    const entry = writeEvent('death', {
        episode,
        step: stepCount,
        pos,
        cause,
        blocksExploredThisRun: worldMemory.totalBlocksExplored,
    });
    console.log(`[Logger] ☠️  Death logged at step ${stepCount} (episode ${episode})`);
    return entry;
}

/**
 * Log episode start/end — useful for training session analysis.
 */
function logEpisode({ type, episode, stepCount, totalReward }) {
    writeEvent(`episode_${type}`, {
        episode,
        step: stepCount,
        totalReward: totalReward != null ? Math.round(totalReward * 100) / 100 : null,
        totalBlocksExplored: worldMemory.totalBlocksExplored,
    });
}

/**
 * Log chat messages — the raw material for future agent-to-agent communication.
 * type: 'incoming' (from players) | 'outgoing' (bot talking)
 */
function logChat({ type, username, message, episode, stepCount }) {
    const entry = {
        t: new Date().toISOString(),
        type,
        username,
        message,
        episode,
        step: stepCount,
    };
    fs.appendFileSync(CHAT_FILE, JSON.stringify(entry) + '\n');

    if (type === 'incoming') {
        console.log(`[Logger] 💬 Chat from ${username}: "${message}"`);
    }
}

/**
 * Log a discovery — named notable events (useful for LLM memory summaries).
 */
function logDiscovery({ name, description, pos, episode }) {
    writeEvent('discovery', { name, description, pos, episode });
    console.log(`[Logger] 🔍 Discovery: ${name} — ${description}`);
}

module.exports = {
    logStep,
    logDeath,
    logEpisode,
    logChat,
    logDiscovery,
    worldMemory: () => worldMemory,
};
