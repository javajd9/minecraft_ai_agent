/**
 * scanner.js — World Vision System for DIDDYBOT
 *
 * Gives the LLM a clear picture of what's around the bot:
 *  1. SURROUNDINGS — 8 compass dirs, scans vertically to find REAL ground level
 *  2. RESOURCE RADAR — nearest of each key resource within 48b
 *  3. ENTITY SCAN — hostiles, food animals within 24b
 *  4. ENVIRONMENT — time, HP, food, light, weather
 *  5. BLOCK COMPOSITION — what blocks dominate the area (biome indicator)
 */

'use strict';

// ── Resource types ────────────────────────────────────────────────────────────

const RESOURCE_RADAR = [
    { key: 'wood', emoji: '🪵', match: b => b.name.includes('_log') },
    { key: 'coal', emoji: '⛏ ', match: b => b.name.includes('coal_ore') },
    { key: 'iron', emoji: '🔩', match: b => b.name.includes('iron_ore') },
    { key: 'gold', emoji: '🥇', match: b => b.name.includes('gold_ore') },
    { key: 'diamond', emoji: '💎', match: b => b.name.includes('diamond_ore') },
    { key: 'water', emoji: '💧', match: b => b.name === 'water' },
    { key: 'lava', emoji: '🌋', match: b => b.name === 'lava' },
    { key: 'crops', emoji: '🌾', match: b => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(b.name) },
    { key: 'chest', emoji: '📦', match: b => b.name === 'chest' },
    { key: 'crafting', emoji: '🪚', match: b => b.name === 'crafting_table' },
    { key: 'furnace', emoji: '🔥', match: b => b.name === 'furnace' },
];

const HOSTILE_MOBS = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'phantom', 'zombie_villager', 'pillager', 'ravager', 'drowned', 'husk', 'stray', 'cave_spider']);
const FOOD_MOBS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom', 'hoglin', 'salmon', 'cod', 'goat']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardinalDirection(dx, dz) {
    const angle = Math.atan2(dx, -dz) * 180 / Math.PI;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round((angle + 180) / 45) % 8];
}

function shortName(name) {
    if (!name) return '?';
    if (name === 'grass_block' || name === 'short_grass' || name === 'tall_grass') return 'grass';
    if (name.includes('stone') && !name.includes('ore')) return 'stone';
    if (name.includes('dirt')) return 'dirt';
    if (name.includes('sand') && !name.includes('stone')) return 'sand';
    if (name.includes('gravel')) return 'gravel';
    if (name.includes('_log')) return '🪵log';
    if (name.includes('_leaves')) return 'leaves';
    if (name.includes('_planks')) return 'planks';
    if (name.includes('water')) return 'water';
    if (name.includes('lava')) return 'lava';
    if (name.includes('coal_ore')) return '⛏coal';
    if (name.includes('iron_ore')) return '🔩iron';
    if (name.includes('diamond_ore')) return '💎diamond';
    if (name === 'crafting_table') return '🪚table';
    if (name === 'furnace') return '🔥furnace';
    if (name === 'chest') return '📦chest';
    if (name === 'bedrock') return 'bedrock';
    if (name === 'air') return 'air';
    if (name.includes('snow')) return 'snow';
    if (name.includes('ice')) return 'ice';
    return name.replace(/_/g, ' ');
}

/**
 * Map a block name to the best tool category for breaking it.
 * Returns emoji + tool name for LLM readability.
 */
function bestToolFor(blockName) {
    if (!blockName) return '🤚hand';
    const n = blockName.toLowerCase();
    // Pickaxe materials
    if (n.includes('stone') || n.includes('ore') || n.includes('cobble') ||
        n.includes('brick') || n.includes('obsidian') || n.includes('netherrack') ||
        n.includes('sandstone') || n.includes('concrete') || n.includes('terracotta') ||
        n.includes('andesite') || n.includes('diorite') || n.includes('granite') ||
        n.includes('basalt') || n.includes('deepslate') || n.includes('tuff') ||
        n.includes('prismarine') || n.includes('purpur') || n.includes('end_stone')) {
        return '⛏pickaxe';
    }
    // Axe materials
    if (n.includes('_log') || n.includes('_wood') || n.includes('planks') ||
        n.includes('fence') || n.includes('door') || n.includes('sign') ||
        n.includes('bookshelf') || n.includes('chest') || n.includes('barrel') ||
        n.includes('crafting') || n.includes('ladder') || n.includes('scaffold')) {
        return '🪓axe';
    }
    // Shovel materials
    if (n.includes('dirt') || n.includes('grass_block') || n.includes('sand') ||
        n.includes('gravel') || n.includes('clay') || n.includes('soul') ||
        n.includes('mud') || n.includes('snow') || n.includes('mycelium') ||
        n.includes('podzol') || n.includes('farmland') || n.includes('rooted')) {
        return '🪣shovel';
    }
    // Shears
    if (n.includes('leaves') || n.includes('wool') || n.includes('cobweb') ||
        n.includes('vine')) {
        return '✂shears';
    }
    return '🤚hand';
}

// ── 1) Surroundings scan — finds REAL ground level in each direction ─────────

function scanSurroundings(bot) {
    const pos = bot.entity?.position;
    if (!pos) return '  [vision unavailable]';

    const feetY = Math.floor(pos.y);
    const lines = [];

    const DIRS = [
        { label: 'N', dx: 0, dz: -1 },
        { label: 'NE', dx: 1, dz: -1 },
        { label: 'E', dx: 1, dz: 0 },
        { label: 'SE', dx: 1, dz: 1 },
        { label: 'S', dx: 0, dz: 1 },
        { label: 'SW', dx: -1, dz: 1 },
        { label: 'W', dx: -1, dz: 0 },
        { label: 'NW', dx: -1, dz: -1 },
    ];

    for (const dir of DIRS) {
        const parts = [];
        const elevations = []; // track elevation at each distance for terrain profile

        for (const dist of [2, 5, 10]) {
            const cx = Math.round(pos.x + dir.dx * dist);
            const cz = Math.round(pos.z + dir.dz * dist);

            try {
                // Find ACTUAL ground level by scanning from +15 to -15 of bot Y
                // Extended range so we can see tall mountains and deep ravines
                let groundY = null;
                for (let dy = 15; dy >= -15; dy--) {
                    const checkY = feetY + dy;
                    const b = bot.blockAt(bot.vec3(cx, checkY, cz));
                    if (b && b.name !== 'air' && b.boundingBox === 'block' &&
                        !b.name.includes('leaves') && !b.name.includes('vine')) {
                        // Found solid ground — check if space above is open
                        const above = bot.blockAt(bot.vec3(cx, checkY + 1, cz));
                        if (!above || above.name === 'air' || above.boundingBox !== 'block' ||
                            above.name.includes('_log') || above.name.includes('leaves')) {
                            groundY = checkY;
                            break;
                        }
                    }
                }

                if (groundY === null) {
                    parts.push('void⚠️');
                    elevations.push(null);
                    continue;
                }

                const yDiff = groundY - (feetY - 1); // relative to bot's ground level
                elevations.push(yDiff);
                const gBlock = bot.blockAt(bot.vec3(cx, groundY, cz));
                const a1 = bot.blockAt(bot.vec3(cx, groundY + 1, cz));
                const a2 = bot.blockAt(bot.vec3(cx, groundY + 2, cz));
                const gName = gBlock?.name || 'air';
                const a1Name = a1?.name || 'air';
                const a2Name = a2?.name || 'air';

                let label = shortName(gName);

                // What's ON the ground? (trees, structures, water over ground)
                if (a1Name.includes('_log') || a2Name.includes('_log')) {
                    label = '🪵TREE';
                } else if (a1Name.includes('_leaves') || a2Name.includes('_leaves')) {
                    label += '+leaves';
                } else if (gName.includes('water')) {
                    label = '💧water (swimmable)';
                } else if (gName.includes('lava')) {
                    label = '🌋lava (⚠️AVOID)';
                } else if (a1Name !== 'air' && a1?.boundingBox === 'block') {
                    label += '+' + shortName(a1Name);
                }

                // Intelligent elevation classification
                // Skip elevation warnings for water — water is safe to enter at any depth
                const isWaterGround = gName.includes('water');
                if (!isWaterGround) {
                    if (yDiff > 0) {
                        if (yDiff <= 1) label += ' (level)';
                        else if (yDiff <= 3) label += ` ↑${yDiff} (climbable slope)`;
                        else if (yDiff <= 6) label += ` ↑${yDiff} (steep hill⛰️)`;
                        else if (yDiff <= 10) label += ` ↑${yDiff} (🏔️mountain — go around)`;
                        else label += ` ↑${yDiff} (🏔️tall mountain — BLOCKED)`;
                    } else if (yDiff < 0) {
                        const drop = Math.abs(yDiff);
                        if (drop <= 1) label += ' (level)';
                        else if (drop <= 3) label += ` ↓${drop} (safe drop)`;
                        else if (drop <= 6) label += ` ↓${drop} (⚠️dangerous drop)`;
                        else label += ` ↓${drop} (⚠️ravine/cliff — AVOID)`;
                    }
                }

                parts.push(label);
            } catch { parts.push('?'); }
        }

        // Build terrain profile summary for this direction
        let terrainNote = '';
        const validElevs = elevations.filter(e => e !== null);
        if (validElevs.length >= 2) {
            const trend = validElevs[validElevs.length - 1] - validElevs[0];
            const maxElev = Math.max(...validElevs);
            const minElev = Math.min(...validElevs);

            if (maxElev > 6) terrainNote = ' [🏔️MOUNTAIN AHEAD]';
            else if (maxElev > 3) terrainNote = ' [⛰️HILL AHEAD]';
            else if (minElev < -6) terrainNote = ' [⚠️RAVINE AHEAD]';
            else if (minElev < -3) terrainNote = ' [DROP AHEAD]';
            else if (Math.abs(trend) <= 1) terrainNote = ' [flat terrain]';
        }

        lines.push(`  ${dir.label.padEnd(3)}: ${parts.join(' → ')}${terrainNote}`);
    }

    // Vertical awareness
    try {
        const bx = Math.round(pos.x), bz = Math.round(pos.z);

        // ABOVE: scan upward to find sky/ceiling
        let aboveBlocks = [];
        let skyDist = null;
        for (let dy = 2; dy <= 12; dy++) {
            const b = bot.blockAt(bot.vec3(bx, feetY + dy, bz));
            if (!b || b.name === 'air') {
                if (!skyDist) skyDist = dy;
            } else {
                aboveBlocks.push({ name: shortName(b.name), dy });
            }
        }
        const aboveStr = aboveBlocks.length > 0
            ? aboveBlocks.slice(0, 3).map(b => `${b.name}(+${b.dy})`).join(', ')
            : 'clear sky';
        lines.push(`  ↑UP: ${aboveStr}${skyDist ? ` | sky at +${skyDist}` : ' | covered'}`);

        // BELOW: only report what's visible (not through solid ground)
        const groundBlock = bot.blockAt(bot.vec3(bx, feetY - 1, bz));
        const isGroundSolid = groundBlock && groundBlock.name !== 'air' &&
            !groundBlock.name.includes('water') && groundBlock.boundingBox === 'block';

        if (isGroundSolid) {
            lines.push(`  ↓DN: solid ground (${shortName(groundBlock.name)})`);
        } else {
            let dropDepth = 0;
            let landedOn = null;
            for (let dy = 1; dy <= 12; dy++) {
                const b = bot.blockAt(bot.vec3(bx, feetY - dy, bz));
                if (b && b.name !== 'air' && b.boundingBox === 'block') {
                    landedOn = shortName(b.name);
                    break;
                }
                dropDepth = dy;
            }
            if (dropDepth > 0) {
                lines.push(`  ↓DN: ⚠️ ${dropDepth}b drop${landedOn ? ' → ' + landedOn : ''}`);
            } else {
                lines.push(`  ↓DN: ${landedOn || 'ground'}`);
            }
        }
    } catch { }

    // Standing on
    try {
        const standing = bot.blockAt(bot.vec3(Math.round(pos.x), feetY - 1, Math.round(pos.z)));
        const atFeet = bot.blockAt(bot.vec3(Math.round(pos.x), feetY, Math.round(pos.z)));
        const standStr = standing ? shortName(standing.name) : 'air';
        const feetStr = atFeet && atFeet.name !== 'air' ? ` (in ${shortName(atFeet.name)})` : '';
        lines.unshift(`  Standing on: ${standStr}${feetStr} at Y=${Math.round(pos.y)}`);
    } catch { }

    return lines.join('\n');
}

// ── 1b) Path data — structured obstruction info for BOTH navigator and LLM ──

/**
 * Core path analysis — returns structured data about what's blocking each direction.
 * This is the SINGLE SOURCE OF TRUTH for both the navigator and the LLM vision.
 *
 * Returns: {
 *   directions: { N: {...}, NE: {...}, ... },  // 8 compass directions
 *   ceiling: { blocked, block, diggable, tool } | null,
 *   floor: { block, diggable, tool } | null,
 *   inCave: boolean,
 *   inWater: boolean,
 * }
 *
 * Each direction entry: {
 *   blocked: boolean,
 *   wallHeight: 0-3+,
 *   jumpable: boolean,      // 1-high, can jump over
 *   diggable: boolean,      // can be broken
 *   tool: string,           // best tool for breaking
 *   blocks: string[],       // block names present
 *   feetBlock: Block|null,  // raw mineflayer block at feet level
 *   headBlock: Block|null,  // raw mineflayer block at head level
 *   isWater: boolean,       // water in this direction (safe)
 *   isLava: boolean,        // lava in this direction (danger)
 *   dropDepth: number,      // how far down if no solid ground (0 = solid)
 * }
 */
function getPathData(bot) {
    const pos = bot.entity?.position;
    if (!pos) return null;

    const feetY = Math.floor(pos.y);
    const bx = Math.round(pos.x);
    const bz = Math.round(pos.z);

    const DIRS = [
        { label: 'N', dx: 0, dz: -1 },
        { label: 'NE', dx: 1, dz: -1 },
        { label: 'E', dx: 1, dz: 0 },
        { label: 'SE', dx: 1, dz: 1 },
        { label: 'S', dx: 0, dz: 1 },
        { label: 'SW', dx: -1, dz: 1 },
        { label: 'W', dx: -1, dz: 0 },
        { label: 'NW', dx: -1, dz: -1 },
    ];

    const directions = {};

    for (const dir of DIRS) {
        const entry = {
            blocked: false, wallHeight: 0, jumpable: false,
            diggable: true, tool: '🤚hand', blocks: [],
            feetBlock: null, headBlock: null,
            isWater: false, isLava: false, dropDepth: 0,
        };

        try {
            const cx = bx + dir.dx;
            const cz = bz + dir.dz;

            const bFeet = bot.blockAt(bot.vec3(cx, feetY, cz));
            const bHead = bot.blockAt(bot.vec3(cx, feetY + 1, cz));
            const bBelow = bot.blockAt(bot.vec3(cx, feetY - 1, cz));

            entry.feetBlock = bFeet;
            entry.headBlock = bHead;

            // Check for water/lava
            if (bFeet && bFeet.name.includes('water')) entry.isWater = true;
            if (bFeet && bFeet.name.includes('lava')) entry.isLava = true;
            if (bBelow && bBelow.name && bBelow.name.includes('water')) entry.isWater = true;

            const feetSolid = bFeet && bFeet.name !== 'air' && bFeet.boundingBox === 'block';
            const headSolid = bHead && bHead.name !== 'air' && bHead.boundingBox === 'block';

            // Drop detection (how far down if no solid ground ahead)
            if (!feetSolid && !entry.isWater && !entry.isLava) {
                const belowSolid = bBelow && bBelow.name !== 'air' &&
                    !bBelow.name.includes('water') && !bBelow.name.includes('lava') &&
                    bBelow.boundingBox === 'block';
                if (!belowSolid) {
                    for (let dy = 2; dy <= 8; dy++) {
                        const deep = bot.blockAt(bot.vec3(cx, feetY - dy, cz));
                        if (deep && deep.name !== 'air' && deep.boundingBox === 'block') break;
                        if (deep && deep.name.includes('water')) break; // water breaks falls
                        entry.dropDepth = dy;
                    }
                }
            }

            if (!feetSolid && !headSolid) {
                directions[dir.label] = entry; // clear path
                continue;
            }

            entry.blocked = true;

            if (feetSolid) {
                entry.wallHeight++;
                if (!entry.blocks.includes(bFeet.name)) entry.blocks.push(bFeet.name);
                if (!bFeet.diggable) entry.diggable = false;
                entry.tool = bestToolFor(bFeet.name);
            }
            if (headSolid) {
                entry.wallHeight++;
                if (!entry.blocks.includes(bHead.name)) entry.blocks.push(bHead.name);
                if (!bHead.diggable) entry.diggable = false;
                if (headSolid && !feetSolid) entry.tool = bestToolFor(bHead.name);
            }

            // Check +2 above feet (3-high wall)
            const bAbove2 = bot.blockAt(bot.vec3(cx, feetY + 2, cz));
            if (bAbove2 && bAbove2.name !== 'air' && bAbove2.boundingBox === 'block') {
                entry.wallHeight++;
            }

            entry.jumpable = entry.wallHeight === 1 && feetSolid && !headSolid;
        } catch { }

        directions[dir.label] = entry;
    }

    // Ceiling check
    let ceiling = null;
    let inCave = false;
    try {
        const cBlock = bot.blockAt(bot.vec3(bx, feetY + 2, bz));
        if (cBlock && cBlock.name !== 'air' && cBlock.boundingBox === 'block') {
            ceiling = {
                blocked: true,
                block: cBlock,
                name: cBlock.name,
                diggable: cBlock.diggable,
                tool: bestToolFor(cBlock.name),
            };
            inCave = true;
        }
    } catch { }

    // Floor check
    let floor = null;
    try {
        const fBlock = bot.blockAt(bot.vec3(bx, feetY - 1, bz));
        if (fBlock && fBlock.name !== 'air' && fBlock.boundingBox === 'block' &&
            fBlock.name !== 'grass_block' && fBlock.name !== 'dirt') {
            if (fBlock.name.includes('stone') || fBlock.name.includes('ore') ||
                fBlock.name.includes('deepslate') || fBlock.name.includes('bedrock')) {
                floor = {
                    block: fBlock,
                    name: fBlock.name,
                    diggable: fBlock.diggable,
                    tool: bestToolFor(fBlock.name),
                };
            }
        }
    } catch { }

    // In water check
    let inWater = false;
    try {
        const atPos = bot.blockAt(pos);
        const belowPos = bot.blockAt(pos.offset(0, -0.5, 0));
        inWater = (atPos && atPos.name.includes('water')) ||
            (belowPos && belowPos.name.includes('water'));
    } catch { }

    return { directions, ceiling, floor, inCave, inWater };
}

/**
 * Format path data as text for the LLM.
 * Uses getPathData() as its source of truth.
 */
function scanPathObstructions(bot) {
    const data = getPathData(bot);
    if (!data) return '  [unavailable]';

    const lines = [];
    let hasObstruction = false;

    for (const [label, entry] of Object.entries(data.directions)) {
        if (!entry.blocked) continue;

        const namesStr = entry.blocks.map(n => shortName(n)).join('+');
        const heightStr = entry.wallHeight >= 3 ? '3+ high wall'
            : entry.wallHeight === 2 ? '2-high wall'
                : '1-high block';
        const jumpStr = entry.jumpable ? ' — jumpable' : ' — MUST BREAK or go around';
        const digStr = entry.diggable ? `breakable, need ${entry.tool}` : '⚠️NOT breakable';

        lines.push(`  ${label.padEnd(3)}: ${namesStr} (${digStr}) — ${heightStr}${jumpStr}`);
        hasObstruction = true;
    }

    if (data.ceiling) {
        const digStr = data.ceiling.diggable ? `breakable, need ${data.ceiling.tool}` : '⚠️NOT breakable';
        lines.push(`  ↑  : ceiling ${shortName(data.ceiling.name)} (${digStr}) — 2b above`);
        hasObstruction = true;
    }

    if (data.floor) {
        const digStr = data.floor.diggable ? `breakable, need ${data.floor.tool}` : '⚠️NOT breakable';
        lines.push(`  ↓  : floor ${shortName(data.floor.name)} (${digStr}) — mine to go deeper`);
        hasObstruction = true;
    }

    if (!hasObstruction) {
        return '  All directions clear — no blocks blocking movement';
    }

    return lines.join('\n');
}

// ── 2) Block composition ─────────────────────────────────────────────────────

function scanBlockComposition(bot) {
    const pos = bot.entity?.position;
    if (!pos) return '  [unavailable]';

    const counts = {};
    const feetY = Math.floor(pos.y);
    const R = 6;

    for (let dx = -R; dx <= R; dx += 2) {
        for (let dz = -R; dz <= R; dz += 2) {
            for (let dy = -2; dy <= 3; dy++) {
                try {
                    const block = bot.blockAt(bot.vec3(
                        Math.round(pos.x + dx), feetY + dy, Math.round(pos.z + dz)
                    ));
                    if (block && block.name !== 'air') {
                        const sn = shortName(block.name);
                        counts[sn] = (counts[sn] || 0) + 1;
                    }
                } catch { }
            }
        }
    }

    const sorted = Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => `${name}(${count})`)
        .join(', ');

    return `  Nearby blocks: ${sorted || 'none'}`;
}

// ── 3) Resource radar + entities ─────────────────────────────────────────────

function scanResourceRadar(bot, radius = 48) {
    const pos = bot.entity?.position;
    if (!pos) return '  [radar unavailable]';

    const botY = Math.round(pos.y);
    const lines = [];

    for (const resource of RESOURCE_RADAR) {
        try {
            const block = bot.findBlock({ matching: resource.match, maxDistance: radius });
            if (block) {
                const dy = Math.round(block.position.y - botY);
                const dx = Math.round(block.position.x - pos.x);
                const dz = Math.round(block.position.z - pos.z);
                const dist = Math.round(Math.sqrt(dx * dx + dz * dz));
                const dir = getCardinalDirection(dx, dz);
                const reachable = Math.abs(dy) <= 10;
                const hNote = !reachable ? ` (${dy > 0 ? dy + '↑' : Math.abs(dy) + '↓'} unreachable)` : '';

                lines.push(
                    `  ${resource.emoji} ${resource.key.padEnd(10)}: ${dist}b ${dir}${hNote}` +
                    (reachable ? ` → [${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}]` : '')
                );
            }
        } catch { }
    }

    // Entity scan
    const ents = Object.values(bot.entities).filter(e =>
        e !== bot.entity && e.position && e.position.distanceTo(pos) <= 24
    );

    const hostile = ents
        .filter(e => HOSTILE_MOBS.has(e.name?.toLowerCase()))
        .map(e => {
            const d = Math.round(e.position.distanceTo(pos));
            const dir = getCardinalDirection(e.position.x - pos.x, e.position.z - pos.z);
            return `⚠️${e.name}(${d}b ${dir})`;
        }).slice(0, 5);

    const food = ents
        .filter(e => FOOD_MOBS.has(e.name?.toLowerCase()))
        .map(e => {
            const d = Math.round(e.position.distanceTo(pos));
            const dir = getCardinalDirection(e.position.x - pos.x, e.position.z - pos.z);
            return `${e.name}(${d}b ${dir})`;
        }).slice(0, 5);

    if (hostile.length) lines.push(`  ☠️ THREATS:    ${hostile.join(', ')}`);
    if (food.length) lines.push(`  🍖 Food mobs: ${food.join(', ')}`);

    // Dropped items on the ground — tracked via entity system
    const droppedItems = ents
        .filter(e => e.name === 'item' || e.displayName === 'Item' ||
            e.entityType === 2 || e.type === 'object')
        .filter(e => e.position.distanceTo(pos) <= 16)
        .map(e => {
            const d = Math.round(e.position.distanceTo(pos));
            const dir = getCardinalDirection(e.position.x - pos.x, e.position.z - pos.z);
            let name = 'item';
            try {
                if (e.metadata?.[8]?.nbtData?.value?.id?.value) {
                    name = e.metadata[8].nbtData.value.id.value.replace('minecraft:', '');
                } else if (e.displayName && e.displayName !== 'Item') {
                    name = e.displayName;
                }
            } catch { }
            return `📦${name}(${d}b ${dir})`;
        }).slice(0, 8);

    if (droppedItems.length) lines.push(`  📥 DROPPED ITEMS: ${droppedItems.join(', ')} — walk close to pick up`);

    return lines.join('\n') || '  Nothing detected';
}

// ── 4) Environment ───────────────────────────────────────────────────────────

function scanEnvironment(bot) {
    try {
        const pos = bot.entity?.position;
        if (!pos) return '  [unavailable]';

        const ticks = bot.time?.timeOfDay ?? 0;
        const isDay = ticks < 13000 || ticks > 23000;
        const timeStr = isDay ? `Day (${ticks} ticks)` : `⚠️ NIGHT (${ticks})`;

        const lightLevel = bot.blockAt(pos)?.light ?? '?';
        const weather = bot.isRaining ? '🌧Raining' : '☀️Clear';
        const hp = Math.round(bot.health ?? 20);
        const food = Math.round(bot.food ?? 20);

        return `  ${timeStr} | HP: ${hp}/20 | Food: ${food}/20 | Light: ${lightLevel} | ${weather} | Y=${Math.round(pos.y)}`;
    } catch {
        return '  [unavailable]';
    }
}

// ── Master formatter ──────────────────────────────────────────────────────────

function formatVision(bot, recentEvents = []) {
    const surroundings = scanSurroundings(bot);
    const obstructions = scanPathObstructions(bot);
    const composition = scanBlockComposition(bot);
    const radar = scanResourceRadar(bot, 48);
    const environment = scanEnvironment(bot);
    const eventLines = recentEvents.slice(-6).map(e => `  ${e}`).join('\n') || '  Nothing notable yet.';

    return `\
SURROUNDINGS (ground + what's on it at 2b, 5b, 10b — ↑/↓ = elevation change):
${surroundings}
${composition}

PATH OBSTRUCTIONS (blocks within 1-2b that need clearing to move):
${obstructions}

RESOURCES & ENTITIES (48b scan):
${radar}

STATUS:
${environment}

RECENT EVENTS:
${eventLines}`.trim();
}

module.exports = { formatVision, scanResourceRadar, getCardinalDirection, getPathData };
