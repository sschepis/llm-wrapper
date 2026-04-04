import { describe, it, expect, vi } from 'vitest';
import { RouterEventEmitter } from '../../src/router/events.js';

describe('RouterEventEmitter', () => {
  it('should register and fire handlers', () => {
    const emitter = new RouterEventEmitter();
    const handler = vi.fn();

    emitter.on('circuit:close', handler);
    emitter.emit('circuit:close', { endpoint: { name: 'ep' } as any });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].endpoint.name).toBe('ep');
  });

  it('should support multiple handlers for same event', () => {
    const emitter = new RouterEventEmitter();
    const h1 = vi.fn();
    const h2 = vi.fn();

    emitter.on('circuit:close', h1);
    emitter.on('circuit:close', h2);
    emitter.emit('circuit:close', { endpoint: { name: 'ep' } as any });

    expect(h1).toHaveBeenCalledTimes(1);
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('should remove handler with off()', () => {
    const emitter = new RouterEventEmitter();
    const handler = vi.fn();

    emitter.on('circuit:close', handler);
    emitter.off('circuit:close', handler);
    emitter.emit('circuit:close', { endpoint: { name: 'ep' } as any });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should not throw when handler errors', () => {
    const emitter = new RouterEventEmitter();
    const badHandler = vi.fn(() => { throw new Error('boom'); });
    const goodHandler = vi.fn();

    emitter.on('circuit:close', badHandler);
    emitter.on('circuit:close', goodHandler);

    expect(() => {
      emitter.emit('circuit:close', { endpoint: { name: 'ep' } as any });
    }).not.toThrow();

    expect(goodHandler).toHaveBeenCalled();
  });

  it('should remove all listeners', () => {
    const emitter = new RouterEventEmitter();
    const handler = vi.fn();

    emitter.on('circuit:close', handler);
    emitter.on('circuit:open', handler);
    emitter.removeAllListeners();
    emitter.emit('circuit:close', { endpoint: { name: 'ep' } as any });
    emitter.emit('circuit:open', { endpoint: { name: 'ep' } as any, health: {} as any });

    expect(handler).not.toHaveBeenCalled();
  });

  it('should support chaining', () => {
    const emitter = new RouterEventEmitter();
    const result = emitter.on('circuit:close', () => {}).off('circuit:close', () => {});
    expect(result).toBe(emitter);
  });
});
