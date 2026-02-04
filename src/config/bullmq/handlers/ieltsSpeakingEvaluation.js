const speakingEvaluation = require('../../../services/ieltsSpeakingEvaluation.service');
const winston = require('../../logger');
const { addJob } = require('../../bullmq/queue.manager');
async function ieltsSpeakingEvaluation(job) {
    let { studentSpeakingAnswer, speakingParts, speakingAudios, student } = job.data;
    let result = await speakingEvaluation.handleIeltsSpeakingEvaluation({
        studentSpeakingAnswer,
        speakingParts,
        speakingAudios,
        student,
    });
    try {
        await addJob('updateIeltsSpeakingDB', result, {
            jobName: 'update-writing-evaluation',
            priority: 1,
        });

        // Log successful queueing
        winston.info('Ielts Speaking evaluation queued successfully via BullMQ', {
            queue: 'ieltsSpeakingEvaluationQueue',
        });
    } catch (queueError) {
        winston.error('There is error in adding Job:=>', queueError);
        // TODO will fall back this to api if error comes.
    }
}

module.exports = {
    ieltsSpeakingEvaluation,
};
