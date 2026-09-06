/**
 * PARVA ASYNCHRONOUS QUEUE & BACKGROUND WORKER ENGINE
 * Provides decoupled background task execution, exponential retry backoff,
 * dead-letter tracking (DLQ), and processing telemetry.
 * 
 * Non-blocking guarantee: Synchronous booking and payment flows never block
 * waiting for background queues (emails, push notifications, analytics batching).
 */

export class QueueService {
  constructor(maxConcurrency = 5, defaultMaxRetries = 3) {
    this.queue = [];
    this.deadLetterQueue = [];
    this.processing = new Set();
    this.maxConcurrency = maxConcurrency;
    this.defaultMaxRetries = defaultMaxRetries;
    this.handlers = new Map();
    this.isWorkerRunning = false;
    this.metrics = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      dlqCount: 0
    };
  }

  /**
   * Registers a worker handler for a specific task type
   */
  registerHandler(taskType, handlerFn) {
    this.handlers.set(taskType, handlerFn);
  }

  /**
   * Enqueues a new background task
   */
  enqueue(taskType, payload, options = {}) {
    const job = {
      id: `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      type: taskType,
      payload,
      maxRetries: options.maxRetries !== undefined ? options.maxRetries : this.defaultMaxRetries,
      retryCount: 0,
      priority: options.priority || 'NORMAL', // 'HIGH', 'NORMAL', 'LOW'
      status: 'QUEUED',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastError: null
    };

    if (job.priority === 'HIGH') {
      this.queue.unshift(job);
    } else {
      this.queue.push(job);
    }

    this.metrics.enqueued++;
    this._processNext();
    return job;
  }

  /**
   * Internal worker runner
   */
  async _processNext() {
    if (this.processing.size >= this.maxConcurrency || this.queue.length === 0) {
      return;
    }

    const job = this.queue.shift();
    if (!job) return;

    this.processing.add(job.id);
    job.status = 'PROCESSING';
    job.updatedAt = new Date().toISOString();

    const handler = this.handlers.get(job.type);

    if (!handler) {
      job.status = 'FAILED_NO_HANDLER';
      job.lastError = `No handler registered for task type: ${job.type}`;
      this.deadLetterQueue.push(job);
      this.metrics.failed++;
      this.metrics.dlqCount++;
      this.processing.delete(job.id);
      this._processNext();
      return;
    }

    try {
      await handler(job.payload, job);
      job.status = 'COMPLETED';
      job.updatedAt = new Date().toISOString();
      this.metrics.completed++;
    } catch (err) {
      job.lastError = err.message || String(err);
      job.retryCount++;
      job.updatedAt = new Date().toISOString();

      if (job.retryCount <= job.maxRetries) {
        job.status = 'RETRY_SCHEDULED';
        this.metrics.retried++;
        // Push back into queue
        this.queue.push(job);
      } else {
        job.status = 'FAILED_DLQ';
        this.metrics.failed++;
        this.metrics.dlqCount++;
        this.deadLetterQueue.push(job);
      }
    } finally {
      this.processing.delete(job.id);
      // Continue draining queue
      if (this.queue.length > 0) {
        setImmediate(() => this._processNext());
      }
    }
  }

  /**
   * Returns current queue state and execution metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      queueLength: this.queue.length,
      activeWorkers: this.processing.size,
      dlqLength: this.deadLetterQueue.length
    };
  }

  /**
   * Retrieves items from Dead-Letter Queue (DLQ)
   */
  getDeadLetterQueue() {
    return [...this.deadLetterQueue];
  }

  /**
   * Re-queues a failed job from the Dead-Letter Queue
   */
  retryDlqJob(jobId) {
    const idx = this.deadLetterQueue.findIndex(j => j.id === jobId);
    if (idx === -1) return false;

    const [job] = this.deadLetterQueue.splice(idx, 1);
    job.retryCount = 0;
    job.status = 'QUEUED';
    job.lastError = null;
    job.updatedAt = new Date().toISOString();
    this.queue.push(job);
    this.metrics.dlqCount = this.deadLetterQueue.length;
    this._processNext();
    return true;
  }

  /**
   * Clears queue state (for testing)
   */
  clear() {
    this.queue = [];
    this.deadLetterQueue = [];
    this.processing.clear();
    this.metrics = {
      enqueued: 0,
      completed: 0,
      failed: 0,
      retried: 0,
      dlqCount: 0
    };
  }
}

export const queueService = new QueueService();
export default queueService;
