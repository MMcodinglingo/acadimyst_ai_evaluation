const winston = require('../config/logger');

/**
 * Retry an async function on transient failures (429 rate limit, 5xx server errors).
 * Uses exponential backoff between retries.
 *
 * @param {Function} fn - Async function to execute
 * @param {Object} options
 * @param {number} options.maxAttempts - Maximum number of attempts (default: 3)
 * @param {number} options.backoffMs - Base backoff in milliseconds (default: 1000)
 * @param {string} options.label - Label for logging (default: 'retry')
 * @returns {Promise<*>} - Result of the function
 */
async function withRetry(fn, { maxAttempts = 3, backoffMs = 1000, label = 'retry' } = {}) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            const isTransient = err.status === 429 || (err.status >= 500 && err.status < 600);
            const isLast = attempt === maxAttempts;

            if (!isTransient || isLast) {
                winston.error(`[${label}] Failed after ${attempt} attempt(s):`, {
                    message: err.message,
                    status: err.status,
                    code: err.code,
                });
                throw err;
            }

            const delay = backoffMs * Math.pow(2, attempt - 1);
            winston.warn(`[${label}] Attempt ${attempt} failed (status: ${err.status}), retrying in ${delay}ms...`);
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}

module.exports = { withRetry };
