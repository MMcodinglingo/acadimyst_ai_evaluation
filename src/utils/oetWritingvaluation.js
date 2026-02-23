const OpenAI = require('openai');
const winston = require('../config/logger');
const {
    formatCaseNotesForLLM,
    extractLetterBlock,
    renderMarkedText,
    extractAssessmentMeta,
    getAssessmentOnly,
    buildAssessmentCards,
} = require('../utils/globalHelper');

const {
    buildOCrExtractionPrompt,
    buildOcrCorrectionSystemPrompt,
    buildCaseNotesProcessingPrompt,
    buildOetEvaluationUserContent,
    buildOetEvaluationSystemPrompt,
} = require('../prompts/oetWriting');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractTextFromImage({ imageUrl, pageIndex = 0, totalPages = 1 } = {}) {
    try {
        // Guard: Validate imageUrl
        if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
            winston.warn('extractTextFromImage: No image URL provided');
            return '';
        }

        const response = await client.chat.completions.create({
            model: 'gpt-4.1',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            // build ocr extraction prompt
                            type: 'text',
                            text: buildOCrExtractionPrompt({ pageIndex, totalPages }),
                        },
                        {
                            type: 'image_url',
                            image_url: {
                                url: imageUrl,
                                detail: 'high',
                            },
                        },
                    ],
                },
            ],
            temperature: 0,
            max_tokens: 2000,
        });

        return response?.choices?.[0]?.message?.content?.trim() || '';
    } catch (err) {
        winston.error('Error extracting text from image:', {
            message: err.message,
            code: err.code,
            imageUrl: imageUrl?.substring?.(0, 100), // Log truncated URL for debugging
            status: err.status,
            data: err.error,
        });
        return ''; // Return empty string instead of undefined
    }
}
async function correctOcrText(ocrText) {
    try {
        if (!ocrText || !ocrText.trim()) {
            throw new Error('OCR text is empty');
        }

        // build ocr correction system prompt
        const systemPrompt = buildOcrCorrectionSystemPrompt();

        const response = await client.chat.completions.create({
            model: 'gpt-4.1',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt,
                },
                {
                    role: 'user',
                    content: `Correct the following OCR text per the rules. Return only the corrected text.

<<<OCR_TEXT_START
${ocrText}
OCR_TEXT_END>>>`,
                },
            ],
            temperature: 0,
        });

        return response?.choices?.[0]?.message?.content?.trim();
    } catch (err) {
        winston.error('Error correcting OCR text:', {
            message: err.message,
            code: err.code,
            status: err.status,
            data: err.error,
        });
        return null; // Return null instead of undefined
    }
}

// Process case notes to extract relevant information
const handleProcessCaseNotes = async (caseNotes) => {
    try {
        // Guard: Validate input
        if (!caseNotes || !Array.isArray(caseNotes) || caseNotes.length === 0) {
            winston.warn('handleProcessCaseNotes: No case notes provided');
            return null;
        }

        const fileContent = formatCaseNotesForLLM(caseNotes);

        // Guard: Check if formatted content is valid
        if (!fileContent || fileContent.trim().length === 0) {
            winston.warn('handleProcessCaseNotes: Case notes formatting produced empty content');
            return null;
        }

        // Process case notes to extract relevant information
        const processingPrompt = buildCaseNotesProcessingPrompt(fileContent);

        const response = await client.chat.completions.create({
            model: 'o3',
            messages: [
                {
                    role: 'system',
                    content: processingPrompt,
                },
                {
                    role: 'user',
                    content: 'Please analyze these case notes and extract relevant information for OET Writing assessment.',
                },
            ],
            // temperature: 0,
            // max_tokens: 2000
        });
        const content = response?.choices?.[0]?.message?.content;
        // Guard: Validate response structure
        if (!content) {
            winston.warn('handleProcessCaseNotes: OpenAI returned empty or invalid response');
            return null;
        }
        return content;
    } catch (error) {
        // Log detailed error for debugging
        winston.error('Error processing case notes:', {
            message: error.message,
            code: error.code,
            status: error.status,
            statusText: error.statusText,
            data: error.error,
        });
        return null; // Explicit null return to indicate failure
    }
};

const handleOETEvaluation = async (correctedText, processedCaseNotes) => {
    try {
        // Guard: Validate input - correctedText is required
        if (!correctedText || typeof correctedText !== 'string' || correctedText.trim().length === 0) {
            winston.warn('handleOETEvaluation: No corrected text provided for evaluation');
            return null;
        }

        // Build System Prompt
        const oetPrompt = buildOetEvaluationSystemPrompt();

        // Prepare the evaluation content
        let evaluationContent = buildOetEvaluationUserContent({ correctedText, processedCaseNotes });

        const response = await client.chat.completions.create({
            model: 'gpt-4o',
            messages: [
                {
                    role: 'system',
                    content: oetPrompt,
                },
                {
                    role: 'user',
                    content: evaluationContent,
                },
            ],

            seed: 12345,
        });

        // Guard: Validate response structure
        const content = response?.choices?.[0]?.message?.content;
        if (!content) {
            winston.warn('handleOETEvaluation: OpenAI returned empty or invalid response');
            return null;
        }

        return {
            content,
            choices: response.choices[0],
            systemPrompt: oetPrompt,
            userPrompt: evaluationContent,
        };
    } catch (error) {
        // Log detailed error for debugging
        winston.error('Error during OET evaluation:', {
            message: error.message,
            code: error.code,
            status: error.status,
            statusText: error.statusText,
            data: error.error,
        });
        return null; // Explicit null return to indicate failure
    }
};

function processOetWritingFeedback(writingFeedback) {
    const content =
        typeof writingFeedback === 'string'
            ? writingFeedback
            : writingFeedback?.choices?.[0]?.message?.content || writingFeedback?.choices?.[0]?.delta?.content || '';

    if (!content) {
        return {
            letterHtml: 'No content found in OPENAI_RESPONSE.',
            meta: {},
            assessmentCards: [],
        };
    }

    const letterBlock = extractLetterBlock(content);
    const letterHtml = renderMarkedText(letterBlock || 'Letter not found.');

    const meta = extractAssessmentMeta(content);

    const assessmentOnly = getAssessmentOnly(content);
    const assessmentCards = buildAssessmentCards(assessmentOnly);

    return {
        letterHtml,
        meta,
        assessmentCards,
    };
}
module.exports = {
    extractTextFromImage,
    correctOcrText,
    handleProcessCaseNotes,
    handleOETEvaluation,
    processOetWritingFeedback,
};
