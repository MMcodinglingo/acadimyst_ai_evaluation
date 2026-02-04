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
const { buildSystemPrompt } = require('../prompts/ieltsSpeaking.js');

async function handleIeltsSpeakingEvaluation({ studentSpeakingAnswer, speakingParts, speakingAudios, student }) {
    try {
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
                examiner_feedback: { type: 'string' },
            },
            required: ['task_relevance', 'scores', 'examiner_feedback'],
        };

        const systemPrompt = buildSystemPrompt();
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
            report.examiner_feedback = String(report.examiner_feedback || '').trim();

            // 4) If ALL tasks mismatched -> force overall 0 and special examiner feedback
            if (totalTasks > 0 && mismatches.length === totalTasks) {
                winston.warn('ALL tasks mismatched - setting scores to 0');
                report.scores = forceZeroScoresObj();

                const allDetail = buildMismatchDetail(mismatches, qaPairsForScoring);

                report.examiner_feedback = `All uploaded audios are mismatched with their questions, so the overall score is 0.
Please answer each question directly according to its task.Re-record each answer while reading the question first, provide relevant answer, keep the same topic and avoid switching to unrelated ideas.

Mismatched: ${allDetail}`.trim();

            } else if (mismatches.length > 0) {
                winston.warn(`${mismatches.length} tasks mismatched - adjusting feedback`);
                const detail = buildMismatchDetail(mismatches, qaPairsForScoring);

                // Only append if the model didn't already mention mismatch
                const alreadyMentions = hasMismatchAlready(report.examiner_feedback, mismatches);

                // Pick ONE place to add it (recommended: examiner feedback only)
                if (!alreadyMentions) {
                    report.examiner_feedback = `${String(report.examiner_feedback ?? '').trim()}

Task alignment issue: some answers did not match their questions, which lowered the overall score.
Mismatches: ${detail}`.trim();
                }

            }

            // 6) Ensure required strings exist (schema safety)
            report.examiner_feedback = String(report.examiner_feedback ?? '');
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

        // helper function to bold the response 
        function boldStarsToHtml(text = '') {
  return String(text)
    // escape HTML first to avoid injection
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // then convert *something* to bold
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
}


        const templateData = {
            studentName: student.fullName || student.firstName || 'Student',
            moduleName: 'IELTS Speaking',
            generatedDate: generatedDate,
            scores: {
                fluency_coherence: clampBand(report.scores.fluency_coherence),
                lexical_resource: clampBand(report.scores.lexical_resource),
                grammatical_range_accuracy: clampBand(report.scores.grammatical_range_accuracy),
                pronunciation: clampBand(report.scores.pronunciation),
                overall_band: clampBand(report.scores.overall_band),
            },
            examiner_feedback: boldStarsToHtml(report.examiner_feedback || '-'),
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
Student: ${student.fullName || student.firstName || 'Student'}
Generated: ${generatedDate}
Overall Band: ${avgBandStr}

--- SCORES ---
Fluency & Coherence: ${clampBand(report.scores.fluency_coherence)}
Lexical Resource: ${clampBand(report.scores.lexical_resource)}
Grammatical Range & Accuracy: ${clampBand(report.scores.grammatical_range_accuracy)}
Pronunciation: ${clampBand(report.scores.pronunciation)}
Overall Band: ${clampBand(report.scores.overall_band)}

--- Examiner's Feedback ---
${report.examiner_feedback || '-'}
`.trim();

        return {
            studentSpeakingAnswer,
            student,
            evaluationResult: {
                pdfUrl: { pdfUrl: pdfResp?.s3Url || null, key: pdfResp?.key || null, localPath: pdfResp?.localPath || null },
                partWiseScores,
                avgBand: avgBandStr,
                checkingStatus: 'checked',
                scoreHistory: [
                    {
                        avgGrade: avgBandStr,
                        evaluatedAt: new Date(),
                        evaluationType: 'ai',
                        partWiseScores,
                    },
                ],
                // Save both plain and HTML feedback
                aiFeedback: plainFeedback,
                aiFeedBackHtml: speakingHtml,
                accessorFeedBackHtml: speakingHtml,
                // Store complete AI evaluation report (new field - flexible schema)
                aiEvaluationReport: {
                    task_relevance: report.task_relevance,
                    scores: report.scores,
                    examiner_feedback: report.examiner_feedback,
                    tokenUsage: usage,
                    generatedAt: new Date(),
                },
            },
        };
    } catch (err) {
        winston.error('Error in IELTS speaking evaluation:', err);
        throw err;
    }
}

module.exports = {
    handleIeltsSpeakingEvaluation,
};
