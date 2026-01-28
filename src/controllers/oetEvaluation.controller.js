const { status } = require('http-status');
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

        return res.status(status[201]).json(res, {
            success: 1,
            message: 'OET Speaking Evaluation processed successfully.',
            data: {
                resp,
            },
        });
    } catch (error) {
        return res.status(status[500]).json(res, {
            success: 0,
            message: 'Something went wrong. Please try again',
            data: {},
        });
    }
};

const handleOetWritingevaluation = async (req, res, next) => {
    try {
        const { testData, studentWritingAnswer, writingText, student, course } = req.body;

        let resp = await oetWritingEvaluationService.handleOetWritingEvaluation({
            studentWritingAnswer,
            student,
            testData,
            writingText,
            course,
        });

        return res.status(status[201]).json(res, {
            success: 1,
            message: 'OET Writing Evaluation processed successfully.',
            data: {
                resp,
            },
        });
    } catch (error) {
        return res.status(status[500]).json(res, {
            success: 0,
            message: 'Something went wrong. Please try again',
            data: {},
        });
    }
};

module.exports = {
    handleOetSpeakingEvaluation,
    handleOetWritingevaluation,
};
