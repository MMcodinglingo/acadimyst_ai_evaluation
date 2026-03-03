const { Queue } = require('bullmq');
const { getClient } = require('../redis/redis.connection');
const winston = require('../logger');

const queueRegistry = {};

const defaultQueueOptions = {
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000,
        },
        removeOnComplete: {
            age: 3600,
        },
        removeOnFail: {
            age: 86400,
        },
    },
    settings: {
        retryProcessDelay: 5000,
        lockRenewTime: 30000,
    },
};

const queueConfigs = {
    updateIeltsWritingDB: {
        name: 'updateIeltsWritingDBQueue',
        description: 'When ielts is evaluated after that it will return the result to main service to update the data in db.',
        options: {
            ...defaultQueueOptions,
            defaultJobOptions: {
                ...defaultQueueOptions.defaultJobOptions,
                attempts: 3,
                timeout: 30000,
            },
        },
    },
    updateIeltsSpeakingDB: {
        name: 'updateIeltsSpeakingDBQueue',
        description: 'When ielts speaking is evaluated after that it will return the result to main service to update the data in db.',
        options: {
            ...defaultQueueOptions,
            defaultJobOptions: {
                ...defaultQueueOptions.defaultJobOptions,
                attempts: 3,
                timeout: 30000,
            },
        },
    },
    updateOetSpeakingDB: {
        name: 'updateOetSpeakingDBQueue',
        description: 'When oet speaking is evaluated after that it will return the result to main service to update the data in db.',
        options: {
            ...defaultQueueOptions,
            defaultJobOptions: {
                ...defaultQueueOptions.defaultJobOptions,
                attempts: 3,
                timeout: 30000,
            },
        },
    },
    updateOetWritingDB: {
        name: 'updateOetWritingDBQueue',
        description: 'When oet writing is evaluated after that it will return the result to main service to update the data in db.',
        options: {
            ...defaultQueueOptions,
            defaultJobOptions: {
                ...defaultQueueOptions.defaultJobOptions,
                attempts: 3,
                timeout: 30000,
            },
        },
    },
};

const createQueue = (queueKey, customOptions = {}) => {
    try {
        if (queueRegistry[queueKey]) {
            return queueRegistry[queueKey];
        }

        const redisClient = getClient();
        const config = queueConfigs[queueKey];
        const queueName = config ? config.name : queueKey;
        const queueOptions = config ? config.options : defaultQueueOptions;

        const mergedOptions = {
            ...queueOptions,
            ...customOptions,
        };

        const connection = redisClient.duplicate();

        const queue = new Queue(queueName, {
            connection,
            ...mergedOptions,
        });

        queueRegistry[queueKey] = queue;

        winston.info(`✅ Queue created/retrieved: ${queueName}`, {
            service: 'BullMQ',
            queue: queueName,
        });

        return queue;
    } catch (error) {
        winston.error(`❌ Failed to create queue: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const addJob = async (queueKey, jobData, jobOptions = {}) => {
    try {
        const queue = createQueue(queueKey);
        const jobName = jobOptions.jobName || `${queueKey}-job`;
        const job = await queue.add(jobName, jobData, {
            jobId: jobOptions.jobId || `${queueKey}-${Date.now()}-${Math.random()}`,
            ...jobOptions,
        });

        winston.debug(`Job added to queue: ${queueKey}`, {
            service: 'BullMQ',
            jobId: job.id,
            queue: queueKey,
        });

        return job;
    } catch (error) {
        winston.error(`❌ Failed to add job to queue: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const addDelayedJob = async (queueKey, jobData, delayMs, jobOptions = {}) => {
    try {
        const queue = createQueue(queueKey);
        const jobName = jobOptions.jobName || `${queueKey}-job`;

        const job = await queue.add(jobName, jobData, {
            jobId: jobOptions.jobId || `${queueKey}-${Date.now()}-${Math.random()}`,
            delay: delayMs,
            ...jobOptions,
        });

        winston.debug(`Delayed job added to queue: ${queueKey}`, {
            service: 'BullMQ',
            jobId: job.id,
            queue: queueKey,
            delay: delayMs,
        });

        return job;
    } catch (error) {
        winston.error(`❌ Failed to add delayed job: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const addRepeatingJob = async (queueKey, jobData, pattern, jobOptions = {}) => {
    try {
        const queue = createQueue(queueKey);
        const jobName = jobOptions.jobName || `${queueKey}-job`;

        const job = await queue.add(jobName, jobData, {
            repeat: {
                pattern: pattern,
            },
            ...jobOptions,
        });

        winston.info(`Repeating job added to queue: ${queueKey}`, {
            service: 'BullMQ',
            jobId: job.id,
            queue: queueKey,
            pattern: pattern,
        });

        return job;
    } catch (error) {
        winston.error(`❌ Failed to add repeating job: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const addBulkJobs = async (queueKey, jobsData, jobOptions = {}) => {
    try {
        const queue = createQueue(queueKey);

        const jobs = await queue.addBulk(
            jobsData.map((data) => ({
                name: queueKey,
                data: data,
                opts: {
                    jobId: jobOptions.jobId || `${queueKey}-${Date.now()}-${Math.random()}`,
                    ...jobOptions,
                },
            }))
        );

        winston.debug(`Bulk jobs added to queue: ${queueKey}`, {
            service: 'BullMQ',
            count: jobs.length,
            queue: queueKey,
        });

        return jobs;
    } catch (error) {
        winston.error(`❌ Failed to add bulk jobs: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        throw error;
    }
};

const getQueueStats = async (queueKey) => {
    try {
        const queue = createQueue(queueKey);
        const counts = await queue.getCountsPerState();
        const isPaused = await queue.isPaused();

        return {
            queue: queueKey,
            counts: counts,
            isPaused: isPaused,
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        winston.error(`❌ Failed to get queue stats: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        return { error: error.message };
    }
};

const getAllQueuesStats = async () => {
    try {
        const stats = {};
        for (const [key, queue] of Object.entries(queueRegistry)) {
            const counts = await queue.getCountsPerState();
            const isPaused = await queue.isPaused();

            stats[key] = {
                counts: counts,
                isPaused: isPaused,
            };
        }

        return {
            queues: stats,
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        winston.error('❌ Failed to get all queues stats', {
            service: 'BullMQ',
            error: error.message,
        });
        return { error: error.message };
    }
};

const pauseQueue = async (queueKey) => {
    try {
        const queue = createQueue(queueKey);
        await queue.pause();

        winston.warn(`⚠️ Queue paused: ${queueKey}`, {
            service: 'BullMQ',
            queue: queueKey,
        });
    } catch (error) {
        winston.error(`❌ Failed to pause queue: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
    }
};

const resumeQueue = async (queueKey) => {
    try {
        const queue = createQueue(queueKey);
        await queue.resume();

        winston.info(`✅ Queue resumed: ${queueKey}`, {
            service: 'BullMQ',
            queue: queueKey,
        });
    } catch (error) {
        winston.error(`❌ Failed to resume queue: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
    }
};

const cleanQueue = async (queueKey, graceMs = 3600000, limit = 1000, status = 'completed') => {
    try {
        const queue = createQueue(queueKey);
        const removed = await queue.clean(graceMs, limit, status);

        winston.info(`Queue cleaned: ${queueKey}`, {
            service: 'BullMQ',
            queue: queueKey,
            removed: removed.length,
            status: status,
        });

        return removed.length;
    } catch (error) {
        winston.error(`❌ Failed to clean queue: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
        return 0;
    }
};

const closeQueue = async (queueKey) => {
    try {
        const queue = queueRegistry[queueKey];
        if (queue) {
            await queue.close();
            delete queueRegistry[queueKey];

            winston.info(`✅ Queue closed: ${queueKey}`, {
                service: 'BullMQ',
                queue: queueKey,
            });
        }
    } catch (error) {
        winston.error(`❌ Failed to close queue: ${queueKey}`, {
            service: 'BullMQ',
            error: error.message,
        });
    }
};

const closeAllQueues = async () => {
    try {
        const queueKeys = Object.keys(queueRegistry);
        for (const key of queueKeys) {
            await closeQueue(key);
        }
        winston.info('✅ All queues closed', { service: 'BullMQ' });
    } catch (error) {
        winston.error('❌ Error closing all queues', {
            service: 'BullMQ',
            error: error.message,
        });
    }
};

const getQueueRegistry = () => {
    return Object.keys(queueRegistry);
};

const isKnownQueueKey = (queueKey) => {
    return !!queueConfigs[queueKey];
};

const getConfiguredQueues = () =>
    Object.entries(queueConfigs).map(([key, cfg]) => ({
        key,
        name: cfg.name,
        description: cfg.description,
    }));

module.exports = {
    createQueue,
    addJob,
    addDelayedJob,
    addRepeatingJob,
    addBulkJobs,
    getQueueStats,
    getAllQueuesStats,
    pauseQueue,
    resumeQueue,
    cleanQueue,
    closeQueue,
    closeAllQueues,
    getQueueRegistry,
    queueConfigs,
    isKnownQueueKey,
    getConfiguredQueues,
};
