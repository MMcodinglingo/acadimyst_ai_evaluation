const winston = require('../config/logger.js');
const config = require('../config/config.js');
const {
    task1ExtractPrompt,
    task2ExtractPrompt,
    generateIeltsWritingEvaluation,
    task1AssessPrompt,
    task2AssessPrompt,
    finalCombinedReportPrompt,
    buildManualCombinedReport,
} = require('../utils/ieltsWritingEvaluation.js');
const globalLibrary = require('../utils/globalHelper.js');
const htmlToPdf = require('../utils/htmlToPdf');
const handleIeltsWritingAiEvaluation = async ({ studentWritingAnswer, student, testData, tasks }) => {
    try {
        /**
         * Helper function to evaluate a single task
         * Extracted to enable parallel processing via Promise.allSettled
         *
         * @param {Object} params - Task evaluation parameters
         * @returns {Promise<Object>} - Result with taskNumber and assessmentReport (or error)
         */
        const evaluateSingleTask = async ({ task, taskIndex }) => {
            const taskNumber = Number(task.taskNumber || taskIndex + 1);

            // Skip if no text was submitted
            if (!task.writingText) {
                winston.info(` Skipping Task ${taskNumber} - no text submitted`);
                return { taskNumber, taskIndex, skipped: true };
            }

            winston.info(` Starting AI evaluation for IELTS Task ${taskNumber}`);

            //  Resolve prompt from testData.writingtask (payload correct place)
            const promptTask = (testData?.writingTask || []).find((t) => Number(t.taskNumber) === taskNumber);

            const questionText = promptTask?.task || '';
            const instructionsText = promptTask?.instructions || '';
            const imageURL = promptTask?.imageURL || null;

            //  Require imageURL for Task 1 (Updated By Jawad)
            if (taskNumber === 1 && !imageURL) {
                winston.warn('Task 1 imageURL missing Falling Back to Text-only extraction', {
                    writingTestId: testData?._id,
                    taskNumber,
                });
            }

            // STEP 1: Extract question features
            winston.info(` Step 1: Extracting key features for Task ${taskNumber}...`);

            let extractPrompt;
            if (taskNumber === 1) {
                extractPrompt = task1ExtractPrompt({
                    questionText,
                    instructionsText,
                    imageURL: imageURL || null,
                });
            } else {
                extractPrompt = task2ExtractPrompt({
                    questionText,
                    extraText: instructionsText,
                });
            }

            const extractResponse = await generateIeltsWritingEvaluation({
                instructions: extractPrompt.instructions,
                input: extractPrompt.input, //  Task 1: array (text+image), Task 2: string
            });

            // Parse extracted features
            const extractedFeatures = globalLibrary.safeJson(extractResponse.content);

            if (!extractedFeatures) {
                winston.error(`Failed to extract features for Task ${taskNumber}. Invalid JSON response.`);
                throw new Error(`Invalid extraction JSON for Task ${taskNumber}`);
            }

            winston.info(`Extracted features for Task ${taskNumber}:`, {
                taskType: (task?.taskType || 'unknown').toLowerCase(),
                featureCount:
                    (Array.isArray(extractedFeatures.key_features) && extractedFeatures.key_features.length) ||
                    (Array.isArray(extractedFeatures.must_address) && extractedFeatures.must_address.length) ||
                    0,
            });

            // STEP 2: Assess student response
            winston.info(` Step 2: Assessing student response for Task ${taskNumber}...`);

            const assessPrompt =
                taskNumber === 1
                    ? task1AssessPrompt({
                          task1KeyJson: extractedFeatures,
                          studentResponse: task.writingText,
                      })
                    : task2AssessPrompt({
                          task2KeyJson: extractedFeatures,
                          studentResponse: task.writingText,
                      });

            const assessResponse = await generateIeltsWritingEvaluation({
                instructions: assessPrompt.instructions,
                input: assessPrompt.input,
            });

            const assessmentReport = globalLibrary.safeJson(assessResponse.content);
            if (!assessmentReport) {
                winston.error(` Failed to assess Task ${taskNumber}. Invalid JSON response.`);
                throw new Error(`Invalid assessment JSON for Task ${taskNumber}`);
            }

            // Extract overall band score from assessment
            const overallBand = globalLibrary.getOverallBandFromReport(assessmentReport);
            const score = overallBand ? Math.round(overallBand * 10) : 0;
            const grade = overallBand || 0;

            winston.info(` Assessment complete for Task ${taskNumber}: Band ${overallBand}`);

            //  Your original plain text summary (kept)
            const plainFeedback = `IELTS Writing Task ${taskNumber} - AI Evaluation

Overall Band: ${overallBand}

=== ORIGINALITY CHECK ===
${assessmentReport.originality_justification || 'N/A'}

=== SUMMARY ===
${assessmentReport.summary || 'N/A'}

=== STRENGTHS ===
${assessmentReport.strength || 'N/A'}

=== AREAS FOR IMPROVEMENT ===
${assessmentReport.areas_of_improvement || 'N/A'}

=== ANNOTATED VERSION ===
${assessmentReport.annotated_version || 'N/A'}

===== Examiner Feedback (Full) =====
${assessmentReport.examiner_feedback || 'N/A'}
`;

            return {
                taskNumber,
                taskIndex,
                assessmentReport,
                score,
                grade,
                plainFeedback,
                skipped: false,

                //  keep your logging payload fields if you use them later
                writingText: task.writingText,
                extractPromptInstructions: extractPrompt.instructions,
                assessPromptInput: assessPrompt.input,
                assessResponseChoices: assessResponse.choices,
            };
        };

        // PARALLEL TASK EVALUATION
        winston.info(` Starting parallel evaluation for ${tasks.length} task(s)...`);

        const evaluationResults = await Promise.allSettled(
            tasks.map((task, i) =>
                evaluateSingleTask({ task, taskIndex: i }).catch((err) => ({
                    taskNumber: task.taskNumber || i + 1,
                    taskIndex: i,
                    error: err,
                    skipped: false,
                }))
            )
        );

        const tasksResult = [];
        const taskReports = {};

        for (const res of evaluationResults) {
            if (res.status === 'fulfilled' && res.value && !res.value.error) {
                const r = res.value;
                r.checkingStatus = 'checked';
                tasksResult.push(r);

                if (!r.skipped) {
                    taskReports[`task${r.taskNumber}`] = r.assessmentReport;
                }
            }
        }

        // COMBINED REPORT (TASK 1 + TASK 2)
        let finalReport = null;

        if (Object.keys(taskReports).length === 2) {
            winston.info('Generating combined report for Task 1 + Task 2...');
            const task1Band = globalLibrary.getOverallBandFromReport(taskReports.task1);
            const task2Band = globalLibrary.getOverallBandFromReport(taskReports.task2);

            const weighted = Number((task1Band * 0.33 + task2Band * 0.66).toFixed(2));
            const rounded = globalLibrary.roundToHalfBand(weighted);

            const combinedPrompt = finalCombinedReportPrompt({
                task1Report: taskReports.task1,
                task2Report: taskReports.task2,
                rounded,
            });

            const combinedResponse = await generateIeltsWritingEvaluation({
                instructions: combinedPrompt.instructions,
                input: combinedPrompt.input,
            });

            finalReport = globalLibrary.safeJson(combinedResponse.content);

            if (finalReport) {
                finalReport.final_summary = {
                    ...(finalReport.final_summary || {}),
                    Overall_writing_band: rounded,
                    task1_band: task1Band,
                    task2_band: task2Band,
                    weighted_estimated_writing_band: weighted,
                    rounded_writing_band: rounded,
                };
            }
        } else {
            let isTask1 = taskReports.task1 ? true : false;
            let isTask2 = taskReports.task2 ? true : false;
            const taskBand = isTask1
                ? globalLibrary.getOverallBandFromReport(taskReports.task1)
                : globalLibrary.getOverallBandFromReport(taskReports.task2);
            const rounded = globalLibrary.roundToHalfBand(taskBand);

            const combinedPrompt = finalCombinedReportPrompt({
                task1Report: isTask1 ? taskReports.task1 : null,
                task2Report: isTask2 ? taskReports.task2 : null,
                rounded,
            });
            const combinedResponse = await generateIeltsWritingEvaluation({
                instructions: combinedPrompt.instructions,
                input: combinedPrompt.input,
            });
            finalReport = globalLibrary.safeJson(combinedResponse.content);

            if (finalReport) {
                finalReport.final_summary = {
                    ...(finalReport.final_summary || {}),
                    Overall_writing_band: rounded,
                    task1_band: isTask1 ? taskBand : null,
                    task2_band: isTask2 ? taskBand : null,
                    weighted_estimated_writing_band: taskBand,
                    rounded_writing_band: rounded,
                };
            }
        }

        // OVERALL SCORE
        const validScores = tasksResult.filter((t) => !t.skipped && typeof t.score === 'number').map((t) => t.score);
        const overallScore = validScores.length > 0 ? Math.round(validScores.reduce((a, b) => a + b, 0) / validScores.length) : null;
        let overallGrade = overallScore ? overallScore / 10 : null;
        // PDF GENERATION
        let pdf = null;
        let combinedPlainFeedback = '';

        try {
            const aiPayload = {
                ok: true,
                mode: tasks.length === 1 ? (tasks[0].taskNumber === 1 ? 'task1_only' : 'task2_only') : 'combined',
                result:
                    tasks.length === 1
                        ? {
                              overall_band: tasksResult[0]?.grade?.toString() || '—',
                              ...tasksResult[0]?.assessmentReport,
                          }
                        : finalReport || buildManualCombinedReport(tasksResult),
            };

            const pdfResult = await htmlToPdf.generateIeltsWritingPdf(student, aiPayload, studentWritingAnswer, testData);

            pdf = {
                pdfUrl: `${config.aws.s3.baseUrl}/${pdfResult.Key}`,
                key: pdfResult.Key,
                html: pdfResult.html,
            };

            if (tasks.length === 1) {
                combinedPlainFeedback = tasksResult[0]?.plainFeedback || '';
            } else {
                const t1 = tasksResult.find((t) => t.taskNumber === 1);
                const t2 = tasksResult.find((t) => t.taskNumber === 2);

                combinedPlainFeedback = `IELTS Writing - Combined Report

=== FINAL SUMMARY ===
Overall Writing Band: ${finalReport?.final_summary?.Overall_writing_band || '—'}
Task 1 Band: ${finalReport?.final_summary?.task1_band || '—'}
Task 2 Band: ${finalReport?.final_summary?.task2_band || '—'}

=== TASK 1 FEEDBACK ===
${t1?.plainFeedback || 'N/A'}

=== TASK 2 FEEDBACK ===
${t2?.plainFeedback || 'N/A'}`;
            }
        } catch (err) {
            console.log(err);
            winston.error('PDF generation failed:', err);
        }

        //  FINAL RETURN (DB-READY PAYLOAD)
        return {
            studentWritingAnswer,
            student, // Include student for OpenAI logging
            evaluationResult: {
                tasksResult,
                taskReports,
                combinedReport: finalReport,
                overall: {
                    overallScore,
                    overallGrade,
                    overallCheckingStatus: tasksResult.every((t) => t.checkingStatus === 'checked') ? 'complete' : 'partial',
                    lastEvaluatedAt: new Date(),
                },
                pdf,
                combinedPlainFeedback,
            },
        };
    } catch (err) {
        console.log(err);
        winston.error(' Error in IELTS AI evaluation:', err);
        return null;
    }
};

module.exports = {
    handleIeltsWritingAiEvaluation,
};
