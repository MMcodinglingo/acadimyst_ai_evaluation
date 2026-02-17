const path = require('path');
const cheerio = require('cheerio');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { exec } = require('child_process');
const winston = require('../config/logger');
const config = require('../config/config');
let DEFAULT_MODE = 'OET Medicine';
/**
 * Extract all linguistic criteria sections
 */
function extractLinguisticCriteria(report) {
    return {
        intelligibility: extractSection(report, 'Intelligibility'),
        fluency: extractSection(report, 'Fluency'),
        appropriateness: extractSection(report, 'Appropriateness of Language'),
        grammarExpression:
            extractSection(report, 'Grammar and Expression \\(Resources of Grammar and Expression\\)') ||
            extractSection(report, 'Grammar and Expression'),
    };
}
/**
 * Extract all clinical communication criteria sections
 */
function extractClinicalCommunication(report) {
    return {
        relationshipBuilding: extractSection(report, 'Relationship Building'),
        understandingPerspective:
            extractSection(report, "Understood and Incorporated Patient's Perspective") ||
            extractSection(report, 'Understanding Perspective'),
        providingStructure: extractSection(report, 'Provided Structure'),
        informationGathering: extractSection(report, 'Information Gathering'),
        informationGiving: extractSection(report, 'Information Giving'),
    };
}
function getOetGrade(score) {
    if (score >= 450) return 'A';
    if (score >= 350) return 'B';
    if (score >= 300) return 'C+';
    if (score >= 200) return 'C';
    if (score >= 100) return 'D';
    return 'E';
}
/**
 * Extract score from a line using regex
 */
function extractScoreFromLine(text, regex) {
    const match = text.match(regex);
    return match ? parseInt(match[1]) : 0;
}
function extractDetailedScores(report) {
    const gradeSection = extractSection(report, 'GRADE AND SCORE');
    if (!gradeSection) return null;

    const scores = {
        linguistic: {
            intelligibility: extractScoreFromLine(gradeSection, /Intelligibility.*?:(\s*\d+)\/80/i),
            fluency: extractScoreFromLine(gradeSection, /Fluency.*?:(\s*\d+)\/80/i),
            appropriateness: extractScoreFromLine(gradeSection, /Appropriateness.*?:(\s*\d+)\/50/i),
            grammarExpression: extractScoreFromLine(gradeSection, /Grammar\/Expression.*?:(\s*\d+)\/40/i),
        },
        clinicalCommunication: {
            relationshipBuilding: extractScoreFromLine(gradeSection, /Relationship Building.*?:(\s*\d+)\/65/i),
            understandingPerspective: extractScoreFromLine(gradeSection, /Understanding Perspective.*?:(\s*\d+)\/60/i),
            providingStructure: extractScoreFromLine(gradeSection, /Providing Structure.*?:(\s*\d+)\/60/i),
            informationGathering: extractScoreFromLine(gradeSection, /Information Gathering.*?:(\s*\d+)\/35/i),
            informationGiving: extractScoreFromLine(gradeSection, /Information Giving.*?:(\s*\d+)\/30/i),
        },
    };

    return scores;
}

async function convertToMp3(inputPath) {
    const ext = path.extname(inputPath);
    const outputPath = ext ? inputPath.replace(ext, '.mp3') : `${inputPath}.mp3`;

    return new Promise((resolve, reject) => {
        const command = `"${ffmpegPath}" -y -i "${inputPath}" -acodec libmp3lame -b:a 128k -ac 1 "${outputPath}"`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                console.error('FFmpeg conversion error:', stderr);
                return reject(error);
            }

            resolve(outputPath);
        });
    });
}

const safeExtractJson = (text, label = 'JSON') => {
    if (!text) throw new Error(`${label}: Empty model output`);

    let cleaned = String(text)
        .replace(/```json/gi, '```')
        .replace(/```/g, '')
        .trim();

    cleaned = cleaned.replace(/[""]/g, '"').replace(/['']/g, "'");

    // ✅ FIXED: Complete implementation
    const extractBalancedObject = (s) => {
        const start = s.indexOf('{');
        if (start === -1) return null;

        let depth = 0;
        let inString = false;
        let escape = false;

        for (let i = start; i < s.length; i++) {
            const ch = s[i];

            if (inString) {
                if (escape) {
                    escape = false;
                } else if (ch === '\\') {
                    escape = true;
                } else if (ch === '"') {
                    inString = false;
                }
                continue;
            } else {
                if (ch === '"') {
                    inString = true;
                    continue;
                }
                if (ch === '{') depth++;
                if (ch === '}') {
                    depth--;
                    if (depth === 0) return s.slice(start, i + 1);
                }
            }
        }
        return null;
    };

    const repair = (s) => {
        return s.replace(/,\s*([}\]])/g, '$1').trim();
    };

    try {
        return JSON.parse(cleaned);
    } catch (e1) {
        console.error(`❌ ${label}: Raw model output ↓`);
        console.error(cleaned);

        const extracted = extractBalancedObject(cleaned);
        if (!extracted) {
            throw new Error(
                `${label}: No complete JSON object found (likely TRUNCATED output). Increase max_tokens or reduce output size.`
            );
        }

        try {
            return JSON.parse(extracted);
        } catch (e2) {
            const repaired = repair(extracted);
            try {
                return JSON.parse(repaired);
            } catch (e3) {
                throw new Error(`${label}: JSON still invalid after extraction/repair. Check console raw output.`);
            }
        }
    }
};

const fmtTime = (s) => {
    const sec = Math.max(0, Number(s || 0));
    const mm = String(Math.floor(sec / 60)).padStart(2, '0');
    const ss = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.floor((sec - Math.floor(sec)) * 1000)).padStart(3, '0');
    return `${mm}:${ss}.${ms}`;
};
const normalizeWords = (text) =>
    String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean);

const countFillers = (text) => {
    const t = String(text || '').toLowerCase();
    const singleWord = ['um', 'uh', 'erm', 'ah'];
    const phrases = ['you know', 'i mean', 'kind of', 'sort of'];

    let count = 0;
    for (const w of singleWord) {
        const re = new RegExp(`\\b${w}\\b`, 'g');
        count += (t.match(re) || []).length;
    }
    for (const p of phrases) {
        const re = new RegExp(p.replace(/\s+/g, '\\s+'), 'g');
        count += (t.match(re) || []).length;
    }
    return count;
};

const countImmediateRepetitions = (text) => {
    const w = normalizeWords(text);
    let reps = 0;
    for (let i = 1; i < w.length; i++) {
        if (w[i] === w[i - 1]) reps++;
    }
    return reps;
};

const countFragments = (doctorRefText, shortTurnThreshold = 5) => {
    const words = normalizeWords(doctorRefText);
    return words.filter((word) => word.length < shortTurnThreshold).length;
};

const computeDoctorSilencesFromTurns = (turns = [], doctorName = 'Dr. Unknown', threshold = 0.6) => {
    const ordered = (Array.isArray(turns) ? turns : [])
        .map((t) => ({
            start: Number(t.start ?? 0),
            end: Number(t.end ?? 0),
            speaker: String(t.speaker || 'Speaker'),
            text: String(t.text || '').trim(),
        }))
        .filter((t) => Number.isFinite(t.start) && Number.isFinite(t.end))
        .sort((a, b) => a.start - b.start);

    let beforeDoctor = { count: 0, total: 0, longest: 0, gaps: [] };
    let consecutiveDoctor = { count: 0, total: 0, longest: 0, gaps: [] };

    for (let i = 0; i < ordered.length - 1; i++) {
        const a = ordered[i];
        const b = ordered[i + 1];
        const gap = Number(b.start - a.end);

        if (!(gap > threshold)) continue;

        if (b.speaker === doctorName) {
            beforeDoctor.count += 1;
            beforeDoctor.total += gap;
            beforeDoctor.longest = Math.max(beforeDoctor.longest, gap);
            beforeDoctor.gaps.push({
                gap_seconds: gap,
                from: a.speaker,
                to: b.speaker,
                time_window: `${fmtMMSS(a.end)}–${fmtMMSS(b.start)}`,
            });
        }

        if (a.speaker === doctorName && b.speaker === doctorName) {
            consecutiveDoctor.count += 1;
            consecutiveDoctor.total += gap;
            consecutiveDoctor.longest = Math.max(consecutiveDoctor.longest, gap);
            consecutiveDoctor.gaps.push({
                gap_seconds: gap,
                time_window: `${fmtMMSS(a.end)}–${fmtMMSS(b.start)}`,
            });
        }
    }

    return {
        threshold,
        SilenceBeforeDoctorSpeaks: beforeDoctor,
        DoctorConsecutiveTurnSilence: consecutiveDoctor,
    };
};
const fmtMMSS = (sec) => {
    const s = Math.max(0, Number(sec || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return `${mm}:${ss}`;
};

/**
 * Extract total score from report
 */
function extractScoreFromReport(report) {
    const match = report.match(/Overall Score:\s*(\d+)\s*\/\s*\d+/i);
    return match ? parseInt(match[1]) : 0;
}

/**
 * Extract OET grade from report
 */
function extractGradeFromReport(report) {
    const match = report.match(/OET Grade:\s*([A-E]\+?)/i);
    return match ? match[1] : 'E';
}

/**
 * Extract a section by heading
 */
function extractSection(report, sectionName) {
    const regex = new RegExp(`\\*\\*${sectionName}\\*\\*\\s*\\n([\\s\\S]*?)(?=\\n\\*\\*|$)`, 'i');
    const match = report.match(regex);
    return match ? match[1].trim() : '';
}

/**
 * Extract list items from a section (items starting with -)
 */
function extractListSection(report, sectionName) {
    const section = extractSection(report, sectionName);
    if (!section) return [];

    return section
        .split(/\n-\s+/)
        .filter((item) => item.trim())
        .map((item) => item.trim());
}

/**
 * Extract overall summary and prescriptive guidance
 */
function extractOverallGuidance(report) {
    return extractSection(report, 'Overall Summary and Prescriptive Guidance');
}
const formatTranscriptFromFinalJson = (finalJson) => {
    const turns = finalJson?.turns || [];
    return turns
        .map((t) => {
            const sp = t.speaker || 'Speaker';
            const start = fmtTime(t.start);
            const end = fmtTime(t.end);
            const tx = (t.text || '').trim();
            return `[${start}–${end}] ${sp}: ${tx}`;
        })
        .join('\n');
};

/**
 * Helper to load the 'toFile' utility from OpenAI package.
 * Handles potential ESM/CommonJS import differences.
 */
async function loadToFile() {
    try {
        const mod = await import('openai/uploads');
        return mod.toFile;
    } catch {
        const mod = await import('openai/uploads.mjs');
        return mod.toFile;
    }
}

/**
 * Convert part number to label (A, B, C)
 */
function partLabelFromNumber(partNumber) {
    if (Number(partNumber) === 1) return 'A';
    if (Number(partNumber) === 2) return 'B';
    if (Number(partNumber) === 3) return 'C';
    return 'A';
}
/**
 * Generate task key from part and order
 */
function taskKey(partNumber, order) {
    return `${partLabelFromNumber(partNumber)}-${Number(order)}`;
}

/**
 * Create zero scores object
 */
function forceZeroScoresObj() {
    return {
        fluency_coherence: 0,
        lexical_resource: 0,
        grammatical_range_accuracy: 0,
        pronunciation: 0,
        overall_band: 0,
    };
}

/**
 * Safe JSON parsing with fallback extraction
 */
const safeJson = (raw) => {
    if (raw == null) return null;
    if (typeof raw === 'object') return raw;
    try {
        return JSON.parse(raw);
    } catch {
        const match = String(raw).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (match) {
            try {
                return JSON.parse(match[0]);
            } catch (err) {
                console.log(err);
            }
        }
        return null;
    }
};

/**
 * Clamp band score to valid range (0-9) and round to nearest 0.5
 */
function clampBand(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return 0;
    if (n < 0) return 0;
    if (n > 9) return 9;
    return roundToNearestHalf(n);
}

/**
 * Round band score to nearest 0.5
 */
const roundToNearestHalf = (x) => Math.round(x * 2) / 2;

/**
 * Compute overall scores from task relevance array
 */
function computeOverallFromTasks(taskRelevance) {
    const tasks = Array.isArray(taskRelevance) ? taskRelevance : [];
    if (!tasks.length) return forceZeroScoresObj();

    const sum = {
        fluency_coherence: 0,
        lexical_resource: 0,
        grammatical_range_accuracy: 0,
        pronunciation: 0,
    };

    let count = 0;

    for (const t of tasks) {
        const s = t?.scores || {};
        sum.fluency_coherence += Number.isFinite(Number(s.fluency_coherence)) ? Number(s.fluency_coherence) : 0;
        sum.lexical_resource += Number.isFinite(Number(s.lexical_resource)) ? Number(s.lexical_resource) : 0;
        sum.grammatical_range_accuracy += Number.isFinite(Number(s.grammatical_range_accuracy)) ? Number(s.grammatical_range_accuracy) : 0;
        sum.pronunciation += Number.isFinite(Number(s.pronunciation)) ? Number(s.pronunciation) : 0;

        count += 1;
    }

    const fcAvg = sum.fluency_coherence / count;
    const lrAvg = sum.lexical_resource / count;
    const graAvg = sum.grammatical_range_accuracy / count;
    const proAvg = sum.pronunciation / count;

    const overall = (fcAvg + lrAvg + graAvg + proAvg) / 4;

    return {
        fluency_coherence: clampBand(fcAvg),
        lexical_resource: clampBand(lrAvg),
        grammatical_range_accuracy: clampBand(graAvg),
        pronunciation: clampBand(proAvg),
        overall_band: clampBand(overall),
    };
}

/**
 * Truncate and clean string for display
 */
function oneLine(s, maxLen = 480) {
    const t = String(s ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    return t.length > maxLen ? t.slice(0, maxLen - 1) + '…' : t;
}

/**
 * Find QA pair by task key
 */
function findQaByTaskKey(list, key) {
    const k = String(key ?? '').trim();

    const exact = (list || []).find((x) => String(x?.task_key ?? '').trim() === k);
    if (exact) return exact;

    const qNum = k.match(/Q(\d+)/i)?.[1];
    if (qNum) {
        return (list || []).find((x) => String(x?.questionNumber ?? '').trim() === qNum) || null;
    }

    return null;
}
/**
 * Generate section label for questions
 */
function sectionLabel(partNumber, questionNumber) {
    const pn = Number(partNumber);

    if (pn === 1) return `Part 1 (Interview) – Question ${questionNumber ?? '?'}`;
    if (pn === 2) return 'Part 2 (Long Turn)';
    if (pn === 3) return `Part 3 (Discussion) – Question ${questionNumber ?? '?'}`;

    return `Part ${pn} – Question ${questionNumber ?? '?'}`;
}
/**
 * Build detailed mismatch description
 */
function buildMismatchDetail(mismatches, qaPairsForScoring) {
    return mismatches
        .map((t) => {
            const qa = findQaByTaskKey(qaPairsForScoring, t.task_key);

            const pn = qa?.partNumber ?? t?.partNumber ?? null;
            const qn = qa?.questionNumber ?? t?.questionNumber ?? null;

            const label = sectionLabel(pn, qn);

            const qAbout = oneLine(t?.question_is_about || qa?.questionText || '', 120) || 'unknown topic';
            const aAbout =
                oneLine(t?.answer_is_about || qa?.answerTranscript_clean || qa?.answerTranscript_verbatim || '', 120) || 'no clear answer';

            return `${label}: Question was about "${qAbout}", but the answer was about "${aAbout}".`;
        })
        .join(' ; ');
}
/**
 * Check if mismatch is already mentioned in text
 */
function hasMismatchAlready(text, mismatches = []) {
    const t = String(text ?? '').toLowerCase();

    if (t.includes('mismatch') || t.includes('mismatched') || t.includes('not related')) return true;

    for (const m of mismatches) {
        const key = String(m?.task_key ?? '').toLowerCase();
        if (key && t.includes(key)) return true;
    }

    return false;
}
/**
 * Helper: Extract overall_band from assessment report
 */
function getOverallBandFromReport(report) {
    const v = report?.overall_band;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Helper: Round score to nearest 0.5 band
 */
function roundToHalfBand(x) {
    const n = Number(x);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 2) / 2;
}

const formatCaseNotesForLLM = (caseNotes) => {
    // Guard: Return empty string if caseNotes is invalid
    if (!caseNotes || !Array.isArray(caseNotes) || caseNotes.length === 0) {
        winston.warn('formatCaseNotesForLLM: Invalid or empty caseNotes provided');
        return '';
    }

    let output = [];

    for (const section of caseNotes) {
        // Guard: Skip sections without a title
        if (!section || typeof section !== 'object') {
            continue;
        }

        const title = section.title || 'UNTITLED SECTION';
        output.push(`\n${title.toUpperCase()}:`);

        if (!section.subSections || !Array.isArray(section.subSections) || section.subSections.length === 0) {
            output.push('- No information provided');
            continue;
        }

        for (const sub of section.subSections) {
            if (typeof sub === 'string') {
                output.push(`- ${sub}`);
            } else if (sub && typeof sub === 'object') {
                const label = sub.title || sub.label || 'Detail';
                const value = sub.value || sub.content || JSON.stringify(sub);
                output.push(`- ${label}: ${value}`);
            }
        }
    }

    return output.join('\n');
};

function extractGradeAndScore(str) {
    const scoreRegex = /TOTAL:\s*(\d+)\/(\d+)/i;
    const gradeRegex = /GRADE:\s*([A-E]\+?)/i;

    const scoreMatch = str.match(scoreRegex);
    const gradeMatch = str.match(gradeRegex);

    const result = {
        score: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
        total: scoreMatch ? parseInt(scoreMatch[2], 10) : null,
        grade: gradeMatch ? gradeMatch[1] : null,
    };
    return result;
}

function patchScoreInHtml(html, meta) {
    const $ = cheerio.load(html);

    // Update grade
    $('#finalGrade').text(meta.grade);

    // Update total score
    $('#finalTotal').text(`TOTAL SCORE: ${meta.totalScore}/${meta.totalOutOf}`);

    // Optional: update result box color
    const $resultBox = $('#finalResultBox');
    $resultBox.removeClass('pass fail');
    if (meta.totalScore >= 300) {
        $resultBox.addClass('pass');
    }

    return $.html();
}
// -------------------- HELPERS --------------------
function escapeHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function extractLetterBlock(content) {
    let c = String(content || '');

    // Check if content contains an error message
    if (c.includes('[ERROR:') || c.includes('ERROR:')) {
        const errorMatch = c.match(/\[ERROR:[^\]]+\]/i) || c.match(/ERROR:[^\n]+/i);
        if (errorMatch) {
            //  Return pre-styled error HTML (server-side styling)
            return `<div style="color: #dc2626; font-weight: bold; padding: 16px; background-color: #fee2e2; border-radius: 8px; border: 2px solid #dc2626; margin: 10px 0;">
                ${escapeHtml(errorMatch[0])}
            </div>`;
        }
    }

    // Remove leading PART 1 heading (supports "—" or ":" variants)
    c = c.replace(/^\*\*PART\s*1[\s\S]*?\*\*\s*/i, '');

    // Cut at SUMMARY (new response has SUMMARY/STRENGTHS/AREAS/FINAL RESULT)
    const cutAtSummary = c.search(/\*\*SUMMARY\*\*/i);
    if (cutAtSummary !== -1) c = c.slice(0, cutAtSummary);

    // Stop at signature if present
    const endMatch = c.match(/Yours sincerely[\s\S]*?(Doctor)/i);
    if (endMatch) {
        const idx = c.toLowerCase().lastIndexOf('doctor');
        if (idx !== -1) c = c.slice(0, idx + 'doctor'.length);
    }

    const result = c.trim();

    // If no valid letter content found, return styled error message
    if (!result || result.length < 10) {
        return `<div style="color: #dc2626; font-weight: bold; padding: 16px; background-color: #fee2e2; border-radius: 8px; border: 2px solid #dc2626; margin: 10px 0;">
            [ERROR: No valid letter content found in AI response]
        </div>`;
    }

    return result;
}
// Token-based renderer (supports **, ~, *, (), [[ ]], [ ])
function renderMarkedText(raw) {
    const s = raw || '';
    let i = 0;
    let html = '';
    const startsWith = (t) => s.slice(i, i + t.length) === t;

    while (i < s.length) {
        // **bold**
        if (startsWith('**')) {
            const j = s.indexOf('**', i + 2);
            if (j !== -1) {
                html += `<span class="bold">${escapeHtml(s.slice(i + 2, j))}</span>`;
                i = j + 2;
                continue;
            }
        }

        // ~~irrelevant~~
        if (startsWith('~~')) {
            const j = s.indexOf('~~', i + 2);
            if (j !== -1) {
                html += `<span class="irrelevant-gray">${escapeHtml(s.slice(i + 2, j))}</span>`;
                i = j + 2;
                continue;
            }
        }

        // ~error~
        if (startsWith('~')) {
            const j = s.indexOf('~', i + 1);
            if (j !== -1) {
                html += `<span class="strike-red">${escapeHtml(s.slice(i + 1, j))}</span>`;
                i = j + 1;
                continue;
            }
        }

        // *correction*
        if (startsWith('*')) {
            const j = s.indexOf('*', i + 1);
            if (j !== -1) {
                html += `<span class="correction-green">${escapeHtml(s.slice(i + 1, j))}</span>`;
                i = j + 1;
                continue;
            }
        }

        // [[missing...]]
        if (startsWith('[[')) {
            const j = s.indexOf(']]', i + 2);
            if (j !== -1) {
                const inside = s.slice(i + 2, j);
                html += `<span class="missing-blue">[${escapeHtml(inside)}]</span>`;
                i = j + 2;
                continue;
            }
        }

        // [missing...]
        if (startsWith('[')) {
            const j = s.indexOf(']', i + 1);
            if (j !== -1) {
                const inside = s.slice(i + 1, j);
                html += `<span class="missing-blue">[${escapeHtml(inside)}]</span>`;
                i = j + 1;
                continue;
            }
        }

        // (assessor...)
        if (startsWith('(')) {
            const j = s.indexOf(')', i + 1);
            if (j !== -1) {
                html += `<span class="assessor-purple">(${escapeHtml(s.slice(i + 1, j))})</span>`;
                i = j + 1;
                continue;
            }
        }

        html += escapeHtml(s[i]);
        i++;
    }

    return html.replace(/\n/g, '<br/>');
}
function pickLastMatch(text, regex) {
    const all = [...text.matchAll(regex)];
    return all.length ? all[all.length - 1] : null;
}
function extractAssessmentMeta(content) {
    const totalMatch = pickLastMatch(content, /TOTAL:\s*([0-9]+(?:\.[0-9]+)?)\s*\/\s*([0-9]+)/gi);
    const totalScore = totalMatch ? Number(totalMatch[1]) : null;
    const totalOutOf = totalMatch ? Number(totalMatch[2]) : 500;

    const resultMatch = pickLastMatch(content, /RESULT:\s*(Pass|Fail)/gi);
    const result = resultMatch ? resultMatch[1] : null;

    const gradeMatch = pickLastMatch(content, /GRADE:\s*([A-E](?:\+)?)/gi);
    const grade = gradeMatch ? gradeMatch[1] : null;

    return { totalScore, totalOutOf, result, grade };
}
// ✅ Assessment is everything from SUMMARY onward
function getAssessmentOnly(content) {
    const c = String(content || '');
    const idx = c.search(/\*\*SUMMARY\*\*/i);
    if (idx !== -1) return c.slice(idx).trim();

    // Fallback: if SUMMARY missing, return anything after PART 1
    return c.replace(/^\*\*PART\s*1[\s\S]*?\*\*\s*/i, '').trim();
}

//  NEW FORMAT CARD BUILDER:
// Creates cards for **SUMMARY**, **STRENGTHS**, **AREAS FOR IMPROVEMENT**, **FINAL RESULT**
function buildAssessmentCards(assessmentText) {
    const text = String(assessmentText || '').trim();
    const cards = [];

    // Match bold headings in all caps (or any text), and capture until next bold heading or end
    const sectionRegex = /\*\*([^\*]+?)\*\*\s*\n+([\s\S]*?)(?=\n\*\*[^\*]+?\*\*|\s*$)/g;
    const matches = [...text.matchAll(sectionRegex)];

    if (matches.length) {
        for (const m of matches) {
            const titleRaw = (m[1] || '').trim();
            const body = (m[2] || '').trim();

            // Only keep meaningful sections (but allow others too)
            const title = titleRaw.replace(/\s+/g, ' ').trim();

            // Skip FINAL RESULT section completely (you don't want it in cards)
            if (/final\s*result/i.test(title)) continue;

            cards.push({
                title,
                body,
            });
        }
    }

    // If parsing fails, fallback
    if (!cards.length) {
        cards.push({ title: 'Assessment', body: text, fullWidth: true });
    }

    return cards
        .map((c) => ({
            title: (c.title || 'Assessment').trim(),
            body: (c.body || '').trim(),
            // RENDER MARKED TEXT HERE FOR THE SERVER SIDE
            htmlBody: renderMarkedText((c.body || '').trim()),
            fullWidth: c.fullWidth || false,
        }))
        .filter((c) => c.body.length > 0);
}

/**
 * Generate PDF URL from S3 upload result
 * @param {Object} uploadResult - Result from uploadToS3
 * @returns {String} - Full S3 URL
 */
function getPdfUrl(uploadResult) {
    return `${config.aws.s3.baseUrl}/${uploadResult.Key}`;
}
/**
 * Get today's date in en-GB format
 * @returns {String} - Formatted date string
 */
function todayString() {
    const d = new Date();
    return d.toLocaleDateString('en-GB', {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
    });
}
/**
 * Build a section HTML block
 * @param {String} title - Section title
 * @param {String} innerHtml - Section content HTML
 * @returns {String} - Section HTML block
 */
function section(title, innerHtml) {
    return `
        <div class="section">
            <div class="section-title">${escapeHtml(title)}</div>
            ${innerHtml}
        </div>
    `;
}
/**
 * Build a key-value table HTML
 * @param {Object} obj - Object with key-value pairs
 * @param {String} headerLeft - Left column header
 * @param {String} headerRight - Right column header
 * @returns {String} - Table HTML
 */
function toKVTable(obj, headerLeft = 'Key', headerRight = 'Value') {
    const o = obj && typeof obj === 'object' ? obj : {};
    const keys = Object.keys(o);
    if (!keys.length) return "<p class='muted'>—</p>";

    return `
        <table class="kv" cellspacing="0" cellpadding="0" border="0">
            <thead>
                <tr><th>${escapeHtml(headerLeft)}</th><th>${escapeHtml(headerRight)}</th></tr>
            </thead>
            <tbody>
                ${keys
                    .map((k) => {
                        const v = o[k];
                        const safeVal = v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                        return `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(safeVal)}</td></tr>`;
                    })
                    .join('')}
            </tbody>
        </table>
    `;
}

/**
 * Convert band value to number
 * @param {*} x - Band value
 * @returns {Number|null} - Band as number or null
 */
function bandToNumber(x) {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
}
/**
 * Convert markdown-style corrections to HTML
 * ~~wrong~~ => red strike; **correct** => green bold
 * @param {String} raw - Raw markdown text
 * @returns {String} - HTML with styled corrections
 */
function markdownFixesToHtml(raw) {
    const safe = escapeHtml(String(raw ?? ''));
    const withStrike = safe.replace(/~~(.+?)~~/g, (m, g1) => {
        return `<span style="color:#991b1b; text-decoration:line-through; font-weight:700;">${g1}</span>`;
    });
    const withBold = withStrike.replace(/\*\*(.+?)\*\*/g, (m, g1) => {
        return `<span style="color:#166534; font-weight:900;">${g1}</span>`;
    });
    return withBold.replace(/\n/g, '<br/>');
}

/* Helpers function for ielts writing */

function allowStrongDelOnly(s) {
    const escaped = escapeHtml(s);
    return escaped
        .replaceAll('&lt;strong&gt;', '<strong>')
        .replaceAll('&lt;/strong&gt;', '</strong>')
        .replaceAll('&lt;del&gt;', '<del>')
        .replaceAll('&lt;/del&gt;', '</del>');
}

function paragraphsToHtmlSafe(text) {
    const safe = allowStrongDelOnly(text);
    return safe
        .split(/\n\s*\n/g)
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => `<p class="fbp">${p}</p>`)
        .join('');
}

/**
 * Build task block sections for a single IELTS task
 * @param {String} label - Task label (e.g., "Task 1", "Task 2")
 * @param {Object} taskBlock - Task data object
 * @returns {Array} - Array of section HTML strings
 */
function buildTaskBlock(label, taskBlock) {
    const s = [];
    if (!taskBlock) return s;

    // 1) Overall band (ONLY)
    s.push(section(`${label}: Overall Band`, toKVTable({ 'Overall Band': taskBlock.overall_band ?? '—' }, 'Item', 'Value')));

    // 2) Originality justification
    // s.push(section(`${label}: Originality Justification`, `<p>${escapeHtml(taskBlock.originality_justification || '—')}</p>`));

    // 3) Inline corrections
    if (taskBlock.annotated_version) {
        s.push(
            section(
                `${label}: Inline Corrections`,
                `
                <div class='corr'>
                    <div class='hint'>
                        Legend:
                        <span style='color:#991b1b; text-decoration:line-through; font-weight:700;'>red strike</span>
                        = errors,
                        <span style='color:#166534; font-weight:900;'>green bold</span>
                        = correction.
                    </div>
                    <div>${markdownFixesToHtml(taskBlock.annotated_version)}</div>
                </div>
            `
            )
        );
    } else {
        s.push(section(`${label}: Inline Corrections`, "<p class='muted'>—</p>"));
    }

    // 7) Examiner Feedback
    s.push(
        section(`${label}: Examiner Feedback`, `<div class = "feedback">${paragraphsToHtmlSafe(taskBlock.examiner_feedback || '—')}</div>`)
    );

    return s;
}
/**
 * Build combined sections for Task 1 and Task 2
 * @param {Object} r - Result object with task1, task2, and final_summary
 * @returns {Array} - Array of section HTML strings
 */
function buildCombinedSections(r) {
    const s = [];
    const fs = (r && r.final_summary) || {};

    s.push(
        section(
            'Final Summary',
            `
                <table class="kv" cellspacing="0" cellpadding="0" border="0">
                    <thead><tr><th>Item</th><th>Value</th></tr></thead>
                    <tbody>
                        <tr><td>Task 1 Band</td><td>${escapeHtml(fs.task1_band ?? '—')}</td></tr>
                        <tr><td>Task 2 Band</td><td>${escapeHtml(fs.task2_band ?? '—')}</td></tr>
                        <tr><td>Overall Writing Band</td><td>${escapeHtml(fs.rounded_writing_band ?? '—')}</td></tr>
                    </tbody>
                </table>
            `
        )
    );

    if (r && r.task1) s.push(...buildTaskBlock('Task 1', r.task1));
    if (r && r.task2) s.push(...buildTaskBlock('Task 2', r.task2));

    return s;
}
/**
 * Render IELTS rubric band pills
 * @param {*} activeBand - The active band value
 * @returns {String} - HTML for rubric pills
 */
function renderRubricIELTS(activeBand) {
    const items = [9, 8, 7, 6, 5, 4];
    const ab = bandToNumber(activeBand);
    return items
        .map((b) => {
            const isActive = ab !== null && Math.abs(ab - b) < 0.26;
            return `<div class="rubric-pill ${isActive ? 'active' : ''}">Band ${b}</div>`;
        })
        .join('');
}
/**
 * Process IELTS writing feedback from AI response
 * @param {Object} payload - The full payload from OpenAI
 * @returns {Object} - Processed data for template rendering
 */
function processIeltsWritingFeedback(payload) {
    const mode = payload?.mode || 'combined';
    const r = payload?.result || {};

    let reportTitle = 'IELTS Writing Final Report';
    let resultTitle = 'FINAL WRITING RESULT';
    let bandBig = '—';
    let bandLine = '—';
    let sectionsHtml = '';

    if (mode === 'task1_only') {
        reportTitle = 'IELTS Writing Report (Task 1)';
        resultTitle = 'TASK 1 RESULT';
        const band = (r && r.overall_band) ?? '—';
        bandBig = band;
        bandLine = `Task 1 Band: ${band}`;
        sectionsHtml = buildTaskBlock('Task 1', r).join('');
    } else if (mode === 'task2_only') {
        reportTitle = 'IELTS Writing Report (Task 2)';
        resultTitle = 'TASK 2 RESULT';
        const band = (r && r.overall_band) ?? '—';
        bandBig = band;
        bandLine = `Task 2 Band: ${band}`;
        sectionsHtml = buildTaskBlock('Task 2', r).join('');
    } else {
        // combined
        reportTitle = 'IELTS Writing Final Report';
        resultTitle = 'FINAL WRITING RESULT';
        const fs = (r && r.final_summary) || {};
        const rounded = fs.rounded_writing_band ?? '—';
        bandBig = rounded;
        bandLine = `Final Band: ${rounded}`;
        sectionsHtml = buildCombinedSections(r).join('');
    }

    // Generate rubric pills
    const rubricHtml = renderRubricIELTS(bandBig);

    return {
        reportTitle,
        resultTitle,
        bandBig,
        bandLine,
        sectionsHtml,
        rubricHtml,
        mode,
        result: r,
    };
}

/**
 * Extract doctor name from text or use student name as fallback
 */
function extractDoctor(text, studentName) {
    const lines = String(text || '')
        .replace(/\r\n/g, '\n')
        .split('\n');

    const first = lines.find((l) => l.trim())?.trim() || '';
    if (!first) return studentName || 'Doctor';

    const looksLikeNameLine = /^(Dr\.|Doctor\.|Nurse\.|Pharmacist\.|Physiotherapist\.|Dentist\.)\s+/i.test(first);

    if (looksLikeNameLine) {
        // If the name contains "Unknown", replace it with the actual student name
        if (/unknown/i.test(first)) {
            return first.replace(/unknown/i, studentName || '');
        }
        return first;
    }

    return studentName || 'Doctor';
}
/**
 * Strip the leading name line from text
 */
function stripLeadingNameLine(text) {
    const lines = String(text || '')
        .replace(/\r\n/g, '\n')
        .split('\n');

    const idx = lines.findIndex((l) => l.trim());
    if (idx === -1) return text;

    const first = lines[idx].trim();

    const looksLikeNameLine = /^(Dr\.|Doctor\.|Nurse\.|Pharmacist\.|Physiotherapist\.|Dentist\.)\s+/i.test(first);

    if (!looksLikeNameLine) return text;

    lines.splice(idx, 1);

    while (lines[idx] !== undefined && lines[idx].trim() === '') {
        lines.splice(idx, 1);
    }

    return lines.join('\n');
}
/**
 * Extract score from text (e.g., "Score: 450/500")
 */
function extractScore500(text) {
    const m =
        String(text || '').match(/Score:\s*(\d{1,3})\s*\/\s*500/i) ||
        String(text || '').match(/Total:\s*(\d{1,3})\s*\/\s*500/i) ||
        String(text || '').match(/TOTAL\s*SCORE:\s*(\d{1,3})\s*\/\s*500/i);
    return m ? Number(m[1]) : null;
}
/**
 * Extract OET grade from text
 */
function extractGrade(text) {
    const m =
        String(text || '').match(/^\s*Grade:\s*([A-E](?:\+)?)\s*$/im) ||
        String(text || '').match(/^\s*OET\s*Grade:\s*([A-E](?:\+)?)\s*$/im);

    return m ? m[1].toUpperCase().replace(/\s+/g, '') : null;
}
/**
 * Split text into sections with titles and bodies
 */
function splitSections(text) {
    const lines = String(text || '')
        .replace(/\r\n/g, '\n')
        .split('\n');

    const sections = [];
    let current = null;
    let skipGradeBlock = false;

    const push = () => {
        if (!current) return;
        const body = current.lines.join('\n').trim();
        if (current.title && body) sections.push({ title: current.title, body });
    };

    for (const rawLine of lines) {
        const line = rawLine ?? '';
        const heading = isHeadingLine(line);

        // If we are skipping grade block, keep skipping until a NEW heading appears
        if (skipGradeBlock) {
            if (heading) {
                // if another heading starts, stop skipping and start new section
                if (heading.trim().toUpperCase() !== 'GRADE AND SCORE') {
                    skipGradeBlock = false;
                    if (current) push();
                    current = { title: heading, lines: [] };
                }
            }
            // otherwise ignore all lines inside grade block
            continue;
        }

        // ignore banner heading
        if (heading && heading.toUpperCase().includes('OET SPEAKING ASSESSMENT REPORT')) {
            if (current) push();
            current = null;
            continue;
        }

        // Start skipping the whole grade block
        if (heading && heading.trim().toUpperCase() === 'GRADE AND SCORE') {
            if (current) push();
            current = null;
            skipGradeBlock = true;
            continue;
        }

        // normal heading
        if (heading) {
            if (current) push();
            current = { title: heading, lines: [] };
            continue;
        }

        // skip metadata-ish lines (include your grade formats too)
        if (/^\s*Doctor:\s*/i.test(line)) continue;
        if (/^\s*Score:\s*\d+\s*\/\s*500/i.test(line)) continue;
        if (/^\s*TOTAL\s*SCORE:\s*\d+\s*\/\s*500/i.test(line)) continue;
        if (/^\s*Overall\s*Score:\s*\d+\s*\/\s*500/i.test(line)) continue;
        if (/^\s*Grade:\s*[A-E](?:\+)?\s*$/i.test(line)) continue;
        if (/^\s*OET\s*Grade:\s*[A-E](?:\+)?\s*$/i.test(line)) continue;

        // create default section only once when real content starts
        if (!current) {
            if (String(line).trim()) current = { title: 'Summary', lines: [] };
            else continue;
        }

        current.lines.push(line);
    }

    if (current) push();

    return sections.filter((s) => s.title.trim().toUpperCase() !== 'GRADE AND SCORE');
}
/**
 * Convert body text to HTML (paragraphs and lists)
 */
function bodyToHtml(bodyText) {
    const lines = String(bodyText || '').split('\n');

    const blocks = [];
    let para = [];
    let list = [];

    const flushPara = () => {
        const t = para.join('\n').trim();
        if (t) blocks.push({ type: 'p', text: t });
        para = [];
    };

    const flushList = () => {
        if (list.length) blocks.push({ type: 'ol', items: list.slice() });
        list = [];
    };

    for (const raw of lines) {
        const line = String(raw || '').trimEnd();
        const trimmed = line.trim();

        if (!trimmed) {
            flushList();
            flushPara();
            continue;
        }

        if (trimmed.startsWith('- ')) {
            flushPara();
            list.push(trimmed.replace(/^-\s+/, '').trim());
            continue;
        }

        flushList();
        para.push(line);
    }

    flushList();
    flushPara();

    return blocks
        .map((b) => {
            if (b.type === 'ol') {
                const items = b.items.map((it) => `<li>${formatInlineBold(escapeHtml(it))}</li>`).join('');
                return `<ol>${items}</ol>`;
            }
            const safe = formatInlineBold(escapeHtml(b.text));
            const withBreaks = safe.replace(/\n/g, '<br/>');
            return `<p>${withBreaks}</p>`;
        })
        .join('');
}
/**
 * Check if a line is a heading
 */
function isHeadingLine(line) {
    const s = String(line || '').trim();
    if (!s) return null;

    // Case 1: **HEADING**
    const m = s.match(/^\*\*(.+?)\*\*\s*$/);
    if (m && m[1]?.trim()) return m[1].trim();

    // Ignore metadata-ish lines
    const isMeta =
        /^Doctor:\s*/i.test(s) ||
        /^Score:\s*\d+\s*\/\s*500/i.test(s) ||
        /^Overall\s*Score:\s*\d+\s*\/\s*500/i.test(s) ||
        /^OET\s*Grade:\s*[A-E](?:\+)?\s*$/i.test(s) ||
        /^TOTAL\s*SCORE:/i.test(s);

    if (isMeta) return null;

    // Case 2: Numbered headings like:
    // "1-Summary", "1. Summary", "2) Strengths", "3: Areas for Improvement"
    const n = s.match(/^\s*(\d+)\s*[-.)\:]\s*(.+?)\s*$/);
    if (n && n[2]?.trim()) {
        const title = n[2].trim();
        // Only accept common section titles (prevents false positives)
        if (/^summary$/i.test(title)) return 'Summary';
        if (/^strengths?$/i.test(title)) return 'Strengths';
        if (/^areas?\s+for\s+improvement$/i.test(title)) return 'Areas for Improvement';
        if (/^grade\s+and\s+score$/i.test(title)) return 'Grade and Score';
        // If you want to allow any numbered heading, return title;
        // but safer to whitelist like above.
    }

    // Case 3: Plain heading
    const looksLikeHeading = s.length <= 40 && !/[.:]$/.test(s) && !s.includes(':') && /^[A-Za-z][A-Za-z &/]+$/.test(s);

    return looksLikeHeading ? s : null;
}
/**
 * Format inline bold markdown (**text**) to HTML <strong>
 */
function formatInlineBold(safeHtmlText) {
    return safeHtmlText.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
/**
 * Render rubric HTML
 */
function renderRubric(activeGrade) {
    const items = [
        { g: 'A', r: '450–500' },
        { g: 'B', r: '350–449' },
        { g: 'C+', r: '300–349' },
        { g: 'C', r: '200–299' },
        { g: 'D', r: '100–199' },
        { g: 'E', r: '0–99' },
    ];

    return items
        .map((x) => {
            const isActive =
                String(activeGrade || '')
                    .replace(/\s+/g, '')
                    .toUpperCase() === x.g.replace(/\s+/g, '').toUpperCase();

            return `<div class="rubric-pill ${isActive ? 'active' : ''}">
              ${escapeHtml(x.g)}: ${escapeHtml(x.r)}
            </div>`;
        })
        .join('');
}
function prepareCardData(evaluationObj, studentName, generatedDate) {
    const content = evaluationObj.fullReport || '';

    const doctorName = extractDoctor(content, studentName);
    const cleanContent = stripLeadingNameLine(content);

    const score = evaluationObj.totalScore || extractScore500(cleanContent);
    const grade = evaluationObj.oetGrade || extractGrade(cleanContent);
    const normalizedGrade = grade ? grade.replace(/\s+/g, '') : null;

    const sections = splitSections(cleanContent);
    const sectionsHtml =
        sections.length === 0
            ? '<div class="section"><p class="muted">No report sections found.</p></div>'
            : sections
                  .map(
                      (s) => `
                <div class="section">
                  <div class="section-title">${escapeHtml(s.title)}</div>
                  ${bodyToHtml(s.body)}
                </div>
              `
                  )
                  .join('');

    const rubricHtml = renderRubric(normalizedGrade || '');

    return {
        cardNumber: evaluationObj.cardNumber || 1,
        doctorName: doctorName,
        moduleName: DEFAULT_MODE,
        grade: normalizedGrade || '—',
        score: score ?? '—',
        totalScoreLine: `TOTAL SCORE: ${score ?? '—'}/500`,
        rubricHtml: rubricHtml,
        sectionsHtml: sectionsHtml,
        generatedDate: generatedDate,
        reportTitle: `${DEFAULT_MODE} Report`,
    };
}
module.exports = {
    extractLinguisticCriteria,
    extractClinicalCommunication,
    getOetGrade,
    extractDetailedScores,
    convertToMp3,
    safeExtractJson,
    countFillers,
    countImmediateRepetitions,
    countFragments,
    computeDoctorSilencesFromTurns,
    extractScoreFromReport,
    extractGradeFromReport,
    extractListSection,
    extractOverallGuidance,
    formatTranscriptFromFinalJson,
    loadToFile,
    taskKey,
    safeJson,
    computeOverallFromTasks,
    buildMismatchDetail,
    hasMismatchAlready,
    forceZeroScoresObj,
    partLabelFromNumber,
    clampBand,
    getOverallBandFromReport,
    roundToHalfBand,
    formatCaseNotesForLLM,
    extractGradeAndScore,
    patchScoreInHtml,
    extractLetterBlock,
    renderMarkedText,
    extractAssessmentMeta,
    getAssessmentOnly,
    buildAssessmentCards,
    getPdfUrl,
    todayString,
    processIeltsWritingFeedback,
    prepareCardData,
    normalizeWords,
    extractSection,
};
