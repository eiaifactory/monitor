import { describe, expect, it } from 'vitest';
import type { Evento } from '../../src/core/contrato';
import { limpiar, redactarTexto, REDACTADO } from '../../src/core/pii';

const evento = (over: Partial<Evento>): Evento => ({
  id_externo: '3f2b8a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b',
  origen: 'browser',
  mensaje: 'x',
  ...over,
});

// Los mismos casos que `_shared/monitor/pii.test.ts` de finance: las dos líneas redactan igual.
describe('redactarTexto', () => {
  it('emails y teléfonos, en cualquier formato argentino', () => {
    expect(redactarTexto('no existe juan.perez@mercado.com.ar')).toBe(`no existe ${REDACTADO}`);
    expect(redactarTexto('llamar al +54 9 11 2850-3180 ya')).toBe(`llamar al ${REDACTADO} ya`);
    expect(redactarTexto('tel 1128503180')).toBe(`tel ${REDACTADO}`);
    expect(redactarTexto('tel 11 2850 3180')).toBe(`tel ${REDACTADO}`);
  });

  it('NO se come lo técnico: uuids, línea:columna, IPs, hashes, números cortos', () => {
    const tecnico = [
      'producto 27260042-eb14-42d5-afef-4526edc15f6f no encontrado',
      'at Cobro (https://app.x.com/assets/index-9f2c1a7b.js:412:18831)',
      'ECONNREFUSED 10.0.0.12:5432',
      'chunk 4821 failed',
      'status 503',
    ];
    for (const t of tecnico) expect(redactarTexto(t)).toBe(t);
  });

  it('sin lookbehind, los bordes se comportan igual: al principio, pegados y seguidos', () => {
    expect(redactarTexto('1128503180 no contesta')).toBe(`${REDACTADO} no contesta`);
    expect(redactarTexto('(1128503180)')).toBe(`(${REDACTADO})`);
    expect(redactarTexto('1128503180,1128503181')).toBe(`${REDACTADO},${REDACTADO}`);
    expect(redactarTexto('1128503180 1128503181')).toBe(`${REDACTADO} ${REDACTADO}`);
    expect(redactarTexto('v1128503180')).toBe('v1128503180');
    expect(redactarTexto('a.1128503180')).toBe('a.1128503180');
    // dos llamadas seguidas no arrastran estado de la regex global
    expect(redactarTexto('tel 1128503180')).toBe(`tel ${REDACTADO}`);
  });
});

describe('limpiar', () => {
  it('claves sensibles del contexto se redactan enteras, sea cual sea el valor', () => {
    const e = limpiar(evento({ contexto: { email: 'x', user_phone: 1234, apiKey: 'sk', Clave: 'x', sucursal: 'centro' } }));
    expect(e.contexto).toEqual({ email: REDACTADO, user_phone: REDACTADO, apiKey: REDACTADO, Clave: REDACTADO, sucursal: 'centro' });
  });

  it('un email escondido en un valor inocente también sale', () => {
    expect(limpiar(evento({ contexto: { nota: 'de juan@x.com' } })).contexto?.nota).toBe(`de ${REDACTADO}`);
  });

  it('mensaje, stack y ruta pasan por el mismo filtro', () => {
    const e = limpiar(evento({ mensaje: 'falló para ana@x.com', stack: 'Error: ana@x.com\n at f (a.js:1:2)', ruta: '/usuarios/ana@x.com' }));
    expect(e.mensaje).toBe(`falló para ${REDACTADO}`);
    expect(e.stack).toBe(`Error: ${REDACTADO}\n at f (a.js:1:2)`);
    expect(e.ruta).toBe(`/usuarios/${REDACTADO}`);
  });

  it('un usuario_id que es un email es un cliente mal configurado: se redacta', () => {
    expect(limpiar(evento({ usuario_id: 'ana@x.com' })).usuario_id).toBe(REDACTADO);
    expect(limpiar(evento({ usuario_id: '7c1e0000-0000-0000-0000-0000000000a9' })).usuario_id).toBe('7c1e0000-0000-0000-0000-0000000000a9');
  });

  it('no toca lo que no tiene que tocar', () => {
    const e = evento({ release: '3f9a2c1', codigo: 'PGRST116', rol: 'cajero' });
    expect(JSON.parse(JSON.stringify(limpiar(e)))).toEqual(e);
  });
});
