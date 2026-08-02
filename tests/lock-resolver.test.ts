import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LockResolver } from '../src/lock-resolver';

vi.useFakeTimers();

describe('LockResolver', () => {
  let resolver: LockResolver;

  beforeEach(() => {
    resolver = new LockResolver();
  });

  afterEach(() => {
    vi.clearAllTimers();
  });

  describe('add', () => {
    it('should add a function to the resolvers map and call init', () => {
      const fn = vi.fn();
      const timeout = 1000;

      resolver.add(fn, timeout);

      expect(resolver['resolvers'].has(fn)).toBe(true);
      expect(resolver['intervalId']).toBeDefined();
    });

    it('should evict the oldest resolver when max capacity is reached', () => {
      const originalMaxResolvers = (resolver as any).maxResolvers;
      (resolver as any).maxResolvers = 1;

      const fn1 = vi.fn();
      const fn2 = vi.fn();

      resolver.add(fn1, 1000);
      resolver.add(fn2, 1000);

      expect(resolver['resolvers'].size).toBe(1);
      expect(resolver['resolvers'].has(fn1)).toBe(false);
      expect(resolver['resolvers'].has(fn2)).toBe(true);

      (resolver as any).maxResolvers = originalMaxResolvers;
    });

    it('should call the evicted resolver callback when capacity is exceeded', () => {
      const originalMaxResolvers = (resolver as any).maxResolvers;
      (resolver as any).maxResolvers = 1;

      const fn1 = vi.fn();
      const fn2 = vi.fn();
      const onEvict = vi.fn();

      resolver.add(fn1, 1000, onEvict);
      resolver.add(fn2, 1000);

      expect(onEvict).toHaveBeenCalledTimes(1);
      expect(resolver['resolvers'].has(fn1)).toBe(false);
      expect(resolver['resolvers'].has(fn2)).toBe(true);

      (resolver as any).maxResolvers = originalMaxResolvers;
    });

    it('should warn when a resolver is evicted due to capacity', () => {
      const originalMaxResolvers = (resolver as any).maxResolvers;
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      (resolver as any).maxResolvers = 1;

      const fn1 = vi.fn();
      const fn2 = vi.fn();

      resolver.add(fn1, 1000);
      resolver.add(fn2, 1000);

      expect(warnSpy).toHaveBeenCalledWith('🚨 Lock resolver capacity exceeded. Evicting oldest pending resolver.');

      (resolver as any).maxResolvers = originalMaxResolvers;
      warnSpy.mockRestore();
    });
  });

  describe('remove', () => {
    it('should remove a function from the resolvers map', () => {
      const fn = vi.fn();
      const timeout = 1000;

      resolver.add(fn, timeout);
      resolver.remove(fn);

      expect(resolver['resolvers'].has(fn)).toBe(false);
    });
  });

  describe('init', () => {
    it('should set an interval if not already set', () => {
      resolver['init']();

      expect(resolver['intervalId']).toBeDefined();
    });

    it('should not set an interval if already set', () => {
      resolver['intervalId'] = setInterval(() => {}, 100);

      resolver['init']();

      expect(vi.getTimerCount()).toBe(1);
    });
  });

  describe('reset', () => {
    it('should clear the interval if set', () => {
      resolver['intervalId'] = setInterval(() => {}, 100);

      resolver['reset']();

      expect(resolver['intervalId']).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('should do nothing if interval is not set', () => {
      resolver['reset']();

      expect(resolver['intervalId']).toBeUndefined();
    });
  });

  describe('resolve', () => {
    it('should call functions whose timeout has been reached and remove them from the resolvers map', () => {
      const fn = vi.fn();
      const timeout = 1000;

      resolver.add(fn, timeout);

      vi.advanceTimersByTime(timeout + 100);

      expect(fn).toHaveBeenCalled();
      expect(resolver['resolvers'].has(fn)).toBe(false);
    });

    it('should not call functions whose timeout has not been reached', () => {
      const fn = vi.fn();
      const timeout = 1000;

      resolver.add(fn, timeout);

      vi.advanceTimersByTime(timeout - 1);

      expect(fn).not.toHaveBeenCalled();
      expect(resolver['resolvers'].has(fn)).toBe(true);
    });

    it('should reset if no functions are left in the resolvers map', () => {
      const fn = vi.fn();
      const timeout = 1000;

      resolver.add(fn, timeout);

      vi.advanceTimersByTime(timeout);

      expect(resolver['intervalId']).toBeUndefined();
    });
  });
});