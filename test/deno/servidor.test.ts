import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Evento } from '../../src/core/contrato';
import { initMonitor, marcarFalla, reportarTercero, withHandler, type Falla, type FallaDeTercero } from '../../src/deno/index';

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

    it('un texto fijo del programa también vale como código (0.1.4): `codigo` es el texto, no el status', async () => {
      for (const codigo of ['timeout', 'anthropic_status_529', 'a'.repeat(64)]) {
        fetchMock.mockClear();
        enEspera = [];
        const { evento } = await conFalla({ paso: 'anthropic', codigo }, 502);
        expect(evento).toMatchObject({ mensaje: `cobrar: respondió 502 en anthropic (${codigo})`, codigo });
      }
    });

    it('un código fuera de la regla se descarta y el paso queda: mayúscula, guión, primer carácter raro o más de 64', async () => {
      for (const codigo of ['Timeout', '_x', '1timeout', 'no-tool-use', 'a'.repeat(65)]) {
        fetchMock.mockClear();
        enEspera = [];
        const { evento } = await conFalla({ paso: 'anthropic', codigo }, 502);
        expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 502 en anthropic', codigo: '502' });
      }
    });

    it('un paso o un código con forma de mensaje se descartan: nunca entra un valor', async () => {
      const raros: Falla[] = [
        { paso: 'invalid input syntax for type uuid: "abc"', codigo: 'duplicate key value' },
        // Con `/` o `-`, finance leería sólo la primera parte del paso.
        { paso: 'storage/upload', codigo: '57014x' },
        { paso: 'stock-loss', codigo: 'no-tool-use' },
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

  describe('0.1.5: la falla de un tercero y el último intento', () => {
    const conFalla = async (falla: Falla, status = 502) => {
      const res = marcarFalla(new Response('{"ok":false,"detalle":"balances_503 30111222"}', { status, headers: { 'x-propio': '1' } }), falla);
      const handler = withHandler(initMonitor(opciones), async () => res);
      const devuelta = await handler(req());
      await esperarEnvios();
      return { res, devuelta, evento: lotes()[0]?.[0] };
    };

    it('con `tercero`: el código es lo que devolvió el servicio y el servicio va en contexto.tercero', async () => {
      const { evento } = await conFalla({ paso: 'interbanking', codigo: 'http_503', tercero: 'interbanking' });
      expect(evento).toMatchObject({
        mensaje: 'cobrar: respondió 502 en interbanking (http_503)',
        codigo: 'http_503',
        tipo_error: 'HttpError',
        ubicacion: 'cobrar',
        contexto: { tercero: 'interbanking' },
      });
      expect(fetchMock.mock.calls[0][1].body).not.toContain('30111222');
    });

    it('todo el vocabulario de finance viaja tal cual como código', async () => {
      for (const codigo of ['http_500', 'http_599', 'http_429', 'timeout', 'red', 'servidor', 'http_401']) {
        fetchMock.mockClear();
        enEspera = [];
        const { evento } = await conFalla({ paso: 'flete47', codigo, tercero: 'flete47' });
        expect(evento).toMatchObject({ codigo, contexto: { tercero: 'flete47' } });
      }
    });

    it('con `final: false` no se reporta, y la respuesta sale idéntica y sin leer', async () => {
      const { res, devuelta } = await conFalla({ paso: 'interbanking', codigo: 'timeout', tercero: 'interbanking', final: false });
      expect(devuelta).toBe(res);
      expect(devuelta.bodyUsed).toBe(false);
      expect(devuelta.status).toBe(502);
      expect(devuelta.headers.get('x-propio')).toBe('1');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('`final: false` también vale sin `tercero`: lo decide quien reintenta', async () => {
      await conFalla({ paso: 'saldos_guardar', codigo: '57014', final: false }, 500);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('`final: true`, sin `final` o con algo que no es `false`: se reporta (nunca se pierde)', async () => {
      for (const final of [true, undefined, 'false', 0, null]) {
        fetchMock.mockClear();
        enEspera = [];
        const { evento } = await conFalla({ paso: 'interbanking', codigo: 'timeout', tercero: 'interbanking', final: final as never });
        expect(evento).toMatchObject({ codigo: 'timeout', contexto: { tercero: 'interbanking' } });
      }
    });

    it('un `tercero` sin la forma del paso no viaja, y el evento sale igual (entra como error)', async () => {
      for (const tercero of ['inter-banking', 'Inter banking', 'ana@banco.com', '', 'x'.repeat(65), 42, {}]) {
        fetchMock.mockClear();
        enEspera = [];
        const { evento } = await conFalla({ paso: 'interbanking', codigo: 'http_503', tercero: tercero as never });
        expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 502 en interbanking (http_503)', codigo: 'http_503' });
        expect(evento.contexto).toBeUndefined();
      }
    });

    it('con `tercero` y sin código, `codigo` sigue siendo nuestro status: finance lo deja como error', async () => {
      const { evento } = await conFalla({ paso: 'interbanking', tercero: 'interbanking' });
      expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 502 en interbanking', codigo: '502', contexto: { tercero: 'interbanking' } });
    });

    it('una marca de la 0.1.4 (sólo paso y código) sale igual que antes: sin contexto', async () => {
      const { evento } = await conFalla({ paso: 'stock_loss_apply', codigo: '57014' }, 500);
      expect(evento).toMatchObject({ mensaje: 'cobrar: respondió 500 en stock_loss_apply (57014)', codigo: '57014' });
      expect(evento.contexto).toBeUndefined();
      expect(Object.keys(evento).sort()).toEqual(
        ['codigo', 'id_externo', 'mensaje', 'ocurrido_at', 'origen', 'release', 'repeticiones', 'ruta', 'tipo_error', 'ubicacion'],
      );
    });

    it('en una 4xx, `tercero` no hace nada: lo que no es 5xx va por reportarTercero', async () => {
      const res = marcarFalla(new Response('{}', { status: 429 }), { paso: 'interbanking', codigo: 'http_429', tercero: 'interbanking' });
      await withHandler(initMonitor(opciones), async () => res)(req());
      await esperarEnvios();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('una marca con un getter que lanza no rompe la respuesta', async () => {
      const falla = { paso: 'x', get final(): boolean { throw new Error('bug del cliente'); } } as Falla;
      const original = new Response('{}', { status: 502 });
      const devuelta = await withHandler(initMonitor(opciones), async () => marcarFalla(original, falla))(req());
      expect(devuelta).toBe(original);
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

describe('reportarTercero (0.1.5)', () => {
  const reportar = async (falla: FallaDeTercero) => {
    const monitor = initMonitor(opciones);
    reportarTercero(monitor, falla);
    await monitor.flush();
    return lotes()[0]?.[0];
  };

  it('un 401 del servicio llega: sin `status`, esEsperado no lo descarta (es nuestro: una credencial)', async () => {
    const evento = await reportar({ servicio: 'interbanking', codigo: 'http_401', paso: 'token' });
    expect(evento).toMatchObject({
      origen: 'edge',
      mensaje: 'cobrar: interbanking falló en token (http_401)',
      tipo_error: 'TerceroError',
      codigo: 'http_401',
      ubicacion: 'cobrar',
      release: 'a1b2c3d',
      contexto: { tercero: 'interbanking' },
    });
    expect(fetchMock.mock.calls[0][1].body).not.toMatch(/"status"/);
  });

  it('el 429 que frena el día, y el resto del vocabulario, llegan con el código como texto', async () => {
    for (const codigo of ['http_429', 'http_403', 'timeout', 'red', 'servidor', 'http_503']) {
      fetchMock.mockClear();
      const evento = await reportar({ servicio: 'interbanking', codigo, paso: 'saldos' });
      expect(evento).toMatchObject({ codigo, mensaje: `cobrar: interbanking falló en saldos (${codigo})`, contexto: { tercero: 'interbanking' } });
    }
  });

  it('sin paso: el mensaje dice sólo el servicio y el código', async () => {
    const evento = await reportar({ servicio: 'flete47', codigo: 'timeout' });
    expect(evento).toMatchObject({ mensaje: 'cobrar: flete47 falló (timeout)', codigo: 'timeout' });
  });

  it('con `final: false` no manda nada; con true, sin final o con otra cosa, sí', async () => {
    const monitor = initMonitor(opciones);
    reportarTercero(monitor, { servicio: 'interbanking', codigo: 'http_503', final: false });
    await monitor.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    for (const final of [true, undefined, 'false', 0]) {
      fetchMock.mockClear();
      expect(await reportar({ servicio: 'interbanking', codigo: 'http_503', final: final as never })).toMatchObject({ codigo: 'http_503' });
    }
  });

  it('un código sin forma no viaja (ni un status numérico), y el evento sale igual', async () => {
    for (const codigo of ['429', 'HTTP_503', 'no-tool-use', 'ana@banco.com', '', 42 as never]) {
      fetchMock.mockClear();
      const evento = await reportar({ servicio: 'interbanking', codigo, paso: 'saldos' });
      expect(evento).toMatchObject({ mensaje: 'cobrar: interbanking falló en saldos', tipo_error: 'TerceroError', contexto: { tercero: 'interbanking' } });
      expect(evento.codigo).toBeUndefined();
    }
  });

  it('un servicio o un paso sin forma no viajan: sin contexto.tercero entra como error, y se ve igual', async () => {
    const evento = await reportar({ servicio: 'Inter banking', codigo: 'http_429', paso: 'storage/upload' });
    expect(evento).toMatchObject({ mensaje: 'cobrar: un servicio de afuera falló (http_429)', codigo: 'http_429' });
    expect(evento.contexto).toBeUndefined();
  });

  it('un PT4xx queda sólo en el mensaje: en `codigo` lo descartaría esEsperado', async () => {
    const evento = await reportar({ servicio: 'interbanking', codigo: 'PT402', paso: 'saldos' });
    expect(evento).toMatchObject({ mensaje: 'cobrar: interbanking falló en saldos (PT402)', contexto: { tercero: 'interbanking' } });
    expect(evento.codigo).toBeUndefined();
  });

  it('dentro de withHandler sale al terminar el request, aunque la función conteste 200', async () => {
    const monitor = initMonitor(opciones);
    const handler = withHandler(monitor, async () => {
      reportarTercero(monitor, { servicio: 'interbanking', codigo: 'http_429', paso: 'saldos' });
      return new Response('{"frenar":true}', { status: 200 });
    });
    expect((await handler(req())).status).toBe(200);
    await esperarEnvios();
    expect(lotes()[0][0]).toMatchObject({ codigo: 'http_429', contexto: { tercero: 'interbanking' } });
  });

  it('sin clave no hace nada; con basura no lanza', async () => {
    const sinClave = initMonitor({ ...opciones, clave: undefined });
    reportarTercero(sinClave, { servicio: 'interbanking', codigo: 'http_503' });
    await sinClave.flush();
    expect(fetchMock).not.toHaveBeenCalled();
    const monitor = initMonitor(opciones);
    for (const raro of [null, undefined, 42, 'x', { get servicio(): string { throw new Error('x'); } }]) {
      expect(() => reportarTercero(monitor, raro as never)).not.toThrow();
    }
    expect(() => reportarTercero(null as never, { servicio: 'interbanking', codigo: 'red' })).not.toThrow();
  });
});
