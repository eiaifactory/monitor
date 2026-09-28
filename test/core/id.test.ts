import { afterEach, describe, expect, it, vi } from 'vitest';
import { nuevoId } from '../../src/core/id';

// La regex que valida finance (`validar.ts`): un id que no la cumple es un evento rechazado.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('nuevoId', () => {
  it('con randomUUID', () => {
    expect(nuevoId()).toMatch(UUID);
  });

  it('sin randomUUID (http en la red del local): getRandomValues, formato v4', () => {
    vi.stubGlobal('crypto', { getRandomValues: (b: Uint8Array) => b.fill(0xff) });
    const id = nuevoId();
    expect(id).toMatch(V4);
    expect(id).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
  });

  it('randomUUID que lanza, o sin crypto: igual sale un v4', () => {
    vi.stubGlobal('crypto', { randomUUID: () => { throw new Error('insecure'); } });
    expect(nuevoId()).toMatch(V4);
    vi.stubGlobal('crypto', undefined);
    const ids = new Set(Array.from({ length: 100 }, nuevoId));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(V4);
  });
});
