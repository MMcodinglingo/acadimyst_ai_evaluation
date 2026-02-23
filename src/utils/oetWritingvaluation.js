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
    // Multi-step prompts
    buildRelevanceCheckPrompt,
    buildErrorDetectionPrompt,
    buildVerificationPrompt,
    buildScoringPrompt,
    buildFeedbackPrompt,
} = require('../prompts/oetWriting');

const { withRetry } = require('../utils/retry');
const {
    // Single-shot (backward compat)
    EvaluationSchema, evaluationJsonSchema,
    // Multi-step schemas
    RelevanceCheckSchema, relevanceCheckJsonSchema,
    ErrorDetectionSchema, errorDetectionJsonSchema,
    VerificationSchema, verificationJsonSchema,
    ScoringSchema, scoringJsonSchema,
    FeedbackSchema, feedbackJsonSchema,
    // Shared
    computeFinalScore, buildLegacyContent,
} = require('../utils/evaluationSchema');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function extractTextFromImage({ imageUrl, pageIndex = 0, totalPages = 1 } = {}) {
    try {
        // Guard: Validate imageUrl
        if (!imageUrl || typeof imageUrl !== 'string' || imageUrl.trim().length === 0) {
            winston.warn('extractTextFromImage: No image URL provided');
            return '';
        }

        const response = await withRetry(
            () => client.chat.completions.create({
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
            }),
            { maxAttempts: 3, backoffMs: 1000, label: 'ocrExtraction' }
        );

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

        const response = await withRetry(
            () => client.chat.completions.create({
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
            }),
            { maxAttempts: 3, backoffMs: 1000, label: 'ocrCorrection' }
        );

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

        const response = await withRetry(
            () => client.chat.completions.create({
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
            }),
            { maxAttempts: 3, backoffMs: 2000, label: 'caseNotesProcessing' }
        );
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

        const response = await withRetry(
            () => client.chat.completions.create({
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
                response_format: {
                    type: 'json_schema',
                    json_schema: {
                        name: 'oet_evaluation',
                        schema: evaluationJsonSchema,
                        strict: true,
                    },
                },
                seed: 12345,
            }),
            { maxAttempts: 3, backoffMs: 2000, label: 'oetEvaluation' }
        );

        // Guard: Validate response structure
        const rawContent = response?.choices?.[0]?.message?.content;
        if (!rawContent) {
            winston.warn('handleOETEvaluation: OpenAI returned empty or invalid response');
            return null;
        }

        // Parse and validate with Zod — guaranteed to match schema or throw
        let structured;
        try {
            const parsed = JSON.parse(rawContent);
            structured = EvaluationSchema.parse(parsed);
        } catch (parseError) {
            winston.error('handleOETEvaluation: Failed to parse/validate structured output:', {
                message: parseError.message,
                rawContent: rawContent.substring(0, 500),
            });
            return null;
        }

        // Compute score and grade deterministically (never trust LLM arithmetic)
        const computed = computeFinalScore(structured.scores);

        // Build legacy content string for backward compatibility with PDF pipeline
        const legacyContent = buildLegacyContent(structured, computed);

        winston.info(`OET Evaluation complete — raw: ${computed.rawTotal}/42, scaled: ${computed.scaledScore}/500, grade: ${computed.grade}`);

        return {
            content: legacyContent,
            structured,
            computed,
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

// ─────────────────────────────────────────────────────────────
// MULTI-STEP EVALUATION (Relevance → Error Detection → Verify → Score → Feedback)
// ─────────────────────────────────────────────────────────────────

/**
 * Helper: make a structured JSON call to OpenAI with retry + Zod validation.
 */
async function structuredCall({ systemPrompt, userContent, jsonSchema, schemaName, zodSchema, label, model = 'gpt-4o' }) {
    const response = await withRetry(
        () => client.chat.completions.create({
            model,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userContent },
            ],
            response_format: {
                type: 'json_schema',
                json_schema: { name: schemaName, schema: jsonSchema, strict: true },
            },
            seed: 12345,
        }),
        { maxAttempts: 3, backoffMs: 2000, label }
    );

    const raw = response?.choices?.[0]?.message?.content;
    if (!raw) {
        winston.warn(`structuredCall [${label}]: empty response`);
        return null;
    }

    const parsed = JSON.parse(raw);
    return zodSchema.parse(parsed);
}

/**
 * Build user content that includes case notes (if available) followed by the student letter.
 */
function buildEvalUserContent(correctedText, processedCaseNotes) {
    if (!processedCaseNotes) return correctedText;
    return `**CASE NOTES ANALYSIS:**\n${processedCaseNotes}\n\n**STUDENT'S LETTER TO EVALUATE:**\n${correctedText}`;
}

/**
 * Build the zero-score result returned when a letter is completely irrelevant to the case notes.
 */
function buildIrrelevantResult(correctedText, relevanceResult) {
    const zeroScores = {
        purpose: 0, content: 0, conciseness_clarity: 0,
        organization_layout: 0, genre_style: 0, language: 0,
    };
    const structured = {
        letterWithCorrections: correctedText,
        summary: `This letter is completely irrelevant to the provided case notes. ${relevanceResult.reason}. The case notes describe "${relevanceResult.caseNotesIdentifiers.patientName}" with "${relevanceResult.caseNotesIdentifiers.primaryCondition}", but the student's letter discusses "${relevanceResult.letterIdentifiers.patientName}" with "${relevanceResult.letterIdentifiers.primaryCondition}". A score of 0 has been assigned for all criteria because the letter does not address the correct case.`,
        strengths: 'No strengths can be identified as the letter does not correspond to the correct case notes and clinical scenario.',
        areasForImprovement: 'The student must write a letter that addresses the correct patient and clinical scenario as described in the case notes. The submitted letter appears to be for a different test or case entirely. Please review the case notes carefully and rewrite the letter accordingly.',
        scores: zeroScores,
    };
    const computed = computeFinalScore(zeroScores);
    const legacyContent = buildLegacyContent(structured, computed);

    return {
        content: legacyContent,
        structured,
        computed,
        confidence: 'high',
        confidenceReason: null,
        justifications: {
            purpose: 'Letter addresses wrong case entirely — 0',
            content: 'Letter content is for a different patient/scenario — 0',
            conciseness_clarity: 'Irrelevant letter — 0',
            organization_layout: 'Irrelevant letter — 0',
            genre_style: 'Irrelevant letter — 0',
            language: 'Irrelevant letter — 0',
        },
        relevanceCheck: relevanceResult,
        verificationSummary: null,
    };
}

const handleMultiStepEvaluation = async (correctedText, processedCaseNotes, patientName = null) => {
    try {
        if (!correctedText || typeof correctedText !== 'string' || correctedText.trim().length === 0) {
            winston.warn('handleMultiStepEvaluation: No corrected text provided');
            return null;
        }

        const userContent = buildEvalUserContent(correctedText, processedCaseNotes);
        const letterLower = correctedText.toLowerCase();

        // ── Step 0: Relevance Gate ──
        // Tier 1: Deterministic name check — no LLM call at all.
        // Tokenize the patient name (strip titles like Mr/Mrs/Ms/Dr) and check if any meaningful
        // name part appears in the letter. If found → correct case → skip LLM check entirely.
        let nameFoundInLetter = false;

        if (patientName) {
            const titleStopwords = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir']);
            const nameTokens = patientName
                .toLowerCase()
                .replace(/[^a-z\s]/g, '')
                .split(/\s+/)
                .filter((t) => t.length > 1 && !titleStopwords.has(t));

            nameFoundInLetter = nameTokens.some((token) => letterLower.includes(token));

            if (nameFoundInLetter) {
                winston.info(`Relevance gate (deterministic): name token found in letter — skipping LLM check. (tokens: ${nameTokens.join(', ')})`);
            } else {
                winston.warn(`Relevance gate (deterministic): NO name token from "${patientName}" found in letter — triggering LLM relevance check. (tokens checked: ${nameTokens.join(', ')})`);
            }
        } else {
            winston.warn('Relevance gate: no patientName available — skipping deterministic check, falling back to LLM');
        }

        // Tier 2: LLM relevance check — only runs when name absent from letter (or name unavailable)
        if (!nameFoundInLetter) {
            winston.info('Multi-step evaluation: Step 0 — LLM Relevance Check');
            const relevanceResult = await structuredCall({
                systemPrompt: buildRelevanceCheckPrompt(),
                userContent,
                jsonSchema: relevanceCheckJsonSchema,
                schemaName: 'oet_relevance_check',
                zodSchema: RelevanceCheckSchema,
                label: 'relevanceCheck',
            });

            if (relevanceResult) {
                winston.info(`Relevance check — Case notes: patient="${relevanceResult.caseNotesIdentifiers.patientName}", condition="${relevanceResult.caseNotesIdentifiers.primaryCondition}"`);
                winston.info(`Relevance check — Letter:     patient="${relevanceResult.letterIdentifiers.patientName}", condition="${relevanceResult.letterIdentifiers.primaryCondition}"`);
                winston.info(`Relevance check verdict: ${relevanceResult.verdict} (confidence: ${relevanceResult.confidence}) — ${relevanceResult.reason}`);

                if (relevanceResult.verdict === 'completely_irrelevant' && relevanceResult.confidence === 'high') {
                    winston.warn('RELEVANCE GATE: Letter is completely irrelevant to case notes — returning zero scores');
                    return buildIrrelevantResult(correctedText, relevanceResult);
                }
                if (relevanceResult.verdict === 'completely_irrelevant' && relevanceResult.confidence === 'low') {
                    winston.warn('Relevance check: irrelevant verdict but low confidence — proceeding with evaluation as safety measure');
                }
                if (relevanceResult.verdict === 'partially_relevant') {
                    winston.warn(`Relevance check: partially relevant — ${relevanceResult.reason}. Proceeding with evaluation.`);
                }
            } else {
                winston.warn('Relevance check LLM call failed — proceeding with evaluation (fail-open)');
            }
        }

        // ── Step 1: Error Detection ──
        winston.info('Multi-step evaluation: Step 1 — Error Detection');
        const errorResult = await structuredCall({
            systemPrompt: buildErrorDetectionPrompt(),
            userContent,
            jsonSchema: errorDetectionJsonSchema,
            schemaName: 'oet_error_detection',
            zodSchema: ErrorDetectionSchema,
            label: 'errorDetection',
        });
        if (!errorResult) {
            winston.error('Multi-step evaluation: Step 1 (Error Detection) failed');
            return null;
        }

        // ── Step 1b: Verification ──
        winston.info('Multi-step evaluation: Step 1b — Verification');
        const verificationContent = [
            `**ORIGINAL STUDENT LETTER:**\n${correctedText}`,
            `**CORRECTED LETTER FROM FIRST EXAMINER:**\n${errorResult.letterWithCorrections}`,
            processedCaseNotes ? `**CASE NOTES:**\n${processedCaseNotes}` : '',
        ].filter(Boolean).join('\n\n');

        const verifyResult = await structuredCall({
            systemPrompt: buildVerificationPrompt(),
            userContent: verificationContent,
            jsonSchema: verificationJsonSchema,
            schemaName: 'oet_verification',
            zodSchema: VerificationSchema,
            label: 'verification',
        });

        // Merge verification corrections into the letter
        let mergedLetter = errorResult.letterWithCorrections;
        if (verifyResult && verifyResult.hasNewErrors && verifyResult.additionalCorrections.length > 0) {
            winston.info(`Verification found ${verifyResult.additionalCorrections.length} additional error(s)`);
            // Apply additional corrections by replacing original text with marked version
            for (const corr of verifyResult.additionalCorrections) {
                if (corr.originalText && mergedLetter.includes(corr.originalText)) {
                    mergedLetter = mergedLetter.replace(corr.originalText, corr.correction);
                }
            }
            // Append any missing-info corrections that couldn't be placed inline
            const missingItems = verifyResult.additionalCorrections.filter(c => c.type === 'missing');
            if (missingItems.length > 0) {
                const missingMarkers = missingItems.map(c => `[[missing: ${c.reason}]]`).join('\n');
                mergedLetter += `\n\n${missingMarkers}`;
            }
        } else {
            winston.info('Verification: no additional errors found');
        }

        // ── Step 2: Scoring ──
        winston.info('Multi-step evaluation: Step 2 — Scoring');
        const scoringContent = [
            `**CORRECTED LETTER WITH ALL ERROR MARKERS:**\n${mergedLetter}`,
            processedCaseNotes ? `**CASE NOTES:**\n${processedCaseNotes}` : '',
        ].filter(Boolean).join('\n\n');

        const scoreResult = await structuredCall({
            systemPrompt: buildScoringPrompt(),
            userContent: scoringContent,
            jsonSchema: scoringJsonSchema,
            schemaName: 'oet_scoring',
            zodSchema: ScoringSchema,
            label: 'scoring',
        });
        if (!scoreResult) {
            winston.error('Multi-step evaluation: Step 2 (Scoring) failed');
            return null;
        }

        // ── Step 3: Feedback ──
        winston.info('Multi-step evaluation: Step 3 — Feedback Generation');
        const feedbackContent = [
            `**CORRECTED LETTER:**\n${mergedLetter}`,
            `**SCORES AND JUSTIFICATIONS:**\n${JSON.stringify(scoreResult.scores, null, 2)}\n\n${JSON.stringify(scoreResult.justifications, null, 2)}`,
        ].join('\n\n');

        const feedbackResult = await structuredCall({
            systemPrompt: buildFeedbackPrompt(),
            userContent: feedbackContent,
            jsonSchema: feedbackJsonSchema,
            schemaName: 'oet_feedback',
            zodSchema: FeedbackSchema,
            label: 'feedback',
        });
        if (!feedbackResult) {
            winston.error('Multi-step evaluation: Step 3 (Feedback) failed');
            return null;
        }

        // ── Assemble final result ──
        const structured = {
            letterWithCorrections: mergedLetter,
            summary: feedbackResult.summary,
            strengths: feedbackResult.strengths,
            areasForImprovement: feedbackResult.areasForImprovement,
            scores: scoreResult.scores,
        };

        const computed = computeFinalScore(structured.scores);
        const legacyContent = buildLegacyContent(structured, computed);

        winston.info(`Multi-step evaluation complete — raw: ${computed.rawTotal}/42, scaled: ${computed.scaledScore}/500, grade: ${computed.grade}, confidence: ${scoreResult.confidence}`);

        return {
            content: legacyContent,
            structured,
            computed,
            confidence: scoreResult.confidence,
            confidenceReason: scoreResult.confidenceReason || null,
            justifications: scoreResult.justifications,
            verificationSummary: verifyResult
                ? { hasNewErrors: verifyResult.hasNewErrors, count: verifyResult.additionalCorrections.length }
                : null,
        };
    } catch (error) {
        winston.error('Error during multi-step OET evaluation:', {
            message: error.message,
            code: error.code,
            status: error.status,
            data: error.error,
        });
        return null;
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
    handleMultiStepEvaluation,
    processOetWritingFeedback,
};
