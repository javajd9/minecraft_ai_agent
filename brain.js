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
const { formatVision } = require('./scanner');
const { ExperienceLog } = require('./experience');
const { StrategyEngine } = require('./strategy');
const { GameKnowledge } = require('./game_knowledge');
const { GoalTracker } = require('./goals');
const { SkillLibrary } = require('./skills');

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
        this.gameKnowledge = null;  // initialized after bot spawns (needs registry)
        this.goals = new GoalTracker();          // tech tree progression
        this.skills = null;                      // initialized after bot spawns

        // Task commitment — prevents flip-flopping between actions
        this._currentTask = null;      // { action, target, startedAt, lockedUntil }

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

        // If committed to a task, skip (unless health critical)
        if (this._currentTask && Date.now() < this._currentTask.lockedUntil) {
            const health = this.bot.health ?? 20;
            if (health >= 6) return;
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

        if (this._currentTask) {
            console.log(`[Brain] 🔓 Task "${this._currentTask.action}" finished`);
            this._currentTask = null;
        }

        this.busy = true;

        try {
            await this._escapeWater();

            // ── Check if we have a pending LLM decision ──────────────
            let action, target;

            if (this._pendingLLMAction) {
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

            // Record outcome
            const invAfter = this._readInventory();
            let result = 'success', detail = '';
            if (action === 'mine_wood') {
                const before = Object.entries(invBefore).filter(([k]) => k.includes('log')).reduce((s, [, v]) => s + v, 0);
                const after = Object.entries(invAfter).filter(([k]) => k.includes('log')).reduce((s, [, v]) => s + v, 0);
                if (after <= before) { result = 'fail'; detail = 'No logs gathered'; }
            }
            const exp = this.experience.endAction(result, detail, this.bot);
            if (exp) this.strategy.recordOutcome(action, result, exp.context);

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

        if (!milestone) return null; // all done

        // Count resources
        const logCount = Object.entries(inv).filter(([k]) => k.includes('_log')).reduce((s, [, v]) => s + v, 0);
        const plankCount = Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
        const stickCount = inv.stick || 0;
        const tableCount = inv.crafting_table || 0;

        switch (milestone.id) {
            case 'get_wood':
                return { action: 'mine_wood', target: 'log', reason: `Gathering wood (have ${logCount} logs, need 8)` };

            case 'craft_basics':
                if (logCount >= 1 && plankCount < 8) {
                    return { action: 'craft', target: 'planks', reason: `Crafting planks (have ${plankCount}, need 8)` };
                }
                if (plankCount >= 2 && stickCount < 4) {
                    return { action: 'craft', target: 'stick', reason: `Crafting sticks (have ${stickCount}, need 4)` };
                }
                // Need more logs for planks
                return { action: 'mine_wood', target: 'log', reason: 'Need more logs for planks & sticks' };

            case 'full_wooden_tools':
                // Need crafting table (cap at 1)
                if (tableCount < 1 && plankCount >= 4) {
                    return { action: 'craft', target: 'crafting_table', reason: 'Crafting table for tools' };
                }
                // Craft tools in order
                if (!inv.wooden_pickaxe) return { action: 'craft', target: 'wooden_pickaxe', reason: 'Crafting wooden pickaxe' };
                if (!inv.wooden_axe) return { action: 'craft', target: 'wooden_axe', reason: 'Crafting wooden axe' };
                if (!inv.wooden_sword) return { action: 'craft', target: 'wooden_sword', reason: 'Crafting wooden sword' };
                if (!inv.wooden_shovel) return { action: 'craft', target: 'wooden_shovel', reason: 'Crafting wooden shovel' };
                // Need more materials
                if (plankCount < 4) return { action: 'craft', target: 'planks', reason: 'Need planks for remaining tools' };
                if (stickCount < 2) return { action: 'craft', target: 'stick', reason: 'Need sticks for remaining tools' };
                return { action: 'mine_wood', target: 'log', reason: 'Need more wood for tools' };

            case 'build_shelter':
                return { action: 'build_shelter', target: '', reason: 'Building shelter' };

            default:
                return { action: milestone.suggestedAction, target: '', reason: milestone.description };
        }
    }

    /**
     * If the bot is standing in water, walk toward nearby land.
     */
    async _escapeWater() {
        const pos = this.bot.entity?.position;
        if (!pos) return;
        const blockAtFeet = this.bot.blockAt(pos.offset(0, -0.5, 0));
        const blockAtHead = this.bot.blockAt(pos);
        const inWater = (blockAtFeet && blockAtFeet.name.includes('water')) ||
            (blockAtHead && blockAtHead.name.includes('water'));
        if (!inWater) return;

        console.log('[Brain] 🌊 In water! Escaping...');
        // Look for a non-water block nearby
        const { Vec3 } = require('vec3');
        for (let attempt = 0; attempt < 4; attempt++) {
            const angle = attempt * (Math.PI / 2); // try 4 directions
            const tx = pos.x + Math.cos(angle) * 10;
            const tz = pos.z + Math.sin(angle) * 10;
            const targetBlock = this.bot.blockAt(new Vec3(Math.round(tx), Math.round(pos.y), Math.round(tz)));
            if (targetBlock && !targetBlock.name.includes('water') && targetBlock.name !== 'air') {
                await this._walkTo(new Vec3(tx, pos.y, tz), 3, 8000);
                // Check if we escaped
                const newBlock = this.bot.blockAt(this.bot.entity.position.offset(0, -0.5, 0));
                if (!newBlock || !newBlock.name.includes('water')) return;
            }
        }
        // Fallback: just jump and walk forward
        this.bot.setControlState('jump', true);
        this.bot.setControlState('forward', true);
        await new Promise(r => setTimeout(r, 3000));
        this.bot.clearControlStates();
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

AVAILABLE ACTIONS:
${this.skills.getSkillList().map(s => '  ' + s).join('\n')}

YOUR TASK: Follow the SURVIVAL PROGRESSION above. Do the 👉 step.
Pick ONE action and commit to it fully. You will be locked in for 15-25 seconds.
If hungry (food < 14), eat first. If health < 10, flee or eat. At night, seek shelter or sleep.

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
            req.setTimeout(60000, () => { req.destroy(); resolve(null); }); // 60s for GPU cold-start
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

                case 'explore':
                default:
                    await this._exploreRandomly();
                    break;
            }
        } catch (err) {
            console.warn(`[Brain] Action "${action}" failed:`, err.message);
        }
    }

    // Cancel current pathfinding goal (if any)
    _stopMovement() {
        try {
            if (this.bot.pathfinder && this.bot.pathfinder.isMoving()) {
                this.bot.pathfinder.stop();
            }
        } catch { /* ignore */ }
    }

    // Walk toward a random point 20-40 blocks away using manual movement
    async _exploreRandomly() {
        const pos = this.bot.entity?.position;
        if (!pos) return;
        const angle = Math.random() * Math.PI * 2;
        const dist = 20 + Math.random() * 20;
        const tx = Math.round(pos.x + Math.cos(angle) * dist);
        const tz = Math.round(pos.z + Math.sin(angle) * dist);
        console.log(`[Brain] 🧭 Exploring towards (${tx}, ${tz})`);
        const { Vec3 } = require('vec3');
        await this._walkTo(new Vec3(tx, pos.y, tz), 5, 15000);
    }

    // ── Game action helpers ────────────────────────────────────────────────────

    /**
     * Navigate to an entity and swing until it dies.
     * Re-chases if the entity flees. Gives up after maxSwings OR 10s timeout.
     */
    async _huntEntity(entityInfo, maxSwings = 20) {
        // entityInfo may be a wrapper { entity, name, ... } or a raw entity
        const mob = entityInfo.entity || entityInfo;
        const mobName = entityInfo.name || mob.name || 'unknown';
        const deadline = Date.now() + 15_000;  // 15s hard timeout
        for (let i = 0; i < maxSwings; i++) {
            if (!mob.isValid) break;
            if (Date.now() > deadline) {
                console.log('[Brain] ⏱️  Hunt timed out — giving up on', mobName);
                this._addEvent(`⏱️ Gave up chasing ${mobName} (timeout)`);
                break;
            }
            const dist = mob.position.distanceTo(this.bot.entity.position);
            if (dist > 4) {
                await this._walkTo(mob.position, 3, 3000);
            }
            if (mob.isValid) {
                this.bot.attack(mob);
                this._addEvent(`⚔️  Attacked ${mobName}`);
            }
            await new Promise(r => setTimeout(r, 600));
        }
    }

    async _mineNearestBlock(blockNameFragment, maxDistance = 32, maxBlocks = 4) {
        let mined = 0;
        const botPos = this.bot.entity.position;

        for (let i = 0; i < maxBlocks; i++) {
            // Find matching blocks, sorted by distance, filtered to reachable Y level
            const candidates = this.bot.findBlocks({
                matching: b => b.name.includes(blockNameFragment),
                maxDistance,
                count: 20,
            }).filter(pos => Math.abs(pos.y - botPos.y) <= 4)  // only blocks within ±4 Y
                .sort((a, b) => a.distanceTo(botPos) - b.distanceTo(botPos));

            if (candidates.length === 0) {
                if (mined === 0) console.log(`[Brain] ❌ No reachable "${blockNameFragment}" found within ${maxDistance} blocks`);
                break;
            }

            const blockPos = candidates[0];
            const block = this.bot.blockAt(blockPos);
            if (!block) break;

            const dist = blockPos.distanceTo(botPos);
            if (mined === 0) {
                console.log(`[Brain] 🪓 Found ${block.name} at ${blockPos} (${Math.round(dist)} blocks away)`);
            }

            // Walk to the block using manual movement
            await this._walkTo(blockPos, 3, 8000);

            const freshBlock = this.bot.blockAt(blockPos);
            if (!freshBlock || !freshBlock.name.includes(blockNameFragment)) {
                console.log(`[Brain] Block gone by the time we arrived`);
                continue;
            }

            await this._equipBestTool(freshBlock);

            try {
                await this.bot.lookAt(blockPos.offset(0.5, 0.5, 0.5));
                await this.bot.dig(freshBlock);
                mined++;
                console.log(`[Brain] ✅ Mined ${freshBlock.name} (${mined}/${maxBlocks})`);
                await new Promise(r => setTimeout(r, 300));
            } catch (e) {
                console.warn(`[Brain] dig failed: ${e.message}`);
                break;
            }
        }

        if (mined > 0) {
            this._addEvent(`🪓 Mined ${mined}× ${blockNameFragment}`);
            const nearby = this.bot.findBlock({ matching: b => b.name.includes(blockNameFragment), maxDistance: 8 });
            if (nearby) {
                this.memory.knownLocations[`${blockNameFragment}_source`] = [
                    Math.round(nearby.position.x),
                    Math.round(nearby.position.y),
                    Math.round(nearby.position.z),
                ];
            }
        }
        return mined;
    }

    /**
     * Walk toward a position using direct controls (no pathfinder).
     * Looks at the target, walks forward with jumps, stops when within range or timeout.
     */
    async _walkTo(targetPos, range = 3, timeoutMs = 8000) {
        const deadline = Date.now() + timeoutMs;
        try {
            while (Date.now() < deadline) {
                const pos = this.bot.entity?.position;
                if (!pos) break;
                const dist = pos.distanceTo(targetPos);
                if (dist <= range) break;

                await this.bot.lookAt(targetPos.offset(0.5, 0.5, 0.5));
                this.bot.setControlState('forward', true);
                this.bot.setControlState('jump', true);
                await new Promise(r => setTimeout(r, 250));

                // Check if stuck (didn't move much)
                const newPos = this.bot.entity?.position;
                if (newPos && pos.distanceTo(newPos) < 0.05) {
                    // Stuck — try jumping and strafing briefly
                    this.bot.setControlState('left', true);
                    await new Promise(r => setTimeout(r, 300));
                    this.bot.setControlState('left', false);
                }
            }
        } finally {
            this.bot.clearControlStates();
        }
    }

    /** Equip the best tool for breaking a block — uses game registry, zero hardcoding */
    async _equipBestTool(block) {
        try {
            const best = this.gameKnowledge?.getBestToolFor(block);
            if (best) {
                await this.bot.equip(best, 'hand');
            } else {
                // No correct tool — un-equip so we use bare hand
                await this.bot.unequip('hand');
            }
        } catch { /* no tool available, use bare hand */ }
    }

    async _navigateTo(x, y, z, range = 2) {
        if (!this.bot.pathfinder) return;
        const goal = new GoalNear(x, y, z, Math.max(range, 1));
        const timeout = new Promise((_, reject) =>
            setTimeout(() => {
                try { this.bot.pathfinder.stop(); } catch { }
                reject(new Error('pathfinding timeout (30s)'));
            }, 30_000)
        );
        try {
            await Promise.race([this.bot.pathfinder.goto(goal), timeout]);
        } catch (e) {
            try { this.bot.pathfinder.stop(); } catch { }
            console.warn(`[Brain] 🧭 Navigation failed: ${e.message}`);
            throw e;
        }
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
            else if (!hasTable) { target = 'crafting_table'; }
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

            await this.bot.craft(recipes[0], 1, craftingTableBlock || null);
            console.log(`[Brain] ✅ Crafted: ${itemName}`);
            this._addEvent(`🔨 Crafted ${itemName}`);
        } catch (e) {
            console.warn(`[Brain] Craft error for ${itemName}: ${e.message}`);
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
