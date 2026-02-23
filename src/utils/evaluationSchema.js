const { z } = require('zod');

// ─── Single-shot Evaluation Schema (kept for backward compatibility) ───

const EvaluationSchema = z.object({
    letterWithCorrections: z.string().min(50),
    summary: z.string().min(20),
    strengths: z.string().min(20),
    areasForImprovement: z.string().min(20),
    scores: z.object({
        purpose: z.number().int().min(0).max(7),
        content: z.number().int().min(0).max(7),
        conciseness_clarity: z.number().int().min(0).max(7),
        organization_layout: z.number().int().min(0).max(7),
        genre_style: z.number().int().min(0).max(7),
        language: z.number().int().min(0).max(7),
    }),
});

// ─── Multi-Step Schemas ───

// Step 1: Error Detection
const ErrorDetectionSchema = z.object({
    letterWithCorrections: z.string().min(50),
});

// Step 1b: Verification
const VerificationSchema = z.object({
    additionalCorrections: z.array(z.object({
        originalText: z.string(),
        correction: z.string(),
        reason: z.string(),
        type: z.string(),
    })),
    hasNewErrors: z.boolean(),
});

// Step 2: Scoring
const ScoringSchema = z.object({
    scores: z.object({
        purpose: z.number().int().min(0).max(7),
        content: z.number().int().min(0).max(7),
        conciseness_clarity: z.number().int().min(0).max(7),
        organization_layout: z.number().int().min(0).max(7),
        genre_style: z.number().int().min(0).max(7),
        language: z.number().int().min(0).max(7),
    }),
    justifications: z.object({
        purpose: z.string(),
        content: z.string(),
        conciseness_clarity: z.string(),
        organization_layout: z.string(),
        genre_style: z.string(),
        language: z.string(),
    }),
    confidence: z.enum(['high', 'low']),
    confidenceReason: z.string().optional(),
});

// Step 3: Feedback
const FeedbackSchema = z.object({
    summary: z.string().min(20),
    strengths: z.string().min(20),
    areasForImprovement: z.string().min(20),
});

// ─── Deterministic score computation ───

function computeFinalScore(scores) {
    const rawTotal = Object.values(scores).reduce((a, b) => a + b, 0);
    const scaledScore = Math.round((rawTotal / 42) * 500 / 10) * 10;

    let grade;
    if (scaledScore >= 450) grade = 'A';
    else if (scaledScore >= 350) grade = 'B';
    else if (scaledScore >= 300) grade = 'C+';
    else if (scaledScore >= 200) grade = 'C';
    else if (scaledScore >= 100) grade = 'D';
    else grade = 'E';

    return { rawTotal, scaledScore, grade };
}

// ─── Legacy content builder ───

function buildLegacyContent(structured, computed) {
    return [
        `**PART 1 — STUDENT LETTER WITH INLINE CORRECTIONS**\n\n${structured.letterWithCorrections}`,
        `**SUMMARY**\n\n${structured.summary}`,
        `**STRENGTHS**\n\n${structured.strengths}`,
        `**AREAS FOR IMPROVEMENT**\n\n${structured.areasForImprovement}`,
        `**FINAL RESULT**\nTOTAL: ${computed.scaledScore}/500\nGRADE: ${computed.grade}`,
    ].join('\n\n');
}

// ─── JSON Schemas for OpenAI strict mode ───

const scoreProperty = { type: 'number', description: 'Score from 0 to 7 (integer)' };
const justificationProperty = { type: 'string', description: 'Brief justification for score' };

// Single-shot (kept for backward compat)
const evaluationJsonSchema = {
    type: 'object',
    properties: {
        letterWithCorrections: { type: 'string', description: 'FULL student letter with ALL inline corrections. Do NOT summarise.' },
        summary: { type: 'string', description: 'ONE cohesive paragraph covering all 6 criteria in sequence.' },
        strengths: { type: 'string', description: 'ONE cohesive paragraph covering what was done well.' },
        areasForImprovement: { type: 'string', description: 'ONE prescriptive paragraph with specific, actionable guidance.' },
        scores: {
            type: 'object',
            properties: {
                purpose: { ...scoreProperty, description: 'Purpose score (0-7)' },
                content: { ...scoreProperty, description: 'Content score (0-7)' },
                conciseness_clarity: { ...scoreProperty, description: 'Conciseness & Clarity score (0-7)' },
                organization_layout: { ...scoreProperty, description: 'Organization & Layout score (0-7)' },
                genre_style: { ...scoreProperty, description: 'Genre & Style score (0-7)' },
                language: { ...scoreProperty, description: 'Language score (0-7)' },
            },
            required: ['purpose', 'content', 'conciseness_clarity', 'organization_layout', 'genre_style', 'language'],
            additionalProperties: false,
        },
    },
    required: ['letterWithCorrections', 'summary', 'strengths', 'areasForImprovement', 'scores'],
    additionalProperties: false,
};

// Step 1: Error Detection
const errorDetectionJsonSchema = {
    type: 'object',
    properties: {
        letterWithCorrections: {
            type: 'string',
            description: 'The FULL student letter reproduced verbatim with ALL inline corrections using markers: ~error~ *correction* (assessor: reason) ~~irrelevant~~ [[missing: detail]].',
        },
    },
    required: ['letterWithCorrections'],
    additionalProperties: false,
};

// Step 1b: Verification
const verificationJsonSchema = {
    type: 'object',
    properties: {
        additionalCorrections: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    originalText: { type: 'string', description: 'Exact text from the letter that contains an error' },
                    correction: { type: 'string', description: 'Corrected version using inline markers' },
                    reason: { type: 'string', description: 'Why this is an error' },
                    type: { type: 'string', description: 'Error type: grammar, spelling, punctuation, content, register, irrelevant, fabricated, or missing' },
                },
                required: ['originalText', 'correction', 'reason', 'type'],
                additionalProperties: false,
            },
        },
        hasNewErrors: { type: 'boolean', description: 'Whether any new errors were found' },
    },
    required: ['additionalCorrections', 'hasNewErrors'],
    additionalProperties: false,
};

// Step 2: Scoring
const scoringJsonSchema = {
    type: 'object',
    properties: {
        scores: {
            type: 'object',
            properties: {
                purpose: { ...scoreProperty, description: 'Purpose score (0-7)' },
                content: { ...scoreProperty, description: 'Content score (0-7)' },
                conciseness_clarity: { ...scoreProperty, description: 'Conciseness & Clarity score (0-7)' },
                organization_layout: { ...scoreProperty, description: 'Organization & Layout score (0-7)' },
                genre_style: { ...scoreProperty, description: 'Genre & Style score (0-7)' },
                language: { ...scoreProperty, description: 'Language score (0-7)' },
            },
            required: ['purpose', 'content', 'conciseness_clarity', 'organization_layout', 'genre_style', 'language'],
            additionalProperties: false,
        },
        justifications: {
            type: 'object',
            properties: {
                purpose: justificationProperty,
                content: justificationProperty,
                conciseness_clarity: justificationProperty,
                organization_layout: justificationProperty,
                genre_style: justificationProperty,
                language: justificationProperty,
            },
            required: ['purpose', 'content', 'conciseness_clarity', 'organization_layout', 'genre_style', 'language'],
            additionalProperties: false,
        },
        confidence: { type: 'string', description: 'high or low' },
        confidenceReason: { type: 'string', description: 'Reason if confidence is low, empty string if high' },
    },
    required: ['scores', 'justifications', 'confidence', 'confidenceReason'],
    additionalProperties: false,
};

// Step 3: Feedback
const feedbackJsonSchema = {
    type: 'object',
    properties: {
        summary: { type: 'string', description: 'ONE cohesive paragraph covering all 6 criteria in sequence.' },
        strengths: { type: 'string', description: 'ONE cohesive paragraph covering what was done well.' },
        areasForImprovement: { type: 'string', description: 'ONE prescriptive paragraph with examples and corrected forms.' },
    },
    required: ['summary', 'strengths', 'areasForImprovement'],
    additionalProperties: false,
};

// Step 0: Relevance Check
const RelevanceCheckSchema = z.object({
    caseNotesIdentifiers: z.object({
        patientName: z.string(),
        primaryCondition: z.string(),
        letterType: z.string(),
        intendedRecipient: z.string(),
    }),
    letterIdentifiers: z.object({
        patientName: z.string(),
        primaryCondition: z.string(),
        letterType: z.string(),
        addressedTo: z.string(),
    }),
    verdict: z.enum(['relevant', 'partially_relevant', 'completely_irrelevant']),
    confidence: z.enum(['high', 'low']),
    reason: z.string(),
});

const relevanceCheckJsonSchema = {
    type: 'object',
    properties: {
        caseNotesIdentifiers: {
            type: 'object',
            properties: {
                patientName: { type: 'string', description: 'Patient name from case notes' },
                primaryCondition: { type: 'string', description: 'Primary condition from case notes' },
                letterType: { type: 'string', description: 'Expected letter type from case notes' },
                intendedRecipient: { type: 'string', description: 'Intended recipient from case notes' },
            },
            required: ['patientName', 'primaryCondition', 'letterType', 'intendedRecipient'],
            additionalProperties: false,
        },
        letterIdentifiers: {
            type: 'object',
            properties: {
                patientName: { type: 'string', description: 'Patient name from student letter' },
                primaryCondition: { type: 'string', description: 'Condition discussed in student letter' },
                letterType: { type: 'string', description: 'Type of letter written' },
                addressedTo: { type: 'string', description: 'Who the letter is addressed to' },
            },
            required: ['patientName', 'primaryCondition', 'letterType', 'addressedTo'],
            additionalProperties: false,
        },
        verdict: { type: 'string', description: 'relevant, partially_relevant, or completely_irrelevant' },
        confidence: { type: 'string', description: 'high or low — use low if any doubt about the verdict' },
        reason: { type: 'string', description: 'Brief explanation for the verdict' },
    },
    required: ['caseNotesIdentifiers', 'letterIdentifiers', 'verdict', 'confidence', 'reason'],
    additionalProperties: false,
};

module.exports = {
    // Single-shot (backward compat)
    EvaluationSchema,
    evaluationJsonSchema,
    // Multi-step
    RelevanceCheckSchema,
    relevanceCheckJsonSchema,
    ErrorDetectionSchema,
    VerificationSchema,
    ScoringSchema,
    FeedbackSchema,
    errorDetectionJsonSchema,
    verificationJsonSchema,
    scoringJsonSchema,
    feedbackJsonSchema,
    // Shared
    computeFinalScore,
    buildLegacyContent,
};
