const ieltsEvaluationService = require('../services/ieltsEvaluation.service');
const responseModule = require('../utils/response');
const StudentSpeakingAnswer = require('../models/studentSpeakingAnswer.model');

const handleIeltsEvaluation = async (req, res, next) => {
  try {
    const { studentSpeakingAnswerId, isAiBased, speakingAudios , studentSpeakingAnswer , student} = req.body;
    
    await ieltsEvaluationService.handleIeltsEvaluation(studentSpeakingAnswer, student, speakingAudios, isAiBased, req);

    responseModule.successResponse(res, {
        success: 1,
        message: 'IELTS Evaluation processed successfully.',
        data: {},
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  handleIeltsEvaluation,
};
