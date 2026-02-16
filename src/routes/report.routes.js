const express = require('express');
const router = express.Router();
const { previewIeltsSpeakingPdf } = require('../controllers/reportPreview.controller');

router.get('/generate-pdf', previewIeltsSpeakingPdf);

module.exports = router;
