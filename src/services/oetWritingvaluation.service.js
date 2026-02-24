const winston = require('../config/logger');
const {
    extractTextFromImage,
    correctOcrText,
    handleProcessCaseNotes,
    handleMultiStepEvaluation,
    processOetWritingFeedback,
} = require('../utils/oetWritingvaluation.js');
const { getPdfUrl } = require('../utils/globalHelper');
const htmlToPdf = require('../utils/htmlToPdf.js');

const handleOetWritingEvaluation = async ({ studentWritingAnswer, student, testData, writingText, course }) => {
    let finalWritingText = writingText;

    //  NEW LOGIC - Process all images if multiple pages

    if (studentWritingAnswer?.isPictureBased) {
        const images = studentWritingAnswer.writingImage || [];
        const totalPages = images.length;
        let combinedOcrText = '';

        // Extract text from each image/page
        for (let i = 0; i < totalPages; i++) {
            const rawOcrText = await extractTextFromImage({
                imageUrl: images[i]?.imageUrl,
                pageIndex: i,
                totalPages: totalPages,
            });

            // Add page separator if multiple images
            if (totalPages > 1) {
                combinedOcrText += `${i > 0 ? '\n\n' : ''}--- Page ${i + 1} ---\n\n${rawOcrText}`;
            } else {
                combinedOcrText = rawOcrText;
            }
        }

        // Correct the combined OCR text
        finalWritingText = await correctOcrText(combinedOcrText.trim());
    }

    // Existing flow continues unchanged
    // Deterministically extract patient name from the structured writingSection.
    // The 'Patient' section always contains the ground-truth name — no LLM needed.
    let patientName = null;
    winston.info(`OET evaluation: testData top-level keys = [${Object.keys(testData || {}).join(', ')}]`);

    // Try every possible path the data might be nested under
    const writingSectionCandidates = [
        testData?.writingTest?.writingSection,    // { writingTest: { writingSection: [...] } }
        testData?.writingSection,                 // { writingSection: [...] }
        testData?.test?.writingSection,           // { test: { writingSection: [...] } }
        testData?.data?.writingSection,           // { data: { writingSection: [...] } }
        testData?.caseNotes,                      // fallback: caseNotes array (same structure)
    ];

    let writingSections = null;
    for (const candidate of writingSectionCandidates) {
        if (Array.isArray(candidate) && candidate.length > 0) {
            writingSections = candidate;
            break;
        }
    }

    if (writingSections) {
        // Log section titles to help debug data shape
        const sectionTitles = writingSections.map((s) => s.title || s.heading || 'NO_TITLE').join(', ');
        winston.info(`OET evaluation — writingSections found (${writingSections.length} items): [${sectionTitles}]`);

        // Strategy 1: Look for a section titled exactly "Name" — most reliable
        const nameSection = writingSections.find(
            (s) => typeof s.title === 'string' && s.title.trim().toLowerCase() === 'name'
        );
        if (nameSection?.subSections?.length > 0) {
            patientName = nameSection.subSections[0]?.content?.trim() || null;
        }

        // Strategy 2: Look for a section with title "Patient" that has content
        if (!patientName) {
            const patientSection = writingSections.find(
                (s) => typeof s.title === 'string'
                    && s.title.trim().toLowerCase() === 'patient'
                    && s.subSections?.length > 0
            );
            if (patientSection) {
                patientName = patientSection.subSections[0]?.content?.trim() || null;
            }
        }

        // Strategy 3: Look for sections containing 'patient' with non-empty subSections
        if (!patientName) {
            const patientContentSection = writingSections.find(
                (s) => typeof s.title === 'string'
                    && s.title.trim().toLowerCase().includes('patient')
                    && s.subSections?.length > 0
                    && s.subSections[0]?.content?.trim()
            );
            if (patientContentSection) {
                patientName = patientContentSection.subSections[0]?.content?.trim() || null;
            }
        }

        if (patientName) {
            winston.info(`OET evaluation — patient name extracted: "${patientName}"`);
        } else {
            const firstSection = writingSections[0];
            winston.warn(`OET evaluation — no patient name found. First section keys: [${Object.keys(firstSection || {}).join(', ')}]`);
        }
    } else {
        winston.warn('OET evaluation — no writingSections array found in any candidate path');
    }

    winston.info(`OET evaluation — patient name extracted: "${patientName || 'NOT FOUND — deterministic check will be skipped'}"`);


    const caseNotesFeedback = await handleProcessCaseNotes(testData.caseNotes);
    if (caseNotesFeedback) {
        const writingFeedback = await handleMultiStepEvaluation(finalWritingText, caseNotesFeedback, patientName);
        if (writingFeedback && writingFeedback?.content) {
            // Process the AI feedback using the helper (for PDF rendering)
            const processedData = processOetWritingFeedback(writingFeedback.content);

            // Use deterministic scores from structured output — never regex, never null
            const writingMarks = writingFeedback.computed.scaledScore;
            const writingGrade = writingFeedback.computed.grade;

            // Generate PDF with AI feedback
            let pdfUrl = null;
            let generatedHtml = null;
            try {
                const pdfResult = await htmlToPdf.generateOETWritingPdf(
                    student,
                    writingMarks,
                    writingGrade,
                    writingFeedback.content, // Legacy content string for PDF template
                    studentWritingAnswer,
                    course?.name,
                    processedData // Pass the processed data (letterHtml, meta, assessmentCards)
                );
                pdfUrl = getPdfUrl(pdfResult);
                generatedHtml = pdfResult.html;
                winston.info(`PDF generated and uploaded successfully: ${pdfUrl}`);
            } catch (pdfError) {
                winston.error('PDF generation failed, continuing without PDF:', pdfError);
                // Continue execution even if PDF generation fails
            }

            return {
                studentWritingAnswer,
                student,
                evaluationResult: {
                    writingText: finalWritingText,
                    pdfUrl,
                    checkingStatus: 'checked',
                    score: writingMarks,
                    grade: writingGrade,
                    lastEvaluatedAt: new Date(),
                    aiFeedBack: writingFeedback.content,
                    aiFeedBackHtml: generatedHtml,
                    accessorFeedBackHtml: generatedHtml,
                    // Confidence flag for teacher routing
                    confidence: writingFeedback.confidence || 'high',
                    confidenceReason: writingFeedback.confidenceReason || null,
                    // AI criterion scores (0-7 per criterion) for teacher comparison
                    aiCriterionScores: writingFeedback.aiCriterionScores || null,
                    // Holistic impression from senior examiner anchor step
                    holisticImpression: writingFeedback.holisticImpression || null,
                    scoreHistory: {
                        score: writingMarks,
                        grade: writingGrade,
                        evaluatedAt: new Date(),
                        evaluationType: 'ai',
                        note: '',
                    },
                },
                writingFeedback,
            };
        } else {
            winston.error('handleOetWritingEvaluation: Writing feedback returned null or empty content');
        }
    } else {
        winston.error('handleOetWritingEvaluation: Case notes processing returned null');
    }

    // TODO: Implement email notification with PDF attachment
    // await sendFeedbackEmail(student, pdfUrl, studentWritingAnswer._id);
};

module.exports = {
    handleOetWritingEvaluation,
};
