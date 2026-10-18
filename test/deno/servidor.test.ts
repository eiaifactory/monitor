import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Evento } from '../../src/core/contrato';
import { initMonitor, marcarFalla, withHandler, type Falla } from '../../src/deno/index';

const URL_PRUEBA = 'https://finance.test/functions/v1/monitor-ingesta';
const opciones = { clave: 'eiai_mon_dev_' + 'b'.repeat(32), url: URL_PRUEBA, funcion: 'cobrar', release: 'a1b2c3d' };

let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;
let waitUntil: Mock<(p: Promise<unknown>) => void>;
let enEspera: Promise<unknown>[];

const lotes = (): Evento[][] => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).eventos);
const req = (path = '/functions/v1/cobrar?venta=3') => new Request(`https://cliente.supabase.co${path}`, { method: 'POST' });
const esperarEnvios = () => Promise.all(enEspera);

beforeEach(() => {
  fetchMock = vi.fn(() => Promise.resolve(new Response('{"recibidos":1,"duplicados":0,"rechazados":[]}', { status: 202 })));
  vi.stubGlobal('fetch', fetchMock);
  enEspera = [];
  waitUntil = vi.fn((p) => void enEspera.push(p));
  vi.stubGlobal('EdgeRuntime', { waitUntil });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('withHandler', () => {
  it('devuelve la MISMA respuesta y no manda nada si no hubo error', async () => {
    const monitor = initMonitor(opciones);
    const res = new Response('{"ok":true}', { status: 200, headers: { 'x-propio': '1' } });
    const handler = withHandler(monitor, async () => res);
    expect(await handler(req())).toBe(res);
    await esperarEnvios();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('responde primero: la respuesta no espera al envío, que va en waitUntil', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // finance no contesta nunca
    const monitor = initMonitor(opciones);
    const handler = withHandler(monitor, async () => {
      throw new Error('se cayó');
    });
    const res = await handler(req());
    expect(res.status).toBe(500);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('si lanza: lo reporta con ubicacion, ruta sin query, release y origen edge, y devuelve un 500 JSON', async () => {
    const monitor = initMonitor(opciones);
    const handler = withHandler(monitor, async () => {
      throw new TypeError('venta.items is undefined');
    });
    const res = await handler(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'error_interno' });
    await esperarEnvios();
    expect(lotes()[0][0]).toMatchObject({
      origen: 'edge',
      mensaje: 'venta.items is undefined',
      tipo_error: 'TypeError',
      ubicacion: 'cobrar',
      ruta: '/functions/v1/cobrar',
      release: 'a1b2c3d',
    });
    expect((fetchMock.mock.calls[0][1].headers as Record<string, string>).authorization).toBe(`Bearer ${opciones.clave}`);
  });

  it('si lanza y hay aRespuesta, devuelve ésa (con los CORS de la función)', async () => {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const handler = withHandler(
      initMonitor(opciones),
      async () => {
        throw new Error('x');
      },
      { aRespuesta: () => new Response('{"error":"interno"}', { status: 500, headers: cors }) },
    );
    const res = await handler(req());
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  });

  it('un aRespuesta que lanza cae al 500 de siempre', async () => {
    const handler = withHandler(
      initMonitor(opciones),
      async () => {
        throw new Error('x');
      },
      { aRespuesta: () => { throw new Error('bug del cliente'); } },
    );
    expect((await handler(req())).status).toBe(500);
  });

  it('una 5xx se reporta como «<función>: respondió <status>», nunca con el cuerpo', async () => {
    const monitor = initMonitor(opciones);
    const res = new Response('{"error":"falló","dni":"30111222"}', { status: 503 });
    const handler = withHandler(monitor, async () => res);
    expect(await handler(req())).toBe(res);
    await esperarEnvios();
    expect(lotes()[0][0]).toMatchObject({ mensaje: 'cobrar: respondió 503', codigo: '503', tipo_error: 'HttpError' });
    expect(fetchMock.mock.calls[0][1].body).not.toContain('30111222');
  });

  describe('marcarFalla: el paso y el código de una 5xx, fuera de banda', () => {
    const conFalla = async (falla: Falla, status = 500) => {
      const res = marcarFalla(new Response('{"ok":false,"error":{"code":"db_error","message":"valor \\"30111222\\""}}', { status, headers: { 'x-propio': '1' } }), falla);
      const handler = withHandler(initMonitor(opciones), async () => res);
      const devuelta = await handler(req());
      await esperarEnvios();
      return { res, devuelta, evento: lotes()[0]?.[0] };
    };

    it('la respuesta sale idéntica: misma instancia, sin leer el body, mismos headers', async () => {
      const original = new Response('{"x":1}', { status: 500, headers: { 'x-propio': '1' } });
      const res = marcarFalla(original, { paso: 'stock_loss_apply', codigo: '57014' });
      expect(res).toBe(original);
      const handler = withHandler(initMonitor(opciones), async () => res);
      const devuelta = await handler(req());
      expect(devuelta).toBe(original);
      expect(devuelta.bodyUsed).toBe(false);
      expect(devuelta.headers.get('x-propio')).toBe('1');
      const nombres: string[] = [];
      devuelta.headers.forEach((_v, k) => nombres.push(k));
      expect(nombres).toEqual(['content-type', 'x-propio']);
      expect(await devuelta.text()).toBe('{"x":1}');
    });

    it('el mensaje dice el paso y el código, y `codigo` es el SQLSTATE; nada del body viaja', async () => {
      const { evento } = await conFalla({ paso: 'stock_loss_apply', codigo: '57014' });
      expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 500 en stock_loss_apply (57014)', codigo: '57014', tipo_error: 'HttpError', ubicacion: 'cobrar' });
      expect(fetchMock.mock.calls[0][1].body).not.toContain('30111222');
      expect(fetchMock.mock.calls[0][1].body).not.toContain('db_error');
    });

    it('sin código: el paso solo, y `codigo` sigue siendo el status', async () => {
      const { evento } = await conFalla({ paso: 'anthropic' }, 502);
      expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 502 en anthropic', codigo: '502' });
    });

    it('el código de PostgREST también vale', async () => {
      const { evento } = await conFalla({ paso: 'products_priced', codigo: 'PGRST202' });
      expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 500 en products_priced (PGRST202)', codigo: 'PGRST202' });
    });

    it('un paso o un código con forma de mensaje se descartan: nunca entra un valor', async () => {
      const raros: Falla[] = [
        { paso: 'invalid input syntax for type uuid: "abc"', codigo: 'duplicate key value' },
        { paso: '', codigo: '5701' },
        { paso: 'x'.repeat(65), codigo: '570144' },
        { paso: 42 as never, codigo: {} as never },
      ];
      for (const falla of raros) {
        fetchMock.mockClear();
        enEspera = [];
        const { evento } = await conFalla(falla);
        expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 500', codigo: '500' });
      }
    });

    it('un PT4xx en una 5xx se sigue reportando: el código queda en el mensaje, no en `codigo`', async () => {
      const { evento } = await conFalla({ paso: 'stock_loss_apply', codigo: 'PT403' });
      expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 500 en stock_loss_apply (PT403)', codigo: '500' });
    });

    it('en una 4xx la marca no hace nada: no se reporta', async () => {
      const res = marcarFalla(new Response('{}', { status: 400 }), { paso: 'stock_loss_apply', codigo: '22023' });
      await withHandler(initMonitor(opciones), async () => res)(req());
      await esperarEnvios();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('marcar con basura no lanza y devuelve lo que recibió', () => {
      for (const raro of [null, undefined, 42, 'x']) {
        expect(() => marcarFalla(raro as never, { paso: 'x' })).not.toThrow();
        expect(marcarFalla(raro as never, { paso: 'x' })).toBe(raro);
      }
    });
  });

  it('una 4xx no se reporta: es la función contestando que no', async () => {
    const handler = withHandler(initMonitor(opciones), async () => new Response('{}', { status: 422 }));
    await handler(req());
    await esperarEnvios();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lo esperado no se reporta: PT4xx, AbortError, 401/403 y el esEsperado del cliente', async () => {
    const errores: unknown[] = [
      { code: 'PT402', message: 'Sin stock', details: null, hint: null },
      new DOMException('aborted', 'AbortError'),
      { status: 401, message: 'JWT expired' },
      new Error('venta cerrada'),
    ];
    for (const error of errores) {
      const handler = withHandler(
        initMonitor(opciones),
        async () => {
          throw error;
        },
        { esEsperado: (e) => e instanceof Error && e.message === 'venta cerrada' },
      );
      expect((await handler(req())).status).toBe(500);
    }
    await esperarEnvios();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('también manda lo que la función capturó a mano antes de contestar un 200', async () => {
    const monitor = initMonitor(opciones);
    const handler = withHandler(monitor, async () => {
      monitor.capturar(new Error('no se pudo avisar por mail'), { contexto: { intento: 2 } });
      return new Response('{}', { status: 200 });
    });
    await handler(req());
    await esperarEnvios();
    expect(lotes()[0][0]).toMatchObject({ mensaje: 'no se pudo avisar por mail', contexto: { intento: 2 } });
  });

  it('pasa los argumentos extra de Deno.serve (info) al handler', async () => {
    const handler = withHandler(initMonitor(opciones), async (_req: Request, info: { remoteAddr: string }) => new Response(info.remoteAddr));
    expect(await (await handler(req(), { remoteAddr: '1.2.3.4' })).text()).toBe('1.2.3.4');
  });

  it('sin EdgeRuntime (Deno o Node sueltos) manda igual, sin esperarlo', async () => {
    vi.stubGlobal('EdgeRuntime', undefined);
    const monitor = initMonitor({ ...opciones, origen: 'servidor' });
    const handler = withHandler(monitor, async () => {
      throw new Error('x');
    });
    await handler(req());
    await monitor.flush();
    expect(lotes()[0][0].origen).toBe('servidor');
  });
});

describe('flush de servidor', () => {
  it('sin clave, no-op', async () => {
    const monitor = initMonitor({ ...opciones, clave: undefined });
    monitor.capturar(new Error('x'));
    await monitor.flush();
    const handler = withHandler(monitor, async () => {
      throw new Error('x');
    });
    expect((await handler(req())).status).toBe(500);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('red caída o 5xx: un reintento con el mismo id_externo, y después se suelta', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 503 })));
    const monitor = initMonitor(opciones);
    monitor.capturar(new Error('x'));
    const p = monitor.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lotes()[1][0].id_externo).toBe(lotes()[0][0].id_externo);
    await monitor.flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('un fetch que no contesta se corta a los 2 s', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const monitor = initMonitor(opciones);
    monitor.capturar(new Error('x'));
    const p = monitor.flush();
    await vi.advanceTimersByTimeAsync(2000 + 1000 + 2000);
    await expect(p).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('429: espera Retry-After (hasta 10 s) y reintenta una vez', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce(() => Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '4' } })));
    const monitor = initMonitor(opciones);
    monitor.capturar(new Error('x'));
    const p = monitor.flush();
    await vi.advanceTimersByTimeAsync(3999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('401: se apaga y suelta lo pendiente', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{"error":"clave_invalida"}', { status: 401 })));
    const monitor = initMonitor(opciones);
    monitor.capturar(new Error('x'));
    await monitor.flush();
    monitor.capturar(new Error('y'));
    await monitor.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('413: parte el lote; 25 eventos salen en lotes de hasta 20', async () => {
    fetchMock.mockImplementation((_u, init) =>
      Promise.resolve(new Response('{}', { status: JSON.parse(init.body as string).eventos.length > 10 ? 413 : 202 })));
    const monitor = initMonitor(opciones);
    for (let i = 0; i < 25; i++) monitor.capturar(new Error(`e${i}`));
    await monitor.flush();
    expect(lotes().map((l) => l.length)).toEqual([20, 10, 10, 5]);
  });

  it('flushes concurrentes no duplican envíos', async () => {
    const monitor = initMonitor(opciones);
    monitor.capturar(new Error('x'));
    await Promise.all([monitor.flush(), monitor.flush(), monitor.flush()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
