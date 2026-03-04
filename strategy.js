/**
 * strategy.js — Adaptive Strategy Engine
 *
 * Aggregates experience logs into high-level survival strategies.
 * Learned patterns are used to:
 *   1. Warn the LLM about context-specific failures (e.g. "don't hunt in water")
 *   2. Support hardcoded overrides with data-driven evidence
 *   3. Generate training data for future fine-tuning
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STRATEGY_DB = path.join(__dirname, 'logs', 'strategy_db.json');

class StrategyEngine {
    constructor() {
        this.db = this._load();
    }

    /**
     * Records a new outcome and updates pattern statistics.
     * @param {string} action The action taken (mine_wood, seek_food, etc)
     * @param {string} result 'success' | 'fail' | 'death'
     * @param {Object} context { biome, timeOfDay, tool, threats, nearbyWater }
     */
    recordOutcome(action, result, context = {}) {
        if (!this.db.patterns[action]) {
            this.db.patterns[action] = {
                contexts: {},
                totalAttempts: 0,
                successCount: 0
            };
        }

        const p = this.db.patterns[action];
        p.totalAttempts++;
        if (result === 'success') p.successCount++;

        // Update context-specific patterns
        for (const [key, value] of Object.entries(context)) {
            const ctxKey = `${key}:${value}`;
            if (!p.contexts[ctxKey]) {
                p.contexts[ctxKey] = { success: 0, fail: 0, death: 0 };
            }
            p.contexts[ctxKey][result] = (p.contexts[ctxKey][result] || 0) + 1;
        }

        this.db.lastUpdated = new Date().toISOString();
        this._updateLessons();
        this._save();
    }

    /**
     * Returns a summary of learned lessons for the LLM prompt.
     */
    getLessonsForPrompt(n = 5) {
        if (this.db.lessons.length === 0) {
            return "  No advanced strategies learned yet. Observe results and refine your approach.";
        }
        return this.db.lessons.slice(0, n).map(l => `  💡 ${l.text}`).join('\n');
    }

    /**
     * Returns risky situatuations to avoid.
     */
    getAvoidList() {
        const avoids = [];
        // Never tell the LLM to avoid core survival actions
        const coreActions = new Set(['mine_wood', 'mine_stone', 'craft', 'explore', 'seek_food', 'eat']);
        for (const [action, data] of Object.entries(this.db.patterns)) {
            if (coreActions.has(action)) continue;
            for (const [ctx, stats] of Object.entries(data.contexts || {})) {
                const total = stats.success + stats.fail + stats.death;
                if (total >= 15) {
                    const failRate = (stats.fail + stats.death) / total;
                    if (failRate > 0.75) {
                        avoids.push(`${action} in ${ctx.replace(':', '=')} (${Math.round(failRate * 100)}% fail rate)`);
                    }
                }
            }
        }
        return avoids.length > 0 ? avoids : ["None yet - keep experimenting."];
    }

    /**
     * Returns the success rate for an action in a specific context.
     */
    getSuccessRate(action, contextKey, contextValue) {
        const p = this.db.patterns[action];
        if (!p) return null;
        const ctx = p.contexts[`${contextKey}:${contextValue}`];
        if (!ctx) return p.successCount / p.totalAttempts;
        const total = ctx.success + ctx.fail + ctx.death;
        return ctx.success / total;
    }

    /**
     * Analyzes patterns and generates human-readable lessons.
     */
    _updateLessons() {
        const newLessons = [];

        // Core actions should never get "avoid" lessons — they're essential
        const coreActions = new Set(['mine_wood', 'mine_stone', 'craft', 'explore', 'seek_food', 'eat']);

        for (const [action, data] of Object.entries(this.db.patterns)) {
            // Overall success rate trends
            const rate = data.successCount / data.totalAttempts;
            if (data.totalAttempts >= 20) {
                if (rate > 0.8) {
                    newLessons.push({ text: `${action} is highly reliable (${Math.round(rate * 100)}% success).`, confidence: rate });
                } else if (rate < 0.3 && !coreActions.has(action)) {
                    newLessons.push({ text: `${action} frequently fails. Analyze context to find why.`, confidence: 1 - rate });
                }
            }

            // Context-specific findings
            for (const [ctx, stats] of Object.entries(data.contexts)) {
                const total = stats.success + stats.fail + stats.death;
                if (total >= 15) {
                    const successRate = stats.success / total;
                    const [key, val] = ctx.split(':');

                    if (successRate < 0.25 && !coreActions.has(action)) {
                        newLessons.push({
                            text: `Avoid ${action} when ${key} is ${val} (Fails ${Math.round((1 - successRate) * 100)}% of the time).`,
                            confidence: 1 - successRate
                        });
                    } else if (successRate > 0.85) {
                        newLessons.push({
                            text: `${action} works best when ${key} is ${val}.`,
                            confidence: successRate
                        });
                    }
                }
            }
        }

        // Sort by confidence and keep top 20
        this.db.lessons = newLessons
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, 20);
    }

    _load() {
        try {
            if (fs.existsSync(STRATEGY_DB)) {
                return JSON.parse(fs.readFileSync(STRATEGY_DB, 'utf8'));
            }
        } catch (e) {
            console.warn('[Strategy] Found corrupted DB, starting fresh.');
        }
        return {
            patterns: {},
            lessons: [],
            lastUpdated: new Date().toISOString()
        };
    }

    _save() {
        try {
            fs.writeFileSync(STRATEGY_DB, JSON.stringify(this.db, null, 2));
        } catch (e) {
            console.error('[Strategy] Failed to save DB:', e.message);
        }
    }
}

module.exports = { StrategyEngine };
