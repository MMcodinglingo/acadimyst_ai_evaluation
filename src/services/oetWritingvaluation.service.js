const winston = require('../config/logger');
const {
    extractTextFromImage,
    correctOcrText,
    handleProcessCaseNotes,
    handleOETEvaluation,
    processOetWritingFeedback,
} = require('../utils/oetWritingvaluation.js');
const { extractGradeAndScore, getPdfUrl } = require('../utils/globalHelper');
const htmlToPdf = require('../utils/htmlToPdf.js');
const handleOetWritingEvaluation = async ({ studentWritingAnswer, student, testData, writingText, course }) => {
    let finalWritingText = writingText;

    //  NEW LOGIC - Process all images if multiple pages
    if (studentWritingAnswer.isPictureBased) {
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
    const caseNotesFeedback = await handleProcessCaseNotes(testData.caseNotes);
    if (caseNotesFeedback) {
        const writingFeedback = await handleOETEvaluation(finalWritingText, caseNotesFeedback);
        if (writingFeedback && writingFeedback?.content) {
            // Process the AI feedback using the helper
            // This moves the logic from client-side (template) to server-side
            const processedData = processOetWritingFeedback(writingFeedback?.content);
            const result = extractGradeAndScore(writingFeedback?.content);
            // const scoreMatch = writingFeedback.match(/Total Score:\s*(\d{1,3})\/500/i) || writingFeedback.match(/(\d{1,3})\s*\/\s*500/);
            let writingMarks = result.score;
            let writingGrade = result.grade;
            // Generate PDF with AI feedback
            let pdfUrl = null;
            let generatedHtml = null;
            try {
                const pdfResult = await htmlToPdf.generateOETWritingPdf(
                    student,
                    writingMarks,
                    writingGrade,
                    writingFeedback?.content, // Keeping for reference if needed
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
                pdfUrl,
                generatedHtml,
            };
        } else {
            console.log('Some thing went wrong while processing writing feedback');
        }
    } else {
        console.log('Some thing went wrong while processing case notes');
    }

    // TODO: Implement email notification with PDF attachment
    // await sendFeedbackEmail(student, pdfUrl, studentWritingAnswer._id);
};

module.exports = {
    handleOetWritingEvaluation,
};
