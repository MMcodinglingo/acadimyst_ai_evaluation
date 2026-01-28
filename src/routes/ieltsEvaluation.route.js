const express = require('express');
const ieltsEvaluationController = require('../controllers/ieltsEvaluation.controller');

const router = express.Router();

router.post('/ielts-evaluation', ieltsEvaluationController.handleIeltsSpeakingEvaluation);

module.exports = router;
