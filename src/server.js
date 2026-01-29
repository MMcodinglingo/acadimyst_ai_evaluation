const dotenv = require('dotenv');
dotenv.config();
const app = require('./app');
const logger = require('./config/logger');
const connectDB = require('./config/db');
const winston = require('./config/logger');

const port = process.env.PORT || 3000;

let server;

connectDB().then(() => {
    server = app.listen(port, () => {
        logger.info(`Listening to port ${port}`);
    });
});

const redisManager = require('./config/redis/index');
const config = require('./config/config');
redisManager
    .initialize(config)
    .then((initResult) => {
        winston.info('Redis/BullMQ Initialization Complete', {
            service: 'Redis',
            redis: initResult.redis?.status,
            bullmq: initResult.bullmq?.status,
        });

        // Graceful shutdown handler (using 'once' to prevent duplicate handlers on hot reload)
        process.once('SIGTERM', async () => {
            winston.info('SIGTERM received, shutting down gracefully...', { service: 'Redis' });
            await redisManager.shutdown();
            process.exit(0);
        });

        process.once('SIGINT', async () => {
            winston.info('SIGINT received, shutting down gracefully...', { service: 'Redis' });
            await redisManager.shutdown();
            process.exit(0);
        });
    })
    .catch((error) => {
        winston.error('Failed to initialize Redis/BullMQ', {
            service: 'Redis',
            error: error.message,
        });
        // Don't exit, allow app to run without Redis
    });
const exitHandler = () => {
    if (server) {
        server.close(() => {
            logger.info('Server closed');
            process.exit(1);
        });
    } else {
        process.exit(1);
    }
};

const unexpectedErrorHandler = (error) => {
    logger.error(error);
    exitHandler();
};

process.on('uncaughtException', unexpectedErrorHandler);
process.on('unhandledRejection', unexpectedErrorHandler);

process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    if (server) {
        server.close();
    }
});
