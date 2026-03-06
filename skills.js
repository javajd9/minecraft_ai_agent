/**
 * skills.js — Expanded Skill Library for DIDDYBOT
 *
 * Each skill wraps mineflayer's built-in methods into a reusable,
 * self-contained action. The LLM picks a skill by name, and the
 * skill handles all the low-level logic.
 *
 * Skills use bot.registry data — no hardcoded Minecraft knowledge.
 */

'use strict';

const Vec3 = require('vec3');
const { goals: { GoalNear, GoalBlock } } = require('mineflayer-pathfinder');

class SkillLibrary {
    constructor(bot, gameKnowledge) {
        this.bot = bot;
        this.gk = gameKnowledge;
    }

    /**
     * List all available skills for the LLM prompt.
     */
    getSkillList() {
        return [
            'mine_wood      — chop nearby trees (mines multiple logs)',
            'mine_stone     — mine stone/cobblestone (needs pickaxe)',
            'mine_iron      — mine iron ore (needs stone+ pickaxe)',
            'mine_coal      — mine coal ore (needs pickaxe)',
            'mine_diamond   — mine diamond ore (needs iron+ pickaxe)',
            'craft          — auto-craft next needed item (tools, planks, etc)',
            'upgrade_tools  — craft the next tier of tools (stone → iron → diamond)',
            'seek_food      — hunt nearest animal for food',
            'eat            — eat the best food in inventory',
            'smelt          — place furnace and smelt raw ores/food',
            'build_shelter  — build a simple 5x5 shelter from available blocks',
            'place_torch    — place a torch for light',
            'sleep          — find/craft a bed and sleep through night',
            'explore        — walk toward unexplored areas',
            'flee           — run away from nearest threat',
            'attack_mob     — fight nearest hostile mob',
            'go_to_location — navigate to coordinates (target: x,y,z)',
            'store_items    — put items in a nearby chest (crafts one if needed)',
            'retrieve_items — get items back from a remembered chest',
            'equip_armor    — equip any armor pieces in inventory',
            'idle           — wait and observe',
        ];
    }

    // ── Eating ────────────────────────────────────────────────────────────

    /**
     * Eat the best food item in inventory.
     * Uses bot.consume() — the official mineflayer method.
     */
    async eat() {
        const foods = this._getFoodItems();
        if (foods.length === 0) {
            console.log('[Skills] 🍖 No food in inventory');
            return false;
        }

        const best = foods[0];
        try {
            await this.bot.equip(best.item, 'hand');
            console.log(`[Skills] 🍖 Eating ${best.name}...`);
            await this.bot.consume();
            console.log(`[Skills] 🍖 Ate ${best.name} (+${best.foodPoints || '?'} food)`);
            return true;
        } catch (e) {
            console.warn(`[Skills] 🍖 Failed to eat: ${e.message}`);
            return false;
        }
    }

    // ── Smelting ──────────────────────────────────────────────────────────

    /**
     * Smelt items in a furnace. Places furnace if needed.
     */
    async smelt() {
        // Find or place furnace
        let furnaceBlock = this.bot.findBlock({
            matching: b => b.name === 'furnace' || b.name === 'lit_furnace',
            maxDistance: 32,
        });

        if (!furnaceBlock) {
            // Try to craft a furnace (8 cobblestone)
            const inv = this._readInv();
            const cobble = inv.cobblestone || 0;
            if (cobble < 8) {
                console.log(`[Skills] 🔥 Need 8 cobblestone for furnace (have ${cobble})`);
                return false;
            }

            // Craft it
            const furnaceItem = this.bot.registry.itemsByName.furnace;
            if (furnaceItem) {
                const recipes = this.bot.recipesFor(furnaceItem.id, null, 1, null);
                if (recipes.length > 0) {
                    try {
                        // Need a crafting table for furnace
                        let table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 32 });
                        if (!table) {
                            console.log('[Skills] 🔥 Need a crafting table to build furnace');
                            return false;
                        }
                        await this._navigateTo(table.position, 2);
                        const tableRecipes = this.bot.recipesFor(furnaceItem.id, null, 1, table);
                        if (tableRecipes.length > 0) {
                            await this.bot.craft(tableRecipes[0], 1, table);
                            console.log('[Skills] 🔥 Crafted furnace');
                        }
                    } catch (e) {
                        console.warn(`[Skills] 🔥 Craft furnace failed: ${e.message}`);
                        return false;
                    }
                }
            }

            // Place the furnace
            const fItem = this.bot.inventory.items().find(i => i.name === 'furnace');
            if (fItem) {
                furnaceBlock = await this._placeNearBot(fItem);
                if (!furnaceBlock) return false;
            } else {
                return false;
            }
        }

        // Navigate to furnace
        await this._navigateTo(furnaceBlock.position, 3);

        // Open furnace and smelt
        try {
            const furnace = await this.bot.openFurnace(furnaceBlock);

            // Find something to smelt (raw_iron, raw_gold, raw food)
            const smeltable = this.bot.inventory.items().find(i =>
                i.name.includes('raw_iron') || i.name.includes('raw_gold') ||
                i.name.includes('raw_copper') ||
                i.name.includes('raw_beef') || i.name.includes('raw_chicken') ||
                i.name.includes('raw_porkchop') || i.name.includes('raw_mutton') ||
                i.name.includes('raw_rabbit') || i.name.includes('raw_cod') ||
                i.name.includes('raw_salmon')
            );

            if (!smeltable) {
                console.log('[Skills] 🔥 Nothing to smelt');
                furnace.close();
                return false;
            }

            // Find fuel (coal, charcoal, wood, planks)
            const fuel = this.bot.inventory.items().find(i =>
                i.name === 'coal' || i.name === 'charcoal' ||
                i.name.includes('_log') || i.name.includes('_planks')
            );

            if (!fuel) {
                console.log('[Skills] 🔥 No fuel available');
                furnace.close();
                return false;
            }

            // Put fuel in
            await furnace.putFuel(fuel.type, null, Math.min(fuel.count, 4));
            // Put smeltable in
            await furnace.putInput(smeltable.type, null, Math.min(smeltable.count, 8));

            console.log(`[Skills] 🔥 Smelting ${smeltable.name} with ${fuel.name}...`);

            // Poll for output every 5s instead of sleeping for 82s
            const smeltDeadline = Date.now() + 60_000; // 60s max wait
            let smelted = false;
            while (Date.now() < smeltDeadline) {
                await new Promise(r => setTimeout(r, 5000));
                const output = furnace.outputItem();
                if (output) {
                    await furnace.takeOutput();
                    console.log(`[Skills] 🔥 Smelted → ${output.name} ×${output.count}`);
                    smelted = true;
                    break;
                }
            }
            if (!smelted) console.log('[Skills] 🔥 Smelting timed out (60s)');

            furnace.close();
            return true;
        } catch (e) {
            console.warn(`[Skills] 🔥 Smelt failed: ${e.message}`);
            return false;
        }
    }

    // ── Building ──────────────────────────────────────────────────────────

    /**
     * Build a simple 5x5x3 shelter from cheapest available blocks.
     */
    async buildShelter() {
        const pos = this.bot.entity.position;
        const baseX = Math.floor(pos.x) + 2;
        const baseY = Math.floor(pos.y);
        const baseZ = Math.floor(pos.z) + 2;

        // Find building blocks in inventory
        const buildBlocks = this.bot.inventory.items().filter(i =>
            i.name.includes('_planks') || i.name === 'cobblestone' ||
            i.name.includes('_log') || i.name === 'dirt' || i.name === 'stone'
        );

        const totalBlocks = buildBlocks.reduce((s, b) => s + b.count, 0);
        if (totalBlocks < 20) {
            console.log(`[Skills] 🏠 Not enough blocks (${totalBlocks}/20 minimum)`);
            return false;
        }

        console.log(`[Skills] 🏠 Building shelter at [${baseX}, ${baseY}, ${baseZ}]...`);

        let placed = 0;
        // Build walls (5x5 footprint, 3 high)
        for (let dy = 0; dy < 3; dy++) {
            for (let dx = 0; dx < 5; dx++) {
                for (let dz = 0; dz < 5; dz++) {
                    // Only place on edges (walls) and top (roof)
                    const isWall = dx === 0 || dx === 4 || dz === 0 || dz === 4;
                    const isRoof = dy === 2;
                    const isDoor = dy < 2 && dx === 2 && dz === 0; // leave door opening

                    if ((isWall || isRoof) && !isDoor) {
                        const block = this.bot.inventory.items().find(i =>
                            i.name.includes('_planks') || i.name === 'cobblestone' ||
                            i.name.includes('_log') || i.name === 'dirt'
                        );
                        if (!block) break;

                        try {
                            const targetPos = new Vec3(baseX + dx, baseY + dy, baseZ + dz);
                            const existingBlock = this.bot.blockAt(targetPos);
                            if (existingBlock && existingBlock.name !== 'air') continue;

                            // Find a face to place against
                            const refBlock = this._findAdjacentSolid(targetPos);
                            if (!refBlock) continue;

                            await this._navigateTo(targetPos, 4);
                            await this.bot.equip(block, 'hand');

                            const faceVec = targetPos.minus(refBlock.position);
                            await this.bot.placeBlock(refBlock, faceVec);
                            placed++;

                            if (placed % 10 === 0) {
                                console.log(`[Skills] 🏠 Placed ${placed} blocks...`);
                            }
                            await new Promise(r => setTimeout(r, 200));
                        } catch { /* skip this block position */ }
                    }
                }
            }
        }

        console.log(`[Skills] 🏠 Shelter built! (${placed} blocks placed)`);
        return placed > 10;
    }

    // ── Torch Placement ──────────────────────────────────────────────────

    async placeTorch() {
        const torch = this.bot.inventory.items().find(i => i.name === 'torch');
        if (!torch) {
            console.log('[Skills] 🔦 No torches in inventory');
            return false;
        }

        try {
            const pos = this.bot.entity.position;
            // Try to place on floor beside bot
            for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                const floorPos = pos.offset(dx, -1, dz);
                const floorBlock = this.bot.blockAt(floorPos);
                const placePos = pos.offset(dx, 0, dz);
                const placeBlock = this.bot.blockAt(placePos);

                if (floorBlock && floorBlock.name !== 'air' && placeBlock && placeBlock.name === 'air') {
                    await this.bot.equip(torch, 'hand');
                    await this.bot.placeBlock(floorBlock, new Vec3(0, 1, 0));
                    console.log('[Skills] 🔦 Placed torch');
                    return true;
                }
            }
            console.log('[Skills] 🔦 No valid position for torch');
            return false;
        } catch (e) {
            console.warn(`[Skills] 🔦 Torch placement failed: ${e.message}`);
            return false;
        }
    }

    // ── Sleeping ──────────────────────────────────────────────────────────

    async sleep() {
        const bed = this.bot.findBlock({
            matching: b => b.name.includes('_bed'),
            maxDistance: 32,
        });

        if (!bed) {
            // Try to craft a bed (3 wool + 3 planks)
            console.log('[Skills] 🛏️ No bed nearby');
            return false;
        }

        try {
            await this._navigateTo(bed.position, 2);
            await this.bot.sleep(bed);
            console.log('[Skills] 🛏️ Sleeping...');
            // Wait for wake event with timeout (max 90s for a full night)
            await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    this.bot.removeListener('wake', onWake);
                    resolve();
                }, 90_000);
                const onWake = () => {
                    clearTimeout(timeout);
                    console.log('[Skills] 🛏️ Woke up!');
                    resolve();
                };
                this.bot.once('wake', onWake);
            });
            return true;
        } catch (e) {
            console.warn(`[Skills] 🛏️ Sleep failed: ${e.message}`);
            return false;
        }
    }

    // ── Upgrade Tools ────────────────────────────────────────────────────

    /**
     * Craft the next tier of tools based on available materials.
     */
    async upgradeTools() {
        const inv = this._readInv();

        // Determine what tier we can make
        let tier = null;
        if ((inv.diamond || 0) >= 3) tier = 'diamond';
        else if ((inv.iron_ingot || 0) >= 3) tier = 'iron';
        else if ((inv.cobblestone || 0) >= 3) tier = 'stone';
        else tier = 'wooden';

        const targets = [`${tier}_pickaxe`, `${tier}_sword`, `${tier}_axe`];
        let crafted = 0;

        for (const target of targets) {
            if (inv[target]) continue; // already have it

            const itemData = this.bot.registry.itemsByName[target];
            if (!itemData) continue;

            // Find crafting table
            let table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 32 });
            if (!table) {
                console.log('[Skills] ⚒️ Need a crafting table to upgrade tools');
                return crafted > 0;
            }

            await this._navigateTo(table.position, 2);
            const recipes = this.bot.recipesFor(itemData.id, null, 1, table);
            if (recipes.length > 0) {
                try {
                    // Make sure we have sticks
                    await this._ensureSticks(2);
                    const freshRecipes = this.bot.recipesFor(itemData.id, null, 1, table);
                    if (freshRecipes.length > 0) {
                        await this.bot.craft(freshRecipes[0], 1, table);
                        console.log(`[Skills] ⚒️ Crafted ${target}`);
                        crafted++;
                    }
                } catch (e) {
                    console.warn(`[Skills] ⚒️ Failed to craft ${target}: ${e.message}`);
                }
            }
        }

        if (crafted === 0) console.log(`[Skills] ⚒️ Already have ${tier} tools or missing materials`);
        return crafted > 0;
    }

    // ── Fleeing ───────────────────────────────────────────────────────────

    async flee() {
        const pos = this.bot.entity.position;
        // Find nearest threat
        const threats = Object.values(this.bot.entities).filter(e =>
            e !== this.bot.entity && e.type === 'hostile' &&
            e.position && e.position.distanceTo(pos) < 20
        );

        if (threats.length === 0) {
            console.log('[Skills] 🏃 No threats nearby');
            return false;
        }

        // Run in opposite direction from nearest threat
        const nearest = threats.sort((a, b) =>
            a.position.distanceTo(pos) - b.position.distanceTo(pos)
        )[0];

        const dx = pos.x - nearest.position.x;
        const dz = pos.z - nearest.position.z;
        const dist = Math.sqrt(dx * dx + dz * dz) || 1;
        const fleeX = Math.round(pos.x + (dx / dist) * 30);
        const fleeZ = Math.round(pos.z + (dz / dist) * 30);

        console.log(`[Skills] 🏃 Fleeing from ${nearest.name}!`);
        await this._navigateTo(new Vec3(fleeX, pos.y, fleeZ), 3);
        return true;
    }

    // ── Store Items ──────────────────────────────────────────────────────

    /**
     * Full storage system:
     *  1. Find a remembered chest nearby, or find one in the world
     *  2. If none → craft a chest (8 planks) and place it
     *  3. Deposit non-essential items
     *  4. Remember chest location + contents in brain memory
     *
     * @param {AgentBrain} brain - Reference to the brain for memory persistence
     */
    async storeItems(brain) {
        const KEEP_ITEMS = new Set([
            'torch', 'coal', 'charcoal', 'stick', 'crafting_table',
        ]);
        const isEssential = (name) =>
            name.includes('_pickaxe') || name.includes('_axe') ||
            name.includes('_sword') || name.includes('_shovel') ||
            name.includes('_hoe') || name.includes('_helmet') ||
            name.includes('_chestplate') || name.includes('_leggings') ||
            name.includes('_boots') || name.includes('shield') ||
            name.includes('cooked_') || name.includes('_bed') ||
            KEEP_ITEMS.has(name);

        // Items we want to deposit
        const toStore = this.bot.inventory.items().filter(i => !isEssential(i.name));
        if (toStore.length === 0) {
            console.log('[Skills] 📦 Nothing to store (all items are essential)');
            return false;
        }

        // ── Step 1: Find a chest ────────────────────────────────────────
        let chestBlock = null;

        // Check remembered chest locations first
        if (brain?.memory?.chestContents) {
            const botPos = this.bot.entity.position;
            let nearest = null;
            let nearestDist = Infinity;

            for (const [key, data] of Object.entries(brain.memory.chestContents)) {
                const [cx, cy, cz] = key.split(',').map(Number);
                const dist = botPos.distanceTo(new Vec3(cx, cy, cz));
                if (dist < nearestDist && dist < 200) {
                    nearestDist = dist;
                    nearest = { key, pos: new Vec3(cx, cy, cz), data };
                }
            }

            if (nearest) {
                console.log(`[Skills] 📦 Walking to remembered chest at [${nearest.key}] (${Math.round(nearestDist)}b away)`);
                await this._navigateTo(nearest.pos, 3);
                // Verify the chest still exists
                chestBlock = this.bot.findBlock({
                    matching: b => b.name === 'chest',
                    maxDistance: 6,
                });
                if (!chestBlock) {
                    console.log('[Skills] 📦 Chest gone — removing from memory');
                    delete brain.memory.chestContents[nearest.key];
                }
            }
        }

        // Search the world nearby
        if (!chestBlock) {
            chestBlock = this.bot.findBlock({
                matching: b => b.name === 'chest',
                maxDistance: 32,
            });
        }

        // ── Step 2: Craft + place a chest if needed ─────────────────────
        if (!chestBlock) {
            // Need 8 planks (any type) to craft a chest
            const inv = this._readInv();
            const plankCount = Object.entries(inv)
                .filter(([k]) => k.includes('_planks'))
                .reduce((s, [, v]) => s + v, 0);

            if (plankCount < 8) {
                // Try converting logs to planks first
                const logCount = Object.entries(inv)
                    .filter(([k]) => k.includes('_log'))
                    .reduce((s, [, v]) => s + v, 0);
                if (logCount >= 2) {
                    const logItem = this.bot.inventory.items().find(i => i.name.includes('_log'));
                    const plankName = logItem.name.replace('_log', '_planks');
                    const plankData = this.bot.registry.itemsByName[plankName];
                    if (plankData) {
                        const recipes = this.bot.recipesFor(plankData.id, null, 1, null);
                        if (recipes.length > 0) {
                            try {
                                await this.bot.craft(recipes[0], 2, null);
                                console.log('[Skills] 📦 Crafted planks for chest');
                            } catch { /* ignore */ }
                        }
                    }
                } else {
                    console.log('[Skills] 📦 Not enough wood to craft a chest');
                    return false;
                }
            }

            // Craft the chest
            const chestData = this.bot.registry.itemsByName.chest;
            if (chestData) {
                // Chest needs a crafting table (3x3 recipe)
                let table = this.bot.findBlock({ matching: b => b.name === 'crafting_table', maxDistance: 32 });
                if (!table) {
                    // Try to place one
                    const tableItem = this.bot.inventory.items().find(i => i.name === 'crafting_table');
                    if (tableItem) {
                        table = await this._placeNearBot(tableItem);
                    }
                }
                if (table) {
                    await this._navigateTo(table.position, 2);
                    const recipes = this.bot.recipesFor(chestData.id, null, 1, table);
                    if (recipes.length > 0) {
                        try {
                            await this.bot.craft(recipes[0], 1, table);
                            console.log('[Skills] 📦 Crafted a chest');
                        } catch (e) {
                            console.warn(`[Skills] 📦 Chest craft failed: ${e.message}`);
                            return false;
                        }
                    } else {
                        console.log('[Skills] 📦 No chest recipe available');
                        return false;
                    }
                } else {
                    console.log('[Skills] 📦 Need a crafting table to make a chest');
                    return false;
                }
            }

            // Place the chest
            const chestItem = this.bot.inventory.items().find(i => i.name === 'chest');
            if (chestItem) {
                chestBlock = await this._placeNearBot(chestItem);
                if (chestBlock) {
                    console.log(`[Skills] 📦 Placed chest at [${chestBlock.position}]`);
                } else {
                    console.log('[Skills] 📦 Failed to place chest');
                    return false;
                }
            } else {
                return false;
            }
        }

        // ── Step 3: Deposit items ───────────────────────────────────────
        try {
            await this._navigateTo(chestBlock.position, 2);
            const container = await this.bot.openContainer(chestBlock);

            // Re-read items to deposit (inventory may have changed from crafting)
            const items = this.bot.inventory.items().filter(i => !isEssential(i.name));
            let stored = 0;
            const storedItems = {};

            for (const item of items.slice(0, 20)) {
                try {
                    await container.deposit(item.type, null, item.count);
                    storedItems[item.name] = (storedItems[item.name] || 0) + item.count;
                    stored++;
                } catch { break; } // chest full
            }

            // Read what's now in the chest
            const chestInventory = {};
            for (const slot of container.containerItems()) {
                if (slot) {
                    chestInventory[slot.name] = (chestInventory[slot.name] || 0) + slot.count;
                }
            }

            container.close();

            // ── Step 4: Remember chest location + contents ──────────────
            if (brain?.memory) {
                const pos = chestBlock.position;
                const key = `${Math.round(pos.x)},${Math.round(pos.y)},${Math.round(pos.z)}`;
                brain.memory.chestContents[key] = {
                    items: chestInventory,
                    placedAt: Date.now(),
                    lastAccess: Date.now(),
                };
                brain._saveMemory();

                const summary = Object.entries(chestInventory)
                    .map(([k, v]) => `${k}×${v}`)
                    .join(', ');
                console.log(`[Skills] 📦 Chest [${key}] now contains: ${summary}`);
            }

            console.log(`[Skills] 📦 Stored ${stored} item stacks`);
            return stored > 0;
        } catch (e) {
            console.warn(`[Skills] 📦 Store failed: ${e.message}`);
            return false;
        }
    }

    // ── Retrieve Items ───────────────────────────────────────────────────

    /**
     * Retrieve specific items from a remembered chest.
     * Searches brain.memory.chestContents for a chest containing the item.
     *
     * @param {AgentBrain} brain - Reference to the brain for memory
     * @param {string} itemName - Item to retrieve
     * @param {number} count - How many to withdraw (default: all available)
     */
    async retrieveItems(brain, itemName, count = 64) {
        if (!brain?.memory?.chestContents) {
            console.log('[Skills] 📦 No chest memory available');
            return false;
        }

        // Find a chest that contains the item
        const botPos = this.bot.entity.position;
        let bestChest = null;
        let bestDist = Infinity;

        for (const [key, data] of Object.entries(brain.memory.chestContents)) {
            if (data.items && data.items[itemName] && data.items[itemName] > 0) {
                const [cx, cy, cz] = key.split(',').map(Number);
                const dist = botPos.distanceTo(new Vec3(cx, cy, cz));
                if (dist < bestDist) {
                    bestDist = dist;
                    bestChest = { key, pos: new Vec3(cx, cy, cz), data };
                }
            }
        }

        if (!bestChest) {
            console.log(`[Skills] 📦 No remembered chest contains ${itemName}`);
            return false;
        }

        console.log(`[Skills] 📦 Found ${itemName} in chest [${bestChest.key}] (${Math.round(bestDist)}b away)`);

        // Navigate to the chest
        await this._navigateTo(bestChest.pos, 3);

        const chestBlock = this.bot.findBlock({
            matching: b => b.name === 'chest',
            maxDistance: 6,
        });

        if (!chestBlock) {
            console.log('[Skills] 📦 Chest not found at remembered location — removing from memory');
            delete brain.memory.chestContents[bestChest.key];
            brain._saveMemory();
            return false;
        }

        try {
            await this._navigateTo(chestBlock.position, 2);
            const container = await this.bot.openContainer(chestBlock);

            // Find the item in the chest and withdraw
            const slot = container.containerItems().find(s => s && s.name === itemName);
            if (slot) {
                const withdrawCount = Math.min(count, slot.count);
                await container.withdraw(slot.type, null, withdrawCount);
                console.log(`[Skills] 📦 Withdrew ${withdrawCount}× ${itemName}`);
            } else {
                console.log(`[Skills] 📦 ${itemName} not actually in chest — updating memory`);
            }

            // Update memory with current chest contents
            const chestInventory = {};
            for (const s of container.containerItems()) {
                if (s) {
                    chestInventory[s.name] = (chestInventory[s.name] || 0) + s.count;
                }
            }
            container.close();

            const key = `${Math.round(chestBlock.position.x)},${Math.round(chestBlock.position.y)},${Math.round(chestBlock.position.z)}`;
            brain.memory.chestContents[key] = {
                items: chestInventory,
                placedAt: bestChest.data.placedAt,
                lastAccess: Date.now(),
            };
            brain._saveMemory();

            return true;
        } catch (e) {
            console.warn(`[Skills] 📦 Retrieve failed: ${e.message}`);
            return false;
        }
    }

    // ── Equip Armor ──────────────────────────────────────────────────────

    async equipArmor() {
        const armorSlots = ['head', 'torso', 'legs', 'feet'];
        const armorNames = ['_helmet', '_chestplate', '_leggings', '_boots'];
        let equipped = 0;

        for (let i = 0; i < armorSlots.length; i++) {
            const item = this.bot.inventory.items().find(it => it.name.includes(armorNames[i]));
            if (item) {
                try {
                    await this.bot.equip(item, armorSlots[i]);
                    equipped++;
                } catch { /* already equipped or invalid */ }
            }
        }

        if (equipped > 0) console.log(`[Skills] 🛡️ Equipped ${equipped} armor pieces`);
        return equipped > 0;
    }

    // ── Mine Coal / Diamond (specific mining) ────────────────────────────

    async mineCoal() {
        return this._mineBlock('coal_ore', 32, 4);
    }

    async mineDiamond() {
        // Diamonds are deep — might need to dig down
        return this._mineBlock('diamond_ore', 32, 2);
    }

    // ── Internal Helpers ──────────────────────────────────────────────────

    async _mineBlock(blockName, maxDist = 32, count = 4) {
        let mined = 0;
        for (let i = 0; i < count; i++) {
            const block = this.bot.findBlock({
                matching: b => b.name.includes(blockName),
                maxDistance: maxDist,
            });
            if (!block) break;

            await this._navigateTo(block.position, 1);
            const fresh = this.bot.blockAt(block.position);
            if (!fresh || !fresh.name.includes(blockName)) continue;

            const best = this.gk?.getBestToolFor(fresh);
            if (best) await this.bot.equip(best, 'hand');
            else {
                try { await this.bot.unequip('hand'); } catch { }
            }

            try {
                await this.bot.dig(fresh);
                mined++;
                console.log(`[Skills] ⛏️ Mined ${fresh.name} (${mined}/${count})`);
                await new Promise(r => setTimeout(r, 400));
                await this._navigateTo(block.position, 0).catch(() => { });
            } catch (e) {
                console.warn(`[Skills] dig failed: ${e.message}`);
                break;
            }
        }
        return mined > 0;
    }

    async _navigateTo(posOrVec, range = 2) {
        if (!this.bot.pathfinder) return;
        const p = posOrVec instanceof Vec3 ? posOrVec : new Vec3(posOrVec.x || posOrVec[0], posOrVec.y || posOrVec[1], posOrVec.z || posOrVec[2]);
        const goal = new GoalNear(p.x, p.y, p.z, range);
        // Race pathfinder against a 30s timeout to prevent hanging
        await Promise.race([
            this.bot.pathfinder.goto(goal),
            new Promise(resolve => setTimeout(() => {
                try { this.bot.pathfinder.setGoal(null); } catch { }
                resolve();
            }, 30_000)),
        ]);
    }

    async _placeNearBot(item) {
        const pos = this.bot.entity.position;
        const face = new Vec3(0, 1, 0);
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const floorPos = pos.offset(dx, -1, dz);
            const floorBlock = this.bot.blockAt(floorPos);
            const targetBlock = this.bot.blockAt(pos.offset(dx, 0, dz));
            if (floorBlock && floorBlock.name !== 'air' && targetBlock && targetBlock.name === 'air') {
                try {
                    await this.bot.equip(item, 'hand');
                    await this.bot.placeBlock(floorBlock, face);
                    await new Promise(r => setTimeout(r, 300));
                    return this.bot.findBlock({ matching: b => b.name === item.name, maxDistance: 6 });
                } catch { continue; }
            }
        }
        return null;
    }

    _findAdjacentSolid(pos) {
        for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            const adj = this.bot.blockAt(pos.offset(dx, dy, dz));
            if (adj && adj.name !== 'air') return adj;
        }
        return null;
    }

    _readInv() {
        const inv = {};
        for (const item of this.bot.inventory.items()) {
            inv[item.name] = (inv[item.name] || 0) + item.count;
        }
        return inv;
    }

    _getFoodItems() {
        const foodNames = [
            'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
            'cooked_rabbit', 'cooked_salmon', 'cooked_cod', 'bread', 'golden_apple',
            'apple', 'baked_potato', 'mushroom_stew', 'rabbit_stew', 'beetroot_soup',
            'raw_beef', 'raw_porkchop', 'raw_chicken', 'raw_mutton', 'raw_rabbit',
            'raw_salmon', 'raw_cod', 'potato', 'carrot', 'beetroot', 'melon_slice',
            'sweet_berries', 'dried_kelp',
        ];
        const foodSet = new Set(foodNames);

        return this.bot.inventory.items()
            .filter(i => foodSet.has(i.name))
            .map(i => ({
                name: i.name,
                count: i.count,
                item: i,
                foodPoints: i.name.includes('cooked') ? 8 : 3, // approximate
            }))
            .sort((a, b) => b.foodPoints - a.foodPoints);
    }

    async _ensureSticks(count) {
        const inv = this._readInv();
        if ((inv.stick || 0) >= count) return;

        const plankTypes = Object.keys(inv).filter(k => k.includes('_planks'));
        if (plankTypes.length === 0) return;

        const stickData = this.bot.registry.itemsByName.stick;
        if (!stickData) return;

        const recipes = this.bot.recipesFor(stickData.id, null, 1, null);
        if (recipes.length > 0) {
            try {
                await this.bot.craft(recipes[0], 2, null);
                console.log('[Skills] Crafted sticks');
            } catch { /* already have enough */ }
        }
    }
}

module.exports = { SkillLibrary };
