/**
 * goals.js — Full Minecraft Progression System
 *
 * ~50 milestones covering the entire game from punching first tree to
 * killing the Ender Dragon. The bot checks its state against each
 * milestone and works on the first uncompleted one.
 *
 * Milestones are grouped into PHASES. Each phase unlocks the next.
 */

'use strict';

// ── Inventory helpers ─────────────────────────────────────────────────────────

function countLogs(inv) {
    return Object.entries(inv).filter(([k]) => k.includes('_log')).reduce((s, [, v]) => s + v, 0);
}
function countPlanks(inv) {
    return Object.entries(inv).filter(([k]) => k.includes('_planks')).reduce((s, [, v]) => s + v, 0);
}
function hasItem(inv, name) { return (inv[name] || 0) > 0; }
function hasAny(inv, ...names) { return names.some(n => hasItem(inv, n)); }
function countItem(inv, name) { return inv[name] || 0; }
function hasWoodTools(inv) {
    return hasItem(inv, 'wooden_pickaxe') && hasItem(inv, 'wooden_axe') &&
        hasItem(inv, 'wooden_sword') && hasItem(inv, 'wooden_shovel');
}
function hasStoneTools(inv) {
    return hasItem(inv, 'stone_pickaxe') && hasItem(inv, 'stone_axe') &&
        hasItem(inv, 'stone_sword') && hasItem(inv, 'stone_shovel');
}
function hasIronTools(inv) {
    return hasItem(inv, 'iron_pickaxe') && hasItem(inv, 'iron_axe') &&
        hasItem(inv, 'iron_sword') && hasItem(inv, 'iron_shovel');
}
function hasDiamondTools(inv) {
    return hasItem(inv, 'diamond_pickaxe') && hasItem(inv, 'diamond_sword');
}
function hasAnyArmor(inv) {
    return Object.keys(inv).some(k =>
        k.includes('_helmet') || k.includes('_chestplate') ||
        k.includes('_leggings') || k.includes('_boots'));
}
function hasFullIronArmor(inv) {
    return hasItem(inv, 'iron_helmet') && hasItem(inv, 'iron_chestplate') &&
        hasItem(inv, 'iron_leggings') && hasItem(inv, 'iron_boots');
}

// ── Milestone definitions ─────────────────────────────────────────────────────
// Each milestone: { id, phase, name, description, check(bot, inv, memory), suggestedAction }

const MILESTONES = [
    // ═══════════ PHASE 1: WOOD AGE ═══════════
    {
        id: 'get_wood', phase: 1,
        name: 'Gather Wood',
        description: 'Punch trees — get at least 8 logs',
        check: (bot, inv) => countLogs(inv) >= 8 || countPlanks(inv) >= 16,
        suggestedAction: 'mine_wood',
    },
    {
        id: 'craft_basics', phase: 1,
        name: 'Craft Planks & Sticks',
        description: 'Turn logs into planks and sticks',
        check: (bot, inv) => countPlanks(inv) >= 8 && countItem(inv, 'stick') >= 4,
        suggestedAction: 'craft',
    },
    {
        id: 'crafting_table', phase: 1,
        name: 'Make a Crafting Table',
        description: 'Craft and place a crafting table',
        check: (bot, inv) => hasItem(inv, 'crafting_table'),
        suggestedAction: 'craft',
    },
    {
        id: 'full_wooden_tools', phase: 1,
        name: 'Full Wooden Tool Set',
        description: 'Craft wooden pickaxe, axe, sword, and shovel',
        check: (bot, inv) => hasWoodTools(inv),
        suggestedAction: 'craft',
    },

    // ═══════════ PHASE 2: STONE AGE ═══════════
    {
        id: 'mine_stone', phase: 2,
        name: 'Mine Cobblestone',
        description: 'Use wooden pickaxe to mine at least 16 cobblestone',
        check: (bot, inv) => countItem(inv, 'cobblestone') >= 16,
        suggestedAction: 'mine_stone',
    },
    {
        id: 'stone_tools', phase: 2,
        name: 'Full Stone Tool Set',
        description: 'Craft stone pickaxe, axe, sword, and shovel',
        check: (bot, inv) => hasStoneTools(inv),
        suggestedAction: 'upgrade_tools',
    },
    {
        id: 'build_shelter', phase: 2,
        name: 'Build a Shelter',
        description: 'Build a shelter to survive the night',
        check: (bot, inv, mem) => !!mem.knownLocations['shelter'],
        suggestedAction: 'build_shelter',
    },

    // ═══════════ PHASE 3: COAL & TORCHES ═══════════
    {
        id: 'mine_coal', phase: 3,
        name: 'Mine Coal',
        description: 'Mine at least 8 coal ore',
        check: (bot, inv) => countItem(inv, 'coal') >= 8,
        suggestedAction: 'mine_coal',
    },
    {
        id: 'craft_torches', phase: 3,
        name: 'Craft Torches',
        description: 'Craft torches from coal + sticks',
        check: (bot, inv) => countItem(inv, 'torch') >= 8,
        suggestedAction: 'craft',
    },
    {
        id: 'furnace', phase: 3,
        name: 'Build a Furnace',
        description: 'Craft a furnace from 8 cobblestone',
        check: (bot, inv) => hasItem(inv, 'furnace'),
        suggestedAction: 'craft',
    },
    {
        id: 'cook_food', phase: 3,
        name: 'Cook Food',
        description: 'Kill an animal and cook the meat in a furnace',
        check: (bot, inv) => hasAny(inv, 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'cooked_cod', 'cooked_salmon'),
        suggestedAction: 'smelt',
    },

    // ═══════════ PHASE 4: IRON AGE ═══════════
    {
        id: 'mine_iron', phase: 4,
        name: 'Mine Iron Ore',
        description: 'Mine at least 12 iron ore (need stone pickaxe)',
        check: (bot, inv) => countItem(inv, 'raw_iron') >= 12 || countItem(inv, 'iron_ingot') >= 12,
        suggestedAction: 'mine_iron',
    },
    {
        id: 'smelt_iron', phase: 4,
        name: 'Smelt Iron Ingots',
        description: 'Smelt raw iron into iron ingots',
        check: (bot, inv) => countItem(inv, 'iron_ingot') >= 12,
        suggestedAction: 'smelt',
    },
    {
        id: 'iron_tools', phase: 4,
        name: 'Iron Tool Set',
        description: 'Craft iron pickaxe, axe, sword, and shovel',
        check: (bot, inv) => hasIronTools(inv),
        suggestedAction: 'upgrade_tools',
    },
    {
        id: 'iron_armor', phase: 4,
        name: 'Iron Armor Set',
        description: 'Craft a full set of iron armor',
        check: (bot, inv) => hasFullIronArmor(inv),
        suggestedAction: 'craft',
    },
    {
        id: 'shield', phase: 4,
        name: 'Craft a Shield',
        description: 'Craft a shield from iron + planks',
        check: (bot, inv) => hasItem(inv, 'shield'),
        suggestedAction: 'craft',
    },
    {
        id: 'bucket', phase: 4,
        name: 'Craft a Bucket',
        description: 'Craft an iron bucket — essential for water and lava',
        check: (bot, inv) => hasItem(inv, 'bucket') || hasItem(inv, 'water_bucket'),
        suggestedAction: 'craft',
    },

    // ═══════════ PHASE 5: FOOD SUSTAINABILITY ═══════════
    {
        id: 'get_seeds', phase: 5,
        name: 'Collect Seeds',
        description: 'Break grass to collect wheat seeds',
        check: (bot, inv) => countItem(inv, 'wheat_seeds') >= 4,
        suggestedAction: 'seek_food',
    },
    {
        id: 'start_farm', phase: 5,
        name: 'Start a Farm',
        description: 'Use hoe to till dirt near water and plant seeds',
        check: (bot, inv, mem) => !!mem.knownLocations['farm'],
        suggestedAction: 'use_skill',
    },
    {
        id: 'bread', phase: 5,
        name: 'Make Bread',
        description: 'Harvest wheat and craft bread (3 wheat = 1 bread)',
        check: (bot, inv) => hasItem(inv, 'bread'),
        suggestedAction: 'craft',
    },

    // ═══════════ PHASE 6: DIAMOND AGE ═══════════
    {
        id: 'mine_diamond', phase: 6,
        name: 'Find Diamonds',
        description: 'Mine at Y=11 to find diamonds (need iron pickaxe)',
        check: (bot, inv) => countItem(inv, 'diamond') >= 3,
        suggestedAction: 'mine_diamond',
    },
    {
        id: 'diamond_tools', phase: 6,
        name: 'Diamond Pickaxe & Sword',
        description: 'Craft diamond pickaxe and diamond sword',
        check: (bot, inv) => hasDiamondTools(inv),
        suggestedAction: 'craft',
    },
    {
        id: 'enchanting_table', phase: 6,
        name: 'Enchanting Table',
        description: 'Craft enchanting table (4 obsidian + 2 diamonds + book)',
        check: (bot, inv) => hasItem(inv, 'enchanting_table'),
        suggestedAction: 'craft',
    },

    // ═══════════ PHASE 7: NETHER ═══════════
    {
        id: 'obsidian', phase: 7,
        name: 'Mine Obsidian',
        description: 'Get at least 10 obsidian blocks (need diamond pickaxe)',
        check: (bot, inv) => countItem(inv, 'obsidian') >= 10,
        suggestedAction: 'use_skill',
    },
    {
        id: 'nether_portal', phase: 7,
        name: 'Build Nether Portal',
        description: 'Build and light a nether portal',
        check: (bot, inv, mem) => !!mem.knownLocations['nether_portal'],
        suggestedAction: 'use_skill',
    },
    {
        id: 'blaze_rods', phase: 7,
        name: 'Get Blaze Rods',
        description: 'Kill blazes in a nether fortress to get blaze rods',
        check: (bot, inv) => countItem(inv, 'blaze_rod') >= 6,
        suggestedAction: 'use_skill',
    },
    {
        id: 'ender_pearls', phase: 7,
        name: 'Get Ender Pearls',
        description: 'Kill endermen to collect ender pearls',
        check: (bot, inv) => countItem(inv, 'ender_pearl') >= 12,
        suggestedAction: 'use_skill',
    },
    {
        id: 'eyes_of_ender', phase: 7,
        name: 'Craft Eyes of Ender',
        description: 'Craft eyes of ender from blaze powder + ender pearls',
        check: (bot, inv) => countItem(inv, 'ender_eye') >= 12,
        suggestedAction: 'craft',
    },

    // ═══════════ PHASE 8: THE END ═══════════
    {
        id: 'find_stronghold', phase: 8,
        name: 'Find the Stronghold',
        description: 'Use eyes of ender to locate the stronghold',
        check: (bot, inv, mem) => !!mem.knownLocations['stronghold'],
        suggestedAction: 'use_skill',
    },
    {
        id: 'end_portal', phase: 8,
        name: 'Activate End Portal',
        description: 'Fill the end portal with eyes of ender',
        check: (bot, inv, mem) => !!mem.knownLocations['end_portal'],
        suggestedAction: 'use_skill',
    },
    {
        id: 'kill_dragon', phase: 8,
        name: '🐉 Kill the Ender Dragon',
        description: 'Destroy the end crystals and defeat the dragon!',
        check: (bot, inv, mem) => !!mem.achievements?.['dragon_slayer'],
        suggestedAction: 'use_skill',
    },
];

// ── GoalTracker class ─────────────────────────────────────────────────────────

class GoalTracker {
    constructor() {
        this.milestones = MILESTONES;
        this.completed = new Set();
    }

    /**
     * Evaluate all milestones. Returns { completed, current, phase, progress }.
     */
    evaluate(bot, inv, memory) {
        this.completed = new Set();
        let current = null;

        for (const m of this.milestones) {
            try {
                if (m.check(bot, inv, memory)) {
                    this.completed.add(m.id);
                } else if (!current) {
                    current = m;
                }
            } catch {
                if (!current) current = m;
            }
        }

        return {
            completed: [...this.completed],
            current,
            phase: current ? current.phase : 8,
            progress: `${this.completed.size}/${this.milestones.length}`,
        };
    }

    /**
     * Format for LLM prompt — shows tech tree status.
     */
    getProgressForPrompt(bot, inv, memory) {
        const status = this.evaluate(bot, inv, memory);
        const currentPhase = status.current ? status.current.phase : 8;

        // Only show milestones from current phase and one ahead
        const visible = this.milestones.filter(m =>
            m.phase <= currentPhase + 1
        );

        const lines = [`  Progress: ${status.progress} | Phase ${currentPhase}/8`];

        let lastPhase = 0;
        for (const m of visible) {
            if (m.phase !== lastPhase) {
                const phaseNames = {
                    1: 'WOOD AGE', 2: 'STONE AGE', 3: 'COAL & TORCHES',
                    4: 'IRON AGE', 5: 'FOOD', 6: 'DIAMOND AGE',
                    7: 'NETHER', 8: 'THE END'
                };
                lines.push(`  ── ${phaseNames[m.phase] || `PHASE ${m.phase}`} ──`);
                lastPhase = m.phase;
            }

            const done = this.completed.has(m.id);
            const isCurrent = status.current && status.current.id === m.id;
            const mark = done ? '✅' : isCurrent ? '👉' : '⬜';
            lines.push(`  ${mark} ${m.name}${isCurrent ? ' ← DO THIS NOW' : ''}`);
        }

        if (status.current) {
            lines.push('');
            lines.push(`  🎯 OBJECTIVE: ${status.current.description}`);
            lines.push(`  💡 ACTION: ${status.current.suggestedAction}`);
        } else {
            lines.push('');
            lines.push('  🏆 ALL MILESTONES COMPLETE!');
        }

        return lines.join('\n');
    }

    /**
     * Get just the current milestone for deterministic action selection.
     */
    getCurrentMilestone(bot, inv, memory) {
        const status = this.evaluate(bot, inv, memory);
        return status.current;
    }
}

module.exports = { GoalTracker, MILESTONES };
