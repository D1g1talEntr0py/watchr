import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LockResolver } from '../src/lock-resolver';

vi.useFakeTimers();

describe('LockResolver', () => {
  let resolver: LockResolver;

  beforeEach(() => {
    resolver = new LockResolver();
  });

  afterEach(() => {
    resolver.reset();
    vi.clearAllTimers();
  });

  it('calls a resolver after its timeout', () => {
    const fn = vi.fn();

    resolver.add(fn, 100);
    vi.advanceTimersByTime(150);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not call a resolver before timeout', () => {
    const fn = vi.fn();

    resolver.add(fn, 100);
    vi.advanceTimersByTime(99);

    expect(fn).not.toHaveBeenCalled();
  });

  it('does not call a removed resolver', () => {
    const fn = vi.fn();

    resolver.add(fn, 100);
    resolver.remove(fn);
    vi.advanceTimersByTime(200);

    expect(fn).not.toHaveBeenCalled();
  });

  it('resets pending resolvers', () => {
    const fn = vi.fn();

    resolver.add(fn, 100);
    resolver.reset();
    vi.advanceTimersByTime(200);

    expect(fn).not.toHaveBeenCalled();
  });

  it('evicts the oldest resolver when capacity is exceeded', () => {
    const cappedResolver = new LockResolver({ maxResolvers: 1 });
    const oldest = vi.fn();
    const newest = vi.fn();

    cappedResolver.add(oldest, 1_000);
    cappedResolver.add(newest, 1_000);
    vi.advanceTimersByTime(1_100);

    expect(oldest).not.toHaveBeenCalled();
    expect(newest).toHaveBeenCalledTimes(1);

    cappedResolver.reset();
  });

  it('calls onEvict callback and warns on eviction', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cappedResolver = new LockResolver({ maxResolvers: 1 });
    const onEvict = vi.fn();

    cappedResolver.add(() => undefined, 1_000, onEvict);
    cappedResolver.add(() => undefined, 1_000);

    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith('🚨 Lock resolver capacity exceeded. Evicting oldest pending resolver.');

    warnSpy.mockRestore();
    cappedResolver.reset();
  });
});