const express = require('express');
const ieltsEvaluationController = require('../controllers/ieltsEvaluation.controller');

const router = express.Router();

router.post('/ielts-writing-evaluation', ieltsEvaluationController.handleIeltsWritingEvaluation);

router.post('/ielts-speaking-evaluation', ieltsEvaluationController.handleIeltsSpeakingEvaluation);


module.exports = router;
