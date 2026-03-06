/**
 * game_knowledge.js — Registry-Based Game Knowledge for DIDDYBOT
 *
 * Instead of hardcoding Minecraft mechanics, this module reads them
 * directly from mineflayer's built-in minecraft-data registry.
 * Works for any Minecraft version and even modded blocks.
 *
 * Usage:
 *   const gk = new GameKnowledge(bot);
 *   const bestTool = gk.getBestToolFor(block);
 *   const recipe = gk.getRecipeChain('wooden_pickaxe');
 *   const foodInfo = gk.getFoodItems();
 */

'use strict';

class GameKnowledge {
    constructor(bot) {
        this.bot = bot;
        // Cache tool items by category for fast lookup
        this._toolCache = null;
    }

    /**
     * Find the best tool in inventory for breaking a specific block.
     * Uses the game's own harvest data — no hardcoding needed.
     * Returns the item to equip, or null if bare hand is best.
     */
    getBestToolFor(block) {
        if (!block) return null;

        const items = this.bot.inventory.items();
        if (items.length === 0) return null;

        // Get the tools from inventory
        const tools = items.filter(i =>
            i.name.includes('_pickaxe') ||
            i.name.includes('_axe') ||
            i.name.includes('_shovel') ||
            i.name.includes('_hoe') ||
            i.name.includes('_sword') ||
            i.name.includes('shears')
        );

        if (tools.length === 0) return null;

        // Method 1: Use block.harvestTools if available (exact match)
        const harvestTools = block.harvestTools;
        if (harvestTools) {
            // harvestTools is { itemId: true, ... } — find the best tool we own
            const validTools = tools.filter(t => harvestTools[t.type]);
            if (validTools.length > 0) {
                // Return highest-tier tool (diamond > iron > stone > golden > wooden)
                return this._bestTier(validTools);
            }
        }

        // Method 2: Use block.material field (e.g. "mineable/axe", "mineable/pickaxe")
        const material = block.material;
        if (material) {
            const toolType = this._materialToToolType(material);
            if (toolType) {
                const matching = tools.filter(t => t.name.includes(toolType));
                if (matching.length > 0) return this._bestTier(matching);
            }
        }

        // Method 3: Compare dig times — only check actual tools, not random items
        let bestTool = null;
        let bestTime = Infinity;

        // Check bare hand first
        try {
            const bareTime = block.digTime(null, false, false, false);
            bestTime = bareTime;
        } catch { /* skip */ }

        for (const tool of tools) {
            try {
                const time = block.digTime(tool.type, false, false, false);
                if (time < bestTime) {
                    bestTime = time;
                    bestTool = tool;
                }
            } catch { /* skip invalid */ }
        }

        return bestTool;
    }

    /**
     * Check if a block REQUIRES a specific tool type to drop items.
     * Stone mined by hand drops nothing — you need a pickaxe.
     */
    requiresTool(block) {
        return block.harvestTools != null && Object.keys(block.harvestTools).length > 0;
    }

    /**
     * Get all food items currently in inventory with their food/saturation values.
     */
    getFoodItems() {
        const foods = [];
        const items = this.bot.inventory.items();

        for (const item of items) {
            const foodData = this.bot.registry.foodsByName?.[item.name]
                || this.bot.registry.itemsByName?.[item.name];
            if (foodData && (foodData.foodPoints || foodData.saturation)) {
                foods.push({
                    name: item.name,
                    count: item.count,
                    foodPoints: foodData.foodPoints || 0,
                    saturation: foodData.saturation || 0,
                    slot: item.slot,
                    item
                });
            }
        }

        // Sort by food points (best food first)
        foods.sort((a, b) => b.foodPoints - a.foodPoints);
        return foods;
    }

    /**
     * Generate a compact summary of what the bot knows about nearby resources.
     * Useful for injecting into an LLM prompt.
     */
    getToolAdvice() {
        const inv = this.bot.inventory.items();
        const tools = inv.filter(i =>
            i.name.includes('_pickaxe') || i.name.includes('_axe') ||
            i.name.includes('_shovel') || i.name.includes('_sword')
        );

        if (tools.length === 0) return 'No tools — craft wooden tools first.';

        const advice = tools.map(t => {
            const tier = t.name.split('_')[0];
            const type = t.name.split('_').slice(1).join('_');
            return `${tier} ${type}`;
        });

        return `Tools: ${advice.join(', ')}`;
    }

    // ── Internals ─────────────────────────────────────────────────────────

    /** Map block material string to tool suffix */
    _materialToToolType(material) {
        if (!material) return null;
        const m = material.toLowerCase();
        if (m.includes('axe') && !m.includes('pickaxe')) return '_axe';
        if (m.includes('pickaxe')) return '_pickaxe';
        if (m.includes('shovel')) return '_shovel';
        if (m.includes('hoe')) return '_hoe';
        return null;
    }

    /** Pick the highest-tier tool from a list */
    _bestTier(tools) {
        const tierOrder = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
        for (const tier of tierOrder) {
            const match = tools.find(t => t.name.startsWith(tier));
            if (match) return match;
        }
        return tools[0]; // fallback to first
    }
}

module.exports = { GameKnowledge };
