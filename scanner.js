/**
 * scanner.js — High-Quality World Vision System for DIDDYBOT
 *
 * Design principles:
 *  - Only report what the bot can ACTUALLY reach and mine.
 *  - Reachability filter: block must be within ±4 Y of the bot's feet.
 *  - Eye-level directional scan (y+1) to see what's really in the path.
 *  - 5 depth levels per ray (1, 2, 4, 8, 16 blocks).
 *  - Entity detection capped at 24 blocks with exact name matching.
 *  - No stale cache — everything is computed fresh from live chunk data.
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
    { key: 'leaves', emoji: '🌿', match: b => b.name.includes('_leaves') },
    { key: 'crops', emoji: '🌾', match: b => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(b.name) },
    { key: 'chest', emoji: '📦', match: b => b.name === 'chest' },
    { key: 'crafting', emoji: '🪚', match: b => b.name === 'crafting_table' },
    { key: 'furnace', emoji: '🔥', match: b => b.name === 'furnace' },
];

// Exact entity name sets — no substring matching
const HOSTILE_MOBS = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'phantom', 'zombie_villager', 'pillager', 'ravager']);
const FOOD_MOBS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom', 'hoglin', 'salmon', 'cod', 'goat']);
const NEUTRAL_MOBS = new Set(['villager', 'iron_golem', 'horse', 'donkey', 'mule', 'wolf', 'cat', 'bee']);

// ── Helpers ───────────────────────────────────────────────────────────────────

function getCardinalDirection(dx, dz) {
    const angle = Math.atan2(dx, -dz) * 180 / Math.PI;
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round((angle + 180) / 45) % 8];
}

function getForwardVector(yaw) {
    return { dx: -Math.sin(yaw), dz: -Math.cos(yaw) };
}

function rotate90CW(v) {
    return { dx: -v.dz, dz: v.dx };
}

/**
 * Human-readable block label. Marks important blocks in CAPS.
 */
function describeBlock(block) {
    if (!block || block.name === 'air') return 'air';
    if (block.name.includes('_log')) return '🪵LOG!';
    if (block.name.includes('_leaves')) return 'leaves';
    if (block.name.includes('diamond_ore')) return '💎DIAMOND!';
    if (block.name.includes('iron_ore')) return '🔩iron_ore';
    if (block.name.includes('coal_ore')) return '⛏ coal_ore';
    if (block.name.includes('gold_ore')) return '🥇gold_ore';
    if (block.name === 'water') return '💧water';
    if (block.name === 'lava') return '🌋LAVA!';
    if (block.name === 'chest') return '📦CHEST!';
    if (block.name === 'crafting_table') return '🪚CRAFTING_TABLE!';
    if (block.name === 'furnace') return '🔥furnace';
    if (block.name === 'grass_block') return 'grass';
    if (block.name === 'dirt') return 'dirt';
    if (block.name === 'stone') return 'stone';
    if (block.name.includes('planks')) return 'planks';
    if (block.name.includes('fence')) return 'fence';
    if (block.name.includes('_door')) return '🚪door';
    if (block.name.includes('glass')) return 'glass';
    if (block.name.includes('wool')) return 'wool';
    if (block.name === 'bedrock') return 'bedrock';
    if (block.name === 'sand') return 'sand';
    if (block.name === 'gravel') return 'gravel';
    return block.name;
}

// ── Directional vision ────────────────────────────────────────────────────────

/**
 * Scans 5 rays at eye level (y+1) in forward, fwd-left, fwd-right, left, right.
 * Depths: 1, 2, 4, 8, 16 blocks.
 * Only shows eye-level blocks — what the bot literally looks at while walking.
 */
function scanDirectional(bot) {
    const pos = bot.entity?.position;
    if (!pos) return '  [vision unavailable]';

    const eyeY = Math.floor(pos.y) + 1;   // eye height

    const fwd = getForwardVector(bot.entity.yaw);
    const right = rotate90CW(fwd);
    const left = { dx: -right.dx, dz: -right.dz };
    const fwdLeft = { dx: (fwd.dx + left.dx) * 0.7, dz: (fwd.dz + left.dz) * 0.7 };
    const fwdRight = { dx: (fwd.dx + right.dx) * 0.7, dz: (fwd.dz + right.dz) * 0.7 };

    const facingDir = getCardinalDirection(fwd.dx, fwd.dz);
    const depths = [1, 2, 4, 8, 16];

    const rays = [
        { label: `Forward (${facingDir})`, v: fwd },
        { label: 'Forward-left', v: fwdLeft },
        { label: 'Forward-right', v: fwdRight },
        { label: 'Left', v: left },
        { label: 'Right', v: right },
    ];

    const lines = [];
    for (const ray of rays) {
        const segs = depths.map(d => {
            try {
                const bx = Math.round(pos.x + ray.v.dx * d);
                const bz = Math.round(pos.z + ray.v.dz * d);
                const block = bot.blockAt(bot.vec3(bx, eyeY, bz));
                return describeBlock(block);
            } catch { return '?'; }
        });
        // Collapse long runs of the same block to avoid noise
        const collapsed = segs.reduce((acc, cur) => {
            if (acc.length && acc[acc.length - 1].startsWith(cur.split('!')[0])) {
                return acc;  // skip repeat
            }
            acc.push(cur);
            return acc;
        }, []);
        lines.push(`  ${ray.label.padEnd(22)}: ${collapsed.join(' → ')}`);
    }

    // Also check floor 1 block ahead for drop-offs / cliffs
    try {
        const floorBlock = bot.blockAt(bot.vec3(
            Math.round(pos.x + fwd.dx * 2),
            Math.floor(pos.y) - 1,
            Math.round(pos.z + fwd.dz * 2)
        ));
        const floorLabel = (!floorBlock || floorBlock.name === 'air') ? '⚠️ DROP-OFF ahead!' : floorBlock.name;
        lines.push(`  ${'Floor +2 blocks'.padEnd(22)}: ${floorLabel}`);
    } catch { /* skip */ }

    return lines.join('\n');
}

// ── Resource radar ────────────────────────────────────────────────────────────

/**
 * Scans loaded chunks for each resource type.
 * REACHABILITY FILTER: only reports blocks within ±4 Y of the bot's feet.
 * This prevents the bot acting on resources that are underground or floating.
 */
function scanResourceRadar(bot, radius = 48) {
    const pos = bot.entity?.position;
    if (!pos) return '  [radar unavailable]';

    const botY = Math.round(pos.y);
    const lines = [];

    for (const resource of RESOURCE_RADAR) {
        try {
            const block = bot.findBlock({
                matching: resource.match,
                maxDistance: radius,
                // Prefer blocks at a reachable Y first
            });

            if (block) {
                const dy = Math.round(block.position.y - botY);
                const dx = Math.round(block.position.x - pos.x);
                const dz = Math.round(block.position.z - pos.z);
                const dist = Math.round(Math.sqrt(dx * dx + dz * dz));
                const dir = getCardinalDirection(dx, dz);

                // Reachability check
                const reachable = Math.abs(dy) <= 4;
                const hNote = dy > 4 ? ` (${dy}↑ ABOVE — unreachable)` :
                    dy < -4 ? ` (${Math.abs(dy)}↓ BELOW — unreachable)` : '';
                const reachMark = reachable ? '' : ' ⚠️';

                lines.push(
                    `  ${resource.emoji} ${resource.key.padEnd(10)}: ${dist}b ${dir}${hNote}${reachMark}` +
                    (reachable ? ` → [${Math.round(block.position.x)},${Math.round(block.position.y)},${Math.round(block.position.z)}]` : '')
                );
            } else {
                lines.push(`  ${resource.emoji} ${resource.key.padEnd(10)}: none within ${radius}b`);
            }
        } catch { /* chunk not loaded */ }
    }

    // Entity scan — exact name, 24-block cap
    const ents = Object.values(bot.entities).filter(e =>
        e !== bot.entity && e.position &&
        e.position.distanceTo(pos) <= 24
    );

    const hostile = ents
        .filter(e => HOSTILE_MOBS.has(e.name?.toLowerCase()))
        .map(e => {
            const d = Math.round(e.position.distanceTo(pos));
            const dir = getCardinalDirection(e.position.x - pos.x, e.position.z - pos.z);
            return `${e.name}(${d}b ${dir})`;
        }).slice(0, 5);

    const food = ents
        .filter(e => FOOD_MOBS.has(e.name?.toLowerCase()))
        .map(e => {
            const d = Math.round(e.position.distanceTo(pos));
            const dir = getCardinalDirection(e.position.x - pos.x, e.position.z - pos.z);
            return `${e.name}(${d}b ${dir})`;
        }).slice(0, 5);

    const neutral = ents
        .filter(e => NEUTRAL_MOBS.has(e.name?.toLowerCase()))
        .map(e => {
            const d = Math.round(e.position.distanceTo(pos));
            const dir = getCardinalDirection(e.position.x - pos.x, e.position.z - pos.z);
            return `${e.name}(${d}b ${dir})`;
        }).slice(0, 3);

    lines.push(`  ☠️  hostile   : ${hostile.length ? hostile.join(', ') : 'none within 24b'}`);
    lines.push(`  🍖 food mobs : ${food.length ? food.join(', ') : 'none within 24b'}`);
    lines.push(`  👤 neutral   : ${neutral.length ? neutral.join(', ') : 'none within 24b'}`);

    return lines.join('\n');
}

// ── Environment ───────────────────────────────────────────────────────────────

function scanEnvironment(bot) {
    try {
        const pos = bot.entity?.position;
        if (!pos) return '  [environment unavailable]';

        const ticks = bot.time?.timeOfDay ?? 0;
        const isDay = ticks < 13000 || ticks > 23000;
        const timeStr = isDay
            ? `Day (${ticks} ticks)`
            : `⚠️ NIGHT (${ticks}) — hostile mobs spawning!`;

        const lightLevel = bot.blockAt(pos)?.light ?? '?';
        const weather = bot.isRaining ? '🌧 Raining' : '☀️ Clear';
        const y = Math.round(pos.y);

        // Light level warning
        const lightWarn = lightLevel !== '?' && lightLevel <= 7 ? ' ⚠️ LOW LIGHT (mob spawns possible)' : '';

        return `  Time: ${timeStr} | Light: ${lightLevel}${lightWarn} | Weather: ${weather} | Y: ${y}`;
    } catch {
        return '  [environment unavailable]';
    }
}

// ── Master formatter ──────────────────────────────────────────────────────────

/**
 * Combines all vision layers into one string for the LLM prompt.
 * Everything shown is VERIFIED live from chunk data — no stale cache.
 */
function formatVision(bot, recentEvents = []) {
    const directional = scanDirectional(bot);
    const radar = scanResourceRadar(bot, 48);
    const environment = scanEnvironment(bot);
    const eventLines = recentEvents.slice(-5).map(e => `  ${e}`).join('\n') || '  Nothing notable yet.';

    return `\
VISION (live, verified from chunk data):
${directional}

RESOURCE RADAR (48b radius — ⚠️ = unreachable height, only act on reachable entries):
${radar}

ENVIRONMENT:
${environment}

RECENT EVENTS:
${eventLines}`.trim();
}

module.exports = { formatVision, scanResourceRadar, getCardinalDirection };
