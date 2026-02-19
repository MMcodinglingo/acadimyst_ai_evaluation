const oetWritingEvaluationService = require('../services/oetWritingvaluation.service');
const oetSpeakingEvaluationService = require('../services/oetSpeakingEvaluation.service');

const handleOetSpeakingEvaluation = async (req, res, next) => {
    try {
        const { speakingAudios, studentSpeakingAnswer, speakingParts, student, speakingMainCard, speakingCard } = req.body;

        let resp = await oetSpeakingEvaluationService.handleOetSpeakingEvaluation(
            studentSpeakingAnswer,
            student,
            speakingAudios,
            speakingParts,
            speakingMainCard,
            speakingCard
        );

        // REMOVED 'res' from inside .json()
        return res.status(201).json({
            success: 1,
            message: 'OET Speaking Evaluation processed successfully.',
            data: {
                resp,
            },
        });
    } catch (error) {
        // REMOVED 'res' from inside .json()
        return res.status(500).json({
            success: 0,
            message: error?.message || 'Something went wrong. Please try again',
            data: {},
        });
    }
};

const handleOetWritingEvaluation = async (req, res, next) => {
    try {
        const { testData, studentWritingAnswer, writingText, student, course } = req.body;

        let resp = await oetWritingEvaluationService.handleOetWritingEvaluation({
            studentWritingAnswer,
            student,
            testData,
            writingText,
            course,
        });

        // REMOVED 'res' from inside .json()
        return res.status(201).json({
            success: 1,
            message: 'OET Writing Evaluation processed successfully.',
            data: {
                resp,
            },
        });
    } catch (error) {
        // Standardized error response
        return res.status(500).json({
            success: 0,
            message: error?.message || 'Something went wrong. Please try again',
            data: {},
        });
    }
};

module.exports = {
    handleOetSpeakingEvaluation,
    handleOetWritingEvaluation,
};