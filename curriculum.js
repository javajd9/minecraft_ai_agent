/**
 * curriculum.js — Self-directed Learning Curriculum
 *
 * Tracks what the bot has mastered and suggests progressively harder challenges.
 * Instead of just following the linear GoalTracker, this lets the bot:
 *   1. Track mastery level for each skill/action
 *   2. Generate new challenges based on what it's good at
 *   3. Prioritize weaknesses for improvement
 *   4. Scale difficulty over time
 *
 * Stored in logs/curriculum.json — persists across sessions.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const CURRICULUM_FILE = path.join(__dirname, 'logs', 'curriculum.json');

// How many successful attempts = "mastered"
const MASTERY_THRESHOLD = 5;

// Challenge templates — progressively harder
const CHALLENGE_TEMPLATES = [
    // Tier 1: Basic survival
    { id: 'mine_4_logs', tier: 1, action: 'mine_wood', desc: 'Mine 4 logs', check: inv => countLogs(inv) >= 4 },
    { id: 'mine_16_logs', tier: 1, action: 'mine_wood', desc: 'Mine 16 logs', check: inv => countLogs(inv) >= 16 },
    { id: 'craft_planks', tier: 1, action: 'craft', desc: 'Craft 16 planks', check: inv => countPlanks(inv) >= 16 },
    { id: 'craft_sticks', tier: 1, action: 'craft', desc: 'Craft 8 sticks', check: inv => (inv.stick || 0) >= 8 },

    // Tier 2: Tools & building
    { id: 'make_pickaxe', tier: 2, action: 'craft', desc: 'Craft a pickaxe', check: inv => inv.wooden_pickaxe || inv.stone_pickaxe || inv.iron_pickaxe },
    { id: 'mine_16_stone', tier: 2, action: 'mine_stone', desc: 'Mine 16 cobblestone', check: inv => (inv.cobblestone || 0) >= 16 },
    { id: 'build_shelter', tier: 2, action: 'build_shelter', desc: 'Build a shelter', check: (inv, mem) => !!mem.knownLocations?.shelter },

    // Tier 3: Resources
    { id: 'mine_coal', tier: 3, action: 'mine_coal', desc: 'Mine 8 coal', check: inv => (inv.coal || 0) >= 8 },
    { id: 'craft_torches', tier: 3, action: 'craft', desc: 'Craft 16 torches', check: inv => (inv.torch || 0) >= 16 },
    { id: 'smelt_iron', tier: 3, action: 'smelt', desc: 'Smelt 8 iron ingots', check: inv => (inv.iron_ingot || 0) >= 8 },
    { id: 'kill_mob', tier: 3, action: 'attack_mob', desc: 'Kill a hostile mob', check: inv => inv.rotten_flesh || inv.bone || inv.string || inv.gunpowder },

    // Tier 4: Advanced
    { id: 'full_iron_tools', tier: 4, action: 'upgrade_tools', desc: 'Get full iron tool set', check: inv => inv.iron_pickaxe && inv.iron_axe && inv.iron_sword },
    { id: 'iron_armor', tier: 4, action: 'craft', desc: 'Craft iron armor', check: inv => inv.iron_chestplate },
    { id: 'mine_diamonds', tier: 4, action: 'mine_diamond', desc: 'Find 3 diamonds', check: inv => (inv.diamond || 0) >= 3 },
    {
        id: 'cook_food_stack', tier: 4, action: 'smelt', desc: 'Cook 16 food items', check: inv => {
            const cooked = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton'];
            return cooked.reduce((s, k) => s + (inv[k] || 0), 0) >= 16;
        }
    },

    // Tier 5: Expert
    { id: 'enchant_item', tier: 5, action: 'use_skill', desc: 'Enchant an item', check: inv => Object.keys(inv).some(k => k.includes('enchanted')) },
    { id: 'nether_visit', tier: 5, action: 'use_skill', desc: 'Visit the Nether', check: (inv, mem) => !!mem.knownLocations?.nether_portal },
    { id: 'blaze_rods', tier: 5, action: 'use_skill', desc: 'Get blaze rods', check: inv => (inv.blaze_rod || 0) >= 1 },
];

function countLogs(inv) {
    return Object.entries(inv).filter(([k]) => k.includes('_log')).reduce((s, [, v]) => s + v, 0);
}
function countPlanks(inv) {
    return Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
}

class Curriculum {
    constructor() {
        this.data = this._load();
    }

    /**
     * Record an action outcome for mastery tracking.
     */
    recordOutcome(action, success) {
        if (!this.data.mastery[action]) {
            this.data.mastery[action] = { successes: 0, failures: 0, attempts: 0 };
        }
        const m = this.data.mastery[action];
        m.attempts++;
        if (success) m.successes++;
        else m.failures++;

        this._save();
    }

    /**
     * Check if an action is mastered (>= MASTERY_THRESHOLD successes, >80% rate).
     */
    isMastered(action) {
        const m = this.data.mastery[action];
        if (!m || m.attempts < MASTERY_THRESHOLD) return false;
        return (m.successes / m.attempts) >= 0.8;
    }

    /**
     * Get mastery level (0-100) for an action.
     */
    getMasteryLevel(action) {
        const m = this.data.mastery[action];
        if (!m || m.attempts === 0) return 0;
        return Math.round((m.successes / m.attempts) * 100);
    }

    /**
     * Get the next challenge the bot should attempt.
     * Prioritizes: unmastered challenges in lowest available tier.
     */
    getNextChallenge(inv, memory) {
        for (const challenge of CHALLENGE_TEMPLATES) {
            // Skip completed challenges
            if (this.data.completed.includes(challenge.id)) continue;

            // Check if this challenge is doable (its check shows true)
            try {
                if (challenge.check(inv, memory)) {
                    // Challenge is already met — mark complete
                    this.data.completed.push(challenge.id);
                    this._save();
                    continue;
                }
            } catch { }

            // Return the first uncompleted challenge
            return challenge;
        }
        return null; // all challenges complete
    }

    /**
     * Format mastery status for LLM prompt.
     */
    getMasteryForPrompt() {
        const lines = [];
        for (const [action, m] of Object.entries(this.data.mastery)) {
            if (m.attempts >= 3) {
                const rate = Math.round((m.successes / m.attempts) * 100);
                const bar = rate >= 80 ? '🟢' : rate >= 50 ? '🟡' : '🔴';
                lines.push(`  ${bar} ${action}: ${rate}% (${m.successes}/${m.attempts})`);
            }
        }
        if (lines.length === 0) return '  No mastery data yet.';
        return lines.join('\n');
    }

    _load() {
        try {
            if (fs.existsSync(CURRICULUM_FILE)) {
                return JSON.parse(fs.readFileSync(CURRICULUM_FILE, 'utf8'));
            }
        } catch { }
        return { mastery: {}, completed: [], lastUpdated: new Date().toISOString() };
    }

    _save() {
        try {
            this.data.lastUpdated = new Date().toISOString();
            fs.writeFileSync(CURRICULUM_FILE, JSON.stringify(this.data, null, 2));
        } catch { }
    }
}

module.exports = { Curriculum, CHALLENGE_TEMPLATES };
