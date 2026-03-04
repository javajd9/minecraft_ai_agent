/**
 * test_strategy.js — Unit tests for StrategyEngine
 */

const { StrategyEngine } = require('../strategy');
const fs = require('fs');
const path = require('path');

async function runTest() {
    console.log('🧪 Testing StrategyEngine...');

    // Use a temporary DB for testing
    const testDbPath = path.join(__dirname, '..', 'logs', 'strategy_db_test.json');
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);

    // Mock the path to use the test DB
    // (In a real setup we'd pass the path to constructor, but we'll manually set it for this test)
    const engine = new StrategyEngine();
    // Override the save path by monkey-patching _save (simplest for this test)
    engine._save = function () {
        fs.writeFileSync(testDbPath, JSON.stringify(this.db, null, 2));
    };

    // 1. Record some successes
    console.log('  Recording successful actions...');
    for (let i = 0; i < 10; i++) {
        engine.recordOutcome('mine_wood', 'success', { biome: 'forest', time: 'day' });
    }

    // 2. Record some failures in specific context
    console.log('  Recording failed actions in specific context...');
    for (let i = 0; i < 8; i++) {
        engine.recordOutcome('seek_food', 'fail', { biome: 'swamp', nearbyWater: 'true' });
    }
    engine.recordOutcome('seek_food', 'success', { biome: 'swamp', nearbyWater: 'true' });
    engine.recordOutcome('seek_food', 'success', { biome: 'swamp', nearbyWater: 'true' });

    // 3. Verify lessons
    console.log('  Verifying lessons...');
    const lessons = engine.getLessonsForPrompt();
    console.log(lessons);

    if (lessons.includes('mine_wood is highly reliable')) {
        console.log('  ✅ Correctly identified reliable action');
    } else {
        console.log('  ❌ Failed to identify reliable action');
    }

    if (lessons.includes('Avoid seek_food when biome is swamp')) {
        console.log('  ✅ Correctly identified risky context');
    } else {
        console.log('  ❌ Failed to identify risky context');
    }

    // 4. Verify avoid list
    console.log('  Verifying avoid list...');
    const avoids = engine.getAvoidList();
    console.log('  Avoid List:', avoids);
    if (avoids.some(a => a.includes('seek_food') && a.includes('biome is swamp'))) {
        console.log('  ✅ Correctly added to avoid list');
    } else {
        console.log('  ❌ Failed to add to avoid list');
    }

    // Cleanup
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    console.log('✨ Test Complete.');
}

runTest().catch(console.error);
