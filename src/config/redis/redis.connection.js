const Redis = require('ioredis');
const winston = require('../logger');
let redisConnection = null;
let isConnecting = false;
let isReady = false;

const initializeRedis = async (redisConfig) => {
    if (isConnecting) {
        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                if (isReady && redisConnection) {
                    clearInterval(interval);
                    resolve(redisConnection);
                }
            }, 100);

            setTimeout(() => {
                clearInterval(interval);
                reject(new Error('Redis connection timeout'));
            }, 30000);
        });
    }

    if (isReady && redisConnection) {
        return redisConnection;
    }
    isConnecting = true;

    try {
        redisConnection = new Redis(redisConfig.url || redisConfig, {
            maxRetriesPerRequest: null,
            enableReadyCheck: false,
            enableOfflineQueue: true,
            connectTimeout: 10000,
            retryStrategy: (times) => {
                const delay = Math.min(times * 50, 2000);
                return delay;
            },
            reconnectOnError: (err) => {
                const targetError = 'READONLY';
                if (err.message.includes(targetError)) {
                    return true;
                }
                return false;
            },

            keepAlive: 30000,
            noDelay: true,
            family: 4,
            ...(redisConfig.sentinels && { sentinels: redisConfig.sentinels }),
            ...(redisConfig.name && { name: redisConfig.name }),
        });
        redisConnection.on('connect', () => {
            isReady = true;
            isConnecting = false;
            winston.info('Redis connection established', { service: 'Redis' });
        });

        redisConnection.on('ready', () => {
            winston.info('Redis client ready for commands', { service: 'Redis' });
        });

        redisConnection.on('reconnecting', () => {
            isReady = false;
            winston.warn('Redis attempting to reconnect...', { service: 'Redis' });
        });

        redisConnection.on('error', (err) => {
            isReady = false;
            winston.error('Redis connection error', {
                service: 'Redis',
                error: err.message,
                code: err.code,
            });
        });

        redisConnection.on('close', () => {
            isReady = false;
            winston.warn('Redis connection closed', { service: 'Redis' });
        });

        redisConnection.on('end', () => {
            isReady = false;
            winston.warn('Redis connection ended', { service: 'Redis' });
        });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                isConnecting = false;
                reject(new Error('Redis connection timeout after 15 seconds'));
            }, 15000);

            const checkReady = () => {
                if (isReady) {
                    clearTimeout(timeout);
                    resolve();
                } else {
                    setTimeout(checkReady, 100);
                }
            };

            checkReady();
        });

        return redisConnection;
    } catch (error) {
        isConnecting = false;
        isReady = false;
        winston.error('Failed to initialize Redis connection', {
            service: 'Redis',
            error: error.message,
        });

        throw error;
    }
};

const getClient = () => {
    if (!redisConnection) {
        throw new Error('Redis connection not initialized. Call initializeRedis() first.');
    }
    return redisConnection;
};

const isConnected = () => {
    return isReady && redisConnection && redisConnection.status === 'ready';
};

const ping = async () => {
    try {
        if (!redisConnection) {
            return false;
        }
        const result = await redisConnection.ping();
        return result === 'PONG';
    } catch (error) {
        winston.error('Redis ping failed', {
            service: 'Redis',
            error: error.message,
        });
        return false;
    }
};

const disconnect = async () => {
    if (redisConnection) {
        try {
            await redisConnection.quit();
            isReady = false;
            isConnecting = false;
            redisConnection = null;
            winston.info('Redis connection closed gracefully', { service: 'Redis' });
        } catch (error) {
            winston.error('Error closing Redis connection', {
                service: 'Redis',
                error: error.message,
            });
            await redisConnection.disconnect();
            redisConnection = null;
        }
    }
};

const getInfo = async () => {
    try {
        if (!redisConnection) {
            return {
                connected: false,
                status: 'disconnected',
                error: 'Redis not initialized',
            };
        }
        const info = await redisConnection.info();
        return {
            connected: isConnected(),
            status: redisConnection.status,
            info: info,
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        return {
            connected: false,
            status: redisConnection?.status || 'unknown',
            error: error.message,
            timestamp: new Date().toISOString(),
        };
    }
};

module.exports = {
    initializeRedis,
    getClient,
    isConnected,
    ping,
    disconnect,
    getInfo,
};
