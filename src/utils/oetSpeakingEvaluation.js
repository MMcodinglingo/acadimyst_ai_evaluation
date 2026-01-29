const path = require('path');
const fs = require('fs');

const axios = require('axios');
const globalHeper = require('../utils/globalHelper');
const fileToBase64 = (filePath) => {
    const fileData = fs.readFileSync(filePath);
    return fileData.toString('base64');
};

const step1_WhisperThenDiarizeThenMerge = async (localPath, filename, rolePlayerCard) => {
    try {
        const ext = path.extname(filename).toLowerCase();
        const allowed = ['.mp3', '.mpeg', '.mpga', '.m4a', '.wav', '.webm'];
        let fileToSend = localPath;

        // Check file size
        const stats = fs.statSync(localPath);
        const fileSizeInMB = stats.size / (1024 * 1024);

        if (fileSizeInMB > 25) {
            throw new Error(`File too large: ${fileSizeInMB.toFixed(2)}MB (max 25MB)`);
        }

        // Convert if needed
        if (ext === '.m4a' || !allowed.includes(ext)) {
            fileToSend = await globalHeper.convertToMp3(localPath);
        }

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

        // ✅ STEP 1a: Whisper Transcription (initial attempt without forced language)
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
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
            console.log(`⚠️ Whisper detected non-English (${detectedLangRaw}). Retrying with forced English...`);

            const form2 = new FormData();
            form2.append('file', fs.createReadStream(fileToSend), {
                filename: path.basename(fileToSend),
                contentType: correctContentType,
            });
            form2.append('model', 'whisper-1');
            form2.append('response_format', 'verbose_json');
            form2.append('timestamp_granularities[]', 'segment');
            form2.append('language', 'en'); // ✅ Force English

            const whisperRes2 = await axios.post('https://api.openai.com/v1/audio/transcriptions', form2, {
                headers: {
                    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

        console.log(`✅ Whisper complete. Language: ${detectedLangRaw}. Segments: ${whisperSegments.length}`);

        // ✅ STEP 2: Diarization with gpt-4o-audio-preview
        console.log('🎭 Step 2: Diarization with gpt-4o-audio-preview...');

        // Convert to mp3 if needed (gpt-4o-audio-preview only supports wav/mp3)
        let audioFileForDiarization = fileToSend;
        const audioExt = path.extname(fileToSend).replace('.', '');

        // Convert all formats except clean mp3 to ensure compatibility
        if (audioExt === 'webm' || audioExt === 'm4a' || audioExt === 'wav' || audioExt === 'mpeg' || audioExt === 'mpga') {
            console.log(`🔄 Converting ${audioExt} to MP3 for diarization...`);
            audioFileForDiarization = await globalHeper.convertToMp3(fileToSend);
        }

        const base64Audio = fileToBase64(audioFileForDiarization);
        const diarizationExt = path.extname(audioFileForDiarization).replace('.', '');

        const diarizeSystem = `
        You are an expert OET role-play transcriber + diarizer.

IMPORTANT LANGUAGE POLICY (STRICT BUT PRACTICAL):
1) The required language is ENGLISH.
2) DO NOT translate any non-English speech into English.
   - If the audio is in Urdu (or any non-English language) and you can understand it, you must still NOT translate.
3) Small non-English items are allowed and MUST NOT cause failure, such as:
   - Names (e.g., "Ahsan", "Hina", "Muhammad", "Aneeqa", "Ghaznavi")
   - Place names (e.g., Islamabad, Lahore)
4) If you encounter short non-English phrases inside an otherwise English conversation:
   - Keep the transcript in English for English parts.
   - Replace the non-English phrase ONLY with: [NON_ENGLISH]
   - Continue diarization.

HARD FAIL RULE (ONLY when mostly non-English):
- If more than 50% of the spoken content is clearly NOT English (e.g., full Urdu conversation),
  return ONLY this JSON and nothing else:
  { "error": "NON_ENGLISH_AUDIO", "message": "Audio language is not English. Please provide an English audio." }

GOAL:
- Identify the healthcare profession correctly from ROLE PLAY CARDS + the audio:
  Doctor OR Nurse OR Pharmacist.
- Transcribe ONLY what is spoken.
- Do NOT add missing lines.
- Do NOT paraphrase.
- Do NOT translate.
- Identify speakers by their REAL names if clearly spoken (listen for introductions).
- Determine which speaker is the healthcare professional vs patient/client using role cards + conversation style.

INPUTS:
1) Audio.
2) Whisper segment timestamps (segments list with start/end/text). Use these timestamps as anchors.
3) Whisper detected language: ${detectedLangRaw || 'unknown'} (may be imperfect)


SPEAKER LABEL RULES (MUST FOLLOW EXACTLY):
- healthcare_name must be:
  "Dr. <Name>" OR "Nurse. <Name>" OR "Pharmacist. <Name>"
  If name is unclear: "Dr. Unknown" / "Nurse. Unknown" / "Pharmacist. Unknown"
- patient_name must be:
  "<Name>" (no title). If unclear: "Patient"

TIMING RULES:
- Use Whisper segment timestamps as anchors.
- Turns must be time-aligned.
- Split turns when speaker changes.
- Keep turns concise but do not drop content.

INPUTS:
1) Audio
2) Whisper segments (start/end/text) as anchors
3) ROLE PLAY CARDS

OUTPUT (JSON ONLY, exact shape):
{
  "speakers": {
    "healthcare_name": "Dr. ... / Nurse. ... / Pharmacist. ...",
    "patient_name": "..."
  },
  "turns": [
    { "start": 0.00, "end": 1.23, "speaker": "Dr. ... / Nurse. ... / Pharmacist. ... / PatientName", "text": "..." }
  ]
}

STRICT OUTPUT RULES:
- Return ONLY valid JSON. No markdown. No commentary. No extra keys.
- If audio is mostly non-English, return ONLY the NON_ENGLISH_AUDIO JSON.
`.trim();

        const roleCardsText = JSON.stringify(rolePlayerCard, null, 2);
        console.log('Role Cards:', roleCardsText);

        const diarizeUser = `
WHISPER DETECTED LANGUAGE (may be imperfect):
${detectedLangRaw || 'unknown'}

ROLE PLAY CARDS (to identify profession + names):
${roleCardsText || 'N/A'}

Whisper segments (timestamps anchors):
${JSON.stringify(whisperSegments.slice(0, 250), null, 2)}

Now diarize the audio into speaker turns with start/end and text.
`.trim();

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
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

        // ✅ If diarize returns NON_ENGLISH_AUDIO, fallback to Whisper-only turns
        if (diarizeObj?.error === 'NON_ENGLISH_AUDIO') {
            console.warn('⚠️ Diarize returned NON_ENGLISH_AUDIO. Falling back to Whisper-only turns.');
            diarizeObj = buildWhisperFallbackDiarizeObj(whisperSegments);
        }

        console.log('✅ Diarization complete.');

        // ✅ STEP 3: Merge Whisper + Diarization
        console.log('🔀 Step 3: Merging Whisper + Diarization...');

        const mergeSystem = `
You merge two imperfect outputs into one best transcript.

LANGUAGE POLICY:
- Output must match the spoken language.
- Do NOT translate.
- If mostly non-English (>50%), return NON_ENGLISH_AUDIO JSON.
- If a tiny non-English phrase appears, replace it with [NON_ENGLISH] and continue.
- DO NOT return NON_ENGLISH_AUDIO unless the audio is clearly mostly non-English (>50%).
- Even if Whisper language label is wrong, use the transcript content.

INPUT A (Whisper):
- Has reliable timestamps by segment but weaker speaker labeling.

INPUT B (Diarization draft):
- Has better speaker changes and names but timestamps may be approximate.

TASK:
Produce FINAL JSON with accurate transcribe + diarize + timestamps.

CRITICAL RULES:
- Doctor/Pharmacist/Nurse must be labeled as: "Dr. <Name>/Pharmacist. <Name>/Nurse. <Name>" (include Dr./Pharmacist./Nurse. prefix).
- Patient must be "<Name>".
- Ensure the Doctor/Pharmacist/Nurse vs PATIENT roles are correctly assigned using conversation context.
- Use Whisper timestamps as the primary source of timing. Adjust diarization turn boundaries to match Whisper segments when possible.
- Output JSON ONLY with shape:
{
  "speakers": { "healthcare_name": "...", "patient_name": "..." },
  "turns": [ { "start": number, "end": number, "speaker": string, "text": string } ]
}

OR if clearly non-English:
{ "error": "NON_ENGLISH_AUDIO", "message": "Audio language is not English." }

No extra keys.
`.trim();

        const mergeUser = `
WHISPER (timestamp segments):
${JSON.stringify(whisperSegments, null, 2)}

DIARIZATION DRAFT (names + turns):
${JSON.stringify(diarizeObj, null, 2)}

Now output FINAL JSON.
`.trim();

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
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

        // ✅ If merge returns NON_ENGLISH (rare model mistake), fallback to Whisper-based final JSON
        if (finalObj?.error === 'NON_ENGLISH_AUDIO') {
            console.warn('⚠️ Merge returned NON_ENGLISH_AUDIO. Falling back to Whisper-only final JSON.');
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
        console.log('✅ Step 1 Complete: FINAL (transcribe + diarize + timestamps) ready.');

        const transcript = globalHeper.formatTranscriptFromFinalJson(finalObj);

        return {
            transcript,
            step1FinalJson: finalObj,
        };
    } catch (err) {
        console.error('❌ Step 1 Error:', err);
        throw err;
    }
};

const generateIntelligibilityReport_DoctorOnly = async (step1FinalJson, rolePlayerCard, transcript) => {
    if (!step1FinalJson?.turns?.length) throw new Error('Run Step 1 first.');

    try {
        const SILENCE_THRESHOLD = 0.6;

        // ---- Identify healthcare professional name (matches Step 1 schema) ----
        const doctorName =
            step1FinalJson?.speakers?.healthcare_name || // ✅ primary key from diarize JSON
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
        // ✅ REPLACEMENTS FOR HUME OUTPUT (Step-1 only "Speech Cues")
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
        // ✅ STEP 4A (NEW): ROLEPLAY RELEVANCE GATE (STRICT)
        // If unrelated => DO NOT score anything. Force 0/500 and Grade E.
        // =========================================================
        console.log('🔍 Step 4A: Validating role-play relevance (gate check)...');

        const relevanceSystem = `
You are an OET role-play relevance validator.

Goal:
Decide whether the transcript is a healthcare role-play conversation that matches the ROLE PLAY CARDS in a practical sense.

How to judge (IMPORTANT):
- Judge "RELATED" if the conversation clearly looks like a healthcare consultation role-play (greetings, patient concerns, history taking, advice, reassurance, explanation, closing), even if some details differ.
- Judge "PARTIALLY_RELATED" if it is a consultation but misses major required parts of the scenario or becomes off-topic for long sections.
- Judge "UNRELATED" ONLY if it is clearly NOT a healthcare role-play (e.g., casual chat, business talk, unrelated topics) OR if the role-play context is not present at all.

Do NOT fail due to:
- greetings/small talk
- short off-topic lines
- accent, names, or minor mismatch
- imperfect speaker labeling

Return JSON only:
{
  "status": "UNRELATED" | "PARTIALLY_RELATED" | "RELATED",
  "coverage": number,
  "reason": string,
  "matched_signals": ["...","..."],
  "missing_signals": ["...","..."]
}
        `.trim();

        const relevanceUser = `
ROLE PLAY CARDS:
${roleCardsText || 'N/A'}

FULL TRANSCRIPT:
${transcriptText || 'N/A'}

DOCTOR ONLY TEXT:
${doctorRefText || 'N/A'}

Return JSON now.
`.trim();

        const relevanceRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                temperature: 0,
                max_tokens: 500,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: relevanceSystem },
                    { role: 'user', content: relevanceUser },
                ],
            }),
        });

        if (!relevanceRes.ok) {
            const error = await relevanceRes.text();
            throw new Error(`Relevance check API error: ${error}`);
        }

        const relevanceJson = await relevanceRes.json();
        const relevanceContent = relevanceJson?.choices?.[0]?.message?.content || '{}';
        const relevanceObj = globalHeper.safeExtractJson(relevanceContent, 'Relevance') || {};

        const relevanceStatus = String(relevanceObj?.status || '').toUpperCase();
        const relevanceCoverage = Number(relevanceObj?.coverage || 0);
        const relevanceReason = String(relevanceObj?.reason || '').trim();

        console.log('✅ Relevance check:', { relevanceStatus, relevanceCoverage, relevanceReason });

        // ✅ HARD FAIL: Completely unrelated => return 0 score report immediately
        if (relevanceStatus === 'UNRELATED' || relevanceCoverage <= 20) {
            console.warn('⚠️ Conversation is UNRELATED to role-play. Returning 0/500 report.');

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

        // ✅ Build user prompt (KEEP LENGTH; now includes relevance result)
        const userPrompt = `
ROLE PLAY CARDS (context for appropriateness + clinical communication):
${roleCardsText || 'N/A'}

TRANSCRIPT (Full timestamped text for linguistic + clinical analysis):
${transcriptText || 'N/A'}

DOCTOR NAME:
${doctorName}

ROLEPLAY RELEVANCE CHECK (strict):
- status=${relevanceStatus}
- coverage=${Number.isFinite(relevanceCoverage) ? relevanceCoverage : 0}%
- reason=${relevanceReason || 'N/A'}
NOTE: If PARTIALLY_RELATED, scores MUST be reduced across ALL categories. If mostly unrelated, score must be 0.

CANDIDATE SPEECH CUES (Step 1 only - replaces emotion analysis; for tone/fluency hints):
${doctorHumePretty || 'N/A'}

METRICS USED (computed locally):
- Speaking Time: ${Number(doctorSpeakingSeconds || 0).toFixed(2)}s
- Words Per Minute: ${Number(wpm || 0).toFixed(2)}
- Word Error Rate: ${(Number(wer || 0) * 100).toFixed(2)}%
- Verbal Fillers: ${Number(fillerCount || 0)}
- Immediate Repetitions: ${Number(repetitionCount || 0)}
- Fragments/Short Turns: ${Number(fragmentCount || 0)}
- Avg Confidence (Emotion): ${Number(avgConfidenceEmotionScore || 0).toFixed(4)}
- Silence Before Speaking: count=${Number(sb.count || 0)}, total=${Number(sb.total || 0).toFixed(2)}s, longest=${Number(
            sb.longest || 0
        ).toFixed(2)}s
- Consecutive Turn Silence: count=${Number(cd.count || 0)}, total=${Number(cd.total || 0).toFixed(2)}s, longest=${Number(
            cd.longest || 0
        ).toFixed(2)}s

${emotionsSortedLine}

DOCTOR SEGMENTS (corrected text + evidence block):
${doctorHumePretty}

SILENCE DETAILS (examples; time windows are mm:ss):
Silence Before Doctor Speaks (top 10):
${
    (sb.gaps || [])
        .slice(0, 10)
        .map((g) => `- ${g.time_window} | ${Number(g.gap_seconds || 0).toFixed(2)}s | from=${g.from} to=${g.to}`)
        .join('\n') || 'N/A'
}

Doctor Consecutive Turn Silence (top 10):
${
    (cd.gaps || [])
        .slice(0, 10)
        .map((g) => `- ${g.time_window} | ${Number(g.gap_seconds || 0).toFixed(2)}s`)
        .join('\n') || 'N/A'
}
`.trim();

        const systemPrompt =
            `You are an Occupational English Test (OET) Speaking Assessor working within a language-learning management system. Your job is to evaluate a healthcare candidate's recorded role play consultation and assess their communication skills. The assessment must focus on HOW they communicate, not on clinical correctness.

You will provide NARRATIVE, PRESCRIPTIVE FEEDBACK under each criterion. Describe the candidate's performance: note strengths, weaknesses, and specific examples. When identifying weaknesses, EXPLAIN THE MISTAKE IN DETAIL and offer guidance on correction (e.g., point out exactly where grammar was incorrect and how it should be structured, or highlight inappropriate tone and suggest adjustment).

**CRITICAL: Return PLAIN TEXT REPORT (NOT JSON). Do not wrap in code fences or markdown formatting.**

ROLEPLAY RELEVANCE RULE (STRICT):
- Before scoring, judge whether the conversation follows the role-play cards.
- If the conversation is mostly unrelated to the role-play cards (different topic/purpose), you MUST give 0/500 and grade E, and clearly state: "Speakers were talking about something unrelated to the role-play cards."
- If the conversation is PARTIALLY related, you MUST reduce scores across ALL categories, including linguistic scores (intelligibility/fluency/grammar/appropriateness), because the role-play performance is incomplete.
- You MUST mention what parts matched the role-play and what parts were off-topic (with timestamps).
- Use the provided "ROLEPLAY RELEVANCE CHECK" from the user prompt as a guide; do not ignore it.

**YOUR ASSESSMENT APPROACH:**
1. Evaluate each criterion below with SPECIFIC COMMENTS explaining performance. For weaknesses, explain the mistake and what should have been done instead.
2. Remain profession-neutral. Focus on communication skills applicable across healthcare professions.
3. Be objective and specific. Base comments on evidence, citing examples. Avoid vague statements.
4. Provide prescriptive summary highlighting strengths and improvement areas with specific action steps.
6-Numbers should be avoided like WER 151 , 251 Fragments these type of numbers should be avoided.
7-explain some terminologies like non intrusive accent so the user can understands betters.
8-use easy words of english dont use difficult words like moments of choppiness etc.
9-dont just write it should be more accurate or good provide the corrected version too.
10-Don't use name in the report instead use "candidate" wherever required.
-11 try to identify the pateint whether its a pateint or pateint parent or relative. dont write it as a pateint parent everytime unless it is the same case.

IMPORTANT REPLACEMENT RULE (Step 1 only):
- There is NO emotion model data. Any place where tone/empathy was previously supported by emotion scores, you must now support it using:
  (a) the candidate's exact words, and
  (b) how the candidate used pacing, pauses, fillers, repetitions, and sentence style from the transcript.
- Use the provided "Candidate Speech Cues" as hints, but DO NOT present these as emotions or scores.

${doctorName}

**Summary**
[Write 8-10 lines covering: overall intelligibility level, pronunciation/stress/intonation patterns, fluency characteristics (pace, hesitations, fillers), candidate's tone inferred from wording and delivery cues (pauses/fillers), clinical communication effectiveness, grammar quality, overall impact. Use learner-appropriate language.]
[Also include 2-4 lines explaining role-play relevance: what matched and what was off-topic, with timestamps.]

**Linguistic Criteria**

**Intelligibility**
[5-6 detailed sentences analyzing must be in paragraph:]
- CLEAR PRONUNCIATION: Identify specific mispronounced words with timestamps and phonetic corrections. Example: "At 02:15, 'patient' was pronounced /ˈpeɪʃənt/ instead of /ˈpeɪʃnt/." Also write the corrected version with "Instead of ... say ...".
- NON-INTRUSIVE ACCENT: Explain in simple words. Cite moments where accent interfered and suggest adjustments.
- CORRECT WORD STRESS: Quote specific multi-syllable words where stress was misplaced with corrected version.
- NATURAL INTONATION: Note deviations and suggest appropriate patterns, with corrected versions.
- PACE CONSISTENCY: Quote specific rushed or dragging moments.
- WORD CHOICE ACCURACY: Identify awkward phrasing with corrections.

**Fluency**
[4-5 detailed sentences covering must be in paragraph:]
- NATURAL FLOW: Quote specific hesitant moments.
- APPROPRIATE FILLERS: Quote examples with timestamps; suggest pausing strategies.
- FEW HESITATIONS/FALSE STARTS: Quote examples; recommend practice.
- FRAGMENTS: Quote fragments and provide complete sentence corrections.
- PACE BREAKS: Use silence windows as evidence.

**Appropriateness of Language**
[4 detailed sentences (use transcript evidence) must be in paragraph:]
- APPROPRIATE FORMALITY: If opening mismatched, provide better example.
- JARGON AVOIDED: Provide simpler alternatives and corrected versions.
- APPROPRIATE TONE: Infer from words + pauses/fillers; provide corrected wording.
- EMPATHY MARKERS: Quote or suggest missing empathetic lines.

**Grammar and Expression (Resources of Grammar and Expression)**
[4-5 sentences with SPECIFIC ERRORS must be in paragraph:]
- VARIETY OF GRAMMAR
- ACCURATE GRAMMAR: Quote errors and provide corrected versions
- USE OF COHESIVE DEVICES

**Clinical Communication Criteria**

**Relationship Building**
[5 detailed sentences with evidence must be in paragraph:]

**Understood and Incorporated Patient's Perspective**
[4 sentences with EXAMPLES must be in paragraph:]

**Provided Structure**
[3-4 sentences with EVIDENCE must be in paragraph:]

**Information Gathering**
[5-6 sentences with DETAILED EXAMPLES must be in paragraph:]

**Information Giving**
[4 sentences with EXAMPLES in paragraph:]

**Strengths**
[List 4-6 specific strengths with evidence + timestamps]

**Areas for Improvement**
[List 4-6 issues with PRESCRIPTIVE CORRECTIONS + timestamps]

**Overall Summary and Prescriptive Guidance**
[Comprehensive summary + action steps]

**GRADE AND SCORE**
[Provide detailed scoring with evidence-based justification:]

Linguistic Criteria (0-250):
- Intelligibility (pronunciation, stress, intonation): X/80
- Fluency: X/80
- Appropriateness: X/50
- Grammar/Expression: X/40

Clinical Communication (0-250):
- Relationship Building: X/65
- Understanding Perspective: X/60
- Providing Structure: X/60
- Information Gathering: X/35
- Information Giving: X/30

Total Score: X/500
OET Grade: [A|B|C+|C|D|E]

**Required Output Format**
----

1-Sumamry
Write 8–10 clear, learner-friendly lines that provide an overall evaluation of the candidate’s speaking performance.
Do not mention timestamps, individual word errors, or phonetic symbols.

-The summary must use the pauses and fillers as indirect evidence of fluency and tone.
- Dont use the timings , wpm, wer, speaking time directly as evidence.
- but use them to infer the fluency and pace of the candidate.
- use general transcription content to show the pronunciation of the candidate.if there are mispronounced words use them as indirect evidence of intelligibility.

The summary must follow this sequence and structure:
First, focus on Clinical Communication:
Effectiveness of clinical communication overall
Ability to build rapport and a professional relationship
Understanding and incorporation of the patient’s perspective
Clarity and appropriateness of information gathering
Effectiveness and organization of information giving

Then, move to Linguistic Performance:
Overall intelligibility and ease of understanding
General pronunciation, stress, and intonation patterns (descriptive, not technical)
Fluency characteristics (pace, hesitations, fillers, smoothness)
Appropriateness of language for a clinical setting
Overall grammar control and quality of expression
Finally, comment briefly on:
Candidate’s tone and attitude as inferred from delivery
Overall impact on the listener

🔒 Rules for Summary
❌ No timestamps
❌ No word-by-word corrections
❌ No phonetic notation
✅ Use supportive, professional examiner language
✅ Keep it cohesive, well-sequenced, and non-repetitive
✅ The summary should read as a holistic examiner judgement, not a checklist


2. Strengths
Write one well-developed paragraph (5–7 lines) describing the candidate’s key strengths in speaking performance.
This paragraph must be continuous prose (not a list) and should sound balanced, encouraging, and examiner-like.

The paragraph must follow this sequence and focus:
First, focus on Clinical Communication Strengths:
Ability to build rapport and a professional relationship with the patient
Sensitivity to and incorporation of the patient’s perspective
Effectiveness of relational communication and empathy
Clarity and organization in information gathering
Effectiveness and structure of information giving

Then, move to Linguistic Strengths:
Overall intelligibility and clarity of speech
Fluency and smoothness of delivery
Appropriateness of language for a clinical context
Control of grammar and quality of expression
The paragraph should describe patterns and positive behaviors, not isolated moments or specific errors.

🔒 Rules for Strengths

❌ No listing or bullet points
❌ No mention of errors or weaknesses
❌ No timestamps or task references
❌ No specific word-level examples
✅ One cohesive paragraph only
✅ Moderate length (not too short, not too long)
✅ Focus on strengths across both clinical communication and language

3. Areas for Improvement
Write one focused paragraph (5–7 lines) identifying the candidate’s key areas for improvement in a prescriptive but supportive way.
The tone should be coaching-oriented, constructive, and examiner-like.

-The summary must use the pauses and fillers as indirect evidence of fluency and tone.
- Dont use the timings , wpm, wer, speaking time directly as evidence.
- but use them to infer the fluency and pace of the candidate.
- use general transcription content to show the pronunciation of the candidate.if there are mispronounced words use them as indirect evidence of intelligibility.
-There should not be any contradiction between summary , strengths and areas of improvement.

The paragraph must follow this sequence and structure:
First, focus on Clinical Communication Development:
Improving relational building and rapport with the patient
Better understanding and incorporation of the patient’s perspective
Clearer and more consistent structure in information gathering
More organized and patient-centred information giving
Greater effectiveness in overall clinical communication

Then, move to Linguistic Development:
Improving overall intelligibility and clarity of pronunciation
Better fluency control, including management of hesitations and fillers
More consistent appropriateness of language and professional tone
Expanding grammar range and improving sentence control and accuracy
The paragraph should focus on recurring patterns and provide practical guidance on how to improve, not just what is weak.

🔒 Rules for Areas for Improvement
❌ No word-level corrections
❌ No timestamps or task references
❌ No harsh, judgmental, or penal language
❌ No isolated mistake descriptions
✅ One cohesive paragraph only
✅ Use supportive, coaching-style guidance
✅ Suggest improvement strategies, not only deficiencies


4. Grade and Score

-Grading should not be too strict or too generous; reflect realistic OET standards.
-For Grading and its related scoring follow this table: OET Grade: [A: 450-500 | B: 350-449 | C+: 300-349 | C: 200-299 | D: 100-199 | E: 0-99].
-Follow the above table strictly while providing the final score and grade.

Provide a final overall score and grade only, without detailed sub-criteria breakdown.
Format exactly as follows:
Overall Score: X / 500  
OET Grade: [A | B | C+ | C | D | E]


🔒 Rules for Grading
❌ No justification paragraphs
❌ No criterion-wise scoring
✅ Grade must reflect overall communicative effectiveness
✅ Use realistic OET grading standards

-----
🧠 EVALUATION STYLE GUIDELINES (IMPORTANT)
Write like a trained OET speaking assessor
Keep language clear, professional, and learner-appropriate
Avoid robotic or AI-sounding phrasing
Do not repeat ideas across sections
Maintain a human, balanced tone

**ASSESSMENT RULES:**
1. CITE TIMESTAMPS (mm:ss) for every example from transcript
2. QUOTE ACTUAL TEXT - never fabricate examples
3. PROVIDE CORRECTIONS for every error (pronunciation guides, grammar fixes, rephrased versions)
4. DO NOT reference emotion scores; infer tone from words + delivery cues (pauses/fillers)
5. ANALYZE SILENCE appropriately (listening vs. awkward delays)
6. BE SPECIFIC - no generic feedback
7. BALANCE criticism with encouragement - be constructive
8. JUSTIFY SCORES with evidence from analysis
9. CROSS-REFERENCE role play cards for requirements fulfillment
10. FOCUS on communication over clinical knowledge

**DATA SOURCES FOR YOUR ANALYSIS (use but don't display labels in output):**
ROLE PLAY CONTEXT:
${roleCardsText || 'N/A'}

FULL TIMESTAMPED TRANSCRIPT:
${transcriptText || 'N/A'}

COMPUTED METRICS:
- Speaking Time: ${Number(doctorSpeakingSeconds || 0).toFixed(2)}s
- WPM: ${Number(wpm || 0).toFixed(2)} (normal: 120-150)
- WER: ${(Number(wer || 0) * 100).toFixed(2)}%
- Verbal Fillers: ${Number(fillerCount || 0)}
- Repetitions: ${Number(repetitionCount || 0)}
- Fragments: ${Number(fragmentCount || 0)}
- Pre-Speech Pauses: count=${Number(sb.count || 0)}, total=${Number(sb.total || 0).toFixed(
                2
            )}s, longest=${Number(sb.longest || 0).toFixed(2)}s
- Consecutive Turn Pauses: count=${Number(cd.count || 0)}, total=${Number(cd.total || 0).toFixed(
                2
            )}s, longest=${Number(cd.longest || 0).toFixed(2)}s

SPEECH CUES OVERVIEW:
${emotionsSortedLine}

SILENCE PATTERNS:
Pre-Speech Pauses (top 10):
${
    (sb.gaps || [])
        .slice(0, 10)
        .map((g) => `- ${g.time_window} | ${Number(g.gap_seconds || 0).toFixed(2)}s | from=${g.from} to=${g.to}`)
        .join('\n') || 'N/A'
}

Consecutive Turn Pauses (top 10):
${
    (cd.gaps || [])
        .slice(0, 10)
        .map((g) => `- ${g.time_window} | ${Number(g.gap_seconds || 0).toFixed(2)}s`)
        .join('\n') || 'N/A'
}
`.trim();

        console.log('📝 Step 4: Generating intelligibility report...');

        const res = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: 'gpt-4o',
                temperature: 0,
                max_tokens: 6500,
                seed: 12345,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
        });

        if (!res.ok) throw new Error(await res.text());
        const j = await res.json();
        const choice = j?.choices?.[0];
        if (choice?.finish_reason === 'length') {
            throw new Error('Step 4 output was truncated (max_tokens too low). Increase max_tokens or reduce JSON size.');
        }
        const content = j?.choices?.[0]?.message?.content || '';
        return { content: content || '', choices: j?.choices[0], systemPrompt, userPrompt };
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
