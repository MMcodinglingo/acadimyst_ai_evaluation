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
    buildHolisticImpressionPrompt,
} = require('../prompts/oetWriting');

const { withRetry } = require('../utils/retry');
const {
    // Single-shot (backward compat)
    EvaluationSchema,
    evaluationJsonSchema,
    // Multi-step schemas
    RelevanceCheckSchema,
    relevanceCheckJsonSchema,
    ErrorDetectionSchema,
    errorDetectionJsonSchema,
    VerificationSchema,
    verificationJsonSchema,
    ScoringSchema,
    scoringJsonSchema,
    FeedbackSchema,
    feedbackJsonSchema,
    HolisticImpressionSchema,
    holisticImpressionJsonSchema,
    // Shared
    computeFinalScore,
    buildLegacyContent,
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
            () =>
                client.chat.completions.create({
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
            () =>
                client.chat.completions.create({
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
        const processingPrompt = buildCaseNotesProcessingPrompt({ fileContent });

        const response = await withRetry(
            () =>
                client.chat.completions.create({
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
            () =>
                client.chat.completions.create({
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

        winston.info(
            `OET Evaluation complete — raw: ${computed.rawTotal}/42, scaled: ${computed.scaledScore}/500, grade: ${computed.grade}`
        );

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
async function structuredCall({ systemPrompt, userContent, jsonSchema, schemaName, zodSchema, label, model = 'gpt-4o', seed = 12345 }) {
    const response = await withRetry(
        () =>
            client.chat.completions.create({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent },
                ],
                response_format: {
                    type: 'json_schema',
                    json_schema: { name: schemaName, schema: jsonSchema, strict: true },
                },
                seed,
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
 * Dual-pass scoring: run scoring twice with different seeds, compare results.
 * If any criterion diverges by more than 1 point, take the median (average rounded down).
 * Returns the final reconciled scores, justifications, and confidence.
 */
async function dualPassScoring(scoringContent) {
    const SEED_A = 12345;
    const SEED_B = 67890;

    // Run both passes in parallel for speed
    const [passA, passB] = await Promise.all([
        structuredCall({
            systemPrompt: buildScoringPrompt(),
            userContent: scoringContent,
            jsonSchema: scoringJsonSchema,
            schemaName: 'oet_scoring',
            zodSchema: ScoringSchema,
            label: 'scoring_passA',
            seed: SEED_A,
        }),
        structuredCall({
            systemPrompt: buildScoringPrompt(),
            userContent: scoringContent,
            jsonSchema: scoringJsonSchema,
            schemaName: 'oet_scoring',
            zodSchema: ScoringSchema,
            label: 'scoring_passB',
            seed: SEED_B,
        }),
    ]);

    // If one pass failed, fall back to the other
    if (!passA && !passB) return null;
    if (!passA) return passB;
    if (!passB) return passA;

    // Compare and reconcile
    const criteria = ['purpose', 'content', 'conciseness_clarity', 'organization_layout', 'genre_style', 'language'];
    const reconciledScores = {};
    const divergences = [];

    for (const c of criteria) {
        const a = passA.scores[c];
        const b = passB.scores[c];
        const diff = Math.abs(a - b);

        if (diff > 1) {
            // Significant divergence — take the median (floor of average)
            reconciledScores[c] = Math.floor((a + b) / 2);
            divergences.push(`${c}: passA=${a}, passB=${b}, reconciled=${reconciledScores[c]}`);
        } else {
            // Within tolerance — take the lower score (conservative, like a real examiner)
            reconciledScores[c] = Math.min(a, b);
        }
    }

    if (divergences.length > 0) {
        winston.warn(`Dual-pass scoring divergences found:\n${divergences.join('\n')}`);
    } else {
        winston.info('Dual-pass scoring: both passes agree (within ±1 tolerance)');
    }

    // Use justifications from pass A (primary), but flag confidence as low if divergences exist
    const confidence = divergences.length > 0 ? 'low' : passA.confidence;
    const confidenceReason = divergences.length > 0
        ? `Scoring passes diverged on ${divergences.length} criterion/criteria: ${divergences.map(d => d.split(':')[0]).join(', ')}`
        : passA.confidenceReason;

    return {
        scores: reconciledScores,
        justifications: passA.justifications,
        confidence,
        confidenceReason: confidenceReason || '',
        passA: passA.scores,
        passB: passB.scores,
    };
}

/**
 * Build the zero-score result returned when a letter is completely irrelevant to the case notes.
 */
function buildIrrelevantResult(correctedText, relevanceResult) {
    const zeroScores = {
        purpose: 0,
        content: 0,
        conciseness_clarity: 0,
        organization_layout: 0,
        genre_style: 0,
        language: 0,
    };
    const structured = {
        letterWithCorrections: correctedText,
        examinerFeedback: `This letter is completely irrelevant to the provided case notes. ${relevanceResult.reason}. The case notes describe "${relevanceResult.caseNotesIdentifiers.patientName}" with "${relevanceResult.caseNotesIdentifiers.primaryCondition}", but the student's letter discusses "${relevanceResult.letterIdentifiers.patientName}" with "${relevanceResult.letterIdentifiers.primaryCondition}". A score of 0 has been assigned for all criteria because the letter does not address the correct case. The student must write a letter that addresses the correct patient and clinical scenario as described in the case notes.`,
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

/**
 * Build the zero-score result returned when a submission is not a valid letter.
 */
function buildNotALetterResult(submittedText, reason) {
    const zeroScores = {
        purpose: 0,
        content: 0,
        conciseness_clarity: 0,
        organization_layout: 0,
        genre_style: 0,
        language: 0,
    };
    const structured = {
        letterWithCorrections: submittedText,
        examinerFeedback: `This submission is not a valid OET letter and cannot be evaluated. ${reason}. To receive a score, you must write an original medical letter (referral, discharge, transfer, or update) in proper letter format, addressing the patient and clinical scenario described in the case notes. Your letter should include a salutation (e.g., "Dear Dr..."), body paragraphs discussing the patient's case, and an appropriate closing (e.g., "Yours sincerely").`,
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
            purpose: 'Not a valid letter submission — 0',
            content: 'Not a valid letter submission — 0',
            conciseness_clarity: 'Not a valid letter submission — 0',
            organization_layout: 'Not a valid letter submission — 0',
            genre_style: 'Not a valid letter submission — 0',
            language: 'Not a valid letter submission — 0',
        },
        relevanceCheck: { verdict: 'not_a_letter', reason },
        verificationSummary: null,
    };
}

// ── Deterministic format validation constants ──
const FORMAT_MIN_WORD_COUNT = 50;
const GIBBERISH_MARKERS = ['lorem', 'ipsum', 'dolor sit amet', 'consectetur adipiscing', 'sed do eiusmod'];

// Salutation patterns that indicate the start of a letter
const SALUTATION_PATTERNS = [
    /\bdear\s+(dr|doctor|mr|mrs|ms|miss|prof|professor|sir|madam|colleague)/i,
    /\bdear\s+[A-Z]/,          // "Dear " followed by a capitalized word
    /\bto\s+whom\s+it\s+may\s+concern/i,
    /\bre\s*:\s*/i,            // "Re:" subject line (common in OET letters)
];

// Closing patterns that indicate the end of a letter
const CLOSING_PATTERNS = [
    /yours\s+(sincerely|faithfully|truly)/i,
    /kind\s+regards/i,
    /with\s+(kind|best|warm)\s+regards/i,
    /yours\s+respectfully/i,
    /regards\s*,?\s*$/im,
];

// Case-notes structural markers — if the submission contains many of these,
// it's likely copied case notes rather than a letter
const CASE_NOTES_MARKERS = [
    'social background', 'family history', 'medical history', 'current drugs',
    'o/e', 'pathology requested', 'pathology report', 'review 2 weeks',
    'review 4 weeks', 'nil significant', 'nil else significant', 'nad',
    'bowels normal', 'micturition normal', 'bmi', 'fbe', 'u&es', 'lfts',
    'hba1c', 'full lipid profile', 'subSections', 'writingSection',
];

const handleMultiStepEvaluation = async (correctedText, processedCaseNotes, patientName = null) => {
    try {
        if (!correctedText || typeof correctedText !== 'string' || correctedText.trim().length === 0) {
            winston.warn('handleMultiStepEvaluation: No corrected text provided');
            return null;
        }

        const userContent = buildEvalUserContent(correctedText, processedCaseNotes);
        const letterLower = correctedText.toLowerCase();

        // ── Step -1: Deterministic Format Validation Gate ──
        // This gate ALWAYS runs — it cannot be bypassed by name matching.
        // It catches: too short, lorem ipsum, copied case notes, and non-letter submissions.
        const words = correctedText.trim().split(/\s+/);
        const wordCount = words.length;

        // Check 1: Minimum word count
        if (wordCount < FORMAT_MIN_WORD_COUNT) {
            winston.warn(`Format gate: submission too short (${wordCount} words, minimum ${FORMAT_MIN_WORD_COUNT}) — rejecting`);
            return buildNotALetterResult(correctedText, `Your submission contains only ${wordCount} words. An OET letter typically requires 180-200 words to adequately address the case notes`);
        }

        // Check 2: Gibberish / placeholder text detection
        const hasGibberish = GIBBERISH_MARKERS.some((marker) => letterLower.includes(marker));
        if (hasGibberish) {
            winston.warn('Format gate: gibberish/placeholder text detected (lorem ipsum) — rejecting');
            return buildNotALetterResult(correctedText, 'Your submission contains placeholder or test text (e.g., "lorem ipsum") and is not a genuine letter attempt');
        }

        // Check 3: Letter structure — must have a salutation (Dear ...) AND closing
        const hasSalutation = SALUTATION_PATTERNS.some((pattern) => pattern.test(correctedText));
        const hasClosing = CLOSING_PATTERNS.some((pattern) => pattern.test(correctedText));

        if (!hasSalutation && !hasClosing) {
            // No letter structure at all — likely copied case notes or random text
            winston.warn('Format gate: no letter structure found (no salutation, no closing) — rejecting');
            return buildNotALetterResult(correctedText, 'Your submission does not have the structure of a letter. An OET letter must begin with a salutation (e.g., "Dear Dr Smith") and end with an appropriate closing (e.g., "Yours sincerely"). It appears you may have submitted raw case notes or unformatted text instead of a letter');
        }

        if (!hasSalutation) {
            winston.warn('Format gate: no salutation found — logging warning, proceeding to LLM check');
        }
        if (!hasClosing) {
            winston.warn('Format gate: no closing found — logging warning, proceeding to evaluation');
        }

        // Check 4: Case notes copy detection — if the submission contains many case-notes
        // structural markers, it's likely the student just copied the case notes verbatim
        const caseNotesMarkerCount = CASE_NOTES_MARKERS.filter((marker) => letterLower.includes(marker)).length;
        if (caseNotesMarkerCount >= 5) {
            winston.warn(`Format gate: submission appears to be copied case notes (${caseNotesMarkerCount} case-notes markers found) — rejecting`);
            return buildNotALetterResult(correctedText, 'Your submission appears to be a copy of the case notes rather than an original letter. You must write your own letter using the information from the case notes, not copy them directly. Transform the case notes into a properly formatted medical letter with a salutation, body paragraphs in complete sentences, and a closing');
        }

        winston.info(`Format gate passed: ${wordCount} words, salutation=${hasSalutation}, closing=${hasClosing}, caseNotesMarkers=${caseNotesMarkerCount}`);

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
                winston.info(
                    `Relevance gate (deterministic): name token found in letter — skipping LLM check. (tokens: ${nameTokens.join(', ')})`
                );
            } else {
                winston.warn(
                    `Relevance gate (deterministic): NO name token from "${patientName}" found in letter — triggering LLM relevance check. (tokens checked: ${nameTokens.join(', ')})`
                );
            }
        } else {
            winston.warn('Relevance gate: no patientName available — falling back to LLM');
        }

        // Tier 2: LLM relevance check — runs when deterministic name check fails.
        // The AI compares the letter content against the case notes dynamically.
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
                winston.info(
                    `Relevance check — Case notes: patient="${relevanceResult.caseNotesIdentifiers.patientName}", condition="${relevanceResult.caseNotesIdentifiers.primaryCondition}"`
                );
                winston.info(
                    `Relevance check — Letter:     patient="${relevanceResult.letterIdentifiers.patientName}", condition="${relevanceResult.letterIdentifiers.primaryCondition}"`
                );
                winston.info(
                    `Relevance check verdict: ${relevanceResult.verdict} (confidence: ${relevanceResult.confidence}) — ${relevanceResult.reason}`
                );

                // Reject on not_a_letter — submission is not a valid letter at all
                if (relevanceResult.verdict === 'not_a_letter') {
                    winston.warn('RELEVANCE GATE: Submission is not a valid letter — returning zero scores');
                    return buildNotALetterResult(correctedText, relevanceResult.reason);
                }

                // Reject on completely_irrelevant — ANY confidence level
                if (relevanceResult.verdict === 'completely_irrelevant') {
                    winston.warn('RELEVANCE GATE: Letter is completely irrelevant to case notes — returning zero scores');
                    return buildIrrelevantResult(correctedText, relevanceResult);
                }
                if (relevanceResult.verdict === 'partially_relevant') {
                    winston.warn(`Relevance check: partially relevant — ${relevanceResult.reason}. Proceeding with evaluation.`);
                }
            } else {
                // FAIL-CLOSED: if LLM check fails and name was not found, we cannot confirm
                // this letter matches the case notes. Reject instead of risking a wrong evaluation.
                winston.error('Relevance check LLM call failed AND no deterministic name match — rejecting (fail-closed)');
                const zeroScores = {
                    purpose: 0,
                    content: 0,
                    conciseness_clarity: 0,
                    organization_layout: 0,
                    genre_style: 0,
                    language: 0,
                };
                const structured = {
                    letterWithCorrections: correctedText,
                    examinerFeedback:
                        'The system was unable to verify whether this letter corresponds to the provided case notes. Please ensure your letter addresses the correct patient and clinical scenario as described in the case notes, and try again.',
                    scores: zeroScores,
                };
                const computed = computeFinalScore(zeroScores);
                return {
                    content: buildLegacyContent(structured, computed),
                    structured,
                    computed,
                    confidence: 'high',
                    confidenceReason: 'Relevance check failed — cannot confirm letter matches case notes',
                    justifications: {
                        purpose: 'Unable to verify relevance — 0',
                        content: 'Unable to verify relevance — 0',
                        conciseness_clarity: 'Unable to verify relevance — 0',
                        organization_layout: 'Unable to verify relevance — 0',
                        genre_style: 'Unable to verify relevance — 0',
                        language: 'Unable to verify relevance — 0',
                    },
                    verificationSummary: null,
                };
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
        ]
            .filter(Boolean)
            .join('\n\n');

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
            const missingItems = verifyResult.additionalCorrections.filter((c) => c.type === 'missing');
            if (missingItems.length > 0) {
                const missingMarkers = missingItems.map((c) => `[[missing: ${c.reason}]]`).join('\n');
                mergedLetter += `\n\n${missingMarkers}`;
            }
        } else {
            winston.info('Verification: no additional errors found');
        }

        // ── Step 1c: Holistic Impression ──
        // A senior examiner "gut-level" band assessment before analytical scoring.
        // This anchors the scoring step and prevents score drift.
        winston.info('Multi-step evaluation: Step 1c — Holistic Impression');
        const holisticContent = [
            `**STUDENT LETTER:**\n${correctedText}`,
            processedCaseNotes ? `**CASE NOTES:**\n${processedCaseNotes}` : '',
        ]
            .filter(Boolean)
            .join('\n\n');

        const holisticResult = await structuredCall({
            systemPrompt: buildHolisticImpressionPrompt(),
            userContent: holisticContent,
            jsonSchema: holisticImpressionJsonSchema,
            schemaName: 'oet_holistic_impression',
            zodSchema: HolisticImpressionSchema,
            label: 'holisticImpression',
        });

        if (holisticResult) {
            winston.info(`Holistic impression: band=${holisticResult.holisticBand}, strength="${holisticResult.keyStrength}", weakness="${holisticResult.keyWeakness}"`);
        } else {
            winston.warn('Holistic impression step failed — proceeding without anchor');
        }

        // ── Step 2: Dual-Pass Scoring ──
        // Run scoring twice with different seeds. If any criterion diverges by >1,
        // take the median. This catches random variance in LLM scoring.
        winston.info('Multi-step evaluation: Step 2 — Dual-Pass Scoring');
        const scoringContent = [
            `**CORRECTED LETTER WITH ALL ERROR MARKERS:**\n${mergedLetter}`,
            processedCaseNotes ? `**CASE NOTES:**\n${processedCaseNotes}` : '',
            holisticResult
                ? `**HOLISTIC IMPRESSION (senior examiner anchor):**\nOverall band: ${holisticResult.holisticBand}\nImpression: ${holisticResult.impression}\nKey strength: ${holisticResult.keyStrength}\nKey weakness: ${holisticResult.keyWeakness}\n\nIMPORTANT: Your analytical scores should be CONSISTENT with this holistic band. If the holistic band is "${holisticResult.holisticBand}", your criterion scores should cluster around the corresponding score range. Large deviations require strong justification.`
                : '',
        ]
            .filter(Boolean)
            .join('\n\n');

        const scoreResult = await dualPassScoring(scoringContent);
        if (!scoreResult) {
            winston.error('Multi-step evaluation: Step 2 (Dual-Pass Scoring) failed');
            return null;
        }

        // Log dual-pass details if available
        if (scoreResult.passA && scoreResult.passB) {
            winston.info(`Dual-pass scores — Pass A: ${JSON.stringify(scoreResult.passA)}`);
            winston.info(`Dual-pass scores — Pass B: ${JSON.stringify(scoreResult.passB)}`);
            winston.info(`Dual-pass scores — Final:  ${JSON.stringify(scoreResult.scores)}`);
        }

        // ── Step 3: Feedback ──
        winston.info('Multi-step evaluation: Step 3 — Feedback Generation');
        const feedbackContent = [
            `**ORIGINAL STUDENT LETTER (exactly as submitted):**\n${correctedText}`,
            `**CORRECTED LETTER WITH ERROR MARKERS:**\n${mergedLetter}`,
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
            examinerFeedback: feedbackResult.examinerFeedback,
            scores: scoreResult.scores,
        };

        const computed = computeFinalScore(structured.scores);
        const legacyContent = buildLegacyContent(structured, computed);

        winston.info(
            `Multi-step evaluation complete — raw: ${computed.rawTotal}/42, scaled: ${computed.scaledScore}/500, grade: ${computed.grade}, confidence: ${scoreResult.confidence}`
        );

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
            holisticImpression: holisticResult || null,
            // AI criterion scores for teacher comparison — save these so teachers
            // can rate and compare their own scores against the AI's scores
            aiCriterionScores: {
                purpose: scoreResult.scores.purpose,
                content: scoreResult.scores.content,
                conciseness_clarity: scoreResult.scores.conciseness_clarity,
                organization_layout: scoreResult.scores.organization_layout,
                genre_style: scoreResult.scores.genre_style,
                language: scoreResult.scores.language,
            },
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
