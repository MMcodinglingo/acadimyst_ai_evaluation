const path = require('path');
const cheerio = require('cheerio');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const { exec } = require('child_process');
const winston = require('../config/logger');
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
    const outputPath = inputPath.replace(path.extname(inputPath), '.mp3');

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
            // ✅ Return pre-styled error HTML (server-side styling)
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

// ✅ NEW FORMAT CARD BUILDER:
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
};
