/**
 * experience.js — Outcome Tracking & Experience Logger
 *
 * Records every action's result (success/failure/death) with inventory deltas,
 * health changes, and timing. Feeds recent experiences back into the LLM prompt
 * so the bot learns from its own history.
 *
 * Data is also the foundation for future fine-tuning (Level 3 learning).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXP_FILE = path.join(__dirname, 'logs', 'experiences.json');
const MAX_ENTRIES = 200;   // rolling cap — oldest pruned first

class ExperienceLog {
    constructor() {
        this.entries = this._load();
        this._pending = null;   // the action currently in-flight
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Call BEFORE an action starts. Snapshots state so we can diff later.
     */
    beginAction(action, target, bot, sessionCount) {
        const pos = bot.entity?.position;
        let biome = 'unknown';
        try { biome = bot.blockAt(pos)?.biome?.name || 'unknown'; } catch { }
        const timeOfDay = bot.time?.timeOfDay;
        const isNight = timeOfDay ? (timeOfDay > 13000 && timeOfDay < 23000) : false;

        // Count nearby hostile mobs by name (mineflayer doesn't have e.type === 'hostile')
        const hostileNames = new Set(['zombie', 'skeleton', 'spider', 'creeper', 'enderman', 'witch', 'phantom', 'pillager']);
        let hostileCount = 0;
        try {
            hostileCount = Object.values(bot.entities).filter(e =>
                e !== bot.entity && e.name && hostileNames.has(e.name.toLowerCase()) &&
                e.position && bot.entity?.position && e.position.distanceTo(bot.entity.position) < 20
            ).length;
        } catch { }

        this._pending = {
            session: sessionCount,
            time: new Date().toLocaleTimeString(),
            action,
            target: target || '',
            startMs: Date.now(),
            invBefore: this._countItems(bot),
            healthBefore: bot.health ?? 20,
            posBefore: this._pos(bot),
            context: {
                biome,
                time: isNight ? 'night' : 'day',
                hasHostiles: hostileCount,
                equipped: bot.heldItem ? bot.heldItem.name : 'none'
            }
        };
    }

    /**
     * Call AFTER the action finishes (or fails / bot dies).
     * result: 'success' | 'fail' | 'death' | 'timeout'
     */
    endAction(result, details, bot) {
        if (!this._pending) return;

        const p = this._pending;
        this._pending = null;

        const invAfter = this._countItems(bot);
        const gained = {};
        const lost = {};

        // Diff inventories
        const allKeys = new Set([...Object.keys(p.invBefore), ...Object.keys(invAfter)]);
        for (const k of allKeys) {
            const before = p.invBefore[k] || 0;
            const after = invAfter[k] || 0;
            if (after > before) gained[k] = after - before;
            if (before > after) lost[k] = before - after;
        }

        const entry = {
            session: p.session,
            time: p.time,
            action: p.action,
            target: p.target,
            result,
            details: details || '',
            gained,
            lost,
            healthBefore: p.healthBefore,
            healthAfter: bot.health ?? 0,
            durationMs: Date.now() - p.startMs,
            context: p.context
        };

        this.entries.push(entry);

        // Rolling cap
        while (this.entries.length > MAX_ENTRIES) this.entries.shift();

        this._save();

        // Console log with emoji
        const emoji = result === 'success' ? '✅' : result === 'death' ? '💀' : '❌';
        const gainStr = Object.keys(gained).length ? ` +${Object.entries(gained).map(([k, v]) => `${v} ${k}`).join(', ')}` : '';
        const lostStr = Object.keys(lost).length ? ` -${Object.entries(lost).map(([k, v]) => `${v} ${k}`).join(', ')}` : '';
        console.log(`[Experience] ${emoji} ${p.action}(${p.target}) → ${result}${gainStr}${lostStr} (${Math.round(entry.durationMs / 1000)}s)`);

        return entry;
    }

    /**
     * Abort tracking if an action was interrupted without completing.
     */
    cancel() {
        this._pending = null;
    }

    /**
     * Format recent N experiences for the LLM prompt.
     */
    getRecentForPrompt(n = 8) {
        const recent = this.entries.slice(-n);
        if (recent.length === 0) return '  No experiences yet — this is a fresh start.';

        return recent.map(e => {
            const emoji = e.result === 'success' ? '✅' : e.result === 'death' ? '💀' : '❌';
            const gain = Object.entries(e.gained || {}).map(([k, v]) => `+${v} ${k}`).join(', ');
            const lose = Object.entries(e.lost || {}).map(([k, v]) => `-${v} ${k}`).join(', ');
            const delta = [gain, lose].filter(Boolean).join(', ');
            return `  ${emoji} ${e.action}(${e.target || '-'}) → ${e.result}${delta ? ' [' + delta + ']' : ''}`;
        }).join('\n');
    }

    /**
     * Compute per-action success rate stats for the prompt.
     */
    getStats() {
        const stats = {};
        for (const e of this.entries) {
            if (!stats[e.action]) stats[e.action] = { ok: 0, total: 0 };
            stats[e.action].total++;
            if (e.result === 'success') stats[e.action].ok++;
        }

        if (Object.keys(stats).length === 0) return '  No data yet.';

        return Object.entries(stats)
            .map(([action, { ok, total }]) => {
                const pct = Math.round((ok / total) * 100);
                return `  ${action}: ${pct}% (${ok}/${total})`;
            })
            .join(' | ');
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    _countItems(bot) {
        const counts = {};
        try {
            for (const item of bot.inventory.items()) {
                counts[item.name] = (counts[item.name] || 0) + item.count;
            }
        } catch { /* bot may not have inventory yet */ }
        return counts;
    }

    _pos(bot) {
        try {
            const p = bot.entity.position;
            return [Math.round(p.x), Math.round(p.y), Math.round(p.z)];
        } catch { return [0, 0, 0]; }
    }

    _load() {
        try {
            if (fs.existsSync(EXP_FILE)) {
                return JSON.parse(fs.readFileSync(EXP_FILE, 'utf8'));
            }
        } catch (e) {
            console.warn('[Experience] Could not load experiences:', e.message);
        }
        return [];
    }

    _save() {
        try {
            fs.writeFileSync(EXP_FILE, JSON.stringify(this.entries, null, 2));
        } catch (e) {
            console.warn('[Experience] Could not save:', e.message);
        }
    }
}

module.exports = { ExperienceLog };
