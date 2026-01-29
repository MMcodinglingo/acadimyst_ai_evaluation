const express = require('express');
const ieltsEvaluationController = require('../controllers/ieltsEvaluation.controller');

const router = express.Router();

router.post('/ielts-evaluation', ieltsEvaluationController.handleIeltsWritingEvaluation);

module.exports = router;
