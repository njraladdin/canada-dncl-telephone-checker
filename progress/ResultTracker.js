const clc = require('cli-color');

class ResultTracker {
    constructor() {
        this.results = [];
        this.startTime = Date.now();
        this.maxResults = 500;
        this.firstProcessingTime = null;
    }

    addResult(result) {
        if (!this.firstProcessingTime) {
            this.firstProcessingTime = Date.now();
        }

        this.results.push({
            success: result.success,
            processed: result.status === 'ACTIVE' || result.status === 'INACTIVE',
            timestamp: Date.now()
        });
        
        if (this.results.length > this.maxResults) {
            this.results.shift();
        }
    }

    getStats() {
        if (this.results.length === 0) return null;

        const successfullyProcessed = this.results.filter(r => r.processed);
        const successCount = this.results.filter(r => r.success).length;
        const successRate = (successCount / this.results.length) * 100;
        
        let avgTimePerNumber = 0;
        if (successfullyProcessed.length > 0) {
            const totalElapsedSeconds = (Date.now() - this.startTime) / 1000;
            avgTimePerNumber = totalElapsedSeconds / successfullyProcessed.length;
        }

        return {
            successRate: successRate.toFixed(2),
            avgTimePerNumber: avgTimePerNumber.toFixed(2),
            totalProcessed: this.results.length,
            successfullyProcessed: successfullyProcessed.length
        };
    }

    async printStats(dbManager) {
        const stats = this.getStats();
        if (!stats) return;

        const remaining = await dbManager.db.get(`
            SELECT COUNT(*) as count 
            FROM numbers 
            WHERE (dncl_status IS NULL OR dncl_status = '')
            AND telephone IS NOT NULL
        `);

        const avgTimePerNumber = parseFloat(stats.avgTimePerNumber);
        const remainingCount = remaining.count;
        const estimatedTimeLeft = remainingCount * avgTimePerNumber;
        const hoursLeft = Math.floor(estimatedTimeLeft / 3600);
        const minutesLeft = Math.floor((estimatedTimeLeft % 3600) / 60);

        console.log(`[Stats] Success: ${clc.green(stats.successRate)}% | Avg Time (successful): ${clc.cyan(stats.avgTimePerNumber)}s | Total Processed: ${clc.yellow(stats.totalProcessed)} | Successfully Processed: ${clc.green(stats.successfullyProcessed)} | Remaining: ${clc.yellow(remaining.count)} | ETA: ${clc.magenta(`${hoursLeft}h ${minutesLeft}m`)}`);
    }
}

module.exports = ResultTracker; 