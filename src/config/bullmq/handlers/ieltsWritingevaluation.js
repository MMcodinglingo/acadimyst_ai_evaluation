const writingEvaluation = require('../../../services/ieltsWritingEvaluation.service');
const winston = require('../../logger');
const { addJob } = require('../../bullmq/queue.manager');
async function ieltsWritingEvaluation(job) {
    const { studentWritingAnswer, student, testData, tasks } = job.data;
    let result = await writingEvaluation.handleIeltsWritingAiEvaluation({ studentWritingAnswer, student, testData, tasks });
    try {
        await addJob('updateIeltsWritingDB', result, {
            jobName: 'update-writing-evaluation',
            priority: 1,
        });

        // Log successful queueing
        winston.info('Ielts Writing evaluation queued successfully via BullMQ', {
            queue: 'ieltsWritingEvaluation',
        });
    } catch (queueError) {
        winston.error('There is error in adding Job:=>', queueError);
        // TODO will fall back this to api if error comes.
    }
}

module.exports = {
    ieltsWritingEvaluation,
};
