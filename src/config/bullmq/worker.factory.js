const { Worker } = require('bullmq');
const { getClient } = require('../redis/redis.connection');
const { ieltsWritingEvaluation } = require('./handlers/ieltsWritingevaluation');
const { ieltsSpeakingEvaluation } = require('../bullmq/handlers/ieltsSpeakingEvaluation');
const { oetSpeakingEvaluation } = require('../bullmq/handlers/oetSpeakingEvaluation');
const winston = require('../logger');

const workerRegistry = {};
let workerConfig = {
    ieltsWritingEvaluation: {
        enabled: true,
        concurrency: 10,
    },
    ieltsSpeakingEvaluation: {
        enabled: true,
        concurrency: 10,
    },
    oetSpeakingEvaluation: {
        enabled: true,
        concurrency: 10,
    },
    oetWritingEvaluation: {
        enabled: true,
        concurrency: 10,
    },
};

const defaultWorkerOptions = {
    concurrency: 5,

    removeOnComplete: {
        age: 3600,
        count: 500,
    },
    removeOnFail: {
        age: 86400,
    },

    stalledInterval: 30000,

    maxStalledCount: 3,

    lockDuration: 30000,

    lockRenewTime: 15000,

    limiter: null,
    metrics: {
        maxDataPoints: 10000,
    },
};

const createWorker = (queueName, processor, options = {}) => {
    try {
        if (workerRegistry[queueName]) {
            winston.warn(`Worker already exists for queue: ${queueName}`, {
                service: 'BullMQ',
                queue: queueName,
            });
            return workerRegistry[queueName];
        }

        const redisClient = getClient();

        const mergedOptions = {
            ...defaultWorkerOptions,
            ...options,
        };

        const connection = redisClient.duplicate();

        const worker = new Worker(queueName, processor, {
            connection,
            ...mergedOptions,
        });

        worker.on('active', (job) => {
            winston.debug(`Job processing started: ${job.id}`, {
                service: 'BullMQ',
                queue: queueName,
                jobId: job.id,
            });
        });

        worker.on('completed', (job, result) => {
            winston.info(`✅ Job completed: ${job.id}`, {
                service: 'BullMQ',
                queue: queueName,
                jobId: job.id,
                duration: job.finishedOn - job.processedOn,
            });
        });

        worker.on('failed', (job, err) => {
            winston.error(`❌ Job failed: ${job.id}`, {
                service: 'BullMQ',
                queue: queueName,
                jobId: job.id,
                error: err.message,
                attempt: job.attemptsMade,
            });
        });

        worker.on('error', (err) => {
            winston.error(`❌ Worker error for queue: ${queueName}`, {
                service: 'BullMQ',
                queue: queueName,
                error: err.message,
            });
        });

        worker.on('stalled', (jobId) => {
            winston.warn(`⚠️ Job stalled: ${jobId}`, {
                service: 'BullMQ',
                queue: queueName,
                jobId: jobId,
            });
        });

        workerRegistry[queueName] = worker;

        winston.info(`Worker created for queue: ${queueName}`, {
            service: 'BullMQ',
            queue: queueName,
            concurrency: mergedOptions.concurrency,
        });

        return worker;
    } catch (error) {
        winston.error(`Failed to create worker for queue: ${queueName}`, {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const initializeAllWorkers = () => {
    const workers = {};
    try {
        if (workerConfig.ieltsWritingEvaluation) {
            workers.ieltsWritingEvaluation = createWorker('ieltsWritingEvaluationQueue', ieltsWritingEvaluation, {
                concurrency: workerConfig?.ieltsWritingEvaluation.concurrency || 15,
            });
        }
        if (workerConfig.ieltsSpeakingEvaluation) {
            workers.ieltsWritingEvaluation = createWorker('ieltsSpeakingEvaluationQueue', ieltsSpeakingEvaluation, {
                concurrency: workerConfig?.ieltsWritingEvaluation.concurrency || 15,
            });
        }
        if (workerConfig.oetSpeakingEvaluation) {
            workers.ieltsWritingEvaluation = createWorker('oetSpeakingEvaluationQueue', oetSpeakingEvaluation, {
                concurrency: workerConfig?.oetSpeakingEvaluation.concurrency || 15,
            });
        }
        if (workerConfig.oetWritingEvaluation) {
            workers.ieltsWritingEvaluation = createWorker('oetWritingEvaluationQueue', oetSpeakingEvaluation, {
                concurrency: workerConfig?.oetWritingEvaluation.concurrency || 15,
            });
        }

        winston.info('All workers initialized', {
            service: 'BullMQ',
            workersCount: Object.keys(workers).length,
        });

        return workers;
    } catch (error) {
        winston.error('Failed to initialize workers', {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const closeWorker = async (queueName) => {
    try {
        const worker = workerRegistry[queueName];

        if (worker) {
            await worker.close();

            delete workerRegistry[queueName];

            winston.info(`✅ Worker closed: ${queueName}`, {
                service: 'BullMQ',
                queue: queueName,
            });
        }
    } catch (error) {
        winston.error(`❌ Failed to close worker: ${queueName}`, {
            service: 'BullMQ',
            error: error.message,
        });
    }
};

const closeAllWorkers = async () => {
    try {
        const queueNames = Object.keys(workerRegistry);

        for (const queueName of queueNames) {
            await closeWorker(queueName);
        }

        winston.info('✅ All workers closed', { service: 'BullMQ' });
    } catch (error) {
        winston.error('❌ Error closing all workers', {
            service: 'BullMQ',
            error: error.message,
        });
    }
};

const getWorkerRegistry = () => {
    return Object.keys(workerRegistry);
};

const getWorkerStatus = async (queueName) => {
    try {
        const worker = workerRegistry[queueName];

        if (!worker) {
            return { error: `Worker not found: ${queueName}` };
        }

        return {
            queue: queueName,
            isRunning: !worker.isPaused(),
            isClosing: worker.isClosing,
        };
    } catch (error) {
        winston.error(`Failed to get worker status: ${queueName}`, {
            service: 'BullMQ',
            error: error.message,
        });
        return { error: error.message };
    }
};

module.exports = {
    createWorker,
    initializeAllWorkers,
    closeWorker,
    closeAllWorkers,
    getWorkerRegistry,
    getWorkerStatus,
};
