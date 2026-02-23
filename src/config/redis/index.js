const winston = require('../logger');

let redisInitialized = false;

let bullmqInitialized = false;

const initialize = async (config) => {
    try {
        const result = {
            redis: null,
            bullmq: null,
        };

        if (config?.redis?.isRedisAvailable) {
            try {
                winston.info('Initializing Redis...', { service: 'Redis' });
                const redisConnection = require('./redis.connection');
                await redisConnection.initializeRedis(config.redis);

                result.redis = {
                    status: 'connected',
                    service: redisConnection,
                };
                redisInitialized = true;
                winston.info('Redis initialized successfully', { service: 'Redis' });
            } catch (error) {
                winston.error('❌ Redis initialization failed', {
                    service: 'Redis',
                    error: error.message,
                });

                result.redis = {
                    status: 'failed',
                    error: error.message,
                };
            }
        } else {
            winston.info('⚠️ Redis disabled in configuration', { service: 'Redis' });

            result.redis = {
                status: 'disabled',
            };
        }

        if (redisInitialized && config?.bullmq?.enabled) {
            try {
                winston.info('Initializing BullMQ...', { service: 'BullMQ' });

                const workerFactory = require('../bullmq/worker.factory');
                // const bullBoard = require('../bullmq/bull.board.dashboard');

                const workerConfig = {};

                const workers = workerFactory.initializeAllWorkers(workerConfig);

                // const bullBoardConfig = {
                //     port: config.bullmq.port || 4001,
                //     basePath: config.bullmq.basePath || '/admin/queues',
                //     authToken: config.bullmq.authToken || 'bullboard123',
                //     readOnly: config.bullmq.readOnly || false,
                // };

                // const dashboardInfo = await bullBoard.initializeBullBoard(bullBoardConfig);

                result.bullmq = {
                    status: 'initialized',
                    workers: Object.keys(workers).length,
                    // dashboard: dashboardInfo.url,
                    services: {
                        workerFactory: workerFactory,
                        // bullBoard: bullBoard,
                    },
                };
                bullmqInitialized = true;
                winston.info('BullMQ initialized successfully', {
                    service: 'BullMQ',
                    workers: Object.keys(workers).length,
                });
            } catch (error) {
                console.log('BullMQ initialization failed', {
                    service: 'BullMQ',
                    error: error.message,
                });
                result.bullmq = {
                    status: 'failed',
                    error: error.message,
                };
            }
        } else if (!redisInitialized) {
            winston.info('BullMQ skipped (Redis not available)', { service: 'BullMQ' });

            result.bullmq = {
                status: 'skipped',
                reason: 'Redis not initialized',
            };
        } else {
            winston.info('BullMQ disabled in configuration', { service: 'BullMQ' });

            result.bullmq = {
                status: 'disabled',
            };
        }
        return result;
    } catch (error) {
        winston.error('Failed to initialize Redis/BullMQ', {
            service: 'Redis',
            error: error.message,
        });
        throw error;
    }
};

const shutdown = async () => {
    try {
        winston.info('Shutting down Redis/BullMQ...', { service: 'Redis' });
        if (bullmqInitialized) {
            const bullBoard = require('../bullmq/bull.board.dashboard');
            const workerFactory = require('../bullmq/worker.factory');
            await bullBoard.closeBullBoard();
            await workerFactory.closeAllWorkers();
            bullmqInitialized = false;
        }

        if (redisInitialized) {
            const redisConnection = require('./redis.connection');
            await redisConnection.disconnect();
            redisInitialized = false;
        }
        winston.info('Redis/BullMQ shutdown complete', { service: 'Redis' });
    } catch (error) {
        winston.error('Error during Redis/BullMQ shutdown', {
            service: 'Redis',
            error: error.message,
        });
    }
};

const getRedis = () => {
    if (!redisInitialized) {
        throw new Error('Redis not initialized');
    }
    return require('./redis.connection').getClient();
};

const getCache = () => {
    if (!redisInitialized) {
        throw new Error('Redis not initialized');
    }
    return require('./redis.cache');
};

const getQueueManager = () => {
    if (!bullmqInitialized) {
        throw new Error('BullMQ not initialized');
    }
    return require('../bullmq/queue.manager');
};

const getWorkerFactory = () => {
    if (!bullmqInitialized) {
        throw new Error('BullMQ not initialized');
    }
    return require('../bullmq/worker.factory');
};

const getStatus = () => {
    return {
        redisInitialized: redisInitialized,
        bullmqInitialized: bullmqInitialized,
    };
};

module.exports = {
    initialize,
    shutdown,
    getRedis,
    getCache,
    getQueueManager,
    getWorkerFactory,
    getStatus,
    redisConnection: () => require('./redis.connection'),
    cache: () => require('./redis.cache'),
    queueManager: () => require('../bullmq/queue.manager'),
    workerFactory: () => require('../bullmq/worker.factory'),
    bullBoard: () => require('../bullmq/bull.board.dashboard'),
};
