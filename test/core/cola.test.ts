import { describe, expect, it } from 'vitest';
import { huellaLocal } from '../../src/core/colapso';
import { crearCola, deserializar, encolar, MAX_BYTES_PERSISTIDOS, serializar } from '../../src/core/cola';
import type { Evento } from '../../src/core/contrato';

let n = 0;
const evento = (over: Partial<Evento> = {}): Evento => ({
  id_externo: `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  origen: 'browser',
  mensaje: 'x is undefined',
  stack: 'TypeError: x is undefined\n    at Cobro (https://app/assets/index-9f2c1a7b.js:1:2)',
  ...over,
});

const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);

describe('huellaLocal', () => {
  it('mismo error, misma huella; otro mensaje, otro frame u otro origen, otra', () => {
    const h = huellaLocal(evento());
    expect(huellaLocal(evento())).toBe(h);
    expect(huellaLocal(evento({ mensaje: 'y is undefined' }))).not.toBe(h);
    expect(huellaLocal(evento({ stack: 'TypeError: x\n    at Venta (https://app/assets/index-9f2c1a7b.js:1:2)' }))).not.toBe(h);
    expect(huellaLocal(evento({ origen: 'edge' }))).not.toBe(h);
  });

  it('la misma falla en otro endpoint es otra huella; sin ubicacion, la de siempre', () => {
    const timeout = { mensaje: 'canceling statement due to statement timeout', stack: undefined, tipo_error: 'Error' };
    const a = huellaLocal(evento({ ...timeout, ubicacion: 'rpc/report_sales_by_day' }));
    expect(huellaLocal(evento({ ...timeout, ubicacion: 'rpc/report_sales_by_day' }))).toBe(a);
    expect(huellaLocal(evento({ ...timeout, ubicacion: 'rpc/report_margin_by_rubro' }))).not.toBe(a);
    expect(huellaLocal(evento({ ...timeout }))).toBe(huellaLocal(evento({ ...timeout, ubicacion: undefined })));
  });
});

describe('encolar', () => {
  it('colapsa repetidos dentro de 10 s en repeticiones; pasada la ventana, encola otro', () => {
    const c = crearCola();
    expect(encolar(c, evento(), T0, 50, 20)).toBe('encolado');
    expect(encolar(c, evento(), T0 + 5000, 50, 20)).toBe('colapsado');
    expect(encolar(c, evento(), T0 + 9999, 50, 20)).toBe('colapsado');
    expect(c.items).toHaveLength(1);
    expect(c.items[0].e.repeticiones).toBe(3);
    expect(encolar(c, evento(), T0 + 10_000, 50, 20)).toBe('encolado');
    expect(c.items).toHaveLength(2);
  });

  it('una tormenta de 12 RPC con el mismo 57014 da 12 ítems, uno por endpoint', () => {
    const c = crearCola();
    for (let i = 0; i < 12; i++) {
      for (let rep = 0; rep < 3; rep++) {
        const e = evento({ mensaje: 'canceling statement due to statement timeout', stack: undefined, ubicacion: `rpc/report_${i}` });
        encolar(c, e, T0 + rep, 50, 20);
      }
    }
    expect(c.items.map((i) => i.e.ubicacion)).toEqual(Array.from({ length: 12 }, (_, i) => `rpc/report_${i}`));
    expect(c.items.every((i) => i.e.repeticiones === 3)).toBe(true);
  });

  it('no colapsa sobre un item en vuelo: esa suma se perdería al llegar el 202', () => {
    const c = crearCola();
    encolar(c, evento(), T0, 50, 20);
    c.items[0].v = true;
    expect(encolar(c, evento(), T0 + 1000, 50, 20)).toBe('encolado');
    expect(c.items[0].e.repeticiones).toBeUndefined();
  });

  it('tope por minuto de reloj; el minuto siguiente vuelve a entrar', () => {
    const c = crearCola();
    for (let i = 0; i < 20; i++) expect(encolar(c, evento({ mensaje: `e${i}` }), T0 + i, 50, 20)).toBe('encolado');
    expect(encolar(c, evento({ mensaje: 'e20' }), T0 + 100, 50, 20)).toBe('tope_por_minuto');
    expect(encolar(c, evento({ mensaje: 'e21' }), T0 + 60_000, 50, 20)).toBe('encolado');
  });

  it('con la cola llena descarta lo más viejo', () => {
    const c = crearCola();
    for (let i = 0; i < 60; i++) encolar(c, evento({ mensaje: `e${i}` }), T0 + i * 60_000, 50, 20);
    expect(c.items).toHaveLength(50);
    expect(c.items[0].e.mensaje).toBe('e10');
    expect(c.items[49].e.mensaje).toBe('e59');
  });
});

describe('serializar / deserializar', () => {
  it('ida y vuelta, sin la marca de en vuelo', () => {
    const c = crearCola();
    encolar(c, evento(), T0, 50, 20);
    c.items[0].v = true;
    const back = deserializar(serializar(c.items));
    expect(back).toEqual([{ e: c.items[0].e, h: c.items[0].h, t: T0 }]);
  });

  it('no pasa de 128 KB en UTF-16: se queda con lo más nuevo', () => {
    const c = crearCola();
    for (let i = 0; i < 50; i++) encolar(c, evento({ mensaje: `e${i}`, stack: 's'.repeat(8192) }), T0 + i * 60_000, 50, 20);
    const s = serializar(c.items);
    expect(s.length * 2).toBeLessThanOrEqual(MAX_BYTES_PERSISTIDOS);
    const back = deserializar(s);
    expect(back.length).toBeGreaterThan(0);
    expect(back.length).toBeLessThan(50);
    expect(back[back.length - 1].e.mensaje).toBe('e49');
  });

  it('lo guardado corrupto o ajeno se ignora, no rompe', () => {
    expect(deserializar(null)).toEqual([]);
    expect(deserializar('no es json')).toEqual([]);
    expect(deserializar('{"a":1}')).toEqual([]);
    expect(deserializar('[1,null,{"e":{}},{"e":{"id_externo":"x","mensaje":"m"},"h":1,"t":2}]')).toEqual([
      { e: { id_externo: 'x', mensaje: 'm' }, h: 1, t: 2 },
    ]);
  });
});
