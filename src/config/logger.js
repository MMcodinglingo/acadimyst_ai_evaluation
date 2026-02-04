'use strict';

let winston = require('winston');

const options = (winston.LoggerOptions = {
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.errors({ stack: true }),
        winston.format.colorize(),
        winston.format.splat(),
        winston.format.printf(({ timestamp, level, label, message, stack, ...metadata }) => {
            const namespace = label ? `(${label})` : '';
            const errStack = stack ? `\n${stack}` : '';

            // Format metadata (objects) properly
            let metadataStr = '';
            if (Object.keys(metadata).length > 0) {
                metadataStr = '\n' + JSON.stringify(metadata, null, 2);
            }

            return `[${timestamp}] ${level}: ${namespace} ${message} ${metadataStr}${errStack}`;
        })
    ),
    transports: [
        //  new winston.transports.Console({ level: process.env.NODE_ENV === 'production' ? 'error' : 'debug' }),
        new winston.transports.Console({ level: process.env.NODE_ENV === 'production' ? 'debug' : 'debug' }),
        new winston.transports.File({ filename: 'logs/error.log', level: 'error' }),
        new winston.transports.File({ filename: 'logs/debug.log', level: 'debug' }),
    ],
});

const logger = winston.createLogger(options);

module.exports = logger;
