const { status } = require('http-status');
const ieltsEvaluationService = require('../services/ieltsWritingEvaluation.service');
const ieltsSpeakingEvaluationService = require('../services/ieltsSpeakingEvaluation.service');

const handleIeltsWritingEvaluation = async (req, res, next) => {
    try {
        const { studentWritingAnswer, testData, tasks, student } = req.body;

        let resp = await ieltsEvaluationService.handleIeltsWritingAiEvaluation(studentWritingAnswer, student, testData, tasks);

        return res.status(status[201]).json({
            success: 1,
            message: 'IELTS Evaluation processed successfully.',
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

const handleIeltsSpeakingEvaluation = async (req, res, next) => {
    try {
        const { studentSpeakingAnswer, speakingParts, speakingAudios, student } = req.body;
        let resp = await ieltsSpeakingEvaluationService.handleIeltsSpeakingEvaluation(studentSpeakingAnswer,  speakingParts, speakingAudios, student);
        return res.status(status[201]).json({
            success: 1,
            message: 'IELTS Speaking Evaluation processed successfully.',
            data: {
                resp,
            },
        });
    } catch (error) {
        return res.status(status[500]).json({
            success: 0,
            message: 'Something went wrong. Please try again',
            data: {},
        });
    }
};
module.exports = {
    handleIeltsWritingEvaluation,
    handleIeltsSpeakingEvaluation,
};
