const winston = require('../config/logger.js');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const ejs = require('ejs');

const {
    step1_WhisperThenDiarizeThenMerge,
    generateIntelligibilityReport_DoctorOnly,
    parseIntelligibilityReport,
} = require('../utils/oetSpeakingEvaluation.js');
const { getOetGrade, prepareCardData } = require('../utils/globalHelper');
const htmlToPdf = require('../utils/htmlToPdf.js');

async function handleOetSpeakingEvaluation({ studentSpeakingAnswer, student, speakingAudios, speakingMainCards, speakingCards }) {
    try {
        let studentFullName = student.fullName;

        const transcripts = [];
        const feedbacks = [];
        const marks = [];
        const grades = [];
        const cardWiseScores = [];
        const cardWiseGrades = [];
        let partWiseFeedback = [];
        let evaluationJson = [];

        for (let i = 0; i < speakingAudios.length; i++) {
            let totalScore = null;
            let oetGrade = null;
            let audioUrl = speakingAudios[i].audioUrl;
            let localPath = speakingAudios[i].key;
            const fullPath = path.resolve(process.cwd(), localPath);

            const dir = path.dirname(fullPath);
            fs.mkdirSync(dir, { recursive: true });

            // Download audio file
            const response = await axios.get(audioUrl, { responseType: 'stream' });
            const writer = fs.createWriteStream(fullPath);
            response.data.pipe(writer);
            await new Promise((resolve) => writer.on('finish', resolve));

            // Get role cards
            let speakingMainCard = speakingMainCards[i];
            let speakingCard = null;
            if (speakingMainCard) {
                speakingCard = speakingCards.filter((card) => card.mainCardId?.toString() === speakingMainCard._id.toString());
            }
            // const rolePlayerCard = speakingCard?.find((c) => c.roleLabel.toLowerCase() !== 'doctor');

            // Step 1: Transcribe and diarize
            const { transcript, step1FinalJson } = await step1_WhisperThenDiarizeThenMerge(fullPath, path.basename(fullPath), speakingCard);

            const intelligibilityReport = await generateIntelligibilityReport_DoctorOnly(step1FinalJson, speakingCard, transcript);

            //  Parse ALL data from the intelligibility report
            const parsedReport = parseIntelligibilityReport(intelligibilityReport?.content);

            totalScore = parsedReport.totalScore;
            oetGrade = parsedReport.oetGrade;
            evaluationJson.push({
                cardNumber: i + 1,
                ...parsedReport, // Include ALL parsed data
            });

            partWiseFeedback.push({
                cardNumber: speakingMainCard.mainCardNumber,
                feedback: intelligibilityReport?.content,
            });

            feedbacks.push(intelligibilityReport?.content);
            transcripts.push(transcript);

            cardWiseScores.push({
                cardNumber: speakingMainCard.mainCardNumber,
                score: totalScore,
            });

            cardWiseGrades.push({
                cardNumber: speakingMainCard.mainCardNumber,
                score: oetGrade,
            });

            marks.push(totalScore);
            grades.push(oetGrade);
        }

        // Calculate average scores
        const [marks1, marks2] = [marks[0], marks[1]];
        const avgMarks = marks1 != null && marks2 != null ? Math.round((marks1 + marks2) / 2) : (marks1 ?? marks2 ?? 0);

        const finalGrade = avgMarks != null ? getOetGrade(avgMarks) : 'E';

        // Generate PDF using EJS template
        winston.info('Converting images to base64 for speaking report...');
        const generatedDate = new Date().toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });

        const studentName = studentFullName || student.firstName || 'Student';

        const cardsData = evaluationJson.map((cardEval) => prepareCardData(cardEval, studentName, generatedDate));

        const templateData = {
            card1: cardsData[0] || null,
            card2: cardsData[1] || null,
            studentName: studentName,
            evaluationJson: evaluationJson,
            avgMarks: avgMarks,
            finalGrade: finalGrade,
            generatedDate: generatedDate,
        };

        winston.info('Rendering EJS template for speaking report...');
        const templatePath = path.resolve('public/templates/oet-speaking-report.ejs');

        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template not found: ${templatePath}`);
        }

        let speakingHtml = await ejs.renderFile(templatePath, templateData);

        let fileName = `feedback_${Date.now()}.pdf`;
        let pdfResult = await htmlToPdf.generatePDF(speakingHtml, studentSpeakingAnswer?._id, fileName);

        // Update student answer
        return {
            studentSpeakingAnswer,
            evaluationResult: {
                pdfUrl: { pdfUrl: pdfResult.s3Url, key: pdfResult.key },
                cardWiseScores,
                avgScore: avgMarks,
                cardWiseGrades,
                avgGrade: finalGrade,
                evaluationJson: evaluationJson,
                partWiseFeedback: partWiseFeedback,
                scoreHistory: [
                    {
                        avgScore: avgMarks,
                        avgGrade: finalGrade,
                        evaluatedAt: new Date(),
                        evaluationType: 'ai',
                        cardWiseScores,
                        cardWiseGrades,
                    },
                ],
                checkingStatus: 'checked',
                aiFeedBackHtml: speakingHtml,
                accessorFeedBackHtml: speakingHtml,
                transcripts: transcripts,
            },
        };
    } catch (err) {
        winston.error('OET Speaking Evaluation Error:', err);
        throw new Error(err.message || String(err));
    }
}
module.exports = {
    handleOetSpeakingEvaluation,
};
