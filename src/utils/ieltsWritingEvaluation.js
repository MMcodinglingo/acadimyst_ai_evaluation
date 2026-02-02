const OpenAI = require('openai');
const winston = require('../config/logger');

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

const {
    task1ExtractPrompt,
    task2ExtractPrompt,
    task1AssessPrompt,
    task2AssessPrompt,
    finalCombinedReportPrompt,
} = require('../prompts/ieltsWriting');
/**
 * Generate IELTS Writing Evaluation using GPT-5
 *
 * This function supports the two-step IELTS evaluation process:
 * 1. Extract: Analyze question to identify key features
 * 2. Assess: Evaluate student response with structured JSON output
 *
 * @param {Object} params - Evaluation parameters
 * @param {String} params.instructions - System instructions for the AI
 * @param {String|Array} params.input - User input (can be string or structured messages)
 * @returns {Promise<Object>} - AI response with content, choices, and model
 */
async function generateIeltsWritingEvaluation({ instructions, input }) {
    try {
        winston.info('🌐 Sending IELTS writing for AI evaluation...');

        // Prepare messages array
        let messages = [];

        // Add system message
        if (instructions) {
            messages.push({ role: 'system', content: instructions });
        }

        // Add user message(s)
        if (typeof input === 'string') {
            messages.push({ role: 'user', content: input });
        } else if (Array.isArray(input)) {
            // Support array of messages (for future multimodal support)
            messages = messages.concat(input);
        }

        // Use GPT-5 like junior dev's code - no fallback
        const model = 'gpt-5';
        winston.info(` Using ${model} for IELTS evaluation...`);

        const response = await client.chat.completions.create({
            model: model,
            messages: messages,
        });

        const content = response.choices?.[0]?.message?.content || '';
        const finishReason = response.choices?.[0]?.finish_reason;

        // Warn if output was truncated
        if (finishReason === 'length') {
            winston.warn(' AI response may be truncated (hit max_tokens limit). Consider increasing max_completion_tokens.');
        }

        winston.info(` IELTS evaluation complete using ${model}.`);

        return {
            content,
            choices: response.choices?.[0],
            model: model,
        };
    } catch (err) {
        console.log(err);
        winston.error('IELTS Writing Evaluation Error:', err);

        // Return error structure
        return {
            content: JSON.stringify({
                error: true,
                message: err.message || 'OpenAI request failed',
                details: err.response?.data || null,
            }),
            choices: null,
            model: null,
        };
    }
}

// Helper function to build manual combined report (fallback)
const buildManualCombinedReport = (tasksResult) => {
    const t1 = tasksResult.find((t) => t.taskNumber === 1);
    const t2 = tasksResult.find((t) => t.taskNumber === 2);

    const task1Band = t1?.grade || 0;
    const task2Band = t2?.grade || 0;
    const weightedBand = (task1Band * 0.33 + task2Band * 0.67).toFixed(3);
    const roundedBand = Math.round(weightedBand * 2) / 2;

    return {
        final_summary: {
            Overall_writing_band: roundedBand,
            task1_band: task1Band,
            task2_band: task2Band,
            weighted_estimated_writing_band: weightedBand,
            rounded_writing_band: roundedBand,
        },
        task1: {
            overall_band: task1Band?.toString() || '—',
            ...t1?.assessmentReport,
        },
        task2: {
            overall_band: task2Band?.toString() || '—',
            ...t2?.assessmentReport,
        },
    };
};

module.exports = {
    task1ExtractPrompt,
    task2ExtractPrompt,
    generateIeltsWritingEvaluation,
    task1AssessPrompt,
    task2AssessPrompt,
    finalCombinedReportPrompt,
    buildManualCombinedReport,
};
