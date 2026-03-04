/**
 * goals.js — Tech Tree Progression System for DIDDYBOT
 *
 * Tracks what the bot has achieved and determines the next milestone.
 * Injected into the LLM prompt so it always knows what to work toward.
 */

'use strict';

const MILESTONES = [
    {
        id: 'get_wood',
        name: 'Gather Wood',
        description: 'Punch trees to get at least 8 logs',
        check: (bot, inv) => {
            const logCount = Object.entries(inv).filter(([k]) => k.includes('_log')).reduce((s, [, v]) => s + v, 0);
            const plankCount = Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
            return logCount >= 8 || plankCount >= 16;
        },
        suggestedAction: 'mine_wood',
    },
    {
        id: 'craft_basics',
        name: 'Craft Planks & Sticks',
        description: 'Turn logs into planks and craft sticks — needed for all tools',
        check: (bot, inv) => {
            const plankCount = Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
            return plankCount >= 8 && (inv.stick || 0) >= 4;
        },
        suggestedAction: 'craft',
    },
    {
        id: 'full_wooden_tools',
        name: 'Full Wooden Tool Set',
        description: 'Craft a wooden pickaxe, wooden axe, wooden sword, AND wooden shovel',
        check: (bot, inv) => {
            return !!inv.wooden_pickaxe && !!inv.wooden_axe &&
                !!inv.wooden_sword && !!inv.wooden_shovel;
        },
        suggestedAction: 'craft',
    },
    {
        id: 'build_shelter',
        name: 'Build a Shelter',
        description: 'Gather 20+ blocks and build a shelter to survive the night',
        check: (bot, inv, memory) => !!memory.knownLocations['shelter'],
        suggestedAction: 'build_shelter',
    },
];

class GoalTracker {
    constructor() {
        this.milestones = MILESTONES;
        this.completed = new Set();
    }

    /**
     * Evaluate all milestones against current state.
     * Returns { completed: [...], current: milestone, progress: "5/12" }
     */
    evaluate(bot, inv, memory) {
        this.completed = new Set();
        let current = null;

        for (const m of this.milestones) {
            try {
                if (m.check(bot, inv, memory)) {
                    this.completed.add(m.id);
                } else if (!current) {
                    current = m;  // first uncompleted milestone
                }
            } catch {
                if (!current) current = m;
            }
        }

        return {
            completed: [...this.completed],
            current,
            progress: `${this.completed.size}/${this.milestones.length}`,
        };
    }

    /**
     * Format for LLM prompt — shows tech tree status.
     */
    getProgressForPrompt(bot, inv, memory) {
        const status = this.evaluate(bot, inv, memory);
        const lines = this.milestones.map(m => {
            const done = this.completed.has(m.id);
            const isCurrent = status.current && status.current.id === m.id;
            const mark = done ? '✅' : isCurrent ? '👉' : '⬜';
            return `  ${mark} ${m.name}${isCurrent ? ' ← DO THIS NOW' : ''}`;
        });

        lines.unshift(`  Progress: ${status.progress}`);
        if (status.current) {
            lines.push(`\n  CURRENT OBJECTIVE: ${status.current.description}`);
            lines.push(`  SUGGESTED ACTION: ${status.current.suggestedAction}`);
        }
        return lines.join('\n');
    }
}

module.exports = { GoalTracker };
