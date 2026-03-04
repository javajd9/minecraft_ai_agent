/**
 * prepare_data.js — Gameplay Experience Processor
 * 
 * Converts logs/experiences.json into a instruction-tuning dataset for Llama 3.2.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const EXP_FILE = path.join(__dirname, '..', 'logs', 'experiences.json');
const OUTPUT_FILE = path.join(__dirname, 'training_data.jsonl');

function prepareData() {
    console.log('📊 Preparing training data...');

    if (!fs.existsSync(EXP_FILE)) {
        console.error('❌ No experiences.json found. Run the bot first!');
        return;
    }

    const experiences = JSON.parse(fs.readFileSync(EXP_FILE, 'utf8'));
    const trainingPairs = [];

    let count = 0;
    for (const exp of experiences) {
        // Skip entries with no real evaluation (from before our Level 2 fix)
        // We can detect these if they have the default "Completed X" detail and no gained/lost items
        if (exp.details.startsWith('Completed') && Object.keys(exp.gained).length === 0 && Object.keys(exp.lost).length === 0 && exp.result === 'success') {
            // console.log(`  Skipping legacy entry: ${exp.action}`);
            // continue;
        }

        const instruction = buildInstruction(exp);
        const output = {
            thought: exp.details || `I chose to ${exp.action} because it seemed appropriate for the current state.`,
            chat: "",
            goal: exp.action,
            memory: "",
            action: exp.action,
            action_target: exp.target
        };

        // We only want to train on SUCCESSES for the specific action choice.
        // For FAILURES, we could train it to AVOID them, but that's more complex.
        // For now, let's focus on positive reinforcement.
        if (exp.result === 'success') {
            trainingPairs.push({
                instruction,
                output: JSON.stringify(output)
            });
            count++;
        }
    }

    // Write to JSONL
    const content = trainingPairs.map(p => JSON.stringify(p)).join('\n');
    fs.writeFileSync(OUTPUT_FILE, content);

    console.log(`✅ Prepared ${count} training examples in ${OUTPUT_FILE}`);
}

/**
 * Reconstructs a prompt similar to what the bot saw during the experience.
 */
function buildInstruction(exp) {
    const ctx = exp.context || { biome: 'unknown', time: 'day' };
    return `You are DIDDYBOT, a Minecraft survival agent.
IDENTITY: I am DIDDYBOT, a Minecraft survival agent. I explore, gather, and build.
STATUS:
  Position: ${exp.target || 'unknown'} | Health: ${exp.healthBefore}/20
  Biome: ${ctx.biome} | Time: ${ctx.time}
  Equipped: ${ctx.equipped || 'none'}
YOUR TASK: Decide what to do next based on your current state.
Respond with ONLY valid JSON.`;
}

prepareData();
