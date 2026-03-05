/**
 * skill_manager.js — Voyager-Style Skill System for DIDDYBOT
 *
 * Instead of picking from a fixed menu, the LLM writes JavaScript code
 * to solve tasks. Working code is saved as reusable skills.
 *
 * Flow:
 *   1. Receive task description (e.g., "mine 8 oak logs")
 *   2. Check skill library for a saved skill
 *   3. If none found → ask LLM to write JavaScript code
 *   4. Execute code in sandbox with bot context
 *   5. If success → save to skill library
 *   6. If fail → send error to LLM → retry with fix
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const Vec3 = require('vec3');

const SKILLS_DIR = path.join(__dirname, 'logs', 'skills');
const MAX_RETRIES = 2;        // How many times to let LLM fix a failed skill
const EXEC_TIMEOUT = 30000;   // 30s max execution time per skill
const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

class SkillManager {
    constructor(bot, navigator, model = 'llama3.1:8b', learnedKnowledge = []) {
        this.bot = bot;
        this.navigator = navigator;
        this.model = model;
        this.learnedKnowledge = learnedKnowledge;
        this.skills = {};  // name → { description, code, successCount, failCount }

        // Ensure skills directory exists
        if (!fs.existsSync(SKILLS_DIR)) {
            fs.mkdirSync(SKILLS_DIR, { recursive: true });
        }

        this._loadSkills();
    }

    /**
     * Execute a task. Checks the skill library first, then generates code.
     *
     * @param {string} task - Natural language task description
     * @returns {{ success: boolean, result: string }}
     */
    async runTask(task) {
        console.log(`[Skills] 📋 Task: "${task}"`);

        // 1. Check skill library for a matching skill
        const existingSkill = this._findSkill(task);
        if (existingSkill) {
            console.log(`[Skills] 📦 Found saved skill: "${existingSkill.name}"`);
            const result = await this._executeSkill(existingSkill);
            if (result.success) {
                existingSkill.successCount++;
                this._saveSkillToDisk(existingSkill);
                return result;
            }
            // Skill failed — fall through to regeneration
            existingSkill.failCount++;
            console.log(`[Skills] ⚠️ Saved skill failed — regenerating...`);
        }

        // 2. Generate new skill via LLM
        let lastError = null;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            const code = await this._generateSkillCode(task, lastError);
            if (!code) {
                console.log('[Skills] ❌ LLM failed to generate code');
                return { success: false, result: 'Code generation failed' };
            }

            console.log(`[Skills] 🔧 Generated code (attempt ${attempt + 1}):\n${code.substring(0, 200)}...`);

            const result = await this._executeSandboxed(code);
            if (result.success) {
                // Save working skill
                const skillName = this._taskToName(task);
                const skill = {
                    name: skillName,
                    description: task,
                    code,
                    successCount: 1,
                    failCount: 0,
                    createdAt: new Date().toISOString(),
                };
                this.skills[skillName] = skill;
                this._saveSkillToDisk(skill);
                console.log(`[Skills] ✅ Skill saved: "${skillName}"`);
                return result;
            }

            // Failed — give error to LLM for retry
            lastError = result.result;
            console.log(`[Skills] ❌ Attempt ${attempt + 1} failed: ${lastError}`);
        }

        return { success: false, result: `Failed after ${MAX_RETRIES + 1} attempts: ${lastError}` };
    }

    /**
     * Get a list of all saved skills for the LLM prompt.
     */
    getSkillList() {
        const names = Object.keys(this.skills);
        if (names.length === 0) return 'No saved skills yet.';
        return names.map(n => {
            const s = this.skills[n];
            return `  • ${n} — ${s.description} (✅${s.successCount} ❌${s.failCount})`;
        }).join('\n');
    }

    // ── Code generation via LLM ──────────────────────────────────────────

    async _generateSkillCode(task, previousError = null) {
        const inventory = {};
        for (const item of this.bot.inventory.items()) {
            inventory[item.name] = (inventory[item.name] || 0) + item.count;
        }

        const pos = this.bot.entity?.position;
        const posStr = pos ? `x=${Math.round(pos.x)}, y=${Math.round(pos.y)}, z=${Math.round(pos.z)}` : 'unknown';

        let prompt = `You are a Minecraft bot code generator. Write a JavaScript async function to complete this task.

TASK: ${task}

BOT STATUS:
  Position: ${posStr}
  Health: ${Math.round(this.bot.health || 20)}/20
  Food: ${Math.round(this.bot.food || 20)}/20
  Inventory: ${JSON.stringify(inventory)}

AVAILABLE APIs:
  bot.findBlock({ matching: b => b.name === 'oak_log', maxDistance: 32 })  — find ONE nearby block
  bot.findBlocks({ matching: b => b.name.includes('log'), maxDistance: 64, count: 20 })  — find block positions
  bot.blockAt(vec3Position)  — get block at position
  bot.dig(block)  — mine/break a block (await this)
  bot.lookAt(vec3Position)  — look at position
  bot.equip(item, 'hand')  — equip item
  bot.craft(recipe, count, craftingTable)  — craft items
  bot.inventory.items()  — list inventory items  
  bot.entity.position  — current position (Vec3)
  bot.placeBlock(referenceBlock, faceVector)  — place block
  bot.chat(message)  — send chat message
  bot.consume()  — eat held food item
  bot.pathfinder.setGoal(new GoalNear(x, y, z, range))  — A* pathfinding
  navigator.goTo(vec3Position, range, timeoutMs)  — walk to position
  Vec3(x, y, z)  — create position vector
  sleep(ms)  — wait for ms milliseconds
  const { GoalNear, GoalBlock } = require('mineflayer-pathfinder').goals;

RULES:
1. Write ONLY the function body (no function declaration, no exports)
2. Use async/await. Code runs inside: async function(bot, navigator, Vec3, sleep) { YOUR CODE }
3. Check if blocks/items exist before using them
4. Use try/catch for operations that might fail
5. Log progress with bot.chat() so we can see what's happening
6. Keep it under 50 lines`;

        // Inject learned knowledge
        if (this.learnedKnowledge && this.learnedKnowledge.length > 0) {
            const knowledge = this.learnedKnowledge.slice(-10).join('\n  ');
            prompt += `\n\nLEARNED FROM EXPERIENCE:\n  ${knowledge}`;
        }

        if (previousError) {
            prompt += `\n\nPREVIOUS ATTEMPT FAILED WITH ERROR:\n${previousError}\n\nFix the error and try a different approach.`;
        }

        prompt += `\n\nRespond with ONLY the JavaScript code. No explanation, no markdown, no \`\`\`.`;

        const response = await this._callOllama(prompt);
        if (!response) return null;

        // Clean up response — remove markdown fences, function declarations
        let code = response.trim();
        code = code.replace(/^```(?:javascript|js)?\n?/gm, '');
        code = code.replace(/```$/gm, '');
        code = code.replace(/^async\s+function\s*\([^)]*\)\s*\{/, '');
        code = code.replace(/\}$/m, '');  // Remove trailing }
        return code.trim();
    }

    // ── Sandboxed execution ──────────────────────────────────────────────

    async _executeSandboxed(code) {
        return new Promise(async (resolve) => {
            const timer = setTimeout(() => {
                resolve({ success: false, result: 'Execution timeout (30s)' });
            }, EXEC_TIMEOUT);

            try {
                // Create the function with limited scope
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const fn = new Function('bot', 'navigator', 'Vec3', 'sleep',
                    `return (async () => { ${code} })();`
                );

                await fn(this.bot, this.navigator, Vec3, sleep);
                clearTimeout(timer);
                resolve({ success: true, result: 'Task completed' });
            } catch (err) {
                clearTimeout(timer);
                resolve({ success: false, result: err.message });
            }
        });
    }

    async _executeSkill(skill) {
        return this._executeSandboxed(skill.code);
    }

    // ── Skill library management ─────────────────────────────────────────

    _findSkill(task) {
        const taskLower = task.toLowerCase();
        // Exact name match
        const name = this._taskToName(task);
        if (this.skills[name]) return this.skills[name];

        // Fuzzy match — check if any skill description is similar
        for (const skill of Object.values(this.skills)) {
            const descWords = new Set(skill.description.toLowerCase().split(/\s+/));
            const taskWords = taskLower.split(/\s+/);
            const overlap = taskWords.filter(w => descWords.has(w)).length;
            if (overlap / taskWords.length >= 0.7) return skill;
        }

        return null;
    }

    _taskToName(task) {
        return task.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .slice(0, 5)
            .join('_');
    }

    _loadSkills() {
        try {
            const files = fs.readdirSync(SKILLS_DIR).filter(f => f.endsWith('.json'));
            for (const file of files) {
                try {
                    const data = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, file), 'utf8'));
                    this.skills[data.name] = data;
                } catch { }
            }
            const count = Object.keys(this.skills).length;
            if (count > 0) console.log(`[Skills] 📦 Loaded ${count} saved skills`);
        } catch { }
    }

    _saveSkillToDisk(skill) {
        try {
            const filePath = path.join(SKILLS_DIR, `${skill.name}.json`);
            fs.writeFileSync(filePath, JSON.stringify(skill, null, 2));
        } catch (e) {
            console.warn(`[Skills] Failed to save skill: ${e.message}`);
        }
    }

    // ── LLM call ─────────────────────────────────────────────────────────

    _callOllama(prompt) {
        return new Promise((resolve) => {
            const body = JSON.stringify({
                model: this.model,
                prompt,
                stream: false,
                options: { temperature: 0.4, num_predict: 500 },  // lower temp for code
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

            req.on('error', () => resolve(null));
            req.setTimeout(60000, () => { req.destroy(); resolve(null); });
            req.write(body);
            req.end();
        });
    }
}

module.exports = { SkillManager };
