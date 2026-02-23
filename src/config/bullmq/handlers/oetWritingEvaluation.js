const writingEvaluation = require('../../../services/oetWritingvaluation.service');
const winston = require('../../logger');
const { addJob } = require('../../bullmq/queue.manager');
async function oetWritingEvaluation(job) {
    let { studentWritingAnswer, student, testData, writingText, course } = job.data;
    let result = await writingEvaluation.handleOetWritingEvaluation({
        studentWritingAnswer,
        student,
        testData,
        writingText,
        course,
    });
    try {
        await addJob('updateOetWritingDB', result, {
            jobName: 'update-oet-writing-evaluation',
            priority: 1,
        });

        // Log successful queueing
        winston.info('Oet Writing evaluation queued successfully via BullMQ', {
            queue: 'updateOetWritingDB',
        });
    } catch (queueError) {
        winston.error('There is error in adding Job:=>', queueError);
        // TODO will fall back this to api if error comes.
    }
}

module.exports = {
    oetWritingEvaluation,
};
