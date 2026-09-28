import { describe, expect, it } from 'vitest';
import { TOPES } from '../../src/core/contrato';
import { armarEvento, contextoPlano, normalizar } from '../../src/core/normalizar';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('normalizar', () => {
  it('Error y subclases: mensaje, tipo y stack', () => {
    const e = new TypeError('x is not a function');
    const n = normalizar(e);
    expect(n).toMatchObject({ mensaje: 'x is not a function', tipo_error: 'TypeError' });
    expect(n.stack).toContain('x is not a function');
  });

  it('PostgREST: el code va a codigo, y details/hint no viajan (traen valores de filas)', () => {
    const n = normalizar({ message: 'duplicate key value', code: '23505', details: 'Key (dni)=(30111222) already exists', hint: null });
    expect(n).toEqual({ mensaje: 'duplicate key value', tipo_error: 'PostgrestError', codigo: '23505' });
    expect(JSON.stringify(n)).not.toContain('30111222');
  });

  it('Functions y Auth de Supabase: el status (o context.status) es el codigo', () => {
    expect(normalizar({ name: 'FunctionsHttpError', message: 'non-2xx', context: { status: 502 } }).codigo).toBe('502');
    expect(normalizar({ name: 'AuthApiError', message: 'x', status: 400, code: 'invalid_credentials' }).codigo).toBe('invalid_credentials');
  });

  it('lo que no es un Error: strings, primitivos, null, símbolos', () => {
    expect(normalizar('se rompió')).toEqual({ mensaje: 'se rompió' });
    expect(normalizar(42)).toEqual({ mensaje: '42' });
    expect(normalizar(null)).toEqual({ mensaje: 'null' });
    expect(normalizar(undefined)).toEqual({ mensaje: 'undefined' });
    expect(normalizar(Symbol('s'))).toEqual({ mensaje: 'Symbol(s)' });
    expect(normalizar('   ')).toEqual({ mensaje: 'Error sin mensaje' });
  });

  it('objetos raros: sin message, circulares, vacíos, con getters que lanzan', () => {
    expect(normalizar({ a: 1 }).mensaje).toBe('{"a":1}');
    expect(normalizar(['a', 1]).mensaje).toBe('["a",1]');
    expect(normalizar(new Map([['a', 1]])).mensaje).toBe('[object Map]');
    const circular: Record<string, unknown> = {};
    circular.yo = circular;
    expect(normalizar(circular).mensaje).toBe('[object Object]');
    expect(normalizar(new Event('x')).mensaje).toBe('[object Event]');
    const trampa = new Proxy({}, { get() { throw new Error('no'); }, ownKeys() { throw new Error('no'); } });
    expect(normalizar(trampa)).toEqual({ mensaje: 'Error no legible' });
  });

  it('recorta a los topes del contrato, con la marca', () => {
    const e = new Error('m'.repeat(1024 * 1024));
    e.stack = 's'.repeat(100_000);
    const n = normalizar(e);
    expect(n.mensaje.length).toBe(TOPES.mensaje);
    expect(n.mensaje.endsWith('…[cortado]')).toBe(true);
    expect(n.stack!.length).toBe(TOPES.stack);
  });
});

describe('contextoPlano', () => {
  it('sólo escalares; NaN e infinitos a null; strings hasta 256', () => {
    expect(contextoPlano({ a: 1, b: 'x', c: true, d: null, e: { f: 1 }, g: [1], h: NaN, i: () => 1, j: 's'.repeat(300) })).toEqual({
      a: 1, b: 'x', c: true, d: null, h: null, j: 's'.repeat(246) + '…[cortado]',
    });
  });

  it('más de 2 KB: corta claves del final y lo marca', () => {
    const grande: Record<string, string> = {};
    for (let i = 0; i < 20; i++) grande[`k${i}`] = 'v'.repeat(200);
    const c = contextoPlano(grande)!;
    expect(new TextEncoder().encode(JSON.stringify(c)).length).toBeLessThanOrEqual(2048);
    expect(c._cortado).toBe(true);
    expect(c.k0).toBeDefined();
  });

  it('vacío o no-objeto → nada', () => {
    expect(contextoPlano({})).toBeUndefined();
    expect(contextoPlano('x')).toBeUndefined();
  });
});

describe('armarEvento', () => {
  it('arma un evento válido del contrato, sin query en la ruta y sin PII', () => {
    const e = armarEvento({
      error: new Error('no existe ana@x.com'),
      origen: 'browser',
      ocurrido: Date.UTC(2026, 8, 28, 12, 0, 0),
      ruta: '/ventas/3?token=abc#x',
      release: 'a1b2c3d',
      usuario_id: '7c1e0000-0000-0000-0000-0000000000a9',
      rol: 'cajero',
      contexto: { sucursal: 'centro', telefono: '1128503180' },
    });
    expect(e.id_externo).toMatch(UUID);
    expect(e).toMatchObject({
      origen: 'browser',
      mensaje: 'no existe [redactado]',
      tipo_error: 'Error',
      ocurrido_at: '2026-09-28T12:00:00.000Z',
      ruta: '/ventas/3',
      release: 'a1b2c3d',
      rol: 'cajero',
      contexto: { sucursal: 'centro', telefono: '[redactado]' },
      repeticiones: 1,
    });
    expect(JSON.stringify(e)).not.toContain('token');
  });

  it('cada evento tiene su propio id_externo', () => {
    const a = armarEvento({ error: 'x', origen: 'edge', ocurrido: Date.now() });
    const b = armarEvento({ error: 'x', origen: 'edge', ocurrido: Date.now() });
    expect(a.id_externo).not.toBe(b.id_externo);
  });
});
