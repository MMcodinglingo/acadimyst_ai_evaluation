const express = require('express');
const ieltsEvaluationController = require('../controllers/ieltsEvaluation.controller');
const { mockAuthMiddleware } = require('../middlewares/mock');

const router = express.Router();

router.post('/ielts-evaluation', mockAuthMiddleware, ieltsEvaluationController.handleIeltsSpeakingEvaluation);

module.exports = router;
