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
const { RecipePlanner } = require('./planner');

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
        this.planner = null;       // initialized after bot spawns (needs registry)

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
        this.planner = new RecipePlanner(this.bot);

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

            const lockMs = { mine_wood: 120000, mine_stone: 120000, mine_iron: 120000, mine_coal: 60000, mine_diamond: 60000, craft: 15000, explore: 30000, build_shelter: 60000, seek_food: 30000, attack_mob: 20000 }[action] || 15000;
            this._currentTask = { action, target, startedAt: Date.now(), lockedUntil: Date.now() + lockMs };
            console.log(`[Brain] ⚙️  Action: ${action} (🔒 ${lockMs / 1000}s)`);

            await this._executeAction(action, target);

            // ── Action finished — clear the lock so we can think again ──
            this._currentTask = null;


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
     * Smart action selector — uses RecipePlanner for craftable/minable goals,
     * falls back to skills for non-plannable milestones.
     * Returns { action, target, reason } or null if all milestones done.
     */
    _getGoalAction() {
        const inv = this._readInventory();
        const eval_ = this.goals.evaluate(this.bot, inv, this.memory);
        const milestone = eval_.current;

        if (!milestone) return null; // all milestones done!

        // ── Non-plannable milestones: use skills/SkillManager directly ──
        const SKILL_MILESTONES = {
            'build_shelter': () => {
                const cobble = inv.cobblestone || 0;
                const planks = Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
                if (cobble + planks < 20)
                    return { action: 'mine_stone', target: 'cobblestone', reason: 'Need more blocks for shelter' };
                return { action: 'build_shelter', target: '', reason: 'Building shelter' };
            },
            'cook_food': () => ({ action: 'smelt', target: 'food', reason: 'Cooking food in furnace' }),
            'get_seeds': () => ({ action: 'seek_food', target: 'seeds', reason: 'Collecting wheat seeds' }),
            'start_farm': () => ({ action: 'use_skill', target: 'start a wheat farm near water', reason: 'Starting farm' }),
            'bread': () => {
                if (inv.wheat >= 3)
                    return { action: 'craft', target: 'bread', reason: 'Crafting bread' };
                return { action: 'use_skill', target: 'harvest wheat from farm', reason: 'Harvesting wheat for bread' };
            },
        };

        if (SKILL_MILESTONES[milestone.id]) {
            return SKILL_MILESTONES[milestone.id]();
        }

        // ── Milestone → target item mapping ─────────────────────────────
        // Maps milestone IDs to the item the planner should resolve
        const MILESTONE_TARGETS = {
            'get_wood': { item: 'oak_log', count: 8 },
            'craft_basics': { item: 'stick', count: 4 },
            'crafting_table': { item: 'crafting_table', count: 1 },
            'full_wooden_tools': { items: ['wooden_pickaxe', 'wooden_axe', 'wooden_sword', 'wooden_shovel'] },
            'mine_stone': { item: 'cobblestone', count: 16 },
            'stone_tools': { action: 'upgrade_tools', target: 'stone', reason: 'Upgrading to stone tools' },
            'mine_coal': { item: 'coal', count: 8 },
            'craft_torches': { item: 'torch', count: 4 },
            'furnace': { item: 'furnace', count: 1 },
            'mine_iron': { item: 'raw_iron', count: 12 },
            'smelt_iron': { item: 'iron_ingot', count: 12 },
            'iron_tools': { action: 'upgrade_tools', target: 'iron', reason: 'Crafting iron tools' },
            'iron_armor': { items: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'] },
            'shield': { item: 'shield', count: 1 },
            'bucket': { item: 'bucket', count: 1 },
            'mine_diamond': { item: 'diamond', count: 3 },
            'diamond_tools': { items: ['diamond_pickaxe', 'diamond_sword'] },
            'enchanting_table': { item: 'enchanting_table', count: 1 },
        };

        const target = MILESTONE_TARGETS[milestone.id];

        // Direct action milestones (upgrade_tools, etc.)
        if (target && target.action) {
            return { action: target.action, target: target.target, reason: target.reason };
        }

        // ── Use the RecipePlanner for item-based milestones ─────────────
        if (this.planner && target) {
            // Multi-item milestones (tools, armor sets)
            if (target.items) {
                for (const itemName of target.items) {
                    if (!inv[itemName]) {
                        const plan = this.planner.planFor(itemName, 1);
                        if (plan.length > 0) {
                            const step = this.planner.getNextStep();
                            if (step) {
                                console.log(`[Planner] 📋 ${this.planner.getPlanSummary()}`);
                                return this.planner.stepToAction(step);
                            }
                        }
                    }
                }
                // If all items are owned, the milestone should be complete
                return { action: 'craft', target: target.items[0], reason: 'Finishing tool set' };
            }

            // Single-item milestones
            if (target.item) {
                const have = this._countItemWild(inv, target.item);
                const need = target.count || 1;

                if (have < need) {
                    const plan = this.planner.planFor(target.item, need);
                    if (plan.length > 0) {
                        const step = this.planner.getNextStep();
                        if (step) {
                            console.log(`[Planner] 📋 ${this.planner.getPlanSummary()}`);
                            return this.planner.stepToAction(step);
                        }
                    }
                }
            }
        }

        // ── Fallback: use SkillManager for advanced milestones ──────────
        return {
            action: 'use_skill',
            target: milestone.description,
            reason: `${milestone.name}: ${milestone.description}`
        };
    }

    /** Count items with wildcard matching (any log type, any plank type) */
    _countItemWild(inv, itemName) {
        if (inv[itemName]) return inv[itemName];
        if (itemName === 'oak_log' || itemName === 'log') {
            return Object.entries(inv).filter(([k]) => k.includes('_log')).reduce((s, [, v]) => s + v, 0);
        }
        if (itemName === 'oak_planks' || itemName === 'planks') {
            return Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
        }
        return 0;
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
            ? `\n⚡ ${this.pendingReply.username} said: "${this.pendingReply.message}" — reply in chat!`
            : '';
        this.pendingReply = null;

        // Time of day (0=dawn 6000=noon 12000=dusk 18000=midnight)
        const time = this.bot.time?.timeOfDay ?? 0;
        let timeLabel;
        if (time < 1000) timeLabel = '🌅 Dawn (safe)';
        else if (time < 11000) timeLabel = '☀️ Day (safe)';
        else if (time < 13000) timeLabel = '🌆 Dusk (get safe soon!)';
        else timeLabel = '🌙 NIGHT — mobs spawning! Seek shelter, fight, or sleep!';

        // Active plan from RecipePlanner
        const planInfo = this.planner?.hasPlan()
            ? `ACTIVE PLAN: ${this.planner.getPlanSummary()}`
            : '';

        // Compact inventory
        const invStr = Object.entries(inventory)
            .map(([k, v]) => `${k}×${v}`)
            .join(', ') || 'empty';

        // Recent memories (last 4, keep it tight)
        const memories = this.memory.shortTermMemory.slice(-4)
            .map(m => '  ' + m).join('\n') || '  Nothing yet.';

        // Gameplay knowledge (last 4)
        const knowledge = (this.memory.gameplayKnowledge || []).slice(-4)
            .map(k => '  • ' + k).join('\n') || '  None yet.';

        return `You are ${this.config.botUsername}, a Minecraft survival AI.

PRIORITY RULES (follow in order):
  1. DANGER: health < 10 → eat food or flee. Always.
  2. HUNGER: food < 14 → eat if you have food.
  3. NIGHT: if night, build shelter / sleep / place torches. Don't explore in the dark.
  4. GOAL: follow the survival progression below.
  5. EXPLORE: if stuck or nothing to do, explore new areas.

STATUS: ${posStr} | ❤️ ${health}/20 | 🍖 ${food}/20 | ${timeLabel}
INVENTORY: ${invStr}
${planInfo}
${reply}

${vision}

PROGRESSION (do the 👉 step):
${this.goals.getProgressForPrompt(this.bot, this._readInventory(), this.memory)}

RECENT NOTES:
${memories}

TIPS:
${knowledge}

ACTIONS: ${this.skills.getSkillList().map(s => s.split('—')[0].trim()).join(', ')}, use_skill

Respond with ONLY this JSON:
{
  "thought": "<1 sentence: why this action>",
  "action": "<one action name>",
  "action_target": "<target if needed, usually empty>",
  "chat": "<say something short or empty>"
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









    // ── Action executor ────────────────────────────────────────────────────────


    async _executeAction(action, target) {
        this._stopMovement();
        try {
            switch (action) {
                // ── Original actions ──────────────────────────────
                case 'mine_wood': {
                    const woodTarget = (target && !target.match(/[-\d,\[\]]/)) ? target : 'log';
                    await this._mineNearestBlock(woodTarget, 64);
                    // No redundant explore — _mineNearestBlock already walks 300 blocks
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
                        await this._exploreRandomly();
                    }
                    break;
                }
                case 'craft': {
                    // No whitelist — let the planner and _craftItem handle validation
                    await this._craftItem(target || 'auto');
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
        const dist = 80 + Math.random() * 40;
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

        // Snapshot inventory BEFORE mining to verify later
        const invBeforeMining = {};
        for (const item of this.bot.inventory.items()) {
            invBeforeMining[item.name] = (invBeforeMining[item.name] || 0) + item.count;
        }

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

                // Check if resource still exists here — clear stale memory if not
                const stillThere = this.bot.findBlock({
                    matching: b => b.name.includes(blockNameFragment),
                    maxDistance: 16,
                });
                if (!stillThere) {
                    console.log(`[Brain] 🗑️ Resource depleted at remembered location — clearing memory`);
                    delete this.memory.knownLocations[knownKey];
                    this._saveMemory();
                }
            }
        }

        // ── Persistent straight-line exploration ────────────────────────────
        // Pick ONE direction and keep walking in legs until we find target blocks.
        // Each leg = 60 blocks. Up to 5 legs = 300 blocks total.
        const MAX_LEGS = 5;
        const LEG_DISTANCE = 60;
        const { angle: exploreAngle, label: exploreLabel } = this._pickUnexploredDirection();
        this._lastExploreDir = exploreLabel;

        for (let leg = 0; leg < MAX_LEGS; leg++) {
            botPos = this.bot.entity.position;

            // Try to mine any target blocks visible from current position
            for (let i = mined; i < maxBlocks; i++) {
                const candidates = this.bot.findBlocks({
                    matching: b => b.name.includes(blockNameFragment),
                    maxDistance,
                    count: 20,
                }).filter(pos => Math.abs(pos.y - botPos.y) <= 6)
                    .sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos));

                if (candidates.length === 0) break;

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

                    const verifyBlock = this.bot.blockAt(blockPos);
                    if (verifyBlock && verifyBlock.name === freshBlock.name) {
                        console.warn(`[Brain] ⚠️ dig() returned but block still there — skipping`);
                        continue;
                    }

                    mined++;
                    console.log(`[Brain] ✅ Mined ${freshBlock.name} (${mined}/${maxBlocks})`);
                    await this._collectNearbyItems(blockPos, 6, 3000);
                } catch (e) {
                    console.warn(`[Brain] dig failed: ${e.message}`);
                    break;
                }
            }

            if (mined >= maxBlocks) break;

            // Walk another leg in the SAME direction
            if (leg < MAX_LEGS - 1) {
                const pos = this.bot.entity.position;
                const tx = Math.round(pos.x + Math.cos(exploreAngle) * LEG_DISTANCE);
                const tz = Math.round(pos.z + Math.sin(exploreAngle) * LEG_DISTANCE);
                const totalDist = (leg + 1) * LEG_DISTANCE;
                console.log(`[Brain] 🔍 No "${blockNameFragment}" — walking ${exploreLabel} (${totalDist}/${MAX_LEGS * LEG_DISTANCE}b)`);
                this._exploredDirs[exploreLabel] = Date.now();
                await this._navigateTo(tx, pos.y, tz, 5);
            }
        }

        // VERIFY: compare inventory before/after to see what was ACTUALLY gained
        const invAfterMining = {};
        for (const item of this.bot.inventory.items()) {
            invAfterMining[item.name] = (invAfterMining[item.name] || 0) + item.count;
        }
        const actualGains = [];
        for (const [name, count] of Object.entries(invAfterMining)) {
            const diff = count - (invBeforeMining[name] || 0);
            if (diff > 0) actualGains.push(`${name}×${diff}`);
        }

        if (mined > 0 && actualGains.length > 0) {
            this._addEvent(`🪓 Mined ${mined}× ${blockNameFragment} → gained: ${actualGains.join(', ')}`);
            const nearby = this.bot.findBlock({ matching: b => b.name.includes(blockNameFragment), maxDistance: 8 });
            if (nearby) {
                this.memory.knownLocations[knownKey] = [
                    Math.round(nearby.position.x),
                    Math.round(nearby.position.y),
                    Math.round(nearby.position.z),
                ];
            }
        } else if (mined > 0 && actualGains.length === 0) {
            console.warn(`[Brain] ⚠️ Dug ${mined} blocks but gained NOTHING — items may have fallen or despawned`);
            this._addEvent(`⚠️ Mined ${mined}× ${blockNameFragment} but items lost`);
        } else {
            console.log(`[Brain] ❌ Couldn't find any "${blockNameFragment}" after ${MAX_EXPLORE_ATTEMPTS} exploration attempts`);
        }
        return mined;
    }

    /**
     * Collect nearby dropped items by tracking item entities.
     * VERIFIES actual inventory changes — no false positives.
     * @param {Vec3} searchCenter - Where to look for items (usually where block was mined)
     * @param {number} radius - Max distance to search for items (default 6)
     * @param {number} timeoutMs - Max time to spend collecting (default 3000)
     */
    async _collectNearbyItems(searchCenter, radius = 6, timeoutMs = 3000) {
        const deadline = Date.now() + timeoutMs;
        const pos = this.bot.entity?.position;
        if (!pos) return 0;

        // Snapshot inventory BEFORE collection
        const invBefore = {};
        for (const item of this.bot.inventory.items()) {
            invBefore[item.name] = (invBefore[item.name] || 0) + item.count;
        }

        // Wait a moment for items to spawn after block break
        await new Promise(r => setTimeout(r, 200));

        const maxAttempts = 5;

        for (let attempt = 0; attempt < maxAttempts && Date.now() < deadline; attempt++) {
            // Find all dropped item entities near the search center
            const droppedItems = Object.values(this.bot.entities)
                .filter(e => {
                    if (!e || !e.position) return false;
                    if (e.name !== 'item' && e.displayName !== 'Item' &&
                        e.entityType !== 2 && e.type !== 'object') return false;
                    const dist = e.position.distanceTo(searchCenter);
                    return dist <= radius;
                })
                .sort((a, b) => {
                    const dA = a.position.distanceTo(this.bot.entity.position);
                    const dB = b.position.distanceTo(this.bot.entity.position);
                    return dA - dB;
                });

            if (droppedItems.length === 0) {
                if (attempt === 0) {
                    await new Promise(r => setTimeout(r, 300));
                    continue;
                }
                break;
            }

            const item = droppedItems[0];
            const itemDist = item.position.distanceTo(this.bot.entity.position);

            if (itemDist <= 2.5) {
                // Close enough — wait for auto-pickup
                await new Promise(r => setTimeout(r, 400));
            } else {
                // Walk to the item
                try {
                    await this.navigator.goTo(item.position, 1.5, Math.min(3000, deadline - Date.now()));
                    await new Promise(r => setTimeout(r, 400)); // wait for pickup
                } catch {
                    break; // item despawned or unreachable
                }
            }
        }

        // Snapshot inventory AFTER collection — count what ACTUALLY changed
        const invAfter = {};
        for (const item of this.bot.inventory.items()) {
            invAfter[item.name] = (invAfter[item.name] || 0) + item.count;
        }

        let collected = 0;
        const gained = [];
        for (const [name, count] of Object.entries(invAfter)) {
            const diff = count - (invBefore[name] || 0);
            if (diff > 0) {
                collected += diff;
                gained.push(`${name}×${diff}`);
            }
        }

        if (collected > 0) {
            console.log(`[Brain] 📥 Picked up: ${gained.join(', ')}`);
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
                // Cave avoidance: restrict pathfinder if no pickaxe
                const hasPickaxe = this.bot.inventory.items().some(i => i.name.includes('_pickaxe'));
                const hasTorches = this.bot.inventory.items().some(i => i.name === 'torch');
                const movements = this.bot.pathfinder.movements;
                if (movements) {
                    if (!hasPickaxe) {
                        // No pickaxe = don't dig, don't drop into caves
                        movements.canDig = false;
                        movements.maxDropDown = 3;     // max 3 block drop (no cave diving)
                    } else {
                        movements.canDig = true;
                        movements.maxDropDown = hasTorches ? 256 : 4;  // with torches = can go deep
                    }
                }

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
        // Items that NEED a crafting table (3x3 grid) — match by pattern, not hardcoded list
        const needsTable = (name) => {
            const TABLE_PATTERNS = ['_pickaxe', '_axe', '_sword', '_shovel', '_hoe',
                '_helmet', '_chestplate', '_leggings', '_boots',
                'shield', 'bucket', 'furnace', 'chest', 'shears'];
            return TABLE_PATTERNS.some(p => name.includes(p));
        };

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
        if (needsTable(target)) {
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
                    await this._mineNearestBlock('log', 64);
                } else if (target === 'crafting_table') {
                    console.log('[Brain] 🔨 Recovery: need 4 planks → crafting planks first');
                    await this._craftItem('planks', _depth + 1);
                } else if (needsTable(target)) {
                    console.log('[Brain] 🔨 Recovery: need crafting table → crafting/placing one');
                    await this._craftItem('crafting_table', _depth + 1);
                } else {
                    // Unknown failure — go explore/mine to find materials
                    console.log('[Brain] 🔨 Recovery: unknown missing material → going to mine wood');
                    await this._mineNearestBlock('log', 64);
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
