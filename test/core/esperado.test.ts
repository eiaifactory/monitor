import { describe, expect, it } from 'vitest';
import { esEsperado, ignorado } from '../../src/core/esperado';

describe('esEsperado', () => {
  it('el RAISE de negocio (PT4xx) es esperado; un error de base, no', () => {
    expect(esEsperado({ code: 'PT402', message: 'Sin stock', details: null, hint: null })).toBe(true);
    expect(esEsperado({ code: '23505', message: 'duplicate key', details: null, hint: null })).toBe(false);
    expect(esEsperado({ code: 'PGRST116', message: 'JSON object requested', details: null, hint: null })).toBe(false);
  });

  it('AbortError es esperado', () => {
    expect(esEsperado(new DOMException('aborted', 'AbortError'))).toBe(true);
  });

  it('401/403 de auth son esperados, en cualquiera de las formas de Supabase', () => {
    expect(esEsperado({ status: 401, message: 'JWT expired' })).toBe(true);
    expect(esEsperado({ name: 'FunctionsHttpError', context: { status: 403 } })).toBe(true);
    expect(esEsperado({ name: 'AuthApiError', status: 400, code: 'invalid_credentials' })).toBe(true);
  });

  it('un 5xx, un Auth 5xx o un TypeError no son esperados', () => {
    expect(esEsperado({ name: 'FunctionsHttpError', context: { status: 502 } })).toBe(false);
    expect(esEsperado({ name: 'AuthRetryableFetchError', status: 503 })).toBe(false);
    expect(esEsperado(new TypeError('x is undefined'))).toBe(false);
  });

  it('nunca lanza', () => {
    for (const v of [null, undefined, 'x', 1, Symbol('s'), new Proxy({}, { get() { throw new Error('no'); } })]) {
      expect(esEsperado(v)).toBe(false);
    }
  });
});

describe('ignorado', () => {
  it('texto contenido o regex; una regex con /g no alterna', () => {
    const ignorar = ['Failed to fetch dynamically imported module', /ResizeObserver loop/g];
    expect(ignorado('TypeError: Failed to fetch dynamically imported module: /assets/x.js', ignorar)).toBe(true);
    for (let i = 0; i < 3; i++) expect(ignorado('ResizeObserver loop limit exceeded', ignorar)).toBe(true);
    expect(ignorado('x is undefined', ignorar)).toBe(false);
  });
});
