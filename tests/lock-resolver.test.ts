import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LockResolver } from '../src/lock-resolver';

vi.useFakeTimers();

describe('LockResolver', () => {
  beforeEach(() => {
    LockResolver['resolvers'].clear();
    LockResolver['intervalId'] = undefined;
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

	describe('constructor', () => {
		it('should throw an error if instantiated', () => {
			// @ts-expect-error Testing for error
			expect(() => new LockResolver()).toThrowError('This class cannot be instantiated');
		});
	});

  describe('add', () => {
    it('should add a function to the resolvers map and call init', () => {
      const fn = vi.fn();
      const timeout = 1000;

      LockResolver.add(fn, timeout);

      expect(LockResolver['resolvers'].has(fn)).toBe(true);
      expect(LockResolver['intervalId']).toBeDefined();
    });
  });

  describe('remove', () => {
    it('should remove a function from the resolvers map', () => {
      const fn = vi.fn();
      const timeout = 1000;

      LockResolver.add(fn, timeout);
      LockResolver.remove(fn);

      expect(LockResolver['resolvers'].has(fn)).toBe(false);
    });
  });

  describe('init', () => {
    it('should set an interval if not already set', () => {
      LockResolver['init']();

      expect(LockResolver['intervalId']).toBeDefined();
    });

    it('should not set an interval if already set', () => {
      LockResolver['intervalId'] = setInterval(() => {}, 100);

      LockResolver['init']();

      expect(vi.getTimerCount()).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear the interval if set', () => {
      LockResolver['intervalId'] = setInterval(() => {}, 100);

      LockResolver['reset']();

      expect(LockResolver['intervalId']).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should do nothing if interval is not set', () => {
      LockResolver['reset']();

      expect(LockResolver['intervalId']).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('should call functions whose timeout has been reached and remove them from the resolvers map', () => {
      const fn = vi.fn();
      const timeout = 1000;

      LockResolver.add(fn, timeout);

      vi.advanceTimersByTime(timeout + 100);

      expect(fn).toHaveBeenCalled();
      expect(LockResolver['resolvers'].has(fn)).toBe(false);
    });

    it('should not call functions whose timeout has not been reached', () => {
      const fn = vi.fn();
      const timeout = 1000;

      LockResolver.add(fn, timeout);

      vi.advanceTimersByTime(timeout - 1);

      expect(fn).not.toHaveBeenCalled();
      expect(LockResolver['resolvers'].has(fn)).toBe(true);
    });

    it('should reset if no functions are left in the resolvers map', () => {
      const fn = vi.fn();
      const timeout = 1000;

      LockResolver.add(fn, timeout);

      vi.advanceTimersByTime(timeout);

      expect(LockResolver['intervalId']).toBeUndefined();
    });
  });
});