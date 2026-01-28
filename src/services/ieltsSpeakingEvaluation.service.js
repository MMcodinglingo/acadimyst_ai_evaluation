const winston = require('../config/logger.js');
const { OpenAI } = require('openai');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');
const {
    loadToFile,
    partLabelFromNumber,
    taskKey,
    forceZeroScoresObj,
    safeJson,
    clampBand,
    computeOverallFromTasks,
    buildMismatchDetail,
    hasMismatchAlready,
} = require('../utils/globalHelper');
const htmlToPdf = require('../utils/htmlToPdf.js');

async function handleIeltsSpeakingEvaluation(studentSpeakingAnswer, speakingParts, speakingAudios, isAiBased, req) {
    try {
        if (!isAiBased) return;

        winston.info('Starting enhanced IELTS speaking evaluation with dual transcription and relevance checking...');

        // ============= INITIALIZE OPENAI CLIENT =============
        if (!process.env.OPENAI_API_KEY) {
            winston.error('OPENAI_API_KEY is missing in environment variables');
            return;
        }

        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const toFile = await loadToFile();
        const sttModel = 'gpt-4o-transcribe';

        // ============= PREP CONTAINERS =============
        const qaPairs = [];
        const questionMetaById = {}; // questionId -> { speakingPartId, subQuestionNumber }

        if (!speakingParts || speakingParts.length === 0) {
            winston.error('No IELTS speaking parts found for this test.');
            return;
        }

        const partById = {};
        const partByNumber = {};

        speakingParts.forEach((p) => {
            partById[String(p._id)] = p;
            partByNumber[p.partNumber] = p;
        });

        /**
         * Transcribe one audio with specific settings
         */
        async function transcribeOneAudio({ toFile, file, model, verbatim = false }) {
            const audioFile = await toFile(file.buffer, file.originalname, {
                type: file.mimetype,
            });

            const t = await client.audio.transcriptions.create({
                file: audioFile,
                model,
                ...(verbatim
                    ? {
                          prompt: 'Transcribe VERBATIM. Include fillers (uh, um, ahm), repetitions, false starts, and discourse markers (you know, like). Do not clean.',
                      }
                    : {
                          prompt: 'Transcribe cleanly for readability. Remove fillers like uh/um where possible, but keep meaning and grammar.',
                      }),
            });

            return (t?.text || '').trim();
        }

        /**
         * Process a single audio file: Download -> Transcribe (Clean + Verbatim in parallel)
         */
        const processSingleAudio = async (audio, i) => {
            const audioUrl = audio.audioUrl;
            const localPath = audio.key;

            try {
                // Download audio file to buffer
                winston.info(`Downloading audio ${i + 1}/${speakingAudios.length}: ${path.basename(localPath)}`);
                const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
                const audioBuffer = Buffer.from(response.data);

                const file = {
                    buffer: audioBuffer,
                    originalname: path.basename(localPath),
                    mimetype: 'audio/mpeg',
                };

                // Run both transcriptions in parallel
                winston.info(`Starting parallel transcriptions for audio ${i + 1}...`);

                const [cleanText, verbatimText] = await Promise.all([
                    transcribeOneAudio({
                        toFile,
                        file,
                        model: sttModel,
                        verbatim: false,
                    }),
                    transcribeOneAudio({
                        toFile,
                        file,
                        model: sttModel,
                        verbatim: true,
                    }),
                ]);

                winston.info(`Transcriptions complete for audio ${i + 1}`);

                const partDoc = partById[String(audio.speakingPartId)];

                if (!partDoc) {
                    winston.error(`IELTS Speaking part not found for speakingPartId ${audio.speakingPartId}`);
                    return null;
                }

                // Find the question text from embedded questions array
                let questionText = 'Question text not found';
                let questionHeading = 'Question Heading not found';
                let questionNumber = null;
                let order = i; // Default fallback

                if (partDoc.questions && typeof partDoc.questions.id === 'function') {
                    const subQ = partDoc.questions.id(audio.questionId);

                    if (subQ && subQ.questions) {
                        questionText = subQ.questions;
                        questionHeading = subQ.questionHeading || '';
                        questionNumber = subQ.questionNumber ?? null;
                        order = subQ.order ?? i;
                    }
                }

                const partNumber = partDoc.partNumber;

                // Side effect: Update metadata map
                questionMetaById[String(audio.questionId)] = {
                    speakingPartId: audio.speakingPartId,
                    subQuestionNumber: audio.subQuestionNumber || null,
                };

                return {
                    partNumber: partNumber,
                    partLabel: partLabelFromNumber(partNumber),
                    order: order,

                    // Use real questionNumber for task_key (fallback)
                    task_key: questionNumber != null ? `P${partNumber}-Q${questionNumber}` : `P${partNumber}-${taskKey(partNumber, order)}`,

                    questionNumber: questionNumber,
                    questionId: String(audio.questionId),
                    questionHeading: questionHeading,
                    questionText: questionText,
                    answerTranscript_clean: cleanText,
                    answerTranscript_verbatim: verbatimText,
                };
            } catch (innerErr) {
                winston.error(`Error while processing audio ${i + 1}:`, innerErr);
                return null;
            }
        };

        // Execute all audio processing in parallel
        const processedResults = await Promise.all(speakingAudios.map((audio, i) => processSingleAudio(audio, i)));

        // Filter out failures and add to qaPairs
        processedResults.forEach((result) => {
            if (result) {
                qaPairs.push(result);
            }
        });

        // Ignore warm-up (part 1 order 0) for scoring
        const qaPairsForScoring = qaPairs.filter((q) => !(q.partNumber === 1 && q.order === 0));
        winston.info(`Generated ${qaPairs.length} QA pairs, ${qaPairsForScoring.length} for scoring`);

        /* ----------------------------- JSON Schema ----------------------------- */

        const bandSchema = { type: 'number' };

        const scoresSchema = {
            type: 'object',
            additionalProperties: false,
            properties: {
                fluency_coherence: bandSchema,
                grammatical_range_accuracy: bandSchema,
                lexical_resource: bandSchema,
                pronunciation: bandSchema,
                overall_band: bandSchema,
            },
            required: ['fluency_coherence', 'grammatical_range_accuracy', 'lexical_resource', 'pronunciation', 'overall_band'],
        };

        const taskRelevanceItemSchema = {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_key: { type: 'string' },
                questionNumber: { type: ['string', 'number', 'null'] },
                partNumber: { type: 'number' },
                order: { type: 'number' },
                relevance: { type: 'string', enum: ['RELATED', 'NOT_RELATED'] },
                question_is_about: { type: 'string' },
                answer_is_about: { type: 'string' },
                scores: scoresSchema,
            },
            required: ['task_key', 'questionNumber', 'partNumber', 'order', 'relevance', 'question_is_about', 'answer_is_about', 'scores'],
        };

        const reportSchema = {
            type: 'object',
            additionalProperties: false,
            properties: {
                task_relevance: {
                    type: 'array',
                    minItems: 1,
                    items: taskRelevanceItemSchema,
                },
                scores: scoresSchema,
                summary: { type: 'string' },
                strengths: { type: 'string' },
                areas_of_improvement: { type: 'string' },
                actionable_feedback: { type: 'string' },
            },
            required: ['task_relevance', 'scores', 'summary', 'strengths', 'areas_of_improvement', 'actionable_feedback'],
        };

        /* ----------------------------- Prompt ----------------------------- */

        const relevanceGatePrefix = `
IMPORTANT OUTPUT STRUCTURE (MUST FOLLOW):
Return JSON with these keys exactly:
- task_relevance: array (one item per qaPair)
- scores
- summary
- strengths
- areas_of_improvement
- actionable_feedback

RELEVANCE GATE (MANDATORY PER TASK):
For EACH qaPair, decide if the answer matches the question.

In task_relevance[] for each qaPair include:
task_key, questionNumber,partNumber, order, relevance ("RELATED"/"NOT_RELATED"),
question_is_about (5–12 words), answer_is_about (5–12 words),
and scores object.
questionNumber MUST be copied from the provided qaPairs.questionNumber for that task (do not invent).


TASK-LEVEL RULES:
If relevance = "NOT_RELATED":
- scores for THAT TASK MUST ALL be 0 (all 5 score fields).
- Do NOT evaluate language quality for that task.
- Do NOT give task-level feedback beyond the required fields.

If relevance = "RELATED":
- Give normal scoring based on IELTS rubric.

GLOBAL REPORT RULES (VERY IMPORTANT):

1) If ALL tasks are marked NOT_RELATED:
- overall scores MUST be 0 for all criteria.
- summary MUST clearly state that all uploaded answers were mismatched with their questions.
- strengths MUST be empty or neutral (do NOT invent strengths).
- areas_of_improvement MUST explain that answers must address the correct questions before language can be assessed.
- actionable_feedback MUST focus only on understanding and answering the task correctly.
- Do NOT generate normal language evaluation.

2) If SOME tasks are RELATED and SOME are NOT_RELATED:
- overall scores MUST be computed including 0 scores for mismatched tasks.
- summary MUST mention that some answers were mismatched and negatively affected the score and mentioned the topic of question and candidate answer.
- areas_of_improvement MUST explicitly mention the mismatched task_keys and explain the impact and also mentioned the topic of question and candidate answer.
- strengths MUST be based ONLY on the RELATED tasks.
- actionable_feedback MUST include advice on answering the correct question before speaking.

3) If NO tasks are NOT_RELATED:
- Generate a normal IELTS speaking report with no mention of mismatch.

IMPORTANT:
- Never hide mismatched answers.
- Never ignore mismatched answers in scoring.
- Never invent language assessment for a NOT_RELATED answer.
`.trim();

        const yourOriginalPrompt = `
You are an IELTS Speaking examiner.
Assess IELTS Speaking strictly using official British Council / IELTS band descriptors.

Return STRICT JSON ONLY.
Do NOT include markdown, explanations, headings, or extra text outside JSON.

IMPORTANT INPUT INFORMATION

Each speaking answer includes two transcripts:

answerTranscript_verbatim:
Contains fillers (uh, um, uhm), repetitions, false starts, self-corrections, and hesitations.

answerTranscript_clean:
Cleaned for readability, with fillers removed where possible, but meaning and grammar preserved.

Transcript usage rules (MANDATORY):

Use answerTranscript_verbatim mainly for Fluency & Coherence assessment (hesitation, repetition, false starts, fillers, pauses).

Use answerTranscript_clean mainly for Lexical Resource and Grammatical Range & Accuracy assessment.

Use both transcripts when judging Pronunciation.

Do NOT infer pronunciation problems purely from transcript limitations or LLM artefacts.

TEST STRUCTURE RULES

Ignore the Introduction (order 0) completely. It is a warm-up and must NOT affect scores.

You must assess ALL parts:

Part 1 (Interview)

Part 2 (Long Turn)

Part 3 (Discussion)

Do NOT focus only on Part 2.

SCORING RULES (MANDATORY)

Always evaluate four criteria using 0.5 band increments only (0.0–9.0):

fluency_coherence

lexical_resource

grammatical_range_accuracy

pronunciation

If a calculated score results in values such as 4.25 or 4.75, round to the nearest 0.5.

Also compute:

overall_band = average of the four criteria, rounded to the nearest 0.5.

HUMAN EXAMINER ALIGNMENT (MANDATORY)

Assessment must reflect real IELTS examiner behaviour.

Do NOT over-penalise:

Natural repetition used for thinking

Slightly slow pace if ideas remain logical and connected

Attempts at discourse markers, even if imperfect

Topic development that is repetitive but still relevant

Give credit for:

Logical sequencing, even with language limitations

Clear intention and message despite errors

Effort to organise ideas, especially in Part 2

If the candidate attempts a feature (cohesion, paraphrasing, contrast, explanation), score must reflect partial success, not total failure.

Always distinguish between:

Attempted control

Lack of control

DETAILED ASSESSMENT CRITERIA
FLUENCY & COHERENCE

Assess the ability to speak at length with overall control.

Natural pauses for thinking are acceptable.

Do NOT penalise slow pace if ideas remain clear.

Penalise only when:

Hesitation breaks meaning

Sentences frequently trail off unfinished

Repairs dominate speech (e.g., "I was… I mean…", restarting mid-idea)

Repetition should reduce score ONLY if:

The same idea is repeated without development

Vocabulary and sentence structure remain unchanged

Cohesion:

Accept basic connectors ("so", "because", "and") at mid bands

Penalise only mechanical or empty linking

PART 2 (LONG TURN) – ADDITIONAL RULES

Response must be extended, organised, and not a list of disconnected points.

Candidate should begin with a background statement introducing the topic.

Actively check range of tenses:

Past, present, future

Check clause usage:

Reason, contrast, purpose

Check use of relevant vocabulary for the cue card topic.

Overuse of discourse markers ("and then", "so", "you know") should reduce score.

Use both strengths and mistakes with brief corrections drawn directly from the candidate's transcript.

LEXICAL RESOURCE

Assess vocabulary based on precision, range, and suitability to the candidate's level.

Do NOT penalise:

Simple but correct vocabulary at mid bands

Repetition of basic words if meaning remains clear

Penalise:

Incorrect word forms (e.g., "weathers", "inhabitation")

Unnatural collocations (e.g., "make fun" instead of "have fun")

Feedback must:

Suggest natural alternatives using simple language

Avoid advanced or academic vocabulary beyond the candidate's level

GRAMMATICAL RANGE & ACCURACY

Assess control before complexity.

At Band 5–6:

Accept simple sentences with occasional complex structures

Errors are expected but should not block meaning

Penalise recurring errors only when:

Errors are systematic (articles, prepositions, agreement)

Errors reduce clarity

Do NOT expect advanced grammar if:

Candidate is clearly operating at an intermediate level

Corrections must be:

Short

Clear

Practical

Based on the candidate's own transcript

PRONUNCIATION

Assess pronunciation holistically.

Do NOT:

Mention transcript or AI limitations

Say pronunciation issues are inferred from text alone

Focus on:

Rhythm

Chunking

Sentence stress

Intonation

Avoid technical phonetic terms.
Use simple sound hints only if necessary.

Assess the following:

Individual sounds

Accuracy of consonants and vowels

Distinction between similar sounds (e.g., ship vs sheep)

Note mispronunciations only if they cause strain or misunderstanding

Word stress

Correct stress in multi-syllable words

Noun–verb stress differences (PREsent vs preSENT)

Sentence stress

Stress on content words

Avoid flat, robotic delivery

Stress should support meaning

Intonation

Rising intonation for questions

Falling intonation for statements

Intonation should convey meaning and attitude

Connected speech

Natural linking (want to → wanna, next please → nexplease)

Smoothness of flow

Over-articulation or overly careful speech should be noted

FEEDBACK RULES

Feedback must be:

Easy to read for an average learner

Free from jargon

Actionable at the candidate's current level

Do NOT:

Say "To reach Band X"

Provide native-level or overly advanced examples

DO:

Say "To reach a higher band"

Give realistic improvements one level above current performance

OUTPUT FORMAT (STRICT)

Return JSON in this exact structure:

{
  "task_relevance": [],
  "scores": {
    "fluency_coherence": 0.0,
    "grammatical_range_accuracy": 0.0,
    "lexical_resource": 0.0,
    "pronunciation": 0.0,
    "overall_band": 0.0
  },
  "summary": "This paragraph should summarise the overall speaking performance in 6–8 lines by first commenting on fluency and coherence (length of responses, hesitation, repetition, pauses with evidences, fillers used by the candidate, and logical flow), then grammatical range and accuracy (sentence variety, tense control, recurring errors), followed by lexical resource (range, precision, repetition, collocations), and finally pronunciation (overall clarity, stress, intonation, and rhythm), without using headings or bullet points. Also Tell about the mismatched question and answer if there were any and tell me what was question about and what candidate answer was.",
  "strengths": "This paragraph should highlight the candidate's main strengths in 5–7 lines with clear evidence from the transcripts, starting with fluency and coherence, followed by grammatical range and accuracy, lexical resource, and ending with pronunciation, written as one continuous paragraph without subheadings.",
  "areas_of_improvement": "This paragraph should explain the key areas for improvement in 8–10 lines with direct transcript evidence and brief corrections, beginning with fluency and coherence (e.g., false starts like 'I was… I mean…' → 'I was', fillers such as 'uh', 'uhm'), followed by grammatical range and accuracy, then lexical resource, and finally pronunciation, all in one paragraph without headings.Also Tell about the mismatched question and answer if there were any and tell me what was question about and what candidate answer was.",
  "actionable_feedback": "This paragraph should provide clear, practical advice in 3–4 lines suited to the candidate's current level, focusing on planning ideas before speaking, finishing sentences, consolidating common grammar patterns, expanding topic-related vocabulary with correct collocations, and improving pronunciation through controlled pacing, clearer stress, and confident intonation, without mentioning specific band scores."
}
`.trim();

        const systemPrompt = `${relevanceGatePrefix}\n\n${yourOriginalPrompt}`.trim();

        /* ----------------------------- Model call ----------------------------- */

        async function callModelOnce({ systemPrompt, payload, reportSchema, maxOutputTokens }) {
            return client.responses.create({
                model: 'gpt-5',
                max_output_tokens: maxOutputTokens,
                input: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: JSON.stringify(payload, null, 2) },
                ],
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'ielts_speaking_report_with_task_relevance',
                        strict: true,
                        schema: reportSchema,
                    },
                    verbosity: 'low',
                },
            });
        }

        async function callModelWithRetry({ systemPrompt, payload, reportSchema }) {
            // Try 1
            winston.info('Calling GPT-5 model with 9000 token limit...');
            let resp = await callModelOnce({
                systemPrompt,
                payload,
                reportSchema,
                maxOutputTokens: 9000,
            });

            const reason = resp?.incomplete_details?.reason;
            const isIncomplete = resp?.status === 'incomplete';

            // If truncated, retry with bigger budget
            if (isIncomplete && reason === 'max_output_tokens') {
                winston.info('Response truncated, retrying with 14000 token limit...');
                resp = await callModelOnce({
                    systemPrompt,
                    payload,
                    reportSchema,
                    maxOutputTokens: 14000,
                });
            }

            return resp;
        }

        winston.info('Sending evaluation request to GPT-5...');
        const response = await callModelWithRetry({
            systemPrompt,
            payload: {
                title: 'IELTS Speaking Test',
                qaPairs: qaPairsForScoring,
            },
            reportSchema,
        });

        const usage = response?.usage || null;
        winston.info(
            `GPT-5 token usage: ${usage?.total_tokens ?? 'unknown'} total, ${usage?.input_tokens ?? 'unknown'} input, ${usage?.output_tokens ?? 'unknown'} output`
        );

        // Parse response
        let report = response.output_parsed;

        if (!report) {
            // fallback: try to read text from output array
            const maybeText =
                response.output?.[0]?.content?.find((c) => c.type === 'output_text')?.text ||
                response.output?.[0]?.content?.[0]?.text ||
                response.output_text ||
                '';

            report = safeJson(maybeText);
        }

        if (!report) {
            winston.error('No JSON received from GPT-5 model');
            return;
        }

        /* -----------------------------
       Server-side enforcement (MANDATORY behavior)
       - NOT_RELATED -> task scores all 0
       - Overall must be affected by mismatches (average includes zeros)
       - If ALL tasks mismatched -> overall 0 and summary states all mismatched
       - If SOME mismatched -> mention them in summary + areas_of_improvement
       - Keep output structure unchanged
    ----------------------------- */

        winston.info('Applying server-side enforcement for relevance checking...');

        if (report && typeof report === 'object' && !report.error) {
            // 1) Enforce task-level scores
            if (Array.isArray(report.task_relevance)) {
                report.task_relevance = report.task_relevance.map((t) => {
                    const rel = String(t?.relevance || '').toUpperCase();

                    if (rel === 'NOT_RELATED') {
                        return {
                            ...t,
                            relevance: 'NOT_RELATED',
                            scores: forceZeroScoresObj(),
                        };
                    }

                    // RELATED: clamp + recompute task overall
                    const s = t?.scores || {};
                    const fc = clampBand(s.fluency_coherence);
                    const lr = clampBand(s.lexical_resource);
                    const gra = clampBand(s.grammatical_range_accuracy);
                    const pro = clampBand(s.pronunciation);
                    const avg = (fc + lr + gra + pro) / 4;

                    return {
                        ...t,
                        relevance: 'RELATED',
                        scores: {
                            fluency_coherence: fc,
                            lexical_resource: lr,
                            grammatical_range_accuracy: gra,
                            pronunciation: pro,
                            overall_band: clampBand(avg),
                        },
                    };
                });
            } else {
                report.task_relevance = [];
            }

            const totalTasks = report.task_relevance.length;

            const mismatches = report.task_relevance.filter((t) => String(t?.relevance || '').toUpperCase() === 'NOT_RELATED');

            winston.info(`Relevance check: ${totalTasks} total tasks, ${mismatches.length} mismatched`);

            // 2) Overall scoring MUST be affected by mismatches (zeros included)
            report.scores = computeOverallFromTasks(report.task_relevance);

            // keep full paragraphs, preserve newlines
            report.summary = String(report.summary ?? '').trim();
            report.strengths = String(report.strengths ?? '').trim();
            report.areas_of_improvement = String(report.areas_of_improvement ?? '').trim();
            report.actionable_feedback = String(report.actionable_feedback ?? '').trim();

            // 4) If ALL tasks mismatched -> force overall 0 and special summary
            if (totalTasks > 0 && mismatches.length === totalTasks) {
                winston.warn('ALL tasks mismatched - setting scores to 0');
                report.scores = forceZeroScoresObj();

                const allDetail = buildMismatchDetail(mismatches, qaPairsForScoring);

                report.summary = `All uploaded audios are mismatched with their mapped questions, so the overall score is 0.
Please answer each question directly according to its task.

Mismatched: ${allDetail}`.trim();

                report.strengths = '';

                report.areas_of_improvement = `All responses are not aligned with the questions.
Focus on understanding each prompt, giving a direct answer first, then adding 1–2 supporting details or examples.

Mismatched: ${allDetail}`.trim();

                report.actionable_feedback =
                    'Re-record each answer while reading the exact question first, give a direct 1-sentence answer, then add 2 supporting sentences; keep the same topic and avoid switching to unrelated ideas.';
            } else if (mismatches.length > 0) {
                winston.warn(`${mismatches.length} tasks mismatched - adjusting feedback`);
                const detail = buildMismatchDetail(mismatches, qaPairsForScoring);

                // Only append if the model didn't already mention mismatch
                const summaryHas = hasMismatchAlready(report.summary, mismatches);
                const areasHas = hasMismatchAlready(report.areas_of_improvement, mismatches);

                // Pick ONE place to add it (recommended: areas_of_improvement only)
                if (!areasHas) {
                    report.areas_of_improvement = `${String(report.areas_of_improvement ?? '').trim()}

Task alignment issue: some answers did not match their mapped questions, which lowered the overall score.
Mismatches: ${detail}`.trim();
                }

                // Do NOT duplicate in summary if summary already contains mismatch explanation
                if (!summaryHas && areasHas) {
                    report.summary = `${String(report.summary ?? '').trim()}

Note: One or more answers were off-topic for their questions, which reduced the overall score.`.trim();
                }
            }

            // 6) Ensure required strings exist (schema safety)
            report.summary = String(report.summary ?? '');
            report.strengths = String(report.strengths ?? '');
            report.areas_of_improvement = String(report.areas_of_improvement ?? '');
            report.actionable_feedback = String(report.actionable_feedback ?? '');
        }

        // ============= BUILD partWiseScores FROM task_relevance =============
        const partWiseScores = [];
        if (Array.isArray(report.task_relevance)) {
            report.task_relevance.forEach((task) => {
                const avgBand = clampBand(task.scores.overall_band);
                partWiseScores.push({
                    speakingPartId: questionMetaById[task.questionId]?.speakingPartId || null,
                    questionNumber: task.questionNumber,
                    bands: String(avgBand),
                    score: null,
                });
            });
        }

        const avgBand = clampBand(report.scores.overall_band);
        const avgBandStr = String(avgBand);

        winston.info(`Overall band score: ${avgBandStr}`);

        // ============= GENERATE PDF & UPDATE StudentSpeakingAnswer =============
        winston.info('Converting images to base64 for IELTS speaking report...');

        const generatedDate = new Date().toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });

        const templateData = {
            studentName: req.user.fullName || req.user.firstName || 'Student',
            moduleName: 'IELTS Speaking',
            generatedDate: generatedDate,
            scores: {
                fluency_coherence: clampBand(report.scores.fluency_coherence),
                lexical_resource: clampBand(report.scores.lexical_resource),
                grammatical_range_accuracy: clampBand(report.scores.grammatical_range_accuracy),
                pronunciation: clampBand(report.scores.pronunciation),
                overall_band: clampBand(report.scores.overall_band),
            },
            summary: report.summary || '—',
            strengths: report.strengths || '—',
            areas_of_improvement: report.areas_of_improvement || '—',
            actionable_feedback: report.actionable_feedback || '—',
        };

        winston.info('Rendering EJS template for IELTS speaking report...');
        const templatePath = path.resolve('public/templates/ielts-speaking-report.ejs');

        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template not found: ${templatePath}`);
        }

        let speakingHtml = await ejs.renderFile(templatePath, templateData);

        let fileName = `feedback_${Date.now()}.pdf`;
        let pdfResp = await htmlToPdf.generatePDF(speakingHtml, studentSpeakingAnswer?._id, fileName);

        // ============= BUILD PLAIN TEXT FEEDBACK =============
        const plainFeedback = `
=== IELTS SPEAKING EVALUATION REPORT ===
Student: ${req.user.fullName || req.user.firstName || 'Student'}
Generated: ${generatedDate}
Overall Band: ${avgBandStr}

--- SCORES ---
Fluency & Coherence: ${clampBand(report.scores.fluency_coherence)}
Lexical Resource: ${clampBand(report.scores.lexical_resource)}
Grammatical Range & Accuracy: ${clampBand(report.scores.grammatical_range_accuracy)}
Pronunciation: ${clampBand(report.scores.pronunciation)}
Overall Band: ${clampBand(report.scores.overall_band)}

--- SUMMARY ---
${report.summary || '—'}

--- STRENGTHS ---
${report.strengths || '—'}

--- AREAS OF IMPROVEMENT ---
${report.areas_of_improvement || '—'}

--- ACTIONABLE FEEDBACK ---
${report.actionable_feedback || '—'}
`.trim();

        return {
            pdfResp,
            plainFeedback,
        };
    } catch (err) {
        winston.error('Error in IELTS speaking evaluation:', err);
    }
}

module.exports = {
    handleIeltsSpeakingEvaluation,
};
