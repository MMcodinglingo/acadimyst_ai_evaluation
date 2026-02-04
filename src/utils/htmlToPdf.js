let puppeteer = require('puppeteer');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');
const winston = require('../config/logger');
const { uploadToS3 } = require('../utils/awsS3');
const { patchScoreInHtml, todayString, processIeltsWritingFeedback } = require('../utils/globalHelper');
const config = require('../config/config');
async function generatePDF(html, writingAnswerId, fileName) {
    try {
        // 1. Define the output directory at root level
        const dirPath = path.resolve('accessorfeedbackpdf');

        // 2. Ensure the directory exists
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }

        // 3. Create the full PDF path
        const pdfPath = path.join(dirPath, `${fileName}`);

        // 4. Launch Puppeteer
        const browser = await puppeteer.launch({
            ...(process.env.NODE_ENV !== 'development' && { executablePath: '/usr/bin/chromium-browser' }),
            headless: 'new',
            args: ['--no-sandbox'],
        });

        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.emulateMediaType('print');

        // 5. Generate PDF
        winston.info(`Generating PDF: ${pdfPath}`);
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,

            // ✅ must be TRUE to show footer on every page
            displayHeaderFooter: false,

            // ✅ reserve space for footer
            margin: {
                top: '15mm',
                right: '12mm',
                bottom: '22mm',
                left: '12mm',
            },

            // ✅ RED footer on every page
            footerTemplate: `
    <div style="width:100%; padding:0 12mm;">
      <div style="
        background:#9d2235;
        color:#fff;
        font-size:10px;
        font-weight:700;
        text-align:center;
        padding:8px 0;
        border-radius:8px;
      ">
        MM Coding and M&amp;M Institute
        <span style="float:right; margin-right:8px; font-weight:600;">
          <span class="pageNumber"></span>/<span class="totalPages"></span>
        </span>
      </div>
    </div>
  `,
        });

        await browser.close();

        let s3_path_key = `accessorFeedback/${writingAnswerId}_${Date.now()}.pdf`;

        let contentType = '.pdf';
        let resp = await uploadToS3(s3_path_key, contentType, pdfPath);
        let s3Url = `${config.aws.s3.baseUrl}/${resp.Key}`;
        resp.s3Url = s3Url;
        if (fs.existsSync(pdfPath)) {
            fs.unlinkSync(pdfPath);
            winston.info(`Deleted local file: ${pdfPath}`);
        } else {
            winston.warn(`Local PDF not found for deletion: ${pdfPath}`);
        }

        winston.info(`PDF generated successfully at ${pdfPath}`);
        return resp;
    } catch (err) {
        console.log(err);
        winston.error('PDF generation failed:', err);
        throw err;
    }
}

async function generateIeltsWritingPdf(student, aiPayload, studentWritingAnswer, testData) {
    let browser = null;
    let pdfPath = null;

    const writingAnswerId = studentWritingAnswer?._id || studentWritingAnswer?.writingAnswerId || `tmp_${Date.now()}`;
    const studentId = student?._id || ' unknown student ';
    const fileName = `ielts_writing_feedback_${writingAnswerId}_${Date.now()}.pdf`;

    try {
        winston.info(`Starting IELTS PDF generation for student: ${studentId}, writing answer: ${writingAnswerId}`);

        // 1. Extract student name
        const studentName = student?.firstName || student?.username || 'Student';

        // 2. Generate current date string
        const generatedDate = todayString();

        // 3. Process IELTS feedback data
        winston.info('Processing IELTS writing feedback...');
        const processedData = processIeltsWritingFeedback(aiPayload);

        // 4. Prepare data for EJS template
        const templateData = {
            studentName,
            moduleName: testData?.courseName || 'IELTS Writing',
            generatedDate,
            reportTitle: processedData.reportTitle,
            resultTitle: processedData.resultTitle,
            bandBig: processedData.bandBig,
            bandLine: processedData.bandLine,
            sectionsHtml: processedData.sectionsHtml,
            rubricHtml: processedData.rubricHtml,
        };

        // 5. Render EJS template
        winston.info('Rendering IELTS EJS template...');
        const templatePath = path.resolve('public/templates/ielts-writing-report.ejs');

        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template not found: ${templatePath}`);
        }

        const html = await ejs.renderFile(templatePath, templateData);

        // 6. Create output directory
        const dirPath = path.resolve('writingSubmissionPdf');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            winston.info(`Created directory: ${dirPath}`);
        }

        // 7. Define PDF path
        pdfPath = path.join(dirPath, fileName);

        // 8. Launch Puppeteer
        winston.info('Launching Puppeteer...');
        browser = await puppeteer.launch({
            ...(process.env.NODE_ENV !== 'development' && { executablePath: '/usr/bin/chromium-browser' }),
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });

        const page = await browser.newPage();

        // 9. Set content and wait for rendering
        winston.info('Setting page content...');
        await page.setContent(html, {
            waitUntil: ['domcontentloaded', 'networkidle0'],
            timeout: 60000,
        });

        // Emulate screen media for better rendering
        await page.emulateMediaType('print');

        // Wait a bit for rendering
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 10. Generate PDF
        winston.info(`Generating PDF: ${pdfPath}`);
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '10px',
                right: '10px',
                bottom: '10px',
                left: '10px',
            },
            preferCSSPageSize: false,
        });

        await browser.close();
        browser = null;

        winston.info(`PDF generated successfully: ${pdfPath}`);

        // 11. Upload to S3
        winston.info('Uploading PDF to S3...');
        const s3PathKey = `pdf/ielts_writing_feedback_${studentWritingAnswer?._id || writingAnswerId}_${Date.now()}.pdf`;
        const contentType = 'application/pdf';

        const uploadResult = await uploadToS3(s3PathKey, contentType, pdfPath);

        winston.info(`PDF uploaded to S3: ${uploadResult.Key}`);

        // 12. Clean up local file
        if (fs.existsSync(pdfPath)) {
            fs.unlinkSync(pdfPath);
            winston.info(`Deleted local PDF: ${pdfPath}`);
        }

        // 13. Return S3 upload result
        return { ...uploadResult, html };
    } catch (error) {
        console.log(error);
        winston.error('IELTS PDF generation failed:', error);

        // Clean up browser if still open
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                winston.error('Error closing browser:', closeError);
            }
        }

        // Clean up local file if exists
        if (pdfPath && fs.existsSync(pdfPath)) {
            try {
                fs.unlinkSync(pdfPath);
                winston.info(`Cleaned up failed PDF: ${pdfPath}`);
            } catch (unlinkError) {
                winston.error('Error deleting failed PDF:', unlinkError);
            }
        }

        throw error;
    }
}
/**
 * Generate OET Writing PDF from AI evaluation feedback
 * @param {Object} student - Student object with firstName, username, email
 * @param {Number} writingMarks - Score out of 500
 * @param {String} writingGrade - Grade (A, B, C+, C, D, E)
 * @param {Object} writingFeedback - Full OpenAI response object with choices
 * @param {Object} studentWritingAnswer - StudentWritingAnswer document
 * @param {Object} testData - Test data with courseId, courseName
 * @param {Object} processedData - Processed data from oetWritingReportHelper (letterHtml, meta, assessmentCards)
 * @returns {Promise<Object>} - S3 upload result with Key and Location
 */

async function generateOETWritingPdf(
    student,
    writingMarks,
    writingGrade,
    writingFeedback,
    studentWritingAnswer,
    moduleName,
    processedData,
    feedBackHtml = null
) {
    let browser = null;
    let pdfPath = null;

    try {
        winston.info(`Starting PDF generation for student: ${student._id}, writing answer: ${studentWritingAnswer._id}`);

        // 1. Extract student name
        const studentName = student.firstName || student.username || 'Student';

        // 3. Convert images to base64
        winston.info('Converting images to base64...');

        // 4. Generate current date string
        const generatedDate = new Date().toLocaleDateString('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
        });

        // 5. Prepare booking URL (can be customized per institution)
        const bookingUrl = config.bookingUrl || 'https://mmcodinglingo.com/book-session';

        // 6. Prepare data for EJS template
        const templateData = {
            studentName,
            moduleName,
            writingFeedback:
                typeof writingFeedback === 'string' ? { choices: [{ message: { content: writingFeedback } }] } : writingFeedback,
            // Pass the pre-processed data
            letterHtml: processedData?.letterHtml || '',
            assessmentCards: processedData?.assessmentCards || [],
            meta: processedData?.meta || {},
            generatedDate,
            bookingUrl,
        };

        // 7. Render EJS template
        winston.info('Rendering EJS template...');
        const templatePath = path.resolve('public/templates/oet-writing-report.ejs');

        if (!fs.existsSync(templatePath)) {
            throw new Error(`Template not found: ${templatePath}`);
        }
        let html;
        if (feedBackHtml) {
            html = patchScoreInHtml(feedBackHtml, templateData.meta);
        } else {
            html = await ejs.renderFile(templatePath, templateData);
        }
        // 8. Create output directory
        const dirPath = path.resolve('writingSubmissionPdf');
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
            winston.info(`Created directory: ${dirPath}`);
        }

        // 9. Define PDF filename and path
        const fileName = `oet_writing_feedback_${studentWritingAnswer._id}_${Date.now()}.pdf`;
        pdfPath = path.join(dirPath, fileName);

        // 10. Launch Puppeteer
        winston.info('Launching Puppeteer...');
        browser = await puppeteer.launch({
            ...(process.env.NODE_ENV !== 'development' && { executablePath: '/usr/bin/chromium-browser' }),
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
        });

        const page = await browser.newPage();

        // 11. Set content and wait for rendering
        winston.info('Setting page content...');
        await page.setContent(html, {
            waitUntil: ['domcontentloaded', 'networkidle0'],
            timeout: 60000,
        });

        // Emulate screen media for better rendering
        await page.emulateMediaType('print');

        // Wait a bit for JavaScript to execute and render cards
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // 12. Generate PDF
        winston.info(`Generating PDF: ${pdfPath}`);
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            printBackground: true,
            margin: {
                top: '10px',
                right: '10px',
                bottom: '10px',
                left: '10px',
            },
            preferCSSPageSize: false,
        });

        await browser.close();
        browser = null;

        winston.info(`PDF generated successfully: ${pdfPath}`);

        // 13. Upload to S3
        winston.info('Uploading PDF to S3...');
        const s3PathKey = `pdf/oet_writing_feedback_${studentWritingAnswer._id}_${Date.now()}.pdf`;
        const contentType = 'application/pdf';

        const uploadResult = await uploadToS3(s3PathKey, contentType, pdfPath);

        winston.info(`PDF uploaded to S3: ${uploadResult.Key}`);

        // 14. Clean up local file
        if (fs.existsSync(pdfPath)) {
            fs.unlinkSync(pdfPath);
            winston.info(`Deleted local PDF: ${pdfPath}`);
        }

        // 15. Return S3 upload result
        return { ...uploadResult, html };
    } catch (error) {
        console.log(error);
        winston.error('PDF generation failed:', error);

        // Clean up browser if still open
        if (browser) {
            try {
                await browser.close();
            } catch (closeError) {
                winston.error('Error closing browser:', closeError);
            }
        }

        // Clean up local file if exists
        if (pdfPath && fs.existsSync(pdfPath)) {
            try {
                fs.unlinkSync(pdfPath);
                winston.info(`Cleaned up failed PDF: ${pdfPath}`);
            } catch (unlinkError) {
                winston.error('Error deleting failed PDF:', unlinkError);
            }
        }

        throw error;
    }
}
module.exports = {
    generatePDF,
    generateIeltsWritingPdf,
    generateOETWritingPdf,
};
