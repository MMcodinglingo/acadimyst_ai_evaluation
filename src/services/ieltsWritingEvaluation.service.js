const winston = require('../config/logger.js');
const {
    task1ExtractPrompt,
    task2ExtractPrompt,
    generateIeltsWritingEvaluation,
    task1AssessPrompt,
    task2AssessPrompt,
    finalCombinedReportPrompt,
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
            const taskNumber = task.taskNumber || taskIndex + 1;

            // Skip if no text was submitted
            if (!task.writingText) {
                winston.info(`⏭️ Skipping Task ${taskNumber} - no text submitted`);
                return { taskNumber, skipped: true };
            }

            winston.info(`🔍 Starting AI evaluation for IELTS Task ${taskNumber}...`);

            // STEP 1: Extract question features
            // This analyzes the question to identify what the student must address
            winston.info(`📋 Step 1: Extracting key features for Task ${taskNumber}...`);

            const extractPrompt =
                taskNumber === 1
                    ? task1ExtractPrompt({
                          questionText: testData.writingPrompt || '',
                          extraText: testData.caseNotes || '',
                      })
                    : task2ExtractPrompt({
                          questionText: testData.writingPrompt || '',
                          extraText: testData.caseNotes || '',
                      });

            const extractResponse = await generateIeltsWritingEvaluation({
                instructions: extractPrompt.instructions,
                input: extractPrompt.input,
            });

            // Parse extracted features
            const extractedFeatures = globalLibrary.safeJson(extractResponse.content);

            if (!extractedFeatures) {
                winston.error(`Failed to extract features for Task ${taskNumber}. Invalid JSON response.`);
                throw new Error('AI returned invalid JSON for feature extraction');
            }

            winston.info(`✅ Extracted features for Task ${taskNumber}:`, {
                type: extractedFeatures.task_type || extractedFeatures.question_type,
                featureCount: extractedFeatures.key_features?.length || extractedFeatures.must_address?.length || 0,
            });

            // STEP 2: Assess student response
            // This evaluates the student's writing against the extracted features
            winston.info(`📝 Step 2: Assessing student response for Task ${taskNumber}...`);

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

            // Parse assessment report
            const assessmentReport = globalLibrary.safeJson(assessResponse.content);

            if (!assessmentReport) {
                winston.error(`❌ Failed to assess Task ${taskNumber}. Invalid JSON response.`);
                throw new Error('AI returned invalid JSON for assessment');
            }

            // Extract overall band score from assessment
            const overallBand = globalLibrary.getOverallBandFromReport(assessmentReport);
            const score = overallBand ? Math.round(overallBand * 10) : 0; // Convert band to score (e.g., 7.5 -> 75)
            const grade = overallBand || 0;

            winston.info(`✅ Assessment complete for Task ${taskNumber}: Band ${overallBand}`);

            // Create plain text summary from structured feedback
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
${assessmentReport.annotated_version || 'N/A'}`;

            return {
                taskNumber,
                taskIndex,
                assessmentReport,
                score,
                grade,
                plainFeedback,
                skipped: false,
            };
        };

        // PARALLEL TASK EVALUATION: Process all tasks concurrently
        // Using Promise.allSettled to handle partial failures (one task can fail without blocking others)
        winston.info(`🚀 Starting parallel evaluation for ${tasks.length} task(s)...`);

        const evaluationPromises = tasks.map((task, i) =>
            evaluateSingleTask({ task, taskIndex: i }).catch((taskError) => {
                winston.error(`❌ Error evaluating Task ${task.taskNumber || i + 1}:`, taskError);
                return { taskNumber: task.taskNumber || i + 1, taskIndex: i, error: taskError, skipped: false };
            })
        );

        const evaluationResults = await Promise.allSettled(evaluationPromises);

        // Build taskReports from successful evaluations
        const taskReports = {};
        evaluationResults.forEach((result) => {
            if (result.status === 'fulfilled' && result.value && !result.value.skipped && !result.value.error) {
                const { taskNumber, assessmentReport } = result.value;
                taskReports[`task${taskNumber}`] = assessmentReport;
            }
        });

        winston.info(`✅ Parallel evaluation complete. Successful tasks: ${Object.keys(taskReports).length}`);

        // Generate final combined report if both tasks are present
        let finalReport = null;

        if (Object.keys(taskReports).length === 2) {
            // Both Task 1 and Task 2 present - generate combined report
            winston.info('🔀 Generating combined report for Task 1 + Task 2...');

            const task1Band = globalLibrary.getOverallBandFromReport(taskReports.task1);
            const task2Band = globalLibrary.getOverallBandFromReport(taskReports.task2);

            const weighted = Number((task1Band * 0.333 + task2Band * 0.666).toFixed(3));
            const rounded = globalLibrary.roundToHalfBand(weighted);

            const combinedPrompt = finalCombinedReportPrompt({
                task1Report: taskReports.task1,
                task2Report: taskReports.task2,
                rounded: rounded,
            });

            const combinedResponse = await generateIeltsWritingEvaluation({
                instructions: combinedPrompt.instructions,
                input: combinedPrompt.input,
            });

            finalReport = globalLibrary.safeJson(combinedResponse.content);

            if (finalReport) {
                // Ensure final_summary is present with correct values
                finalReport.final_summary = {
                    ...(finalReport.final_summary || {}),
                    Overall_writing_band: rounded,
                    task1_band: task1Band,
                    task2_band: task2Band,
                    weighted_estimated_writing_band: weighted,
                    rounded_writing_band: rounded,
                };

                winston.info(`✅ Combined report generated: Overall Band ${rounded}`);
            }
        }

        // Generate PDF report using the new EJS template
        try {
            winston.info('📄 Generating IELTS writing PDF report...');

            // Build the payload for PDF generation
            const aiPayload = {
                ok: true,
                mode: tasks.length === 1 ? (tasks[0].taskNumber === 1 ? 'task1_only' : 'task2_only') : 'combined',
                result: {},
            };

            // Add task data to payload based on what was evaluated
            if (tasks.length === 1) {
                // Single task mode
                const taskIndex = tasks[0].taskNumber - 1; // 0 or 1
                const taskData = studentWritingAnswer.writingTasks[taskIndex];

                // Parse AI feedback (already JSON structure)
                let feedbackData;
                try {
                    feedbackData = JSON.parse(taskData.aiFeedBack || '{}');
                } catch {
                    feedbackData = {};
                }

                aiPayload.result = {
                    overall_band: taskData.grade?.toString() || taskData.score?.toString() || '—',
                    ...feedbackData,
                };
            } else {
                // Combined mode - use final report if available, otherwise build manually
                if (finalReport) {
                    aiPayload.result = finalReport;
                } else {
                    // Fallback: build combined report manually
                    const task1Data = studentWritingAnswer.writingTasks.find((t) => t.taskNumber === 1);
                    const task2Data = studentWritingAnswer.writingTasks.find((t) => t.taskNumber === 2);

                    let task1Feedback = {};
                    let task2Feedback = {};

                    try {
                        task1Feedback = JSON.parse(task1Data?.aiFeedBack || '{}');
                    } catch (err) {
                        console.log('error task 1 feed back', err);
                    }

                    try {
                        task2Feedback = JSON.parse(task2Data?.aiFeedBack || '{}');
                    } catch (err) {
                        console.log('error task 2 feed back', err);
                    }

                    // Calculate final summary
                    const task1Band = parseFloat(task1Data?.grade || task1Data?.score || 0);
                    const task2Band = parseFloat(task2Data?.grade || task2Data?.score || 0);
                    const weightedBand = (task1Band * 0.33 + task2Band * 0.67).toFixed(3);
                    const roundedBand = Math.round(weightedBand * 2) / 2; // Round to nearest 0.5

                    aiPayload.result = {
                        final_summary: {
                            Overall_writing_band: roundedBand,
                            task1_band: task1Band,
                            task2_band: task2Band,
                            weighted_estimated_writing_band: weightedBand,
                            rounded_writing_band: roundedBand,
                        },
                        task1: {
                            overall_band: task1Band?.toString() || '—',
                            ...task1Feedback,
                        },
                        task2: {
                            overall_band: task2Band?.toString() || '—',
                            ...task2Feedback,
                        },
                    };
                }
            }

            // Generate PDF
            const pdfResult = await htmlToPdf.generateIeltsWritingPdf(student, aiPayload, studentWritingAnswer, testData);

            // Create plain text combined feedback for root level
            let combinedPlainFeedback = '';
            if (tasks.length === 1) {
                const taskData = studentWritingAnswer.writingTasks[tasks[0].taskNumber - 1];
                combinedPlainFeedback = taskData.aiFeedBackPlain || '';
            } else {
                // Combined mode - merge both task feedbacks
                const task1Data = studentWritingAnswer.writingTasks.find((t) => t.taskNumber === 1);
                const task2Data = studentWritingAnswer.writingTasks.find((t) => t.taskNumber === 2);
                combinedPlainFeedback = `IELTS Writing - Combined Report

=== FINAL SUMMARY ===
Overall Writing Band: ${aiPayload.result.final_summary?.Overall_writing_band || '—'}
Task 1 Band: ${aiPayload.result.final_summary?.task1_band || '—'}
Task 2 Band: ${aiPayload.result.final_summary?.task2_band || '—'}

=== TASK 1 FEEDBACK ===
${task1Data?.aiFeedBackPlain || 'N/A'}

=== TASK 2 FEEDBACK ===
${task2Data?.aiFeedBackPlain || 'N/A'}`;
            }
            return {
                pdfResult,
                combinedPlainFeedback,
            };
        } catch (pdfError) {
            winston.error('❌ Error generating IELTS PDF report:', pdfError);
            // Don't throw - PDF generation failure shouldn't block the evaluation
        }
    } catch (err) {
        // Log error but don't throw - AI evaluation failure shouldn't block submission
        winston.error('❌ Error in IELTS AI evaluation:', err);
    }
};

module.exports = {
    handleIeltsWritingAiEvaluation,
};
