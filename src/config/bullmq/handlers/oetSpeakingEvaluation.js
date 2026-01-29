const speakingEvaluation = require('../../../services/oetSpeakingEvaluation.service');
const winston = require('../../logger');
const { addJob } = require('../../bullmq/queue.manager');
async function oetSpeakingEvaluation(job) {
    console.log(job.data);
    let { studentSpeakingAnswer, student, speakingAudios, speakingMainCard, speakingCard } = job.data;
    let result = await speakingEvaluation.handleOetSpeakingEvaluation({
        studentSpeakingAnswer,
        student,
        speakingAudios,
        speakingMainCard,
        speakingCard,
    });
    try {
        await addJob('updateOetSpeakingDB', result, {
            jobName: 'update-oet-speaking-evaluation',
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
    oetSpeakingEvaluation,
};
