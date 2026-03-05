/**
 * navigation.js — Reactive Navigation System for DIDDYBOT
 *
 * Human-like movement that adjusts in real-time:
 *  - Obstacle detection and avoidance (jump over 1-high, strafe around 2-high)
 *  - Water detection and escape
 *  - Stuck detection with unstick strategies (dig through if needed)
 *  - Cliff/drop-off avoidance with terrain scanning
 *  - Auto-adjusts target Y to match terrain height
 *  - Sprint on open ground for faster travel
 *
 * Replaces both mineflayer-pathfinder and the dumb _walkTo.
 */

'use strict';

const Vec3 = require('vec3');
const { getPathData, getCardinalDirection } = require('./scanner');

const TICK_MS = 150;         // 6.7Hz — fast reactive loop
const STUCK_THRESHOLD = 0.15; // If we moved < this in 1 second, stuck
const MAX_FALL = 3;          // Don't walk off drops higher than 3

class ReactiveNavigator {
    constructor(bot) {
        this.bot = bot;
        this._moving = false;
        this._posHistory = [];
        this._lastStuckDir = null;  // remember which way we went to avoid repeating
    }

    /**
     * Walk to a target position with real-time obstacle avoidance.
     * Returns true if arrived within range, false if gave up.
     */
    async goTo(target, range = 3, timeoutMs = 30000) {
        if (this._moving) {
            this.stop();
            await new Promise(r => setTimeout(r, 100));
        }

        this._moving = true;
        this._posHistory = [];
        const deadline = Date.now() + timeoutMs;
        let stuckCounter = 0;

        try {
            while (this._moving && Date.now() < deadline) {
                const pos = this.bot.entity?.position;
                if (!pos) break;

                // Check horizontal distance (ignore Y for arrival check)
                const hDist = Math.sqrt((pos.x - target.x) ** 2 + (pos.z - target.z) ** 2);
                if (hDist <= range) {
                    return true;
                }

                // Track position for stuck detection
                this._posHistory.push({ pos: pos.clone(), time: Date.now() });
                if (this._posHistory.length > 8) this._posHistory.shift();


                // ── Check: Stuck? → try various unstick strategies ───
                if (this._isStuck()) {
                    stuckCounter++;
                    if (stuckCounter > 8) {
                        console.log('[Nav] ❌ Hopelessly stuck');
                        return false;
                    }
                    await this._handleStuck(target, stuckCounter);
                    await new Promise(r => setTimeout(r, TICK_MS));
                    continue;
                } else if (stuckCounter > 0) {
                    stuckCounter--; // decay when moving
                }

                // ── Adjust target Y to terrain ───────────────────────
                // If target is at a very different Y, find the ground Y at that XZ
                const adjustedTarget = this._adjustTargetY(target);

                // ── Check: Obstacle ahead? (uses scanner path data) ──────
                const pathData = getPathData(this.bot);

                // In water? Swim toward target
                if (pathData && pathData.inWater) {
                    await this._handleWater(adjustedTarget);
                    continue;
                }

                // Get the direction we're heading toward the target
                const movDir = this._getMovementDir(pos, adjustedTarget, pathData);

                if (movDir) {
                    if (movDir.isLava) {
                        // NEVER walk into lava
                        await this._strafeAround(adjustedTarget);
                        continue;
                    } else if (movDir.blocked && movDir.jumpable) {
                        // 1-high block — sprint-jump over it
                        this.bot.setControlState('jump', true);
                        this.bot.setControlState('forward', true);
                        this.bot.setControlState('sprint', true);
                        await this.bot.lookAt(adjustedTarget.offset(0, 1, 0));
                        await new Promise(r => setTimeout(r, TICK_MS));
                        continue;
                    } else if (movDir.blocked && !movDir.jumpable) {
                        // 2+ high wall — cave-aware response
                        if (pathData.inCave || stuckCounter >= 2) {
                            // In a cave or stuck: dig through immediately
                            await this._digThrough(adjustedTarget);
                        } else {
                            await this._strafeAround(adjustedTarget);
                        }
                        continue;
                    } else if (!movDir.blocked && movDir.dropDepth > MAX_FALL) {
                        // Cliff ahead — avoid
                        await this._avoidCliff(adjustedTarget);
                        continue;
                    } else if (!movDir.blocked && movDir.dropDepth >= 1) {
                        // Safe slope down — walk carefully
                        this.bot.setControlState('sprint', false);
                        this.bot.setControlState('jump', false);
                    } else {
                        this.bot.setControlState('jump', false);
                        this.bot.setControlState('sprint', hDist > 10);
                    }
                } else {
                    // No path data for this direction — basic defaults
                    this.bot.setControlState('jump', false);
                    this.bot.setControlState('sprint', hDist > 10);
                }

                // ── Default: Walk toward target ──────────────────────
                await this.bot.lookAt(adjustedTarget.offset(0.5, 0, 0.5));
                this.bot.setControlState('forward', true);

                // ── Auto-jump: if moving forward but velocity ~ 0, we're hitting a ledge ──
                const vel = this.bot.entity?.velocity;
                if (vel) {
                    const hSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
                    if (hSpeed < 0.03 && this.bot.getControlState('forward')) {
                        // Bot is trying to move but stuck on something — jump!
                        this.bot.setControlState('jump', true);
                        this.bot.setControlState('sprint', true);
                    }
                }

                await new Promise(r => setTimeout(r, TICK_MS));
            }

            if (Date.now() >= deadline) {
                const dist = Math.round(this.bot.entity?.position?.distanceTo(target) || 999);
                console.log(`[Nav] ⏱️ Timeout — ${dist}b away`);
            }
            return false;

        } finally {
            this.bot.clearControlStates();
            this._moving = false;
        }
    }

    stop() {
        this._moving = false;
        try { this.bot.clearControlStates(); } catch { }
    }

    // ── Detection helpers ────────────────────────────────────────────────



    _isStuck() {
        if (this._posHistory.length < 6) return false;
        const recent = this._posHistory.slice(-6);
        const oldest = recent[0];
        const newest = recent[recent.length - 1];
        const timeDelta = newest.time - oldest.time;
        if (timeDelta < 800) return false; // need at least 0.8s of data
        return oldest.pos.distanceTo(newest.pos) < STUCK_THRESHOLD;
    }

    /**
     * Adjust target Y to match actual ground level at target XZ.
     * Prevents the bot from trying to walk to a Y that's underground/in the air.
     */
    _adjustTargetY(target) {
        try {
            const pos = this.bot.entity?.position;
            if (!pos) return target;

            // Only adjust if target is far-ish
            const hDist = Math.sqrt((pos.x - target.x) ** 2 + (pos.z - target.z) ** 2);
            if (hDist < 5) return target; // close enough, trust the target

            // Find ground at target XZ
            const tx = Math.round(target.x);
            const tz = Math.round(target.z);
            const startY = Math.round(pos.y) + 10; // search from above us

            for (let y = startY; y > startY - 20; y--) {
                const block = this.bot.blockAt(new Vec3(tx, y, tz));
                if (block && this._isSolid(block)) {
                    return new Vec3(target.x, y + 1, target.z);
                }
            }
        } catch { }
        return target;
    }

    // Keep _isSolid as a thin helper only for _adjustTargetY
    _isSolid(block) {
        return block && block.name !== 'air' && !block.name.includes('water') &&
            !block.name.includes('lava') && !block.name.includes('grass') &&
            !block.name.includes('flower') && !block.name.includes('torch') &&
            !block.name.includes('sapling') && !block.name.includes('vine') &&
            !block.name.includes('snow_layer') && !block.name.includes('carpet') &&
            !block.name.includes('leaves') && !block.name.includes('fern') &&
            !block.name.includes('dead_bush') && !block.name.includes('mushroom') &&
            block.boundingBox === 'block';
    }

    /**
     * Map the direction toward target to the nearest compass direction
     * from the scanner's path data. Returns the entry for that direction.
     */
    _getMovementDir(pos, target, pathData) {
        if (!pathData) return null;
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const label = getCardinalDirection(dx, dz);
        return pathData.directions[label] || null;
    }

    // ── Movement strategies ──────────────────────────────────────────────

    async _handleWater(target) {
        // Swim TOWARD target — water is safe, not something to flee from
        this.bot.setControlState('jump', true);   // swim upward
        this.bot.setControlState('forward', true);
        this.bot.setControlState('sprint', true);

        const pos = this.bot.entity?.position;
        if (!pos) return;

        // Always aim at the target — swim through water to get there
        await this.bot.lookAt(target.offset(0, 0.5, 0));

        // Only look for land if we've been swimming for a while (stuck check handles that)
        // For now just keep swimming toward the goal
        await new Promise(r => setTimeout(r, 300));
    }

    async _handleStuck(target, attempt) {
        this.bot.clearControlStates();
        const pos = this.bot.entity?.position;

        // Cycle through strategies
        const strategy = attempt % 6;
        switch (strategy) {
            case 1: // Strafe left + jump
                this._lastStuckDir = 'left';
                this.bot.setControlState('left', true);
                this.bot.setControlState('jump', true);
                this.bot.setControlState('forward', true);
                await new Promise(r => setTimeout(r, 800));
                break;
            case 2: // Strafe right + jump
                this._lastStuckDir = 'right';
                this.bot.setControlState('right', true);
                this.bot.setControlState('jump', true);
                this.bot.setControlState('forward', true);
                await new Promise(r => setTimeout(r, 800));
                break;
            case 3: // Back up, then sprint-jump forward
                this.bot.setControlState('back', true);
                await new Promise(r => setTimeout(r, 600));
                this.bot.clearControlStates();
                if (pos) await this.bot.lookAt(target.offset(0, 1, 0));
                this.bot.setControlState('forward', true);
                this.bot.setControlState('jump', true);
                this.bot.setControlState('sprint', true);
                await new Promise(r => setTimeout(r, 800));
                break;
            case 4: // Dig the block in front of us
                await this._digThrough(target);
                break;
            case 5: // Go sideways for longer (big detour)
                console.log('[Nav] 🔄 Big detour');
                const dir = this._lastStuckDir === 'left' ? 'right' : 'left';
                this.bot.setControlState(dir, true);
                this.bot.setControlState('forward', true);
                this.bot.setControlState('jump', true);
                await new Promise(r => setTimeout(r, 1500));
                break;
            default: // Jump + sprint forward
                if (pos) await this.bot.lookAt(target.offset(0, 1, 0));
                this.bot.setControlState('forward', true);
                this.bot.setControlState('jump', true);
                this.bot.setControlState('sprint', true);
                await new Promise(r => setTimeout(r, 600));
                break;
        }
        this.bot.clearControlStates();
        this._posHistory = []; // reset
    }

    /**
     * Dig through a 1-2 block wall in front of the bot.
     * Only digs if the bot has the right tool — won't break stone bare-handed.
     * Never digs downward (prevents falling into caves).
     */
    async _digThrough(target) {
        const pos = this.bot.entity?.position;
        if (!pos) return;

        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.5) return;
        const nx = dx / len;
        const nz = dz / len;

        const aheadX = Math.round(pos.x + nx * 1.2);
        const aheadZ = Math.round(pos.z + nz * 1.2);
        const feetY = Math.floor(pos.y);

        try {
            for (const y of [feetY, feetY + 1]) {
                const block = this.bot.blockAt(new Vec3(aheadX, y, aheadZ));
                if (block && this._isSolid(block) && block.diggable) {
                    // Check if we have the right tool before digging
                    if (!this._hasToolFor(block.name)) {
                        console.log(`[Nav] 🚫 Can't dig ${block.name} — no proper tool`);
                        return;
                    }
                    console.log(`[Nav] ⛏️ Digging through ${block.name}`);
                    await this.bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
                    await this.bot.dig(block);
                }
            }
        } catch (e) {
            console.warn(`[Nav] Dig failed: ${e.message}`);
        }
        this._posHistory = [];
    }

    /**
     * Check if we have the right tool category to efficiently break a block.
     * Returns false if the block needs a tool we don't have (e.g. stone without pickaxe).
     */
    _hasToolFor(blockName) {
        const n = blockName.toLowerCase();
        const inventory = this.bot.inventory.items();

        // Stone/ore blocks need a pickaxe
        if (n.includes('stone') || n.includes('ore') || n.includes('cobble') ||
            n.includes('brick') || n.includes('obsidian') || n.includes('deepslate') ||
            n.includes('andesite') || n.includes('diorite') || n.includes('granite') ||
            n.includes('netherrack') || n.includes('basalt') || n.includes('tuff')) {
            return inventory.some(i => i.name.includes('pickaxe'));
        }
        // Wood blocks need an axe (but CAN be broken by hand, just slowly)
        if (n.includes('_log') || n.includes('_wood') || n.includes('planks')) {
            return true; // wood is always breakable by hand
        }
        // Dirt/sand/gravel — any tool or hand works
        if (n.includes('dirt') || n.includes('grass_block') || n.includes('sand') ||
            n.includes('gravel')) {
            return true;
        }
        // Leaves/vines — breakable by hand
        if (n.includes('leaves') || n.includes('vine')) {
            return true;
        }
        // Unknown block — be cautious, don't dig without a pickaxe
        return inventory.some(i => i.name.includes('pickaxe'));
    }

    async _strafeAround(target) {
        this.bot.clearControlStates();
        const pos = this.bot.entity?.position;

        // Check which side has more open space
        let goLeft = Math.random() > 0.5;
        if (pos) {
            const dx = target.x - pos.x;
            const dz = target.z - pos.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            if (len > 0.5) {
                const nx = dx / len;
                const nz = dz / len;
                // Check left and right for open blocks
                const leftX = Math.round(pos.x + (-nz) * 2);
                const leftZ = Math.round(pos.z + (nx) * 2);
                const rightX = Math.round(pos.x + (nz) * 2);
                const rightZ = Math.round(pos.z + (-nx) * 2);
                try {
                    const leftBlock = this.bot.blockAt(new Vec3(leftX, Math.floor(pos.y), leftZ));
                    const rightBlock = this.bot.blockAt(new Vec3(rightX, Math.floor(pos.y), rightZ));
                    const leftOpen = !leftBlock || !this._isSolid(leftBlock);
                    const rightOpen = !rightBlock || !this._isSolid(rightBlock);
                    if (leftOpen && !rightOpen) goLeft = true;
                    else if (rightOpen && !leftOpen) goLeft = false;
                } catch { }
            }
        }

        const dir = goLeft ? 'left' : 'right';
        this.bot.setControlState(dir, true);
        this.bot.setControlState('forward', true);
        this.bot.setControlState('jump', true);
        await new Promise(r => setTimeout(r, 1000));
        this.bot.clearControlStates();

        if (pos) await this.bot.lookAt(target.offset(0.5, 0, 0.5));
        this._posHistory = [];
    }

    async _avoidCliff(target) {
        const pos = this.bot.entity?.position;
        if (!pos) return;

        console.log('[Nav] ⚠️ Cliff — scanning for safe path');
        this.bot.clearControlStates();

        // Scan left and right along the cliff edge to find a way down/around
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.5) return;
        const nx = dx / len;
        const nz = dz / len;

        // Check perpendicular directions for a safe path
        const dirs = [
            { label: 'left', sx: -nz, sz: nx },
            { label: 'right', sx: nz, sz: -nx },
        ];

        for (const d of dirs) {
            // Check 3, 6, 9 blocks to the side — is there solid ground ahead?
            for (const sideR of [3, 6]) {
                const checkX = Math.round(pos.x + d.sx * sideR + nx * 2);
                const checkZ = Math.round(pos.z + d.sz * sideR + nz * 2);
                try {
                    const block = this.bot.blockAt(new Vec3(checkX, Math.floor(pos.y) - 1, checkZ));
                    if (block && this._isSolid(block)) {
                        // Found safe ground — walk that direction
                        const sideTarget = new Vec3(pos.x + d.sx * sideR, pos.y, pos.z + d.sz * sideR);
                        await this.bot.lookAt(sideTarget);
                        this.bot.setControlState('forward', true);
                        this.bot.setControlState('jump', true);
                        await new Promise(r => setTimeout(r, 1200));
                        this.bot.clearControlStates();
                        this._posHistory = [];
                        return;
                    }
                } catch { }
            }
        }

        // No safe path found — back up
        this.bot.setControlState('back', true);
        await new Promise(r => setTimeout(r, 500));
        this.bot.clearControlStates();
        this._posHistory = [];
    }
}

module.exports = { ReactiveNavigator };
