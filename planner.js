/**
 * planner.js — Recipe-Driven Auto-Planner for DIDDYBOT
 *
 * Reads Minecraft recipe data from mineflayer's registry and builds
 * dependency trees. The LLM decides WHAT to achieve, the planner
 * figures out HOW — producing an ordered step list.
 *
 * Recipe knowledge:
 *   - CRAFTING: Fully dynamic via mineflayer's recipesFor() — knows ALL vanilla recipes
 *   - SMELTING: Comprehensive hardcoded list (mineflayer doesn't expose smelting data)
 *   - MINING:   Dynamically built from minecraft-data block drops at runtime
 */

'use strict';

// ── Smelting recipes — comprehensive list of ALL vanilla smelting/smoking/blasting ──
const SMELT_RECIPES = {
    // ── Ores → Ingots/Materials ──
    raw_iron: 'iron_ingot',
    raw_gold: 'gold_ingot',
    raw_copper: 'copper_ingot',
    iron_ore: 'iron_ingot',
    gold_ore: 'gold_ingot',
    copper_ore: 'copper_ingot',
    deepslate_iron_ore: 'iron_ingot',
    deepslate_gold_ore: 'gold_ingot',
    deepslate_copper_ore: 'copper_ingot',
    nether_gold_ore: 'gold_ingot',
    ancient_debris: 'netherite_scrap',

    // ── Food (furnace + smoker) ──
    raw_beef: 'cooked_beef',
    raw_porkchop: 'cooked_porkchop',
    raw_chicken: 'cooked_chicken',
    raw_mutton: 'cooked_mutton',
    raw_rabbit: 'cooked_rabbit',
    raw_cod: 'cooked_cod',
    raw_salmon: 'cooked_salmon',
    potato: 'baked_potato',
    kelp: 'dried_kelp',
    chorus_fruit: 'popped_chorus_fruit',

    // ── Stone/Building ──
    cobblestone: 'stone',
    stone: 'smooth_stone',
    sandstone: 'smooth_sandstone',
    red_sandstone: 'smooth_red_sandstone',
    quartz_block: 'smooth_quartz',
    stone_bricks: 'cracked_stone_bricks',
    deepslate_bricks: 'cracked_deepslate_bricks',
    deepslate_tiles: 'cracked_deepslate_tiles',
    nether_bricks: 'cracked_nether_bricks',
    polished_blackstone_bricks: 'cracked_polished_blackstone_bricks',
    basalt: 'smooth_basalt',

    // ── Sand/Glass ──
    sand: 'glass',
    red_sand: 'red_stained_glass', // actually just glass, but red_sand → glass
    cobbled_deepslate: 'deepslate',

    // ── Clay/Bricks ──
    clay_ball: 'brick',
    clay: 'terracotta',

    // ── Terracotta → Glazed Terracotta (all 16 colors) ──
    white_terracotta: 'white_glazed_terracotta',
    orange_terracotta: 'orange_glazed_terracotta',
    magenta_terracotta: 'magenta_glazed_terracotta',
    light_blue_terracotta: 'light_blue_glazed_terracotta',
    yellow_terracotta: 'yellow_glazed_terracotta',
    lime_terracotta: 'lime_glazed_terracotta',
    pink_terracotta: 'pink_glazed_terracotta',
    gray_terracotta: 'gray_glazed_terracotta',
    light_gray_terracotta: 'light_gray_glazed_terracotta',
    cyan_terracotta: 'cyan_glazed_terracotta',
    purple_terracotta: 'purple_glazed_terracotta',
    blue_terracotta: 'blue_glazed_terracotta',
    brown_terracotta: 'brown_glazed_terracotta',
    green_terracotta: 'green_glazed_terracotta',
    red_terracotta: 'red_glazed_terracotta',
    black_terracotta: 'black_glazed_terracotta',

    // ── Wood → Charcoal (all log types) ──
    oak_log: 'charcoal',
    spruce_log: 'charcoal',
    birch_log: 'charcoal',
    jungle_log: 'charcoal',
    acacia_log: 'charcoal',
    dark_oak_log: 'charcoal',
    mangrove_log: 'charcoal',
    cherry_log: 'charcoal',
    stripped_oak_log: 'charcoal',
    stripped_spruce_log: 'charcoal',
    stripped_birch_log: 'charcoal',
    stripped_jungle_log: 'charcoal',
    stripped_acacia_log: 'charcoal',
    stripped_dark_oak_log: 'charcoal',
    stripped_mangrove_log: 'charcoal',
    stripped_cherry_log: 'charcoal',
    oak_wood: 'charcoal',
    spruce_wood: 'charcoal',
    birch_wood: 'charcoal',
    jungle_wood: 'charcoal',
    acacia_wood: 'charcoal',
    dark_oak_wood: 'charcoal',
    mangrove_wood: 'charcoal',
    cherry_wood: 'charcoal',
    stripped_oak_wood: 'charcoal',
    stripped_spruce_wood: 'charcoal',
    stripped_birch_wood: 'charcoal',
    stripped_jungle_wood: 'charcoal',
    stripped_acacia_wood: 'charcoal',
    stripped_dark_oak_wood: 'charcoal',
    stripped_mangrove_wood: 'charcoal',
    stripped_cherry_wood: 'charcoal',

    // ── Dyes (smelting flowers/cactus/sea pickle) ──
    cactus: 'green_dye',
    sea_pickle: 'lime_dye',

    // ── Misc ──
    wet_sponge: 'sponge',
    netherrack: 'nether_brick',
    nether_quartz_ore: 'quartz',
};

// Reverse: what do I need to smelt to GET this item?
const SMELT_INPUTS = {};
for (const [input, output] of Object.entries(SMELT_RECIPES)) {
    if (!SMELT_INPUTS[output]) SMELT_INPUTS[output] = [];
    SMELT_INPUTS[output].push(input);
}

// Items that are generic "any wood" — the bot can use any log type
const ANY_LOG = [
    'oak_log', 'spruce_log', 'birch_log', 'jungle_log',
    'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
];
const ANY_PLANKS = [
    'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks',
];

class RecipePlanner {
    constructor(bot) {
        this.bot = bot;
        this._currentPlan = [];
        this._planTarget = null;   // what we're planning for

        // ── Build mining drop tables dynamically from game registry ──────
        // This replaces the old hardcoded MINE_DROPS / MINE_SOURCES.
        // Reads block.drops from minecraft-data so it covers ALL blocks automatically.
        this._mineDrops = {};   // blockName → itemName
        this._mineSources = {}; // itemName → [blockName, ...]
        this._buildMineSources();
    }

    /**
     * Build MINE_DROPS and MINE_SOURCES dynamically from the bot's registry.
     * Each block's `drops` array contains item IDs that the block drops.
     * This covers all 800+ blocks with drop data — no hardcoding needed.
     */
    _buildMineSources() {
        try {
            const blocks = this.bot.registry?.blocksArray;
            if (!blocks) return;

            for (const block of blocks) {
                if (!block.drops || block.drops.length === 0) continue;
                // Use the first drop as the primary drop item
                const dropId = block.drops[0];
                const dropItem = this.bot.registry.items[dropId];
                if (!dropItem) continue;

                this._mineDrops[block.name] = dropItem.name;
                if (!this._mineSources[dropItem.name]) {
                    this._mineSources[dropItem.name] = [];
                }
                this._mineSources[dropItem.name].push(block.name);
            }
            console.log(`[Planner] 📖 Loaded ${Object.keys(this._mineDrops).length} block→drop mappings from registry`);
        } catch (e) {
            console.warn(`[Planner] ⚠️ Failed to build mine sources from registry: ${e.message}`);
        }
    }

    /**
     * Build a full dependency plan to obtain `count` of `itemName`.
     * Returns an ordered list of steps: { type, item, count, reason }
     *
     * Step types:
     *   'mine'   — mine a block to get the item
     *   'craft'  — craft the item using a recipe
     *   'smelt'  — smelt an input to get the item
     */
    planFor(itemName, count = 1) {
        this._planTarget = itemName;
        const steps = [];
        const needed = {};  // track what we still need

        this._resolve(itemName, count, steps, needed, 0);

        this._currentPlan = steps;
        return steps;
    }

    /**
     * Get the next step that hasn't been satisfied by inventory.
     * Re-checks inventory each time so it skips completed steps.
     * Returns null if plan is complete.
     */
    getNextStep() {
        if (this._currentPlan.length === 0) return null;

        const inv = this._readInv();

        for (let i = 0; i < this._currentPlan.length; i++) {
            const step = this._currentPlan[i];

            // Check if this step's output is already satisfied
            if (step.type === 'mine') {
                // For mining, check if we have enough of the drop item
                const have = this._countItem(inv, step.item);
                if (have >= step.count) continue; // already have it
            } else if (step.type === 'craft') {
                const have = this._countItem(inv, step.item);
                if (have >= step.count) continue;
            } else if (step.type === 'smelt') {
                const have = this._countItem(inv, step.item);
                if (have >= step.count) continue;
            }

            // This step needs doing — return it
            return { ...step, stepIndex: i, totalSteps: this._currentPlan.length };
        }

        // All steps satisfied!
        this._currentPlan = [];
        return null;
    }

    /**
     * Map a plan step to a brain action.
     * Returns { action, target, reason } compatible with brain.js action system.
     */
    stepToAction(step) {
        switch (step.type) {
            case 'mine': {
                // Determine what mining action to use
                const item = step.item;
                if (item.includes('_log') || item.includes('_wood'))
                    return { action: 'mine_wood', target: 'log', reason: step.reason };
                if (item === 'cobblestone' || item === 'stone')
                    return { action: 'mine_stone', target: 'cobblestone', reason: step.reason };
                if (item === 'raw_iron')
                    return { action: 'mine_iron', target: 'iron_ore', reason: step.reason };
                if (item === 'coal')
                    return { action: 'mine_coal', target: 'coal_ore', reason: step.reason };
                if (item === 'diamond')
                    return { action: 'mine_diamond', target: 'diamond_ore', reason: step.reason };
                if (item === 'raw_gold')
                    return { action: 'mine_iron', target: 'gold_ore', reason: step.reason };
                // Generic mining
                return { action: 'mine_wood', target: item, reason: step.reason };
            }
            case 'craft':
                return { action: 'craft', target: step.item, reason: step.reason };
            case 'smelt':
                return { action: 'smelt', target: step.smeltInput || step.item, reason: step.reason };
            default:
                return { action: 'explore', target: '', reason: step.reason };
        }
    }

    /** Check if we have an active plan */
    hasPlan() {
        return this._currentPlan.length > 0;
    }

    /** Clear the current plan */
    clearPlan() {
        this._currentPlan = [];
        this._planTarget = null;
    }

    /** Get human-readable plan summary */
    getPlanSummary() {
        if (this._currentPlan.length === 0) return 'No plan';
        const inv = this._readInv();
        const remaining = this._currentPlan.filter(step => {
            const have = this._countItem(inv, step.item);
            return have < step.count;
        });
        return `Plan for ${this._planTarget}: ${remaining.length}/${this._currentPlan.length} steps remaining`;
    }

    // ── Dependency resolution ──────────────────────────────────────────────

    /**
     * Recursively resolve what's needed to obtain `count` of `itemName`.
     * Appends steps to the `steps` array in dependency order (leaves first).
     */
    _resolve(itemName, count, steps, needed, depth) {
        if (depth > 10) return; // prevent infinite recursion

        const inv = this._readInv();
        const have = this._countItem(inv, itemName);
        const still_need = count - have;

        if (still_need <= 0) return; // already have enough

        // Track to avoid duplicating steps
        const key = itemName;
        if (needed[key] && needed[key] >= still_need) return;
        needed[key] = still_need;

        // ── Can we CRAFT it? (check BEFORE mining — sticks, planks, etc.) ──
        const recipe = this._lookupRecipe(itemName);
        if (recipe) {
            // Resolve each ingredient first (dependencies come before the craft step)
            for (const ingredient of recipe.ingredients) {
                this._resolve(ingredient.name, ingredient.count * Math.ceil(still_need / recipe.outputCount), steps, needed, depth + 1);
            }
            steps.push({
                type: 'craft',
                item: itemName,
                count: still_need,
                needsTable: recipe.needsTable,
                reason: `Craft ${still_need}× ${itemName}`,
            });
            return;
        }

        // ── Can we MINE it? ─────────────────────────────────────────
        // Only for raw materials — never mine for craftable items
        if (this._mineSources[itemName]) {
            steps.push({
                type: 'mine',
                item: itemName,
                count: still_need,
                block: this._mineSources[itemName][0],
                reason: `Mine ${still_need}× ${itemName}`,
            });
            return;
        }

        // Special case: any wood log
        if (itemName === 'log' || itemName === 'oak_log') {
            steps.push({
                type: 'mine',
                item: itemName,
                count: still_need,
                block: 'oak_log',
                reason: `Chop ${still_need}× wood`,
            });
            return;
        }

        // ── Can we SMELT it? ────────────────────────────────────────
        if (SMELT_INPUTS[itemName]) {
            const input = SMELT_INPUTS[itemName][0]; // prefer first source
            // Need the input item + fuel
            this._resolve(input, still_need, steps, needed, depth + 1);
            // Need fuel (coal preferred)
            this._resolve('coal', Math.ceil(still_need / 8), steps, needed, depth + 1);
            // Need furnace (check if in inventory or placed nearby)
            if (!this._hasFurnace()) {
                this._resolve('furnace', 1, steps, needed, depth + 1);
            }
            steps.push({
                type: 'smelt',
                item: itemName,
                smeltInput: input,
                count: still_need,
                reason: `Smelt ${still_need}× ${input} → ${itemName}`,
            });
            return;
        }

        // ── Safety net: items that are OBVIOUSLY craftable ────────────
        // If recipe lookup failed (no crafting table placed), don't mine these
        const CRAFT_PATTERNS = [
            '_pickaxe', '_axe', '_sword', '_shovel', '_hoe',
            '_helmet', '_chestplate', '_leggings', '_boots',
            'shield', 'bucket', 'furnace', 'crafting_table',
            'chest', 'torch', 'ladder', 'fence', 'door',
            'bowl', 'boat', 'compass', 'clock', 'shears',
            'enchanting_table', 'anvil', 'brewing_stand',
        ];

        if (CRAFT_PATTERNS.some(p => itemName.includes(p))) {
            console.log(`[Planner] ⚠️ No recipe found for ${itemName} — using craft fallback`);

            // Resolve basic material dependencies for tool patterns
            if (itemName.includes('wooden_')) {
                this._resolve('oak_planks', 3, steps, needed, depth + 1);
                this._resolve('stick', 2, steps, needed, depth + 1);
            } else if (itemName.includes('stone_')) {
                this._resolve('cobblestone', 3, steps, needed, depth + 1);
                this._resolve('stick', 2, steps, needed, depth + 1);
            } else if (itemName.includes('iron_') && !itemName.includes('raw_iron')) {
                this._resolve('iron_ingot', 3, steps, needed, depth + 1);
                this._resolve('stick', 2, steps, needed, depth + 1);
            } else if (itemName.includes('diamond_')) {
                this._resolve('diamond', 3, steps, needed, depth + 1);
                this._resolve('stick', 2, steps, needed, depth + 1);
            }

            // Tools need a crafting table
            this._resolve('crafting_table', 1, steps, needed, depth + 1);

            steps.push({
                type: 'craft',
                item: itemName,
                count: still_need,
                needsTable: true,
                reason: `Craft ${still_need}× ${itemName}`,
            });
            return;
        }

        // ── True fallback: mine the block directly ─────────────────
        // Only for raw blocks like dirt, sand, gravel
        steps.push({
            type: 'mine',
            item: itemName,
            count: still_need,
            block: itemName,
            reason: `Gather ${still_need}× ${itemName}`,
        });
    }

    /**
     * Look up how to craft an item using mineflayer's recipe system.
     * Returns { ingredients: [{name, count}], outputCount, needsTable } or null.
     *
     * IMPORTANT: Always checks 3x3 recipes (crafting table) even if no table is
     * placed nearby. This is critical for the planner — it needs to know what
     * CAN be crafted so it resolves dependencies correctly.
     */
    _lookupRecipe(itemName) {
        try {
            const itemData = this.bot.registry.itemsByName[itemName];
            if (!itemData) return null;

            // Try hand-crafting (2x2) first
            let recipes = this.bot.recipesFor(itemData.id, null, 1, null);

            // Also try with crafting table — look for a real one first,
            // but if none found, use a "fake" table reference to check recipe existence.
            const table = this.bot.findBlock({
                matching: b => b.name === 'crafting_table',
                maxDistance: 32,
            });

            if (table) {
                const tableRecipes = this.bot.recipesFor(itemData.id, null, 1, table);
                if (tableRecipes.length > recipes.length) recipes = tableRecipes;
            } else {
                // No table nearby — check if recipe EXISTS with crafting table
                // by passing true (mineflayer accepts boolean for "has table")
                try {
                    const tableRecipes = this.bot.recipesFor(itemData.id, null, 1, true);
                    if (tableRecipes.length > recipes.length) recipes = tableRecipes;
                } catch {
                    // Older mineflayer may not support boolean — ignore
                }
            }

            if (recipes.length === 0) return null;

            const recipe = recipes[0];
            const ingredients = [];
            const seen = {};

            // Parse recipe ingredients
            // mineflayer recipes have either 'delta' or 'ingredients' format
            if (recipe.delta) {
                for (const delta of recipe.delta) {
                    if (delta.count < 0) {
                        // Negative count = consumed ingredient
                        const ingItem = this.bot.registry.items[delta.id];
                        if (ingItem) {
                            const name = ingItem.name;
                            if (seen[name]) {
                                seen[name].count += Math.abs(delta.count);
                            } else {
                                seen[name] = { name, count: Math.abs(delta.count) };
                                ingredients.push(seen[name]);
                            }
                        }
                    }
                }
            }

            // Determine output count
            let outputCount = 1;
            if (recipe.delta) {
                const outDelta = recipe.delta.find(d => {
                    const item = this.bot.registry.items[d.id];
                    return item && item.name === itemName && d.count > 0;
                });
                if (outDelta) outputCount = outDelta.count;
            }
            if (recipe.result) {
                outputCount = recipe.result.count || 1;
            }

            // Does it need a crafting table? (3x3 recipes do)
            const needsTable = recipe.inShape && recipe.inShape.length > 0 &&
                (recipe.inShape.length > 2 ||
                    (recipe.inShape[0] && recipe.inShape[0].length > 2));

            return { ingredients, outputCount, needsTable };
        } catch (e) {
            return null;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    _readInv() {
        const inv = {};
        for (const item of this.bot.inventory.items()) {
            inv[item.name] = (inv[item.name] || 0) + item.count;
        }
        return inv;
    }

    _countItem(inv, itemName) {
        // Direct match
        if (inv[itemName]) return inv[itemName];

        // Wildcard matching for generic items
        if (itemName === 'log' || itemName === 'oak_log') {
            return ANY_LOG.reduce((sum, name) => sum + (inv[name] || 0), 0);
        }
        if (itemName === 'planks' || itemName === 'oak_planks') {
            return ANY_PLANKS.reduce((sum, name) => sum + (inv[name] || 0), 0);
        }

        return 0;
    }

    _hasFurnace() {
        // Check inventory
        const inv = this._readInv();
        if (inv.furnace) return true;
        // Check nearby placed furnaces
        const furnace = this.bot.findBlock({
            matching: b => b.name === 'furnace' || b.name === 'lit_furnace',
            maxDistance: 32,
        });
        return !!furnace;
    }
}

module.exports = { RecipePlanner, SMELT_RECIPES };
