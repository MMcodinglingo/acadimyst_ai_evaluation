const path = require('path');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');
const OpenAI = require('openai');
const globalHeper = require('../utils/globalHelper');
const config = require('../config/config');
// const e = require('cors');
const fileToBase64 = (filePath) => {
    const fileData = fs.readFileSync(filePath);
    return fileData.toString('base64');
};

const {
    buildDiarizeSystemPrompt,
    buildDiarizeUserPrompt,
    buildMergeSystemPrompt,
    buildMergeUserPrompt,
    buildFinalReviewSystemPrompt,
    buildRelevanceUserPrompt,
    buildSpeakingReportSystemPrompt,
    buildSpeakingReportUserPrompt,
} = require('../prompts/oetSpeaking');
// const { model } = require('mongoose');
// const { build } = require('joi');

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const step1_WhisperThenDiarizeThenMerge = async (localPath, _filename, rolePlayerCard) => {
    try {
        // Normalize every audio to 32kbps mono MP3 before Whisper:
        // handles any input format, keeps payload small, no 25MB limit issues
        const fileToSend = await globalHeper.compressAudioUnder25MB(localPath);

        // Helper: Check if language code is English
        const isEnglishLangCode = (langRaw) => {
            const raw = String(langRaw || '').trim();
            const l = raw.toLowerCase();
            return l === 'english' || l === 'en' || l.startsWith('en');
        };

        // Helper: Heuristic to check if text looks English
        const looksEnglishText = (text) => {
            const s = String(text || '').trim();
            if (!s) return false;

            // 1) ASCII letter ratio
            const letters = (s.match(/[A-Za-z]/g) || []).length;
            const nonSpace = s.replace(/\s+/g, '').length || 1;
            const asciiRatio = letters / nonSpace;

            // 2) Common English words
            const lower = s.toLowerCase();
            const common = [
                'the',
                'and',
                'to',
                'of',
                'a',
                'in',
                'is',
                'it',
                'you',
                'that',
                'for',
                'on',
                'with',
                'i',
                'we',
                'can',
                'will',
                'please',
                'today',
                'pain',
                'take',
                'help',
                'feel',
                'okay',
                'what',
                'when',
                'where',
                'how',
                'your',
                'my',
            ];
            const hits = common.reduce((acc, w) => acc + (lower.includes(` ${w} `) ? 1 : 0), 0);

            // Thresholds: tune if needed
            return asciiRatio > 0.45 || hits >= 3;
        };

        // Helper: Build fallback diarization object from Whisper segments
        const buildWhisperFallbackDiarizeObj = (whisperSegments) => ({
            speakers: { healthcare_name: 'Dr. Unknown', patient_name: 'Patient' },
            turns: (whisperSegments || []).map((s) => ({
                start: Number(s.start ?? 0),
                end: Number(s.end ?? 0),
                speaker: 'Speaker',
                text: String(s.text || '').trim(),
            })),
        });

        // Determine correct MIME type
        const fileExt = path.extname(fileToSend).toLowerCase();
        const mimeTypes = {
            '.mp3': 'audio/mpeg',
            '.mpeg': 'audio/mpeg',
            '.mpga': 'audio/mpeg',
            '.wav': 'audio/wav',
            '.m4a': 'audio/mp4',
            '.webm': 'audio/webm',
        };
        const correctContentType = mimeTypes[fileExt] || 'audio/mpeg';

        //  STEP 1a: Whisper Transcription (initial attempt without forced language)
        console.log('🎙️ Step 1a: Whisper transcription (auto-detect language)...');
        const form1 = new FormData();
        form1.append('file', fs.createReadStream(fileToSend), {
            filename: path.basename(fileToSend),
            contentType: correctContentType,
        });
        form1.append('model', 'whisper-1');
        form1.append('response_format', 'verbose_json');
        form1.append('timestamp_granularities[]', 'segment');

        const whisperRes1 = await axios.post('https://api.openai.com/v1/audio/transcriptions', form1, {
            headers: {
                Authorization: `Bearer ${config.OPENAI_API_KEY}`,
                ...form1.getHeaders(),
            },
        });

        let whisperJson = whisperRes1.data;
        let detectedLangRaw = String(whisperJson?.language || '').trim();
        const whisperText = String(whisperJson?.text || '').trim();

        const whisperEnglish = isEnglishLangCode(detectedLangRaw);
        const whisperLooksEnglish = looksEnglishText(whisperText);

        //  STEP 1b: If Whisper detected non-English, verify with forced English retry
        if (!whisperEnglish && !whisperLooksEnglish) {
            console.log(` Whisper detected non-English (${detectedLangRaw}). Retrying with forced English...`);

            const form2 = new FormData();
            form2.append('file', fs.createReadStream(fileToSend), {
                filename: path.basename(fileToSend),
                contentType: correctContentType,
            });
            form2.append('model', 'whisper-1');
            form2.append('response_format', 'verbose_json');
            form2.append('timestamp_granularities[]', 'segment');
            form2.append('language', 'en'); //  Force English

            const whisperRes2 = await axios.post('https://api.openai.com/v1/audio/transcriptions', form2, {
                headers: {
                    Authorization: `Bearer ${config.OPENAI_API_KEY}`,
                    ...form2.getHeaders(),
                },
            });

            const whisperJson2 = whisperRes2.data;
            const detectedLangRaw2 = String(whisperJson2?.language || '').trim();
            const whisperText2 = String(whisperJson2?.text || '').trim();
            const whisperLooksEnglish2 = looksEnglishText(whisperText2);

            // Use fallback if it looks more English
            if (whisperLooksEnglish2) {
                console.log(' Forced English attempt looks better. Using it.');
                whisperJson = whisperJson2;
                detectedLangRaw = detectedLangRaw2;
            } else {
                //  Reject only now (both attempts look non-English)
                throw new Error(
                    `Whisper language gate failed (verified). Detected: ${
                        detectedLangRaw || 'unknown'
                    }. Audio does not appear to be English.`
                );
            }
        }

        const whisperSegments = (whisperJson?.segments || []).map((s, idx) => ({
            id: idx,
            start: Number(s.start ?? 0),
            end: Number(s.end ?? 0),
            text: String(s.text || '').trim(),
        }));

        console.log(` Whisper complete. Language: ${detectedLangRaw}. Segments: ${whisperSegments.length}`);

        //  STEP 2: Diarization with gpt-4o-audio-preview
        console.log(' Step 2: Diarization with gpt-4o-audio-preview...');

        // Convert to mp3 if needed (gpt-4o-audio-preview only supports wav/mp3)
        let audioFileForDiarization = fileToSend;
        const audioExt = path.extname(fileToSend).replace('.', '');

        // Convert all formats except clean mp3 to ensure compatibility
        if (audioExt === 'webm' || audioExt === 'm4a' || audioExt === 'wav' || audioExt === 'mpeg' || audioExt === 'mpga') {
            console.log(` Converting ${audioExt} to MP3 for diarization...`);
            audioFileForDiarization = await globalHeper.convertToMp3(fileToSend);
        }

        const base64Audio = fileToBase64(audioFileForDiarization);
        const diarizationExt = path.extname(audioFileForDiarization).replace('.', '');

        const diarizeSystem = buildDiarizeSystemPrompt({ detectedLangRaw });
        const roleCardsText = JSON.stringify(rolePlayerCard, null, 2);
        console.log('Role Cards:', roleCardsText);

        const diarizeUser = buildDiarizeUserPrompt({ detectedLangRaw, rolePlayerCard: roleCardsText, whisperSegments });

        const diarizePayload = {
            model: 'gpt-4o-audio-preview',
            modalities: ['text'],
            temperature: 0,
            messages: [
                { role: 'system', content: diarizeSystem },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: diarizeUser },
                        {
                            type: 'input_audio',
                            input_audio: {
                                data: base64Audio,
                                format: diarizationExt === 'mp3' ? 'mp3' : 'wav',
                            },
                        },
                    ],
                },
            ],
        };

        const diarizeRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.OPENAI_API_KEY}`,
            },
            body: JSON.stringify(diarizePayload),
        });

        if (!diarizeRes.ok) {
            const error = await diarizeRes.text();
            throw new Error(`Diarization API error: ${error}`);
        }

        const diarizeJson = await diarizeRes.json();
        const diarizeContent = diarizeJson?.choices?.[0]?.message?.content || '';
        let diarizeObj = globalHeper.safeExtractJson(diarizeContent, 'Diarization');

        // If diarize returns NON_ENGLISH_AUDIO, fallback to Whisper-only turns
        if (diarizeObj?.error === 'NON_ENGLISH_AUDIO') {
            console.warn(' Diarize returned NON_ENGLISH_AUDIO. Falling back to Whisper-only turns.');
            diarizeObj = buildWhisperFallbackDiarizeObj(whisperSegments);
        }

        console.log(' Diarization complete.');

        //  STEP 3: Merge Whisper + Diarization
        console.log(' Step 3: Merging Whisper + Diarization...');

        const mergeSystem = buildMergeSystemPrompt();

        const mergeUser = buildMergeUserPrompt({ whisperOutput: whisperSegments, diarizationOutput: diarizeObj });

        const mergeBody = {
            model: 'gpt-4o',
            temperature: 0,
            max_tokens: 6000,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: mergeSystem },
                { role: 'user', content: mergeUser },
            ],
        };

        const mergeRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${config.OPENAI_API_KEY}`,
            },
            body: JSON.stringify(mergeBody),
        });

        if (!mergeRes.ok) {
            const error = await mergeRes.text();
            throw new Error(`Merge API error: ${error}`);
        }

        const mergeJson = await mergeRes.json();
        const mergeContent = mergeJson?.choices?.[0]?.message?.content || '';
        let finalObj = globalHeper.safeExtractJson(mergeContent, 'Merge');

        //  If merge returns NON_ENGLISH (rare model mistake), fallback to Whisper-based final JSON
        if (finalObj?.error === 'NON_ENGLISH_AUDIO') {
            console.warn(' Merge returned NON_ENGLISH_AUDIO. Falling back to Whisper-only final JSON.');
            finalObj = {
                speakers: {
                    healthcare_name: diarizeObj?.speakers?.healthcare_name || 'Dr. Unknown',
                    patient_name: diarizeObj?.speakers?.patient_name || 'Patient',
                },
                turns: buildWhisperFallbackDiarizeObj(whisperSegments).turns,
            };
        }

        // Infer healthcare name if missing
        const inferHealthcareFromTurns = (turns = []) => {
            const firstHP = turns.find((t) => {
                const sp = String(t?.speaker || '');
                return /^Dr\./i.test(sp) || /^Nurse\./i.test(sp) || /^Pharmacist\.?/i.test(sp);
            })?.speaker;
            return firstHP || 'Health Care Professional';
        };

        if (!finalObj?.speakers?.healthcare_name) {
            finalObj.speakers = finalObj.speakers || {};
            finalObj.speakers.healthcare_name = inferHealthcareFromTurns(finalObj.turns);
        }
        console.log(' Step 1 Complete: FINAL (transcribe + diarize + timestamps) ready.');

        const transcript = globalHeper.formatTranscriptFromFinalJson(finalObj);

        return {
            transcript,
            step1FinalJson: finalObj,
        };
    } catch (err) {
        console.error(' Step 1 Error:', err);
        throw err;
    }
};
const generateIntelligibilityReport_DoctorOnly = async (step1FinalJson, rolePlayerCard, transcript) => {
    if (!step1FinalJson?.turns?.length) throw new Error('Run Step 1 first.');

    try {
        const SILENCE_THRESHOLD = 0.6;

        // ---- Identify healthcare professional name (matches Step 1 schema) ----
        const doctorName =
            step1FinalJson?.speakers?.healthcare_name || //  primary key from diarize JSON
            step1FinalJson?.speakers?.doctor_name ||
            step1FinalJson?.speakers?.Doctor_name ||
            step1FinalJson?.speakers?.pharmacist_name ||
            step1FinalJson?.speakers?.Pharmacist_name ||
            step1FinalJson?.speakers?.nurse_name ||
            step1FinalJson?.speakers?.Nurse_name ||
            step1FinalJson?.turns?.find((t) => {
                const speaker = String(t.speaker || '');
                return /^Dr\./i.test(speaker) || /^Pharmacist\.?/i.test(speaker) || /^Nurse\.?/i.test(speaker);
            })?.speaker ||
            'Dr. Unknown';

        // ---- Step 1 turns (full timeline) ----
        const allTurns = (step1FinalJson.turns || []).map((t) => ({
            start: Number(t.start ?? 0),
            end: Number(t.end ?? 0),
            speaker: String(t.speaker || 'Speaker'),
            text: String(t.text || '').trim(),
        }));

        // ---- Doctor-only transcript from Step 1 ----
        const doctorTurns = allTurns.filter((t) => String(t.speaker) === String(doctorName));
        const doctorRefText = doctorTurns
            .map((t) => t.text)
            .join(' ')
            .trim();
        const doctorSpeakingSeconds = doctorTurns.reduce((sum, t) => sum + Math.max(0, t.end - t.start), 0);

        // ---- Local metrics (Step 1 only) ----
        const refWords = globalHeper.normalizeWords(doctorRefText).length;

        const wpm = doctorSpeakingSeconds > 0 ? refWords / (doctorSpeakingSeconds / 60) : 0;

        // NOTE: Step 2/3 removed => WER not meaningful.
        // Keep it only as a safe internal debug value; DO NOT depend on it for feedback.
        const wer = 0;

        const fillerCount = globalHeper.countFillers(doctorRefText);
        const repetitionCount = globalHeper.countImmediateRepetitions(doctorRefText);
        const fragmentCount = globalHeper.countFragments(doctorRefText);

        // ---- Silences from Step 1 turns ----
        const silences = globalHeper.computeDoctorSilencesFromTurns(allTurns, doctorName, SILENCE_THRESHOLD);

        const sb = silences?.SilenceBeforeDoctorSpeaks || {};
        const cd = silences?.DoctorConsecutiveTurnSilence || {};

        // =========================================================
        //  REPLACEMENTS FOR HUME OUTPUT (Step-1 only "Speech Cues")
        // We keep the same "slot" in the prompt but replace with:
        // - Pace label from WPM
        // - Filler/repetition/fragment labels
        // - Pause patterns from Step 1 silences
        // These are *not* emotions; they're transcript-based speaking cues.
        // =========================================================
        const paceLabel = (() => {
            if (!wpm || !Number.isFinite(wpm)) return 'Unknown';
            if (wpm < 110) return 'Slow';
            if (wpm <= 165) return 'Normal';
            return 'Fast';
        })();

        const levelLabel = (n, lowMax, midMax) => {
            const v = Number(n || 0);
            if (v <= lowMax) return 'Low';
            if (v <= midMax) return 'Moderate';
            return 'High';
        };

        const fillerLabel = levelLabel(fillerCount, 2, 6);
        const repetitionLabel = levelLabel(repetitionCount, 1, 4);
        const fragmentLabel = levelLabel(fragmentCount, 2, 6);

        const pauseLabel = (count) => {
            const c = Number(count || 0);
            if (c <= 1) return 'Rare';
            if (c <= 4) return 'Sometimes';
            return 'Frequent';
        };

        const preSpeechPauseLabel = pauseLabel(sb.count);
        const consecutivePauseLabel = pauseLabel(cd.count);

        // ---- These are "placeholder variables" but now meaningful (Step 1 only) ----
        // Keep variable names to avoid rewriting your whole prompt structure too much.
        const avgConfidenceEmotionScore = 0; // not used; kept to match your existing debug bundle
        const emotionsSortedLine = `Overall Candidate Speech Cues (Top): Pace=${paceLabel}, Fillers=${fillerLabel}, Repetitions=${repetitionLabel}, Fragments=${fragmentLabel}, Pre-speech Pauses=${preSpeechPauseLabel}, Consecutive Pauses=${consecutivePauseLabel}`;

        // Replace "doctorHumePretty" with a Step-1-only evidence block (no emotions)
        const doctorHumePretty = `
Candidate Speech Cues (Step 1 transcript-based, NOT emotions):
- Pace: ${paceLabel} (based on speaking speed)
- Fillers: ${fillerLabel} (um/uh/you know)
- Repetitions: ${repetitionLabel} (immediate repeats like "I I", "the the")
- Fragments: ${fragmentLabel} (incomplete short phrases)
- Pre-speech pauses: ${preSpeechPauseLabel} (gaps before candidate starts speaking)
- Consecutive-turn pauses: ${consecutivePauseLabel} (gaps between candidate's back-to-back turns)

Use these cues only as SUPPORT. The main evidence MUST be transcript quotes + timestamps.
`.trim();

        // ---- role cards ----
        const roleCardsText = rolePlayerCard;

        const transcriptText = transcript || globalHeper.formatTranscriptFromFinalJson(step1FinalJson) || 'N/A';

        // =========================================================
        //  STEP 4A (NEW): ROLEPLAY RELEVANCE GATE (STRICT)
        // If unrelated => DO NOT score anything. Force 0/500 and Grade E.
        // =========================================================
        console.log(' Step 4A: Validating role-play relevance (gate check)...');

        const relevanceSystem = buildFinalReviewSystemPrompt();

        const relevanceUser = buildRelevanceUserPrompt({ roleCardsText, transcript: transcriptText, doctorRefText });

        const relevanceJson = await client.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0,
            max_tokens: 500,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: relevanceSystem },
                { role: 'user', content: relevanceUser },
            ],
        });

        // const relevanceJson = await relevanceRes.json();

        const relevanceContent = relevanceJson?.choices?.[0]?.message?.content || '{}';
        const relevanceObj = globalHeper.safeExtractJson(relevanceContent, 'Relevance') || {};

        const relevanceStatus = String(relevanceObj?.status || '').toUpperCase();
        const relevanceCoverage = Number(relevanceObj?.coverage || 0);
        const relevanceReason = String(relevanceObj?.reason || '').trim();

        console.log(' Relevance check:', { relevanceStatus, relevanceCoverage, relevanceReason });

        //  HARD FAIL: Completely unrelated => return 0 score report immediately
        if (relevanceStatus === 'UNRELATED' || relevanceCoverage <= 20) {
            console.warn(' Conversation is UNRELATED to role-play. Returning 0/500 report.');

            const unrelatedReport = `
${doctorName}

**Summary**
The conversation is not related to the given role-play cards. Because the interaction did not follow the scenario, tasks, or purpose of the role play, a valid OET speaking assessment cannot be given. 

Reason (role-play mismatch): ${relevanceReason || 'Speakers were talking about something unrelated to the role-play cards.'}


Total Score: 0/500
OET Grade: E
`.trim();

            return {
                content: unrelatedReport,
                relevance: relevanceObj,
                unrelated: true,
            };
        }

        //  Build user prompt (KEEP LENGTH; now includes relevance result)
        const userPrompt = buildSpeakingReportUserPrompt(
            roleCardsText,
            transcriptText,
            doctorName,
            relevanceStatus,
            relevanceCoverage,
            relevanceReason,
            doctorHumePretty,
            doctorSpeakingSeconds,
            fillerCount,
            repetitionCount,
            fragmentCount,
            sb,
            cd,
            wpm,
            wer,
            emotionsSortedLine,
            avgConfidenceEmotionScore
        );

        // Build System Prompt
        const systemPrompt = buildSpeakingReportSystemPrompt({
            roleCardsText,
            transcriptText,
            doctorName,
            doctorSpeakingSeconds,
            fillerCount,
            repetitionCount,
            fragmentCount,
            sb,
            cd,
            emotionsSortedLine,
            wpm,
            wer,
        });

        console.log('Step 4: Generating intelligibility report...');

        const j = await client.chat.completions.create({
            model: 'gpt-4o',
            temperature: 0,
            max_tokens: 6500,
            seed: 12345,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
        });

        const choice = j?.choices?.[0];
        if (choice?.finish_reason === 'length') {
            throw new Error('Step 4 output was truncated (max_tokens too low). Increase max_tokens or reduce JSON size.');
        }
        const content = choice?.message?.content || '';
        return { content, choices: choice, systemPrompt, userPrompt };
    } catch (err) {
        console.error(err);
    }
};

/**
 * Extract detailed scores breakdown from GRADE AND SCORE section
 */

/**
 * Parse the complete intelligibility report into structured data
 */
function parseIntelligibilityReport(intelligibilityReport) {
    return {
        // Basic Info
        fullReport: intelligibilityReport,
        totalScore: globalHeper.extractScoreFromReport(intelligibilityReport),
        oetGrade: globalHeper.extractGradeFromReport(intelligibilityReport),

        // Main Sections
        summary: globalHeper.extractSection(intelligibilityReport, 'Summary'),
        strengths: globalHeper.extractListSection(intelligibilityReport, 'Strengths'),
        areasOfImprovement: globalHeper.extractListSection(intelligibilityReport, 'Areas for Improvement'),
        overallGuidance: globalHeper.extractOverallGuidance(intelligibilityReport),

        // Detailed Scores
        detailedScores: globalHeper.extractDetailedScores(intelligibilityReport),

        // Linguistic Criteria
        linguisticCriteria: globalHeper.extractLinguisticCriteria(intelligibilityReport),

        // Clinical Communication
        clinicalCommunication: globalHeper.extractClinicalCommunication(intelligibilityReport),
    };
}

module.exports = {
    step1_WhisperThenDiarizeThenMerge,
    generateIntelligibilityReport_DoctorOnly,
    parseIntelligibilityReport,
};
