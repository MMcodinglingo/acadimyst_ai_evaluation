const express = require('express');
const oetEvaluationController = require('../controllers/oetEvaluation.controller');

const router = express.Router();

router.post('/oet-speaking-evaluation', oetEvaluationController.handleOetSpeakingEvaluation);

module.exports = router;
