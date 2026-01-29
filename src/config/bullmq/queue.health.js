const { getQueueStats } = require('./queue.manager');
const winston = require('../logger');

const HEALTH_THRESHOLDS = {
    authEmail: {
        maxWaiting: 50,
        maxFailed: 10,
        maxDelayed: 20,
        criticalWaiting: 100,
    },
    emailNotification: {
        maxWaiting: 200,
        maxFailed: 50,
        maxDelayed: 100,
        criticalWaiting: 500,
    },
};

const checkQueueHealth = async (queueKey) => {
    try {
        const stats = await getQueueStats(queueKey);
        const thresholds = HEALTH_THRESHOLDS[queueKey];

        if (!thresholds) {
            return {
                queue: queueKey,
                status: 'unknown',
                message: 'No health thresholds defined for this queue',
                stats: stats.counts,
            };
        }

        const { waiting = 0, failed = 0, delayed = 0 } = stats.counts || {};

        let status = 'healthy';
        let issues = [];
        let severity = 'info';

        if (waiting >= thresholds.criticalWaiting) {
            status = 'critical';
            severity = 'error';
            issues.push(`Critical: ${waiting} jobs waiting (threshold: ${thresholds.criticalWaiting})`);
        } else if (waiting >= thresholds.maxWaiting) {
            status = 'warning';
            severity = 'warn';
            issues.push(`Warning: ${waiting} jobs waiting (threshold: ${thresholds.maxWaiting})`);
        }

        if (failed >= thresholds.maxFailed) {
            status = status === 'critical' ? 'critical' : 'warning';
            severity = 'warn';
            issues.push(`${failed} failed jobs (threshold: ${thresholds.maxFailed})`);
        }

        if (delayed >= thresholds.maxDelayed) {
            if (status === 'healthy') status = 'warning';
            issues.push(`${delayed} delayed jobs (threshold: ${thresholds.maxDelayed})`);
        }

        if (stats.isPaused) {
            status = 'critical';
            severity = 'error';
            issues.push('Queue is paused!');
        }

        const healthData = {
            queue: queueKey,
            status,
            severity,
            message: issues.length > 0 ? issues.join('; ') : 'Queue is operating normally',
            stats: {
                waiting,
                failed,
                delayed,
                active: stats.counts?.active || 0,
                completed: stats.counts?.completed || 0,
            },

            isPaused: stats.isPaused,
            timestamp: stats.timestamp,
        };

        if (status === 'critical') {
            winston.error(`Queue health critical: ${queueKey}`, healthData);
        } else if (status === 'warning') {
            winston.warn(`Queue health warning: ${queueKey}`, healthData);
        }

        return healthData;
    } catch (error) {
        winston.error(`Failed to check queue health: ${queueKey}`, {
            error: error.message,
        });

        return {
            queue: queueKey,
            status: 'error',
            severity: 'error',
            message: `Health check failed: ${error.message}`,
            error: error.message,
        };
    }
};

const checkAllCriticalQueues = async () => {
    try {
        const queueKeys = Object.keys(HEALTH_THRESHOLDS);
        const healthChecks = await Promise.all(queueKeys.map((key) => checkQueueHealth(key)));

        const overallStatus = healthChecks.reduce((acc, check) => {
            if (check.status === 'critical') return 'critical';
            if (check.status === 'warning' && acc !== 'critical') return 'warning';
            if (check.status === 'error' && acc === 'healthy') return 'error';
            return acc;
        }, 'healthy'); // Start with 'healthy' as the initial value

        return {
            overallStatus,
            queues: healthChecks,
            timestamp: new Date().toISOString(),
        };
    } catch (error) {
        winston.error('Failed to check all critical queues', {
            error: error.message,
        });

        return {
            overallStatus: 'error',
            error: error.message,
            timestamp: new Date().toISOString(),
        };
    }
};

const getAuthEmailMetrics = async () => {
    try {
        const health = await checkQueueHealth('authEmail');
        const stats = await getQueueStats('authEmail');

        return {
            health: health.status,
            metrics: {
                ...stats.counts,
                isPaused: stats.isPaused,
                processingRate: stats.counts?.completed || 0,
            },
            thresholds: HEALTH_THRESHOLDS.authEmail,
            timestamp: stats.timestamp,
        };
    } catch (error) {
        winston.error('Failed to get auth email metrics', {
            error: error.message,
        });

        return {
            error: error.message,
        };
    }
};

const startHealthMonitoring = (intervalMs = 60000) => {
    winston.info('Starting queue health monitoring', {
        service: 'BullMQ',
        interval: `${intervalMs / 1000}s`,
    });

    const intervalId = setInterval(async () => {
        const health = await checkAllCriticalQueues();

        if (health.overallStatus === 'critical') {
            winston.error('CRITICAL: Queue health check failed', health);
        } else if (health.overallStatus === 'warning') {
            winston.warn('WARNING: Queue health issues detected', health);
        } else {
            winston.debug('Queue health check passed', health);
        }
    }, intervalMs);

    return intervalId;
};

const stopHealthMonitoring = (intervalId) => {
    clearInterval(intervalId);

    winston.info('Stopped queue health monitoring', {
        service: 'BullMQ',
    });
};

module.exports = {
    checkQueueHealth,
    checkAllCriticalQueues,
    getAuthEmailMetrics,
    startHealthMonitoring,
    stopHealthMonitoring,
    HEALTH_THRESHOLDS,
};
