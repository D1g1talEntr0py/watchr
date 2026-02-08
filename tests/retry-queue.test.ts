import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RetryQueue } from '../src/retry-queue';
import { fileDescriptorLimit } from '../src/constants';

describe('RetryQueue', () => {
  let retryQueue: RetryQueue;

  beforeEach(() => {
    retryQueue = new RetryQueue();
  });

  describe('schedule', () => {
    it('should resolve immediately if active queue is not under pressure', async () => {
      const promise = retryQueue.schedule();
      const resolveFn = await promise;

      expect(retryQueue['activeQueue'].size).toBe(1);
      resolveFn();
      expect(retryQueue['activeQueue'].size).toBe(0);
    });

    it('should add to pending queue if active queue is under pressure', async () => {
      const currentLimit = fileDescriptorLimit;
      for (let i = 0; i < currentLimit / 2; i++) {
        retryQueue['activeQueue'].add(vi.fn());
      }

      const promise = retryQueue.schedule();

      expect(retryQueue['pendingQueue'].size).toBe(1);
      await promise;
      expect(retryQueue['pendingQueue'].size).toBe(0);
    });
  });

  describe('add', () => {
    it('should add to pending queue and process immediately if active queue is not under pressure', () => {
      const resolver = vi.fn();
      retryQueue['add'](resolver);

      expect(retryQueue['pendingQueue'].size).toBe(0);
      expect(retryQueue['activeQueue'].size).toBe(1);
    });

    it('should set an interval if active queue is under pressure', () => {
      const currentLimit = fileDescriptorLimit;
      for (let i = 0; i < currentLimit / 2; i++) {
        retryQueue['activeQueue'].add(vi.fn());
      }

      const resolver = vi.fn();
      retryQueue['add'](resolver);

      expect(retryQueue['pendingQueue'].size).toBe(1);
      expect(retryQueue['intervalId']).toBeDefined();
    });

    it('should not set a new interval if one is already running', () => {
      const currentLimit = fileDescriptorLimit;
      for (let i = 0; i < currentLimit / 2; i++) {
        retryQueue['activeQueue'].add(vi.fn());
      }

      const resolver1 = vi.fn();
      retryQueue['add'](resolver1);
      const intervalId = retryQueue['intervalId'];
      expect(intervalId).toBeDefined();

      const resolver2 = vi.fn();
      retryQueue['add'](resolver2);

      expect(retryQueue['intervalId']).toBe(intervalId);
      expect(retryQueue['pendingQueue'].size).toBe(2);
    });
  });

  describe('processQueue', () => {
    it('should process items from pending queue to active queue', () => {
      const resolver = vi.fn();
      retryQueue['pendingQueue'].add(resolver);

      retryQueue['processQueue']();

      expect(retryQueue['pendingQueue'].size).toBe(0);
      expect(retryQueue['activeQueue'].size).toBe(1);
    });

    it('should stop processing if active queue is full', () => {
      const currentLimit = fileDescriptorLimit;
      for (let i = 0; i < currentLimit; i++) {
        retryQueue['activeQueue'].add(vi.fn());
      }

      const resolver = vi.fn();
      retryQueue['pendingQueue'].add(resolver);

      retryQueue['processQueue']();

      expect(retryQueue['pendingQueue'].size).toBe(1);
      expect(retryQueue['activeQueue'].size).toBe(currentLimit);
    });

    it('should stop processing mid-way if active queue becomes full', () => {
      const currentLimit = fileDescriptorLimit;
      // Set active queue to be almost full
      for (let i = 0; i < currentLimit - 1; i++) {
        retryQueue['activeQueue'].add(vi.fn());
      }

      // Add two items to pending queue. Only one should be processed.
      const resolver1 = vi.fn();
      const resolver2 = vi.fn();
      retryQueue['pendingQueue'].add(resolver1);
      retryQueue['pendingQueue'].add(resolver2);

      retryQueue['processQueue']();

      // One item should have been moved from pending to active
      expect(retryQueue['activeQueue'].size).toBe(currentLimit);
      expect(retryQueue['pendingQueue'].size).toBe(1);

      // Check that only the first resolver was called
      expect(resolver1).toHaveBeenCalledTimes(1);
      expect(resolver2).not.toHaveBeenCalled();
    });

    it('should reset the interval if pending queue is empty', () => {
      retryQueue['processQueue']();

      expect(retryQueue['intervalId']).toBeUndefined();
    });
  });

  describe('reset', () => {
    it('should clear the interval if it exists', () => {
      retryQueue['intervalId'] = setInterval(() => {}, RetryQueue['interval']);
      retryQueue['reset']();

      expect(retryQueue['intervalId']).toBeUndefined();
    });

    it('should do nothing if interval does not exist', () => {
      retryQueue['reset']();

      expect(retryQueue['intervalId']).toBeUndefined();
    });
  });
});