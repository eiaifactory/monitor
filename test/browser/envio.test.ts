import { describe, expect, it, vi } from 'vitest';
import { TOPES } from '../../src/core/contrato';
import { CLAVE, T0, URL_PRUEBA, fetchMock, iniciado, lotes, ok, responder } from './ayuda';

const errores = (n: number, prefijo = 'e') => Array.from({ length: n }, (_, i) => new Error(`${prefijo}${i}`));

describe('cuándo sale un lote', () => {
  it('cada 2 s', async () => {
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(URL_PRUEBA);
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${CLAVE}`);
    expect(init.keepalive).toBe(false);
  });

  it('o al juntar 10, sin esperar los 2 s', async () => {
    const sdk = await iniciado();
    for (const e of errores(10)) sdk.capturar(e);
    await vi.advanceTimersByTimeAsync(1);
    expect(lotes()[0]).toHaveLength(10);
  });

  it('el evento lleva ruta sin query, release, dispositivo, user agent, usuario y contexto', async () => {
    history.replaceState(null, '', '/ventas/3?token=abc');
    const sdk = await iniciado({ release: 'a1b2c3d' });
    sdk.setUsuario({ id: '7c1e0000-0000-0000-0000-0000000000a9', rol: 'cajero' });
    sdk.setContext({ sucursal: 'centro', terminal: 2 });
    sdk.capturar(new TypeError('x is undefined'), { contexto: { paso: 'cobro' } });
    sdk.limpiarUsuario();
    sdk.setContext({ terminal: undefined });
    sdk.capturar(new Error('sin usuario'));
    await sdk.flush();
    const [a, b] = lotes()[0];
    expect(a).toMatchObject({
      origen: 'browser',
      mensaje: 'x is undefined',
      tipo_error: 'TypeError',
      ocurrido_at: new Date(T0).toISOString(),
      ruta: '/ventas/3',
      release: 'a1b2c3d',
      usuario_id: '7c1e0000-0000-0000-0000-0000000000a9',
      rol: 'cajero',
      user_agent: navigator.userAgent,
      contexto: { sucursal: 'centro', terminal: 2, paso: 'cobro' },
      repeticiones: 1,
    });
    expect(a.dispositivo_id).toBe(localStorage.getItem('eiai_monitor_dispositivo'));
    expect(b.usuario_id).toBeUndefined();
    expect(b.contexto).toEqual({ sucursal: 'centro' });
  });

  it('el dispositivo_id se mantiene entre cargas', async () => {
    let sdk = await iniciado();
    sdk.capturar(new Error('a'));
    await sdk.flush();
    sdk = await iniciado();
    sdk.capturar(new Error('b'));
    await sdk.flush();
    const [[a], [b]] = lotes();
    expect(a.dispositivo_id).toBe(b.dispositivo_id);
  });
});

describe('frenos del lado del cliente', () => {
  it('colapsa repetidos en ráfaga: un evento con repeticiones', async () => {
    const sdk = await iniciado();
    for (let i = 0; i < 5; i++) sdk.capturar(new Error('x'));
    await sdk.flush();
    expect(lotes()[0]).toHaveLength(1);
    expect(lotes()[0][0].repeticiones).toBe(5);
  });

  it('20 eventos nuevos por minuto, como mucho', async () => {
    const sdk = await iniciado();
    for (const e of errores(25)) sdk.capturar(e);
    await sdk.flush();
    expect(lotes().flat()).toHaveLength(20);
  });

  it('cola de 50 que descarta lo más viejo, persistida', async () => {
    fetchMock.mockImplementation(responder(503));
    const sdk = await iniciado({ maxPorMinuto: 100 });
    for (const e of errores(60)) sdk.capturar(e);
    await vi.advanceTimersByTimeAsync(0);
    const guardada = JSON.parse(localStorage.getItem('eiai_monitor_cola')!);
    expect(guardada).toHaveLength(50);
    expect(guardada[0].e.mensaje).toBe('e10');
  });

  it('ignora lo esperado y lo que el cliente declara en ignorar', async () => {
    const sdk = await iniciado({ ignorar: ['Failed to fetch dynamically imported module', /^ResizeObserver/] });
    sdk.capturar({ code: 'PT402', message: 'Sin stock', details: null, hint: null });
    sdk.capturar(new DOMException('aborted', 'AbortError'));
    sdk.capturar({ name: 'AuthApiError', status: 400, message: 'Invalid login credentials' });
    sdk.capturar(new TypeError('Failed to fetch dynamically imported module: /assets/Caja-1a2b3c.js'));
    sdk.capturar(new Error('ResizeObserver loop completed with undelivered notifications.'));
    sdk.capturar(new Error('este sí'));
    await sdk.flush();
    expect(lotes().flat().map((e) => e.mensaje)).toEqual(['este sí']);
  });
});

describe('qué hace con cada respuesta', () => {
  it('lotes de hasta 60 KB aunque haya 20 eventos pesados, y salen todos', async () => {
    const sdk = await iniciado();
    for (let i = 0; i < 20; i++) {
      const e = new Error(`pesado ${i} ` + 'm'.repeat(TOPES.mensaje));
      e.stack = 's'.repeat(TOPES.stack);
      sdk.capturar(e, { contexto: Object.fromEntries(Array.from({ length: 7 }, (_, k) => [`k${k}`, 'v'.repeat(256)])) });
    }
    await sdk.flush();
    for (const [, init] of fetchMock.mock.calls) {
      expect(new TextEncoder().encode(init.body as string).length).toBeLessThanOrEqual(60 * 1024);
    }
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(lotes().flat()).toHaveLength(20);
  });

  it('413: parte el lote a la mitad y reintenta; no se pierde nada', async () => {
    fetchMock.mockImplementation((_u, init) => {
      const n = JSON.parse(init.body as string).eventos.length;
      return Promise.resolve(new Response('{}', { status: n > 2 ? 413 : 202 }));
    });
    const sdk = await iniciado();
    for (const e of errores(5)) sdk.capturar(e);
    await sdk.flush();
    expect(lotes().map((l) => l.length)).toEqual([5, 2, 3, 1, 2]);
    const recibidos = lotes().filter((l) => l.length <= 2).flat().map((e) => e.mensaje);
    expect(recibidos.sort()).toEqual(['e0', 'e1', 'e2', 'e3', 'e4']);
  });

  it('413 con un solo evento: ése se descarta (con los topes no puede pasar)', async () => {
    fetchMock.mockImplementation(responder(413));
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await sdk.flush();
    expect(localStorage.getItem('eiai_monitor_cola')).toBe('[]');
  });

  it('429 sin Retry-After legible (el navegador hoy): espera al próximo minuto de reloj', async () => {
    vi.setSystemTime(T0 + 30_000); // 12:00:30
    fetchMock.mockImplementationOnce(responder(429, '{"error":"cuota_excedida"}'));
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(2000); // 12:00:32, primer intento → 429
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(27_900); // 12:00:59.9
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); // 12:01:00
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(lotes()[1][0].id_externo).toBe(lotes()[0][0].id_externo);
  });

  it('red caída o 5xx: 1 → 2 → 4 → 30 s, y el reintento manda los mismos id_externo', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(2000);
    const tiempos: number[] = [Date.now()];
    fetchMock.mockImplementation(() => (tiempos.push(Date.now()), Promise.reject(new TypeError('Failed to fetch'))));
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 30_000 + 30_000);
    const esperas = tiempos.slice(1).map((t, i) => t - tiempos[i]);
    expect(esperas).toEqual([1000, 2000, 4000, 30_000, 30_000]);
    expect(new Set(lotes().map((l) => l[0].id_externo)).size).toBe(1);

    // Vuelve finance: sale, y el backoff se reinicia.
    fetchMock.mockImplementation(ok);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(localStorage.getItem('eiai_monitor_cola')).toBe('[]');

    // Un fallo nuevo vuelve a empezar en 1 s, no en 30.
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    sdk.capturar(new Error('otro'));
    await vi.advanceTimersByTimeAsync(2000);
    const antes = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock.mock.calls.length).toBe(antes + 1);
  });

  it('401: se apaga hasta la próxima carga; la cola queda para entonces', async () => {
    fetchMock.mockImplementation(responder(401, '{"error":"clave_invalida"}'));
    let sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    sdk.capturar(new Error('y'));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await sdk.flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.clearAllTimers(); // la pestaña se cerró
    fetchMock.mockImplementation(ok);
    sdk = await iniciado();
    await vi.advanceTimersByTimeAsync(2000);
    expect(lotes()[1].map((e) => e.mensaje)).toEqual(['x']);
  });

  it('400 u otro 4xx: descarta el lote, no insiste', async () => {
    fetchMock.mockImplementation(responder(400, '{"error":"cuerpo_invalido"}'));
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('eiai_monitor_cola')).toBe('[]');
  });
});

describe('irse de la página', () => {
  it('pagehide: procesa lo pendiente y lo manda con keepalive, sin esperar los 2 s', async () => {
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    window.dispatchEvent(new Event('pagehide'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    expect(lotes()[0][0].mensaje).toBe('x');
    // Si la pestaña muere antes de la respuesta, lo pendiente ya está guardado.
    expect(localStorage.getItem('eiai_monitor_cola')).toContain('"mensaje":"x"');
  });

  it('visibilitychange a oculto hace lo mismo; a visible, nada', async () => {
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchMock).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    try {
      document.dispatchEvent(new Event('visibilitychange'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].keepalive).toBe(true);
    } finally {
      delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it('lo que quedó de la carga anterior sale en la siguiente, con los mismos id_externo', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    let sdk = await iniciado();
    sdk.capturar(new Error('x'));
    window.dispatchEvent(new Event('pagehide'));
    await vi.advanceTimersByTimeAsync(0);
    const id = lotes()[0][0].id_externo;

    vi.clearAllTimers(); // la pestaña se cerró
    fetchMock.mockImplementation(ok);
    sdk = await iniciado();
    await vi.advanceTimersByTimeAsync(2000);
    expect(lotes()[1].map((e) => e.id_externo)).toEqual([id]);
  });
});

describe('listeners globales', () => {
  it('captura el error no manejado y la promesa rechazada, sin preventDefault', async () => {
    await iniciado();
    const err = new ErrorEvent('error', { error: new RangeError('fuera de rango'), message: 'fuera de rango', cancelable: true });
    window.dispatchEvent(err);
    const rechazo = Object.assign(new Event('unhandledrejection', { cancelable: true }), { reason: new Error('promesa') });
    window.dispatchEvent(rechazo);
    const script = new ErrorEvent('error', { message: 'Script error.', filename: 'https://cdn.x/a.js', lineno: 1, colno: 9 });
    window.dispatchEvent(script);
    expect(err.defaultPrevented).toBe(false);
    expect(rechazo.defaultPrevented).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(lotes()[0].map((e) => [e.tipo_error, e.mensaje])).toEqual([
      ['RangeError', 'fuera de rango'],
      ['Error', 'promesa'],
      [undefined, 'Script error.'],
    ]);
    expect(lotes()[0][2].stack).toBe('at https://cdn.x/a.js:1:9');
  });

  it('no pisa los handlers que ya tenía la página', async () => {
    const propio = vi.fn();
    const listener = vi.fn();
    window.onerror = propio;
    window.addEventListener('error', listener);
    await iniciado();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('x'), message: 'x' }));
    expect(window.onerror).toBe(propio);
    expect(listener).toHaveBeenCalledTimes(1);
    window.onerror = null;
  });
});

describe('React Query', () => {
  it('toma sólo el primer elemento de la key como ubicacion, e ignora lo esperado', async () => {
    const sdk = await iniciado();
    sdk.onErrorQuery(new Error('fallo ventas'), { queryKey: ['ventas', { sucursal: 3, dni: '30111222' }] });
    sdk.onErrorQuery(new Error('key rara'), { queryKey: [{ scope: 'x' }] });
    sdk.onErrorMutation(new Error('fallo cobro'), { monto: 100 }, undefined, { options: { mutationKey: ['cobrar', 55] } });
    sdk.onErrorMutation(new Error('sin key'), undefined, undefined, { options: {} });
    sdk.onErrorQuery({ code: 'PT402', message: 'Sin stock', details: null, hint: null }, { queryKey: ['stock'] });
    await sdk.flush();
    const eventos = lotes().flat();
    expect(eventos.map((e) => [e.mensaje, e.ubicacion])).toEqual([
      ['fallo ventas', 'ventas'],
      ['key rara', undefined],
      ['fallo cobro', 'cobrar'],
      ['sin key', undefined],
    ]);
    expect(JSON.stringify(eventos)).not.toMatch(/30111222|sucursal|monto|scope/);
  });
});
