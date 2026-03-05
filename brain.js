/**
 * brain.js — LLM Agent Brain for DIDDYBOT
 *
 * This is the "mind" of the agent. It runs on a 30-second thinking cycle,
 * reads recent game events + persistent memory, calls a local Ollama LLM,
 * and drives high-level behaviour:
 *
 *   - Speaks in Minecraft chat (personality, goals, reactions)
 *   - Maintains a persistent memory across restarts
 *   - Decides what task to do next (find wood, mine, seek shelter, etc.)
 *   - Calls game-action helpers on the bot (navigate, mine, attack, craft)
 *
 * Prerequisites:
 *   1. Install Ollama:  https://ollama.com
 *   2. Pull the model:  ollama pull llama3.2
 *   3. Start Ollama:    ollama serve   (it runs automatically on install on Windows)
 */

'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { pathfinder, Movements, goals: { GoalNear } } = require('mineflayer-pathfinder');
const Vec3 = require('vec3');
const { ReactiveNavigator } = require('./navigation');
const { formatVision } = require('./scanner');
const { ExperienceLog } = require('./experience');
const { StrategyEngine } = require('./strategy');
const { GameKnowledge } = require('./game_knowledge');
const { GoalTracker } = require('./goals');
const { SkillLibrary } = require('./skills');
const { SkillManager } = require('./skill_manager');
const { Curriculum } = require('./curriculum');

// ── Config ────────────────────────────────────────────────────────────────────

const OLLAMA_HOST = 'localhost';
const OLLAMA_PORT = 11434;
const OLLAMA_MODEL = 'llama3.1:8b';  // 8B model — smarter decisions (RTX 3060 12GB)
const OLLAMA_MODEL_TUNED = 'diddybot-tuned'; // Our fine-tuned version
const THINK_INTERVAL = 3000;     // 3s — bot is always acting, this just re-evaluates
const MEMORY_FILE = path.join(__dirname, 'logs', 'agent_memory.json');
const EVENTS_FILE = path.join(__dirname, 'logs', 'agent_events.jsonl');
const CHAT_FILE = path.join(__dirname, 'logs', 'chat_history.jsonl');
const WORLD_FILE = path.join(__dirname, 'logs', 'world_memory.json');

// ── Default memory shape ──────────────────────────────────────────────────────

const DEFAULT_MEMORY = {
    identity: 'I am DIDDYBOT, a Minecraft survival agent. I explore, gather, and build.',
    personality: 'Curious, cautious, friendly, resourceful. I think out loud and explain my actions.',
    currentGoal: 'Get a full set of wooden tools and build a shelter.',
    shortTermMemory: [],     // session-scoped tactical notes (cleared on restart)
    knownLocations: {},      // session-scoped coordinates (cleared on restart)
    gameplayKnowledge: [],   // PERSISTENT: map-independent facts the bot learns
    inventory: {},           // last-known inventory snapshot
    sessionCount: 0,
};

// ── Brain class ───────────────────────────────────────────────────────────────

class AgentBrain {
    constructor(bot, config) {
        this.bot = bot;
        this.config = config;
        this.memory = this._loadMemory();
        this.timer = null;
        this.busy = false;
        this.activeModel = OLLAMA_MODEL; // Default
        this.pendingReply = null;
        this.recentEvents = [];   // rolling log of notable events shown to LLM
        // Validate saved locations — delete corrupted ones (e.g., y=-57 underground)
        const locs = this.memory.knownLocations || {};
        for (const [key, coords] of Object.entries(locs)) {
            if (Array.isArray(coords) && (coords[1] < 0 || coords[1] > 320)) {
                console.warn(`[Brain] 🚨 Deleting invalid location "${key}" at y=${coords[1]}`);
                delete locs[key];
            }
        }
        this.experience = new ExperienceLog();  // outcome tracking
        this.strategy = new StrategyEngine();   // lesson aggregation
        this.curriculum = new Curriculum();     // mastery tracking & auto-curriculum
        this.gameKnowledge = null;  // initialized after bot spawns (needs registry)
        this.goals = new GoalTracker();          // tech tree progression
        this.skills = null;                      // initialized after bot spawns
        this.navigator = new ReactiveNavigator(bot);
        this.skillManager = null;  // initialized after bot spawns (needs navigator)

        // Task commitment — prevents flip-flopping between actions
        this._currentTask = null;      // { action, target, startedAt, lockedUntil }

        // Exploration memory — track which directions we've explored recently
        this._exploredDirs = {};  // { 'N': timestamp, 'NE': timestamp, ... }

        console.log('[Brain] Agent memory loaded.');
        console.log(`[Brain] Current goal: ${this.memory.currentGoal}`);
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    async start() {
        this.memory.sessionCount++;

        // ── Clear session-scoped data ────────────────────────────────────────
        // Coordinates become useless on map changes, so reset each session.
        // Only gameplayKnowledge, identity, personality, and sessionCount persist.
        this.memory.knownLocations = {};
        this.memory.shortTermMemory = [];
        this.memory.currentGoal = DEFAULT_MEMORY.currentGoal; // Reset goal to match updated milestones
        // Ensure gameplayKnowledge exists (older memory files won't have it)
        if (!Array.isArray(this.memory.gameplayKnowledge)) {
            this.memory.gameplayKnowledge = [];
        }
        // Reset world_memory.json — explored positions are session-scoped
        const WORLD_MEM = path.join(__dirname, 'logs', 'world_memory.json');
        try { if (fs.existsSync(WORLD_MEM)) fs.unlinkSync(WORLD_MEM); } catch { }
        console.log('[Brain] 🔄 Session data cleared (locations, short-term memory, world map)');
        console.log(`[Brain] 📚 ${this.memory.gameplayKnowledge.length} gameplay facts persisted from previous sessions`);
        this._saveMemory();

        // Check for fine-tuned model in Ollama
        this.activeModel = await this._probeModel();
        console.log(`[Brain] Using model: ${this.activeModel}`);

        // Initialize game knowledge and skills (needs bot.registry to be loaded)
        this.gameKnowledge = new GameKnowledge(this.bot);
        this.skills = new SkillLibrary(this.bot, this.gameKnowledge);

        // Load pathfinder plugin into the bot
        this.bot.loadPlugin(pathfinder);
        const movements = new Movements(this.bot);
        movements.allowSprinting = true;
        movements.canDig = true;
        movements.canOpenDoors = true;   // enter buildings, go through doors
        movements.allowFreeMotion = true;   // navigate inside structures
        movements.canSwim = true;   // cross water
        movements.maxDropDown = 4;   // don't jump off cliffs
        this.bot.pathfinder.setMovements(movements);
        // Increase path computation timeout (default 40ms is too low for complex terrain)
        this.bot.pathfinder.thinkTimeout = 5000;

        // Listen for chat
        this.bot.on('chat', (username, message) => {
            if (username === this.config.botUsername) return;
            this.pendingReply = { username, message };
            this._addEvent(`💬 ${username} said: "${message}"`);
            console.log(`[Brain] Heard: ${username}: "${message}" — will reply on next tick`);
        });

        // Track block breaks (gives LLM instant feedback on what it mined)
        this.bot.on('diggingCompleted', (block) => {
            this._addEvent(`🪓 Mined ${block.name} at [${Math.round(block.position.x)}, ${Math.round(block.position.y)}, ${Math.round(block.position.z)}]`);
        });

        // Track deaths for experience log
        this.bot.on('death', () => {
            this.experience.endAction('death', 'Bot died', this.bot);
            this._addEvent('💀 Died — lost items');
        });

        // Track item pickups — debounced to 1s to avoid slot-change spam
        let invDebounce = null;
        this.bot.inventory.on('updateSlot', () => {
            if (invDebounce) return;
            invDebounce = setTimeout(() => {
                invDebounce = null;
                const inv = this._readInventory();
                const items = Object.entries(inv).map(([k, v]) => `${k}×${v}`).join(', ');
                if (items) this._addEvent(`📦 Inventory now: ${items}`);
            }, 1000);
        });

        // Start the thinking loop
        this.timer = setInterval(() => this._think(), THINK_INTERVAL);
        console.log(`[Brain] Thinking every ${THINK_INTERVAL / 1000}s. Session #${this.memory.sessionCount}`);

        // First think after 8 seconds (let bot fully spawn)
        setTimeout(() => this._think(), 8000);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this._saveMemory();
        console.log('[Brain] Stopped. Memory saved.');
    }

    // ── Core think cycle ───────────────────────────────────────────────────────

    async _think() {
        if (this.busy) return;

        // If committed to a task, skip (unless health critical OR mob threat)
        if (this._currentTask && Date.now() < this._currentTask.lockedUntil) {
            const health = this.bot.health ?? 20;

            // Emergency 1: Health critical
            if (health < 6) {
                console.log(`[Brain] ⚠️ Health critical (${health}) — emergency survival!`);
                this._currentTask = null;
                this.busy = true;
                try {
                    const food = this.bot.inventory.items().find(i =>
                        i.name.includes('cooked_') || i.name === 'bread' || i.name === 'apple' || i.name === 'golden_apple'
                    );
                    if (food) {
                        console.log(`[Brain] 🍖 Emergency eating: ${food.name}`);
                        await this.bot.equip(food, 'hand');
                        await this.bot.consume();
                    } else {
                        console.log('[Brain] 🏃 No food — fleeing!');
                        await this._exploreRandomly();
                    }
                } catch (e) {
                    console.warn('[Brain] Emergency failed:', e.message);
                } finally { this.busy = false; }
                return;
            }

            // Emergency 2: Mob threat — break lock if hostile within 8 blocks
            if (!this.busy) {
                const { hostiles, closestDist } = this._assessThreat();
                if (hostiles.length > 0 && closestDist < 8) {
                    console.log(`[Brain] ⚠️ Mob threat (${hostiles[0].name} at ${Math.round(closestDist)}b) — breaking task lock!`);
                    this._currentTask = null;
                    // Fall through to normal think cycle below
                } else {
                    return; // Still locked, no threat
                }
            } else {
                return; // busy executing, can't interrupt
            }
        }

        if (this._currentTask) {
            console.log(`[Brain] 🔓 Task "${this._currentTask.action}" finished`);
            this._currentTask = null;
        }

        this.busy = true;

        try {
            // ── Check if we have a pending LLM decision ──────────────
            let action, target;

            // AUTO-THREAT: Check for nearby hostile mobs before anything else
            const threatResponse = this._fightOrFlight();
            if (threatResponse) {
                action = threatResponse.action;
                target = threatResponse.target;
                console.log(`[Brain] ${threatResponse.action === 'flee' ? '🏃' : '⚔️'} ${threatResponse.reason}`);
            } else if (this._pendingLLMAction) {
                // LLM has responded — use its decision
                action = this._pendingLLMAction.action;
                target = this._pendingLLMAction.target;
                console.log(`[Brain] 🧠 LLM decided: ${action}(${target})`);
                this._pendingLLMAction = null;
            } else {
                // No LLM response yet — use goal-driven action so the bot keeps moving
                const fallback = this._getGoalAction();
                if (fallback) {
                    action = fallback.action;
                    target = fallback.target || '';
                    console.log(`[Brain] 🎯 Goal action: ${action} — ${fallback.reason}`);
                } else {
                    action = 'explore';
                    target = '';
                }
            }

            // ── Fire LLM call in background (non-blocking) ───────────
            // The bot won't wait — it'll execute the action above NOW
            // and pick up the LLM's response on the NEXT tick.
            if (!this._llmInFlight) {
                this._llmInFlight = true;
                const context = this._buildContext();
                this._callOllama(context).then(async (response) => {
                    this._llmInFlight = false;
                    if (response) {
                        try {
                            const resp = typeof response === 'string' ? JSON.parse(response) : response;
                            // Store thought
                            if (resp.thought) console.log(`[Brain] 💭 ${resp.thought}`);
                            // Store chat
                            if (resp.chat && resp.chat.trim()) {
                                this.bot.chat(resp.chat.trim());
                            }
                            // Store memory
                            if (resp.memory && resp.memory.trim() && resp.memory.trim().split(/\s+/).length >= 4) {
                                const newMem = resp.memory.trim();
                                const coordTokens = newMem.split(/\s+/).filter(w => /^[-\d.,]+$/.test(w)).length;
                                if (coordTokens / newMem.split(/\s+/).length <= 0.4) {
                                    this.memory.shortTermMemory.push(`[${new Date().toLocaleTimeString()}] ${newMem}`);
                                    if (this.memory.shortTermMemory.length > 15) this.memory.shortTermMemory.shift();
                                }
                            }
                            // Store knowledge
                            if (resp.knowledge && resp.knowledge.trim().length > 10) {
                                const fact = resp.knowledge.trim();
                                const knowledge = this.memory.gameplayKnowledge || [];
                                const isDup = knowledge.some(e => {
                                    const ew = new Set(e.toLowerCase().split(/\s+/));
                                    const nw = fact.toLowerCase().split(/\s+/);
                                    return nw.filter(w => ew.has(w)).length / nw.length >= 0.7;
                                });
                                if (!isDup) {
                                    knowledge.push(fact);
                                    if (knowledge.length > 30) knowledge.shift();
                                    this.memory.gameplayKnowledge = knowledge;
                                    console.log(`[Brain] 📚 Learned: ${fact}`);
                                }
                            }
                            // Update goal
                            if (resp.goal) this.memory.currentGoal = resp.goal;
                            // Queue next action from LLM
                            if (resp.action) {
                                const rawAction = String(resp.action).split(/[\s|,]+/)[0].toLowerCase().trim();
                                this._pendingLLMAction = {
                                    action: rawAction,
                                    target: String(resp.action_target || '').trim(),
                                };
                            }
                            this._saveMemory();
                        } catch (e) {
                            console.warn('[Brain] LLM parse error:', e.message);
                        }
                    }
                }).catch(() => { this._llmInFlight = false; });
            }

            // ── Execute the action NOW (don't wait for LLM) ──────────
            this.experience.beginAction(action, target, this.bot);
            const invBefore = this._readInventory();

            const lockMs = { mine_wood: 25000, craft: 10000, explore: 15000, build_shelter: 40000, seek_food: 20000, attack_mob: 15000 }[action] || 10000;
            this._currentTask = { action, target, startedAt: Date.now(), lockedUntil: Date.now() + lockMs };
            console.log(`[Brain] ⚙️  Action: ${action} (🔒 ${lockMs / 1000}s)`);

            await this._executeAction(action, target);

            // Record outcome — compare inventory before/after
            const invAfter = this._readInventory();
            let result = 'success', detail = '';

            // Detect success/fail per action type
            const gained = {};
            for (const [k, v] of Object.entries(invAfter)) {
                const diff = v - (invBefore[k] || 0);
                if (diff > 0) gained[k] = diff;
            }
            const lost = {};
            for (const [k, v] of Object.entries(invBefore)) {
                const diff = v - (invAfter[k] || 0);
                if (diff > 0) lost[k] = diff;
            }

            // Check if mining actions actually gathered anything
            if (action.startsWith('mine_')) {
                const targetBlock = action.replace('mine_', '');
                const gotAnything = Object.keys(gained).length > 0;
                if (!gotAnything) { result = 'fail'; detail = `No ${targetBlock} gathered`; }
            }

            const exp = this.experience.endAction(result, detail, this.bot);
            if (exp) this.strategy.recordOutcome(action, result, exp.context);

            // Track mastery for curriculum
            this.curriculum.recordOutcome(action, result === 'success');

            // ── Lesson extraction — REAL learning from every action ──
            this._extractLesson(action, target, result, gained, lost, exp);

        } catch (err) {
            console.error('[Brain] Error:', err.message);
        } finally {
            this.busy = false;
        }
    }

    /**
     * Deterministic action selector based on current milestone.
     * Returns { action, target, reason } or null if all milestones done.
     */
    _getGoalAction() {
        const inv = this._readInventory();
        const eval_ = this.goals.evaluate(this.bot, inv, this.memory);
        const milestone = eval_.current;

        if (!milestone) return null; // all milestones done!

        // Count resources
        const logCount = Object.entries(inv).filter(([k]) => k.includes('_log')).reduce((s, [, v]) => s + v, 0);
        const plankCount = Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
        const stickCount = inv.stick || 0;
        const tableCount = inv.crafting_table || 0;
        const cobble = inv.cobblestone || 0;
        const coal = inv.coal || 0;
        const rawIron = inv.raw_iron || 0;
        const ironIngot = inv.iron_ingot || 0;
        const diamond = inv.diamond || 0;

        switch (milestone.id) {
            // ── PHASE 1: WOOD ──────────────────────────────
            case 'get_wood':
                return { action: 'mine_wood', target: 'log', reason: `Gathering wood (have ${logCount} logs, need 8)` };

            case 'craft_basics':
                if (logCount >= 1 && plankCount < 8)
                    return { action: 'craft', target: 'planks', reason: `Crafting planks (have ${plankCount}, need 8)` };
                if (plankCount >= 2 && stickCount < 4)
                    return { action: 'craft', target: 'stick', reason: `Crafting sticks (have ${stickCount}, need 4)` };
                return { action: 'mine_wood', target: 'log', reason: 'Need more logs for planks & sticks' };

            case 'crafting_table':
                if (plankCount >= 4)
                    return { action: 'craft', target: 'crafting_table', reason: 'Crafting table for tools' };
                if (logCount >= 1)
                    return { action: 'craft', target: 'planks', reason: 'Need planks for crafting table' };
                return { action: 'mine_wood', target: 'log', reason: 'Need wood for crafting table' };

            case 'full_wooden_tools':
                if (tableCount < 1 && plankCount >= 4)
                    return { action: 'craft', target: 'crafting_table', reason: 'Crafting table for tools' };
                if (!inv.wooden_pickaxe) return { action: 'craft', target: 'wooden_pickaxe', reason: 'Crafting wooden pickaxe' };
                if (!inv.wooden_axe) return { action: 'craft', target: 'wooden_axe', reason: 'Crafting wooden axe' };
                if (!inv.wooden_sword) return { action: 'craft', target: 'wooden_sword', reason: 'Crafting wooden sword' };
                if (!inv.wooden_shovel) return { action: 'craft', target: 'wooden_shovel', reason: 'Crafting wooden shovel' };
                if (plankCount < 4) return { action: 'craft', target: 'planks', reason: 'Need planks for tools' };
                if (stickCount < 2) return { action: 'craft', target: 'stick', reason: 'Need sticks for tools' };
                return { action: 'mine_wood', target: 'log', reason: 'Need more wood for tools' };

            // ── PHASE 2: STONE ─────────────────────────────
            case 'mine_stone':
                return { action: 'mine_stone', target: 'cobblestone', reason: `Mining cobblestone (have ${cobble}, need 16)` };

            case 'stone_tools':
                return { action: 'upgrade_tools', target: 'stone', reason: 'Upgrading to stone tools' };

            case 'build_shelter':
                if (cobble + plankCount < 20)
                    return { action: 'mine_stone', target: 'cobblestone', reason: 'Need more blocks for shelter' };
                return { action: 'build_shelter', target: '', reason: 'Building shelter' };

            // ── PHASE 3: COAL & TORCHES ────────────────────
            case 'mine_coal':
                return { action: 'mine_coal', target: 'coal_ore', reason: `Mining coal (have ${coal}, need 8)` };

            case 'craft_torches':
                if (coal >= 1 && stickCount >= 1)
                    return { action: 'craft', target: 'torch', reason: 'Crafting torches' };
                if (stickCount < 1)
                    return { action: 'craft', target: 'stick', reason: 'Need sticks for torches' };
                return { action: 'mine_coal', target: 'coal_ore', reason: 'Need coal for torches' };

            case 'furnace':
                if (cobble >= 8)
                    return { action: 'craft', target: 'furnace', reason: 'Crafting furnace' };
                return { action: 'mine_stone', target: 'cobblestone', reason: `Need cobblestone for furnace (have ${cobble}, need 8)` };

            case 'cook_food':
                return { action: 'smelt', target: 'food', reason: 'Cooking food in furnace' };

            // ── PHASE 4: IRON ──────────────────────────────
            case 'mine_iron':
                return { action: 'mine_iron', target: 'iron_ore', reason: `Mining iron ore (have ${rawIron + ironIngot}, need 12)` };

            case 'smelt_iron':
                return { action: 'smelt', target: 'raw_iron', reason: `Smelting iron (have ${rawIron} raw, ${ironIngot} ingots)` };

            case 'iron_tools':
                return { action: 'upgrade_tools', target: 'iron', reason: 'Crafting iron tools' };

            case 'iron_armor':
                if (ironIngot >= 24)
                    return { action: 'craft', target: 'iron_armor', reason: 'Crafting iron armor set' };
                return { action: 'mine_iron', target: 'iron_ore', reason: `Need more iron for armor (have ${ironIngot} ingots, need 24)` };

            case 'shield':
                if (ironIngot >= 1 && plankCount >= 6)
                    return { action: 'craft', target: 'shield', reason: 'Crafting shield' };
                if (ironIngot < 1)
                    return { action: 'mine_iron', target: 'iron_ore', reason: 'Need iron for shield' };
                return { action: 'mine_wood', target: 'log', reason: 'Need planks for shield' };

            case 'bucket':
                if (ironIngot >= 3)
                    return { action: 'craft', target: 'bucket', reason: 'Crafting bucket' };
                return { action: 'mine_iron', target: 'iron_ore', reason: 'Need iron for bucket' };

            // ── PHASE 5: FOOD ──────────────────────────────
            case 'get_seeds':
                return { action: 'seek_food', target: 'seeds', reason: 'Collecting wheat seeds' };

            case 'start_farm':
                return { action: 'use_skill', target: 'start a wheat farm near water', reason: 'Starting farm' };

            case 'bread':
                if (inv.wheat >= 3)
                    return { action: 'craft', target: 'bread', reason: 'Crafting bread' };
                return { action: 'use_skill', target: 'harvest wheat from farm', reason: 'Harvesting wheat for bread' };

            // ── PHASE 6: DIAMOND ───────────────────────────
            case 'mine_diamond':
                return { action: 'mine_diamond', target: 'diamond_ore', reason: `Mining diamonds at Y=11 (have ${diamond}, need 3)` };

            case 'diamond_tools':
                if (diamond >= 2 && stickCount >= 1)
                    return { action: 'craft', target: 'diamond_pickaxe', reason: 'Crafting diamond pickaxe' };
                if (diamond >= 2)
                    return { action: 'craft', target: 'diamond_sword', reason: 'Crafting diamond sword' };
                return { action: 'mine_diamond', target: 'diamond_ore', reason: 'Need more diamonds' };

            case 'enchanting_table':
                return { action: 'use_skill', target: 'craft an enchanting table', reason: 'Crafting enchanting table' };

            // ── PHASE 7-8: NETHER & END (all via SkillManager) ──
            default:
                // For advanced milestones, let the SkillManager handle it
                return {
                    action: 'use_skill',
                    target: milestone.description,
                    reason: `${milestone.name}: ${milestone.description}`
                };
        }
    }



    /** Triggers thinking soon, but not instantly (prevents infinite CPU loops) */
    thinkNextTick(delayMs = 200) {
        if (this._nextThink) clearTimeout(this._nextThink);
        this._nextThink = setTimeout(() => {
            if (!this.busy) this._think();
        }, delayMs);
    }

    // ── Context builder ────────────────────────────────────────────────────────

    _buildContext() {
        const pos = this.bot.entity?.position;
        const health = this.bot.health ?? '?';
        const food = this.bot.food ?? '?';
        const inventory = this._readInventory();
        const vision = formatVision(this.bot, this.recentEvents);

        // Update memory with latest inventory snapshot
        this.memory.inventory = inventory;

        const posStr = pos
            ? `x=${Math.round(pos.x)}, y=${Math.round(pos.y)}, z=${Math.round(pos.z)}`
            : 'unknown';

        const reply = this.pendingReply
            ? `\nIMPORTANT: ${this.pendingReply.username} just said: "${this.pendingReply.message}". Address them directly in your chat.`
            : '';
        this.pendingReply = null;

        return `You are ${this.config.botUsername}, a Minecraft survival agent.

IDENTITY: ${this.memory.identity}
PERSONALITY: ${this.memory.personality}

STATUS:
  Position: ${posStr} | Health: ${health}/20 | Food: ${food}/20
  Inventory: ${JSON.stringify(inventory)}
  Current goal: ${this.memory.currentGoal}
  Sessions: ${this.memory.sessionCount} | Lifetime blocks explored: ${this._readWorldStats().totalBlocks}

WHAT YOU NOTICED THIS SESSION:
${this.memory.shortTermMemory.slice(-6).map(m => '  ' + m).join('\n') || '  Nothing yet — just spawned.'}

SESSION DISCOVERIES: ${Object.keys(this.memory.knownLocations).length > 0 ? JSON.stringify(this.memory.knownLocations) : 'None yet — explore to find resources!'}

GAMEPLAY KNOWLEDGE (facts that work on ANY map):
${(this.memory.gameplayKnowledge || []).slice(-8).map(k => '  • ' + k).join('\n') || '  None yet — learn by playing!'}
${reply}

${vision}

SURVIVAL PROGRESSION (follow this tech tree — do the 👉 step):
${this.goals.getProgressForPrompt(this.bot, this._readInventory(), this.memory)}

RECENT EXPERIENCES:
${this.experience.getRecentForPrompt(5)}

LEARNED STRATEGIES:
${this.strategy.getLessonsForPrompt(3)}

SKILL MASTERY (how good you are at each action):
${this.curriculum.getMasteryForPrompt()}

AVAILABLE ACTIONS:
${this.skills.getSkillList().map(s => '  ' + s).join('\n')}
  use_skill      \u2014 write & run custom code for any task (action_target = task description)

SAVED SKILLS (reusable code):
${this.skillManager ? this.skillManager.getSkillList() : '  None yet.'}

YOUR TASK: Follow the SURVIVAL PROGRESSION above. Do the 👉 step.
Pick ONE action and commit to it fully. You will be locked in for 15-25 seconds.
If hungry (food < 14), eat first. If health < 10, flee or eat. At night, seek shelter or sleep.
If PATH OBSTRUCTIONS shows blocks in your way, mine through them before trying to move (equip the right tool first).

Respond with ONLY valid JSON:
{
  "thought": "<why you chose this action based on progression and what you see>",
  "chat": "",
  "goal": "<your current survival goal>",
  "memory": "<one tactical note about THIS session, or empty string>",
  "knowledge": "<one map-independent gameplay fact you learned, or empty string>",
  "action": "<one of the available actions listed above>",
  "action_target": "<for go_to_location: x,y,z. For mine_*: block name. Usually empty.>"
}`;
    }

    // ── Ollama API call ────────────────────────────────────────────────────────

    _callOllama(prompt) {
        return new Promise((resolve) => {
            const body = JSON.stringify({
                model: this.activeModel,
                prompt,
                format: 'json',   // forces valid JSON output every time — no more parse errors
                stream: false,
                options: { temperature: 0.7, num_predict: 200 },
            });

            const req = http.request({
                hostname: OLLAMA_HOST,
                port: OLLAMA_PORT,
                path: '/api/generate',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        resolve(parsed.response || null);
                    } catch {
                        resolve(null);
                    }
                });
            });

            req.on('error', () => resolve(null)); // Ollama not running — fail silently
            req.setTimeout(15000, () => { req.destroy(); resolve(null); }); // 15s — don't idle waiting
            req.write(body);
            req.end();
        });
    }

    // ── Response processor ────────────────────────────────────────────────────

    async _processResponse(rawText) {
        // Extract JSON from the LLM response (it might have surrounding text)
        const jsonMatch = rawText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.warn('[Brain] Could not find JSON in LLM response:', rawText.slice(0, 200));
            return;
        }

        let resp;
        try {
            resp = JSON.parse(jsonMatch[0]);
        } catch (e) {
            console.warn('[Brain] Invalid JSON from LLM:', e.message);
            return;
        }

        // ── Log internal thought (terminal only, never in-game chat) ─────────
        if (resp.thought) {
            console.log(`[Brain] 💭 ${resp.thought} `);
        }

        // ── Say something in chat (only when the bot has something real to say) ─
        const chatMsg = (resp.chat || '').trim();
        if (chatMsg && chatMsg.length > 2) {
            const msg = chatMsg.slice(0, 256);
            this.bot.chat(msg);
            console.log(`[Brain] 💬 "${msg}"`);

            // Log outgoing chat
            fs.appendFileSync(CHAT_FILE, JSON.stringify({
                t: new Date().toISOString(),
                type: 'outgoing',
                username: this.config.botUsername,
                message: msg,
            }) + '\n');
        }

        // ── Update goal ───────────────────────────────────────────────────────
        if (resp.goal && resp.goal !== this.memory.currentGoal) {
            console.log(`[Brain] 🎯 New goal: ${resp.goal} `);
            this.memory.currentGoal = resp.goal;
        }

        // ── Store memory (session-scoped, with dedup and coordinate filtering) ──
        if (resp.memory && resp.memory.trim()) {
            const newMem = resp.memory.trim();
            const newWords = newMem.toLowerCase().split(/\s+/);

            // Filter out coordinate-heavy memories (useless on map change)
            const coordTokens = newWords.filter(w => /^[-\d.,]+$/.test(w)).length;
            const isCoordHeavy = coordTokens / newWords.length > 0.4;
            if (isCoordHeavy) {
                console.log('[Brain] 🧠 Skipped coordinate-heavy memory');
            } else if (newWords.length >= 4) {
                // Filter stopwords before overlap comparison to avoid false duplicates
                const stopwords = new Set(['i', 'the', 'a', 'an', 'at', 'to', 'in', 'on', 'is', 'was', 'and', 'or', 'near', 'found', 'have', 'had', 'some', 'my', 'this', 'that']);
                const contentWords = newWords.filter(w => !stopwords.has(w) && w.length > 2);

                // Check overlap against last 5 memories (not just the last one)
                const recent = this.memory.shortTermMemory.slice(-5);
                const isDup = recent.some(old => {
                    const oldWords = old.toLowerCase().split(/\s+/).filter(w => !stopwords.has(w) && w.length > 2);
                    if (contentWords.length === 0 || oldWords.length === 0) return false;
                    const overlap = contentWords.filter(w => oldWords.includes(w)).length;
                    return overlap / contentWords.length >= 0.6;  // 60% overlap of content words
                });

                if (!isDup) {
                    this.memory.shortTermMemory.push(`[${new Date().toLocaleTimeString()}] ${newMem} `);
                    if (this.memory.shortTermMemory.length > 15) this.memory.shortTermMemory.shift();
                    console.log(`[Brain] 🧠 Remembered: ${newMem} `);
                } else {
                    console.log(`[Brain] 🧠 Skipped duplicate memory`);
                }
            }
        }

        // ── Store gameplay knowledge (persistent across sessions/maps) ────────
        if (resp.knowledge && resp.knowledge.trim() && resp.knowledge.trim().length > 10) {
            const fact = resp.knowledge.trim();
            const knowledge = this.memory.gameplayKnowledge || [];
            // Dedup: skip if very similar to existing knowledge
            const isDup = knowledge.some(existing => {
                const existWords = new Set(existing.toLowerCase().split(/\s+/));
                const newWords = fact.toLowerCase().split(/\s+/);
                const overlap = newWords.filter(w => existWords.has(w)).length;
                return overlap / newWords.length >= 0.7;
            });
            if (!isDup) {
                knowledge.push(fact);
                if (knowledge.length > 30) knowledge.shift(); // cap at 30 facts
                this.memory.gameplayKnowledge = knowledge;
                console.log(`[Brain] 📚 Learned: ${fact}`);
            }
        }


        // ── Record spawn position (refreshes each session) ───────────────────
        const pos = this.bot.entity?.position;
        if (pos && !this.memory.knownLocations['spawn']) {
            this.memory.knownLocations['spawn'] = [Math.round(pos.x), Math.round(pos.y), Math.round(pos.z)];
        }

        this._saveMemory();

        // ── Execute action (with inventory overrides — only for critical situations) ──
        // Sanitise: take first whitespace/pipe-delimited token only
        let rawAction = String(resp.action || 'explore').split(/[\s|,]+/)[0].toLowerCase().trim();
        const target = String(resp.action_target || '').trim();

        // Only override for CRAFT when we have logs and no tools — this is survival-critical
        const craftCooledDown = !this._craftCooldownUntil || Date.now() > this._craftCooldownUntil;
        const inv0 = this._readInventory();
        const logCount = ['oak', 'birch', 'spruce', 'jungle', 'acacia', 'dark_oak'].reduce((s, t) => s + (inv0[`${t}_log`] || 0), 0);
        const hasPickaxe = Object.keys(inv0).some(k => k.includes('_pickaxe'));
        const hasAxe = Object.keys(inv0).some(k => k.includes('_axe'));
        const hasSword = Object.keys(inv0).some(k => k.includes('_sword'));
        const toolsDone = hasPickaxe && hasAxe && hasSword;

        if (logCount >= 4 && !toolsDone && craftCooledDown) {
            console.log(`[Brain] 📦 Inventory override → craft(${logCount} logs, tools incomplete)`);
            rawAction = 'craft';
        }

        // Block LLM-chosen craft if on cooldown to prevent re-entering broken loops
        if (rawAction === 'craft' && !craftCooledDown) {
            console.log('[Brain] 🔨 Craft on cooldown — exploring instead');
            rawAction = 'explore';
        }

        // ── Task Commitment ─────────────────────────────────────────────────
        // Lock into this action for a minimum duration so we don't flip-flop
        const TASK_DURATIONS = {
            mine_wood: 30000,    // 30s — time to walk + mine a few logs
            mine_stone: 30000,
            mine_iron: 35000,
            seek_food: 30000,    // 30s — time to chase + kill an animal
            craft: 15000,        // 15s — crafting is quick
            explore: 25000,      // 25s — walk somewhere meaningful
            attack_mob: 20000,
            go_to_location: 25000,
            build_shelter: 45000,
            smelt: 30000,
            idle: 10000,
        };
        const lockDuration = TASK_DURATIONS[rawAction] || 10000;
        this._currentTask = {
            action: rawAction,
            target,
            startedAt: Date.now(),
            lockedUntil: Date.now() + lockDuration
        };

        console.log(`[Brain] ⚙️  Action: ${rawAction}${target ? ' → ' + target : ''} (🔒 locked for ${lockDuration / 1000}s)`);

        // Track action outcome
        this.experience.beginAction(rawAction, target, this.bot, this.memory.sessionCount);
        const invBefore = this._readInventory();
        const healthBefore = this.bot.health ?? 20;

        await this._executeAction(rawAction, target);

        // ── Honest Outcome Evaluation ────────────────────────────────────────
        // Wait a small amount for world state to settle (e.g. items to land in inv)
        await new Promise(r => setTimeout(r, 800));

        const invAfter = this._readInventory();
        const healthAfter = this.bot.health ?? 0;
        let result = 'success';
        let detail = `Completed ${rawAction} `;

        if (healthAfter <= 0) {
            result = 'death';
            detail = 'Died during action';
        } else if (healthAfter < healthBefore - 5) {
            result = 'fail';
            detail = 'Took significant damage';
        } else {
            // Action-specific success checks
            switch (rawAction) {
                case 'mine_wood':
                case 'mine_stone':
                case 'mine_iron': {
                    const logsBefore = Object.entries(invBefore).filter(([k]) => k.includes('log') || k.includes('stone') || k.includes('ore')).reduce((s, [, v]) => s + v, 0);
                    const logsAfter = Object.entries(invAfter).filter(([k]) => k.includes('log') || k.includes('stone') || k.includes('ore')).reduce((s, [, v]) => s + v, 0);
                    if (logsAfter <= logsBefore) {
                        result = 'fail';
                        detail = 'No resources gathered';
                    }
                    break;
                }
                case 'seek_food': {
                    const foodBefore = Object.entries(invBefore).filter(([k]) => k.includes('raw_') || k.includes('cooked_')).reduce((s, [, v]) => s + v, 0);
                    const foodAfter = Object.entries(invAfter).filter(([k]) => k.includes('raw_') || k.includes('cooked_')).reduce((s, [, v]) => s + v, 0);
                    if (foodAfter <= foodBefore) {
                        result = 'fail';
                        detail = 'No food gathered';
                    }
                    break;
                }
                case 'craft': {
                    const itemsBefore = Object.keys(invBefore).length;
                    const itemsAfter = Object.keys(invAfter).length;
                    // If target was auto, just check if anything was lost/gained
                    if (itemsAfter === itemsBefore && Object.keys(invBefore).every(k => invBefore[k] === invAfter[k])) {
                        result = 'fail';
                        detail = 'Crafting failed or no materials';
                    }
                    break;
                }
            }
        }

        const exp = this.experience.endAction(result, detail, this.bot);
        if (exp) {
            this.strategy.recordOutcome(rawAction, result, exp.context);
        }
    }

    // ── Action executor ────────────────────────────────────────────────────────

    async _executeAction(action, target) {
        this._stopMovement();
        try {
            switch (action) {
                // ── Original actions ──────────────────────────────
                case 'mine_wood': {
                    const woodTarget = (target && !target.match(/[-\d,\[\]]/)) ? target : 'log';
                    const mined = await this._mineNearestBlock(woodTarget, 64);
                    if (!mined) {
                        console.log('[Brain] 🪵 No wood nearby — exploring to find trees');
                        this._addEvent('🪵 No trees found nearby — exploring');
                        await this._exploreRandomly();
                    }
                    break;
                }
                case 'mine_stone':
                    await this._mineNearestBlock('stone', 32);
                    break;
                case 'mine_iron':
                    await this._mineNearestBlock('iron_ore', 32);
                    break;
                case 'mine_coal':
                    await this.skills.mineCoal();
                    break;
                case 'mine_diamond':
                    await this.skills.mineDiamond();
                    break;
                case 'seek_food': {
                    const foodTypes = ['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom'];
                    let food = null;
                    for (const candidate of this._findAllEntities(foodTypes)) {
                        const blockAt = this.bot.blockAt(candidate.position.offset(0, -1, 0));
                        if (blockAt && blockAt.name.includes('water')) continue;
                        food = candidate;
                        break;
                    }
                    if (food) {
                        console.log(`[Brain] 🥩 Chasing ${food.name}...`);
                        await this._huntEntity(food);
                    } else {
                        console.log('[Brain] No huntable food nearby — exploring');
                        this._exploreRandomly();
                    }
                    break;
                }
                case 'craft': {
                    const VALID_CRAFT = new Set(['planks', 'crafting_table', 'stick',
                        'wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel',
                        'stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace',
                        'torch', 'chest', 'auto']);
                    const craftTarget = VALID_CRAFT.has(target) ? target : 'auto';
                    await this._craftItem(craftTarget);
                    break;
                }
                case 'attack_mob': {
                    const hostiles = ['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch'];
                    const mob = this._findNearestEntity(hostiles);
                    if (mob) {
                        console.log(`[Brain] ⚔️ Fighting ${mob.name}...`);
                        await this._huntEntity(mob);
                    } else {
                        console.log('[Brain] No hostile mobs nearby');
                        this._exploreRandomly();
                    }
                    break;
                }
                case 'go_to_location': {
                    let cx, cy, cz;
                    try {
                        const parsed = JSON.parse(target);
                        if (Array.isArray(parsed)) [cx, cy, cz] = parsed;
                        else { cx = parsed.x; cy = parsed.y; cz = parsed.z; }
                    } catch {
                        const xm = target.match(/x[=:]?\s*(-?[\d.]+)/i);
                        const zm = target.match(/z[=:]?\s*(-?[\d.]+)/i);
                        const ym = target.match(/y[=:]?\s*(-?[\d.]+)/i);
                        if (xm && zm) { cx = +xm[1]; cz = +zm[1]; cy = ym ? +ym[1] : Math.round(this.bot.entity.position.y); }
                        else { const parts = target.split(',').map(s => parseFloat(s.replace(/[^\d.-]/g, '')));[cx, cy, cz] = parts; }
                    }
                    if (!isNaN(cx) && !isNaN(cz)) await this._navigateTo(cx, cy ?? this.bot.entity.position.y, cz, 3);
                    else this._exploreRandomly();
                    break;
                }

                // ── New skill-based actions ───────────────────────
                case 'eat':
                    await this.skills.eat();
                    break;
                case 'smelt':
                    await this.skills.smelt();
                    break;
                case 'build_shelter':
                    await this.skills.buildShelter();
                    if (this.bot.entity?.position) {
                        const p = this.bot.entity.position;
                        this.memory.knownLocations['shelter'] = [Math.round(p.x + 2), Math.round(p.y), Math.round(p.z + 2)];
                        this._saveMemory();
                    }
                    break;
                case 'place_torch':
                    await this.skills.placeTorch();
                    break;
                case 'sleep':
                    await this.skills.sleep();
                    break;
                case 'upgrade_tools':
                    await this.skills.upgradeTools();
                    break;
                case 'flee':
                    await this.skills.flee();
                    break;
                case 'store_items':
                    await this.skills.storeItems();
                    break;
                case 'equip_armor':
                    await this.skills.equipArmor();
                    break;

                case 'idle':
                    console.log('[Brain] 💤 Idling — observing surroundings');
                    this._stopMovement();
                    break;

                case 'use_skill': {
                    // Voyager-style: pass task description to skill manager
                    if (target && target.length > 3) {
                        if (!this.skillManager) {
                            this.skillManager = new SkillManager(
                                this.bot, this.navigator, this.activeModel,
                                this.memory.gameplayKnowledge || []
                            );
                        } else {
                            // Update knowledge on every call
                            this.skillManager.learnedKnowledge = this.memory.gameplayKnowledge || [];
                        }
                        const result = await this.skillManager.runTask(target);
                        if (result.success) {
                            this._addEvent(`✅ Skill completed: ${target}`);
                        } else {
                            this._addEvent(`❌ Skill failed: ${result.result}`);
                        }
                    }
                    break;
                }
                case 'explore':
                default:
                    await this._exploreRandomly();
                    break;
            }
        } catch (err) {
            console.warn(`[Brain] Action "${action}" failed:`, err.message);
        }
    }

    _stopMovement() {
        try { this.navigator.stop(); } catch { }
        try { if (this.bot.pathfinder?.isMoving()) this.bot.pathfinder.stop(); } catch { }
    }

    async _exploreRandomly() {
        const pos = this.bot.entity?.position;
        if (!pos) return;
        const { angle, label } = this._pickUnexploredDirection();
        const dist = 30 + Math.random() * 20;
        const tx = Math.round(pos.x + Math.cos(angle) * dist);
        const tz = Math.round(pos.z + Math.sin(angle) * dist);
        console.log(`[Brain] 🧭 Exploring ${label} (${Math.round(dist)}b)`);
        this._addEvent(`🧭 Explored ${label}`);
        this._exploredDirs[label] = Date.now();
        await this._navigateTo(tx, pos.y, tz, 5);
    }

    /**
     * Pick the least recently explored compass direction.
     * Tracks absolute positions to avoid revisiting the same areas.
     * Returns { angle (radians), label (string) }.
     */
    _pickUnexploredDirection() {
        const DIRS = [
            { label: 'N', angle: -Math.PI / 2 },
            { label: 'NE', angle: -Math.PI / 4 },
            { label: 'E', angle: 0 },
            { label: 'SE', angle: Math.PI / 4 },
            { label: 'S', angle: Math.PI / 2 },
            { label: 'SW', angle: 3 * Math.PI / 4 },
            { label: 'W', angle: Math.PI },
            { label: 'NW', angle: -3 * Math.PI / 4 },
        ];

        const now = Date.now();
        const EXPIRE_MS = 5 * 60 * 1000; // directions "expire" after 5 min

        // Clean up expired entries
        for (const key of Object.keys(this._exploredDirs)) {
            if (now - this._exploredDirs[key] > EXPIRE_MS) delete this._exploredDirs[key];
        }
        if (!this._exploredPositions) this._exploredPositions = [];
        this._exploredPositions = this._exploredPositions.filter(p => now - p.time < EXPIRE_MS);

        const pos = this.bot.entity?.position;

        // Score each direction — lower is better
        const scored = DIRS.map(dir => {
            let score = 0;

            // Penalize recently explored directions
            const lastExplored = this._exploredDirs[dir.label] || 0;
            if (lastExplored > 0) {
                score += 100 - Math.min(100, (now - lastExplored) / 1000); // 0-100 based on recency
            }

            // Penalize directions where we've already BEEN (absolute position check)
            if (pos) {
                const testDist = 40;
                const targetX = pos.x + Math.cos(dir.angle) * testDist;
                const targetZ = pos.z + Math.sin(dir.angle) * testDist;
                for (const visited of this._exploredPositions) {
                    const dx = targetX - visited.x;
                    const dz = targetZ - visited.z;
                    const distToVisited = Math.sqrt(dx * dx + dz * dz);
                    if (distToVisited < 30) {
                        score += 50; // already been near this target area
                    }
                }
            }

            // Heavily penalize the opposite of last explored direction (no back-and-forth)
            if (this._lastExploreDir) {
                const OPPOSITES = { N: 'S', S: 'N', E: 'W', W: 'E', NE: 'SW', SW: 'NE', NW: 'SE', SE: 'NW' };
                if (dir.label === OPPOSITES[this._lastExploreDir]) {
                    score += 200; // strongly avoid going back
                }
            }

            // Small random factor to break ties
            score += Math.random() * 10;

            return { ...dir, score };
        });

        // Pick the lowest-scored direction
        scored.sort((a, b) => a.score - b.score);
        const picked = scored[0];

        // Record this choice
        this._lastExploreDir = picked.label;
        if (pos) {
            const testDist = 40;
            this._exploredPositions.push({
                x: pos.x + Math.cos(picked.angle) * testDist,
                z: pos.z + Math.sin(picked.angle) * testDist,
                time: now,
            });
        }

        return picked;
    }

    // ── Game action helpers ────────────────────────────────────────────────────

    /**
     * Navigate to an entity and swing until it dies.
     * Re-chases if the entity flees. Gives up after maxSwings OR 10s timeout.
     */
    async _huntEntity(entityInfo, maxSwings = 20) {
        const mob = entityInfo.entity || entityInfo;
        const mobName = entityInfo.name || mob.name || 'unknown';
        const deadline = Date.now() + 15_000;

        // Equip best weapon first
        await this._equipBestWeapon();

        for (let i = 0; i < maxSwings; i++) {
            if (!mob.isValid) {
                this._addEvent(`☠️ Killed ${mobName}`);
                break;
            }
            if (Date.now() > deadline) {
                this._addEvent(`⏱️ Gave up chasing ${mobName}`);
                break;
            }

            // Check health mid-fight — flee if getting low
            if ((this.bot.health ?? 20) < 6) {
                console.log('[Brain] 🏃 Health critical mid-fight — fleeing!');
                this._addEvent(`🏃 Fled from ${mobName} (low HP)`);
                await this._fleeFrom(mob.position);
                return;
            }

            const dist = mob.position.distanceTo(this.bot.entity.position);
            if (dist > 4) {
                await this.navigator.goTo(mob.position, 2, 3000);
            }
            if (mob.isValid) {
                await this.bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0));
                this.bot.attack(mob);
            }
            await new Promise(r => setTimeout(r, 500)); // attack cooldown
        }
    }

    /**
     * Assess combat confidence: should we fight or flee?
     * Returns a score from 0 (run!) to 100 (easy fight).
     */
    _assessThreat() {
        const pos = this.bot.entity?.position;
        if (!pos) return { confidence: 50, hostiles: [], closestDist: Infinity };

        const HOSTILE_MOBS = new Set([
            'zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch',
            'drowned', 'husk', 'stray', 'phantom', 'pillager', 'vindicator',
            'zombie_villager', 'cave_spider', 'warden', 'wither_skeleton'
        ]);
        const DANGEROUS = new Set(['creeper', 'enderman', 'witch', 'warden', 'wither_skeleton']);

        // Find nearby hostiles
        const hostiles = Object.values(this.bot.entities)
            .filter(e => e !== this.bot.entity && e.position &&
                HOSTILE_MOBS.has(e.name?.toLowerCase()) &&
                e.position.distanceTo(pos) <= 16)
            .sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos));

        if (hostiles.length === 0) return { confidence: 100, hostiles: [], closestDist: Infinity };

        const closestDist = hostiles[0].position.distanceTo(pos);

        // Build confidence score
        let confidence = 50;

        // Health factor
        const health = this.bot.health ?? 20;
        confidence += (health - 10) * 3; // +30 at full health, -30 at 0

        // Food factor
        const food = this.bot.food ?? 20;
        if (food >= 14) confidence += 10;
        else if (food < 6) confidence -= 20;

        // Weapon factor
        const inv = this.bot.inventory.items();
        const hasSword = inv.some(i => i.name.includes('_sword'));
        const hasAxe = inv.some(i => i.name.includes('_axe'));
        const hasShield = inv.some(i => i.name === 'shield');
        if (hasSword) confidence += 20;
        else if (hasAxe) confidence += 10;
        if (hasShield) confidence += 10;

        // Armor factor
        const armorSlots = ['head', 'torso', 'legs', 'feet'];
        let armorPieces = 0;
        for (const slot of armorSlots) {
            try { if (this.bot.inventory.slots[this.bot.getEquipmentDestSlot(slot)]) armorPieces++; } catch { }
        }
        confidence += armorPieces * 8;

        // Enemy factor
        confidence -= (hostiles.length - 1) * 15; // multiple mobs = scary
        if (hostiles.some(e => DANGEROUS.has(e.name?.toLowerCase()))) confidence -= 25;
        if (hostiles.some(e => e.name === 'creeper') && closestDist < 5) confidence -= 30;

        return {
            confidence: Math.max(0, Math.min(100, confidence)),
            hostiles,
            closestDist: Math.round(closestDist),
        };
    }

    /**
     * Auto fight-or-flight. Returns { action, target, reason } or null if no threat.
     */
    _fightOrFlight() {
        const { confidence, hostiles, closestDist } = this._assessThreat();
        if (hostiles.length === 0) return null;

        const closest = hostiles[0];
        const mobName = closest.name || 'hostile';

        // Too far to care (> 12 blocks and not approaching)
        if (closestDist > 12) return null;

        // FLEE: low confidence or creeper very close
        if (confidence < 40 || (mobName === 'creeper' && closestDist < 6)) {
            return {
                action: 'flee',
                target: '',
                reason: `Fleeing from ${mobName} (confidence: ${confidence}%, dist: ${closestDist}b)`,
            };
        }

        // FIGHT: confident and mob is close
        if (confidence >= 40 && closestDist <= 10) {
            return {
                action: 'attack_mob',
                target: mobName,
                reason: `Fighting ${mobName} (confidence: ${confidence}%, dist: ${closestDist}b)`,
            };
        }

        return null; // not threatening enough to react
    }

    /**
     * Equip the best melee weapon from inventory.
     */
    async _equipBestWeapon() {
        const weapons = [
            'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
            'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
        ];
        for (const name of weapons) {
            const item = this.bot.inventory.items().find(i => i.name === name);
            if (item) {
                try {
                    await this.bot.equip(item, 'hand');
                    console.log(`[Brain] ⚔️ Equipped ${name}`);
                    return;
                } catch { }
            }
        }
    }

    /**
     * Run away from a position (opposite direction, sprint + jump).
     */
    async _fleeFrom(dangerPos) {
        const pos = this.bot.entity?.position;
        if (!pos || !dangerPos) return;

        // Run in the opposite direction
        const dx = pos.x - dangerPos.x;
        const dz = pos.z - dangerPos.z;
        const len = Math.sqrt(dx * dx + dz * dz) || 1;
        const fleeTarget = new Vec3(
            pos.x + (dx / len) * 30,
            pos.y,
            pos.z + (dz / len) * 30
        );

        console.log('[Brain] 🏃 Running away!');
        await this.navigator.goTo(fleeTarget, 5, 8000);
    }

    async _mineNearestBlock(blockNameFragment, maxDistance = 48, maxBlocks = 4) {
        let mined = 0;
        let botPos = this.bot.entity.position;

        // Check memory for a known source location first
        const knownKey = `${blockNameFragment}_source`;
        if (this.memory.knownLocations[knownKey] && mined === 0) {
            const [kx, ky, kz] = this.memory.knownLocations[knownKey];
            const knownPos = new Vec3(kx, ky, kz);
            const distToKnown = botPos.distanceTo(knownPos);
            if (distToKnown > maxDistance && distToKnown < 200) {
                console.log(`[Brain] 🗺️ Walking to remembered ${blockNameFragment} source at [${kx},${ky},${kz}] (${Math.round(distToKnown)}b away)`);
                await this._navigateTo(kx, ky, kz, 5);
                botPos = this.bot.entity.position;
            }
        }

        // Exploration loop: try to find blocks, explore further if none found
        const MAX_EXPLORE_ATTEMPTS = 3;

        for (let explore = 0; explore < MAX_EXPLORE_ATTEMPTS; explore++) {
            botPos = this.bot.entity.position;

            for (let i = mined; i < maxBlocks; i++) {
                const candidates = this.bot.findBlocks({
                    matching: b => b.name.includes(blockNameFragment),
                    maxDistance,
                    count: 20,
                }).filter(pos => Math.abs(pos.y - botPos.y) <= 6)
                    .sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos));

                if (candidates.length === 0) break; // no blocks here, go explore

                const blockPos = candidates[0];
                const block = this.bot.blockAt(blockPos);
                if (!block) break;

                if (mined === 0) {
                    console.log(`[Brain] 🪓 Found ${block.name} at ${blockPos} (${Math.round(blockPos.distanceTo(botPos))}b away)`);
                }

                await this._navigateTo(blockPos.x, blockPos.y, blockPos.z, 2);

                const freshBlock = this.bot.blockAt(blockPos);
                if (!freshBlock || !freshBlock.name.includes(blockNameFragment)) {
                    console.log(`[Brain] Block gone by the time we arrived`);
                    continue;
                }

                await this._equipBestTool(freshBlock);

                try {
                    await this.bot.lookAt(blockPos.offset(0.5, 0.5, 0.5));
                    await this.bot.dig(freshBlock);

                    // VERIFY the block is actually gone before claiming success
                    const verifyBlock = this.bot.blockAt(blockPos);
                    if (verifyBlock && verifyBlock.name === freshBlock.name) {
                        console.warn(`[Brain] ⚠️ dig() returned but block still there — skipping`);
                        continue;
                    }

                    mined++;
                    console.log(`[Brain] ✅ Mined ${freshBlock.name} (${mined}/${maxBlocks})`);

                    // Collect dropped items using entity tracking
                    await this._collectNearbyItems(blockPos, 6, 3000);
                } catch (e) {
                    console.warn(`[Brain] dig failed: ${e.message}`);
                    break;
                }
            }

            // Did we get enough?
            if (mined >= maxBlocks) break;

            // No blocks found — explore in an UNEXPLORED direction
            if (explore < MAX_EXPLORE_ATTEMPTS - 1) {
                const { angle, label } = this._pickUnexploredDirection();
                const dist = 35 + Math.random() * 25;
                const pos = this.bot.entity.position;
                const tx = Math.round(pos.x + Math.cos(angle) * dist);
                const tz = Math.round(pos.z + Math.sin(angle) * dist);
                console.log(`[Brain] 🔍 No "${blockNameFragment}" nearby — exploring ${label} ${Math.round(dist)}b (attempt ${explore + 2}/${MAX_EXPLORE_ATTEMPTS})`);
                this._addEvent(`🔍 Searched ${label} for ${blockNameFragment}`);
                this._exploredDirs[label] = Date.now();
                await this._navigateTo(tx, pos.y, tz, 5);
            }
        }

        if (mined > 0) {
            this._addEvent(`🪓 Mined ${mined}× ${blockNameFragment}`);
            const nearby = this.bot.findBlock({ matching: b => b.name.includes(blockNameFragment), maxDistance: 8 });
            if (nearby) {
                this.memory.knownLocations[knownKey] = [
                    Math.round(nearby.position.x),
                    Math.round(nearby.position.y),
                    Math.round(nearby.position.z),
                ];
            }
        } else {
            console.log(`[Brain] ❌ Couldn't find any "${blockNameFragment}" after ${MAX_EXPLORE_ATTEMPTS} exploration attempts`);
        }
        return mined;
    }

    /**
     * Collect nearby dropped items by tracking item entities.
     * Uses bot.entities to find actual dropped item positions instead of guessing.
     * @param {Vec3} searchCenter - Where to look for items (usually where block was mined)
     * @param {number} radius - Max distance to search for items (default 6)
     * @param {number} timeoutMs - Max time to spend collecting (default 3000)
     */
    async _collectNearbyItems(searchCenter, radius = 6, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        const pos = this.bot.entity?.position;
        if (!pos) return 0;

        // Wait a moment for items to spawn after block break
        await new Promise(r => setTimeout(r, 150));

        let collected = 0;
        const maxItems = 5; // don't chase too many items

        for (let attempt = 0; attempt < maxItems && Date.now() < deadline; attempt++) {
            // Find all dropped item entities near the search center
            const droppedItems = Object.values(this.bot.entities)
                .filter(e => {
                    if (!e || !e.position) return false;
                    // Dropped items: check name, displayName, entityType, or type
                    // In mineflayer, dropped items have name 'item' and metadata
                    if (e.name !== 'item' && e.displayName !== 'Item' &&
                        e.entityType !== 2 && e.type !== 'object') return false;
                    // Check if within radius of search center
                    const dist = e.position.distanceTo(searchCenter);
                    return dist <= radius;
                })
                .sort((a, b) => {
                    // Sort by distance to bot (pick up closest first)
                    const dA = a.position.distanceTo(this.bot.entity.position);
                    const dB = b.position.distanceTo(this.bot.entity.position);
                    return dA - dB;
                });

            if (droppedItems.length === 0) {
                // No items found — try waiting a bit in case they're still spawning
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }
                break;
            }

            const item = droppedItems[0];
            const itemDist = item.position.distanceTo(this.bot.entity.position);

            // If close enough, just wait for auto-pickup
            if (itemDist <= 2.5) {
                await new Promise(r => setTimeout(r, 300));
                collected++;
                continue;
            }

            // Walk to the item's actual position
            const itemName = item.metadata?.[8]?.itemId || item.displayName || 'item';
            console.log(`[Brain] 📥 Walking to dropped ${itemName} at [${Math.round(item.position.x)},${Math.round(item.position.y)},${Math.round(item.position.z)}] (${Math.round(itemDist)}b away)`);

            try {
                await this.navigator.goTo(item.position, 1.5, Math.min(3000, deadline - Date.now()));
                await new Promise(r => setTimeout(r, 300)); // wait for pickup
                collected++;
            } catch {
                // Item might have despawned or been picked up already
                break;
            }
        }

        if (collected > 0) {
            console.log(`[Brain] 📥 Collected ${collected} dropped item(s)`);
        }
        return collected;
    }



    /** Equip the best tool for breaking a block — uses game registry, zero hardcoding */
    async _equipBestTool(block) {
        try {
            const best = this.gameKnowledge?.getBestToolFor(block);
            if (best) {
                await this.bot.equip(best, 'hand');
            } else {
                // No correct tool — make sure we're not holding a non-tool item
                const held = this.bot.heldItem;
                if (held && !held.name.includes('_axe') && !held.name.includes('_pickaxe') &&
                    !held.name.includes('_sword') && !held.name.includes('_shovel')) {
                    // Holding something useless (like crafting_table) — drop to bare hand
                    try { await this.bot.unequip('hand'); } catch { }
                }
            }
        } catch { /* no tool available, use bare hand */ }
    }

    async _navigateTo(x, y, z, range = 2) {
        const target = new Vec3(x, y, z);
        const dist = this.bot.entity.position.distanceTo(target);

        // Use mineflayer-pathfinder A* for ALL distances — it pre-calculates
        // the full route and naturally avoids cliffs, water, lava
        if (this.bot.pathfinder) {
            try {
                const { GoalNear } = require('mineflayer-pathfinder').goals;
                this.bot.pathfinder.setGoal(new GoalNear(x, y, z, range));
                // Timeout scales with distance
                const timeoutMs = Math.min(Math.max(dist * 1000, 5000), 30000);
                await new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        try { this.bot.pathfinder.setGoal(null); } catch { }
                        resolve();
                    }, timeoutMs);
                    this.bot.once('goal_reached', () => { clearTimeout(timeout); resolve(); });
                    this.bot.once('path_update', (r) => {
                        if (r.status === 'noPath') { clearTimeout(timeout); resolve(); }
                    });
                });
                return;
            } catch (e) {
                console.warn(`[Brain] Pathfinder failed, using reactive: ${e.message}`);
            }
        }

        // Reactive navigator fallback only if pathfinder unavailable/failed
        await this.navigator.goTo(target, range, 30000);
    }

    /**
     * LESSON EXTRACTION — the bot's real learning mechanism.
     * After every action, analyze what happened and store useful knowledge.
     */
    _extractLesson(action, target, result, gained, lost, exp) {
        const lessons = [];
        const time = new Date().toLocaleTimeString();
        const pos = this.bot.entity?.position;
        const y = pos ? Math.round(pos.y) : '?';

        // What tool was equipped?
        const held = this.bot.heldItem?.name || 'bare_hands';

        // ── Mining lessons ───────────────────────────────
        if (action.startsWith('mine_')) {
            const resource = action.replace('mine_', '');
            if (result === 'success') {
                const items = Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ');
                if (items) {
                    lessons.push(`${action} at Y=${y}: gained ${items} (using ${held})`);
                }
            } else {
                lessons.push(`${action} failed at Y=${y} — resources may not be nearby, try exploring a new direction`);
            }
        }

        // ── Crafting lessons ─────────────────────────────
        if (action === 'craft') {
            const items = Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ');
            if (result === 'success' && items) {
                lessons.push(`Crafted: ${items}`);
            } else if (result === 'fail') {
                lessons.push(`craft(${target}) failed — may need more materials or a crafting table`);
            }
        }

        // ── Combat lessons ───────────────────────────────
        if (action === 'attack_mob') {
            if (result === 'success') {
                const drops = Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ');
                if (drops) lessons.push(`Killed ${target} — drops: ${drops}`);
            } else {
                lessons.push(`Fighting ${target} failed — need better gear or avoid this mob`);
            }
        }

        // ── Death lessons (highest priority) ─────────────
        if (exp?.context?.result === 'death' || this.bot.health <= 0) {
            lessons.push(`⚠️ DIED during ${action}! Avoid this situation or prepare better.`);
        }

        // ── Store lessons in permanent knowledge ─────────
        if (lessons.length > 0) {
            if (!this.memory.gameplayKnowledge) this.memory.gameplayKnowledge = [];

            for (const lesson of lessons) {
                const entry = `[${time}] ${lesson}`;
                this.memory.gameplayKnowledge.push(entry);
                console.log(`[Brain] 📝 Learned: ${lesson}`);
            }

            // Cap at 50 lessons — remove oldest
            if (this.memory.gameplayKnowledge.length > 50) {
                this.memory.gameplayKnowledge = this.memory.gameplayKnowledge.slice(-50);
            }

            // Also update strategy-generated lessons
            const stratLessons = this.strategy.getLessonsForPrompt(10);
            // Check for auto-generated rules not already in knowledge
            if (stratLessons && !stratLessons.includes('No advanced')) {
                const rules = stratLessons.split('\n').map(s => s.replace(/^\s*💡\s*/, '').trim()).filter(Boolean);
                for (const rule of rules) {
                    if (!this.memory.gameplayKnowledge.some(k => k.includes(rule))) {
                        this.memory.gameplayKnowledge.push(`[auto] ${rule}`);
                    }
                }
            }

            this._persistMemory();
        }

        // Update current goal to match milestone
        const eval_ = this.goals.evaluate(this.bot, this._readInventory(), this.memory);
        if (eval_.current) {
            this.memory.currentGoal = eval_.current.description;
        }
    }

    /**
     * Save memory to disk (debounced).
     */
    _persistMemory() {
        // Debounce — don't save more than once per 5 seconds
        if (this._saveTimer) return;
        this._saveTimer = setTimeout(() => {
            try {
                const fs = require('fs');
                fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.memory, null, 2));
            } catch (e) {
                console.warn('[Brain] Memory save failed:', e.message);
            }
            this._saveTimer = null;
        }, 5000);
    }

    /**
     * Full crafting chain: logs → planks → crafting_table → tools
     * All inventory-only recipes (planks, crafting_table) use the 2x2 grid (no table needed).
     * Tool recipes auto-place a crafting table if none is nearby.
     */
    async _craftItem(target, _depth = 0) {
        // Prevent infinite recursion (craft table → planks → craft table → ...)
        if (_depth > 3) {
            console.warn('[Brain] 🔨 Craft recursion limit reached — aborting');
            this._craftCooldownUntil = Date.now() + 30_000;
            return;
        }
        // ALWAYS read live inventory — memory snapshot may lag behind freshly crafted items
        const liveItems = () => this.bot.inventory.items();
        const liveCounts = () => {
            const counts = {};
            for (const item of liveItems()) counts[item.name] = (counts[item.name] || 0) + item.count;
            return counts;
        };
        const inv = liveCounts();

        // Detect what wood type we have — match planks to the actual log
        const logItem = liveItems().find(i => i.name.endsWith('_log'));
        const woodType = logItem ? logItem.name.replace('_log', '') : 'oak';

        // Auto mode: walk through the progression step by step
        if (target === 'auto') {
            // Count planks across all wood types
            const plankCount = Object.entries(inv).filter(([k]) => k.endsWith('_planks')).reduce((s, [, v]) => s + v, 0);
            const hasTableInInv = !!inv.crafting_table;
            const hasTableNearby = !!this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 32 });
            const hasTableInMemory = !!this.memory.knownLocations['crafting_table'];
            const hasTable = hasTableInInv || hasTableNearby || hasTableInMemory;
            const hasPickaxe = Object.keys(inv).some(k => k.includes('_pickaxe'));
            const hasAxe = Object.keys(inv).some(k => k.includes('_axe'));
            const hasSword = Object.keys(inv).some(k => k.includes('_sword'));

            if (!logItem && plankCount < 4) { console.log('[Brain] 🔨 Auto-craft: need logs first'); await this._mineNearestBlock('log', 64); return; }
            if (plankCount < 4) { target = 'planks'; }          // need 4 for crafting table
            else if (!hasTable && !inv.crafting_table) { target = 'crafting_table'; }
            else if (inv.crafting_table && !hasTableNearby) { /* have table in inventory, don't craft another */ }
            else if (plankCount < 6 && !hasPickaxe) { target = 'planks'; } // need planks for tools too
            else if (!hasPickaxe) { target = 'wooden_pickaxe'; }
            else if (!hasAxe) { target = 'wooden_axe'; }
            else if (!hasSword) { target = 'wooden_sword'; }
            else { console.log('[Brain] 🔨 All basic tools crafted!'); this._addEvent('✅ Full wooden toolset ready'); return; }
        }

        console.log(`[Brain] 🔨 Crafting: ${target} (wood type: ${woodType})`);

        // Resolve target to registry item name
        // Inventory-only items (2x2 grid — no crafting table needed)
        const inventoryOnly = new Set(['planks', 'crafting_table', 'stick']);
        // Items that NEED a crafting table (3x3 grid)
        const needsTableSet = new Set(['wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel', 'wooden_hoe', 'chest', 'furnace']);

        // Resolve the actual registry item name dynamically
        let itemName;
        if (target === 'planks') {
            itemName = `${woodType}_planks`;  // oak_planks, birch_planks, etc.
        } else if (target === 'crafting_table') {
            itemName = 'crafting_table';
        } else {
            itemName = target;  // wooden_pickaxe, wooden_axe, etc.
        }

        // Get or place crafting table if needed
        let craftingTableBlock = null;
        if (needsTableSet.has(target)) {
            // 1. Check nearby (32 blocks)
            craftingTableBlock = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 32 });

            // 2. If not nearby, check memory for a previously placed one and navigate to it
            if (!craftingTableBlock && this.memory.knownLocations['crafting_table']) {
                const [mx, my, mz] = this.memory.knownLocations['crafting_table'];
                console.log(`[Brain] 🔨 Navigating to remembered crafting table at [${mx}, ${my}, ${mz}]`);
                await this._navigateTo(mx, my, mz, 3).catch(() => { });
                await new Promise(r => setTimeout(r, 500));
                craftingTableBlock = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 8 });
                // If it's gone (broken/despawned), clear the memory
                if (!craftingTableBlock) {
                    console.log('[Brain] 🔨 Remembered table is gone — clearing memory');
                    delete this.memory.knownLocations['crafting_table'];
                    this._saveMemory();
                }
            }

            // 3. If still no table, craft and place one
            if (!craftingTableBlock) {
                // Craft table if not in live inventory
                if (!liveCounts().crafting_table) await this._craftItem('crafting_table', _depth + 1);

                // Place it BESIDE the bot
                const pos = this.bot.entity.position;
                const face = new Vec3(0, 1, 0);
                let placed = false;

                for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                    const floorPos = pos.offset(dx, -1, dz);
                    const targetPos = pos.offset(dx, 0, dz);
                    const floorBlock = this.bot.blockAt(floorPos);
                    const targetBlock = this.bot.blockAt(targetPos);

                    if (floorBlock && floorBlock.name !== 'air' &&
                        targetBlock && targetBlock.name === 'air') {
                        const ctItem = liveItems().find(i => i.name === 'crafting_table');
                        if (!ctItem) break;
                        try {
                            await this.bot.equip(ctItem, 'hand');
                            await this.bot.placeBlock(floorBlock, face);
                            await new Promise(r => setTimeout(r, 300));
                            craftingTableBlock = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 6 });
                            if (craftingTableBlock) {
                                // Remember where we placed it!
                                const cp = craftingTableBlock.position;
                                this.memory.knownLocations['crafting_table'] = [Math.round(cp.x), Math.round(cp.y), Math.round(cp.z)];
                                this._saveMemory();
                                console.log('[Brain] 🔨 Placed crafting table at', cp.toString(), '— remembered in memory');
                                placed = true;
                            }
                            break;
                        } catch { /* try next side */ }
                    }
                }

                if (!placed) {
                    craftingTableBlock = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 16 });
                    if (craftingTableBlock) {
                        const cp = craftingTableBlock.position;
                        this.memory.knownLocations['crafting_table'] = [Math.round(cp.x), Math.round(cp.y), Math.round(cp.z)];
                        this._saveMemory();
                        console.log('[Brain] 🔨 Found existing crafting table at', cp.toString(), '— remembered');
                    }
                }
            }
        }

        // Craft it
        try {
            const itemData = this.bot.registry.itemsByName[itemName];
            if (!itemData) { console.warn(`[Brain] Unknown item: ${itemName}`); return; }

            // Walk close to the crafting table before trying to use it
            if (craftingTableBlock && craftingTableBlock.position) {
                const dist = this.bot.entity.position.distanceTo(craftingTableBlock.position);
                if (dist > 2.5) {
                    await this._navigateTo(craftingTableBlock.position.x, craftingTableBlock.position.y, craftingTableBlock.position.z, 2);
                }
                // Re-acquire block reference after moving
                craftingTableBlock = this.bot.blockAt(craftingTableBlock.position);
            }

            const recipes = this.bot.recipesFor(itemData.id, null, 1, craftingTableBlock || null);
            if (!recipes || recipes.length === 0) {
                console.warn(`[Brain] No recipe for ${itemName}. Have: ${JSON.stringify(this._readInventory())}`);

                // Recovery: go get what's missing instead of looping
                if (target === 'planks') {
                    console.log('[Brain] 🔨 Recovery: need logs → mining wood');
                    this._mineNearestBlock('log', 64).catch(() => { });
                } else if (target === 'crafting_table') {
                    console.log('[Brain] 🔨 Recovery: need 4 planks → crafting planks first');
                    await this._craftItem('planks', _depth + 1);
                } else if (needsTableSet.has(target)) {
                    console.log('[Brain] 🔨 Recovery: need crafting table → crafting/placing one');
                    await this._craftItem('crafting_table', _depth + 1);
                } else {
                    // Unknown failure — go explore/mine to find materials
                    console.log('[Brain] 🔨 Recovery: unknown missing material → going to mine wood');
                    this._mineNearestBlock('log', 64).catch(() => { });
                }
                this._craftCooldownUntil = Date.now() + 30_000; // backoff 30s
                return;
            }

            // Determine how many to craft at once
            // Planks/sticks: craft ALL available at once (batch)
            // Tools/table: craft 1 (only need one)
            let craftCount = 1;
            if (target === 'planks') {
                // Each log → 4 planks. Craft as many as we have logs for.
                const logCount = liveItems().filter(i => i.name.includes('_log')).reduce((s, i) => s + i.count, 0);
                craftCount = Math.max(1, logCount);
            } else if (target === 'stick') {
                // Each 2 planks → 4 sticks. Cap sticks so we don't over-craft
                const currentSticks = liveItems().filter(i => i.name === 'stick').reduce((s, i) => s + i.count, 0);
                if (currentSticks >= 16) {
                    console.log(`[Brain] 🔨 Already have ${currentSticks} sticks — skipping`);
                    return;
                }
                const plankCount = liveItems().filter(i => i.name.includes('_planks')).reduce((s, i) => s + i.count, 0);
                craftCount = Math.min(Math.max(1, Math.floor(plankCount / 2)), 4); // cap at 4 batches (16 sticks)
            }

            // Validate we can actually craft this many
            const maxRecipes = this.bot.recipesFor(itemData.id, null, craftCount, craftingTableBlock || null);
            if (maxRecipes && maxRecipes.length > 0) {
                await this.bot.craft(maxRecipes[0], craftCount, craftingTableBlock || null);
                console.log(`[Brain] ✅ Crafted: ${craftCount}× ${itemName}`);
                this._addEvent(`🔨 Crafted ${craftCount}× ${itemName}`);
            } else {
                // Fall back to crafting 1
                await this.bot.craft(recipes[0], 1, craftingTableBlock || null);
                console.log(`[Brain] ✅ Crafted: 1× ${itemName}`);
                this._addEvent(`🔨 Crafted ${itemName}`);
            }
            this._lastCraftFailed = false;
        } catch (e) {
            console.warn(`[Brain] Craft error for ${itemName}: ${e.message}`);
            this._lastCraftFailed = true;
            this._craftCooldownUntil = Date.now() + 30_000; // backoff 30s after failure
        }
    }

    // Add a notable event to the rolling event log shown to the LLM
    _addEvent(msg) {
        const ts = new Date().toLocaleTimeString();
        this.recentEvents.push(`[${ts}] ${msg}`);
        if (this.recentEvents.length > 15) this.recentEvents.shift();
    }

    _findNearestEntity(typeNames) {
        const all = this._findAllEntities(typeNames);
        return all.length > 0 ? all[0] : null;
    }

    /** Return all matching entities sorted by distance (nearest first), 32-block cap. */
    _findAllEntities(typeNames) {
        const pos = this.bot.entity.position;
        const nameSet = new Set(typeNames.map(n => n.toLowerCase()));
        const results = [];

        for (const e of Object.values(this.bot.entities)) {
            if (e === this.bot.entity) continue;
            if (!e.position || !e.name) continue;
            if (!nameSet.has(e.name.toLowerCase())) continue;
            const dx = e.position.x - pos.x;
            const dz = e.position.z - pos.z;
            const dist = Math.sqrt(dx * dx + dz * dz);
            if (dist < 32) results.push({ entity: e, dist, name: e.name, position: e.position, isValid: e.isValid });
        }

        // Sort nearest first
        results.sort((a, b) => a.dist - b.dist);
        return results;
    }

    // ── Inventory reader ────────────────────────────────────────────────────────

    _readInventory() {
        const inv = {};
        if (!this.bot.inventory) return inv;
        for (const item of this.bot.inventory.items()) {
            inv[item.name] = (inv[item.name] || 0) + item.count;
        }
        return inv;
    }

    _readWorldStats() {
        // Cache for 30 seconds to avoid reading a large JSON file every tick
        if (this._worldStatsCache && Date.now() < this._worldStatsCacheExpiry) {
            return this._worldStatsCache;
        }
        try {
            if (!fs.existsSync(WORLD_FILE)) return { totalBlocks: 0 };
            const d = JSON.parse(fs.readFileSync(WORLD_FILE, 'utf8'));
            this._worldStatsCache = { totalBlocks: d.totalBlocksExplored || 0 };
            this._worldStatsCacheExpiry = Date.now() + 30_000;
            return this._worldStatsCache;
        } catch { return { totalBlocks: 0 }; }
    }

    // ── Memory persistence ─────────────────────────────────────────────────────

    _loadMemory() {
        try {
            if (fs.existsSync(MEMORY_FILE)) {
                return { ...DEFAULT_MEMORY, ...JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')) };
            }
        } catch (e) {
            console.warn('[Brain] Could not load memory, starting fresh:', e.message);
        }
        return { ...DEFAULT_MEMORY };
    }

    _saveMemory() {
        try {
            fs.writeFileSync(MEMORY_FILE, JSON.stringify(this.memory, null, 2));
        } catch (e) {
            console.error('[Brain] Could not save memory:', e.message);
        }
    }

    // Check if the fine-tuned model exists, otherwise return base model
    async _probeModel() {
        return new Promise((resolve) => {
            const http = require('http');
            const req = http.request({
                hostname: OLLAMA_HOST,
                port: OLLAMA_PORT,
                path: '/api/tags',
                method: 'GET'
            }, (res) => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        const names = (parsed.models || []).map(m => m.name.split(':')[0]);
                        if (names.includes(OLLAMA_MODEL_TUNED)) {
                            resolve(OLLAMA_MODEL_TUNED);
                        } else {
                            resolve(OLLAMA_MODEL);
                        }
                    } catch { resolve(OLLAMA_MODEL); }
                });
            });
            req.on('error', () => resolve(OLLAMA_MODEL));
            req.end();
        });
    }
}

module.exports = { AgentBrain };
