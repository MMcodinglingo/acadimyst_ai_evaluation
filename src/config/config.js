require('dotenv').config();

module.exports = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    aws: {
        s3: {
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            region: process.env.S3_REGION,
            bucket: process.env.S3_BUCKET,
            baseUrl: process.env.S3_BASE_URL,
        },
    },
    redis: {
        isRedisAvailable: true,
        url: 'redis://localhost:6379/',
        host: 'localhost',
        port: 6379,
        db: 0,
        password: null,
        enableOfflineQueue: true,
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
    },
    bullmq: {
        enabled: true,
        port: 4001,
        basePath: '/admin/queues',
        authToken: 'staging_bullboard_token_change_in_production',
        readOnly: false,
    },
};
