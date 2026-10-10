// Regla 0 del spec: invisible para el usuario final. Capturar no lee el error ni hace red ni
// storage en el mismo tick, nunca lanza, y un fallo propio no vuelve a entrar al SDK.

import { describe, expect, it, vi } from 'vitest';
import { cargarSdk, fetchMock, iniciado, lotes } from './ayuda';

function storageEspiado(orden: string[]) {
  const datos = new Map<string, string>();
  return {
    getItem: vi.fn((k: string) => (orden.push('storage'), datos.get(k) ?? null)),
    setItem: vi.fn((k: string, v: string) => (orden.push('storage'), void datos.set(k, v))),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  };
}

/** Un error que anota cada propiedad que se le lee: si capturar no lo lee, su tamaño no le cuesta. */
function errorEspiado(mensaje: string, lecturas: PropertyKey[]): Error {
  return new Proxy(new Error(mensaje), {
    get: (e, k) => (lecturas.push(k), Reflect.get(e, k)),
    has: (e, k) => (lecturas.push(k), Reflect.has(e, k)),
    ownKeys: (e) => (lecturas.push('ownKeys'), Reflect.ownKeys(e)),
  });
}

describe('capturar, en el mismo tick', () => {
  it('no toca la red ni el storage: todo pasa después, y en ese orden', async () => {
    const orden: string[] = [];
    vi.stubGlobal('localStorage', storageEspiado(orden));
    fetchMock.mockImplementation(() => (orden.push('fetch'), Promise.resolve(new Response('{}', { status: 202 }))));
    const sdk = await iniciado();

    sdk.capturar(new Error('x'));
    sdk.capturar(new TypeError('y'));
    expect(orden).toEqual([]);

    await vi.advanceTimersByTimeAsync(0);
    expect(orden.length).toBeGreaterThan(0);
    expect(orden).not.toContain('fetch');

    await vi.advanceTimersByTimeAsync(2000);
    expect(orden[orden.length - 2]).toBe('fetch');
    expect(orden.indexOf('fetch')).toBeGreaterThan(orden.indexOf('storage'));
  });

  // Sin medir milisegundos: en un runner compartido, el «peor de 100» medía al recolector de
  // basura y al scheduler, no a capturar. Lo que la hace barata es lo que NO hace, y eso se ve.
  it('no lee el error ni serializa nada, aun con uno de 1 MB: 100 capturas programan un solo setTimeout(0)', async () => {
    vi.stubGlobal('requestIdleCallback', undefined); // Safari
    const sdk = await iniciado();
    await vi.advanceTimersByTimeAsync(0); // el proceso que programa initMonitor
    const lecturas: PropertyKey[] = [];
    const errores = Array.from({ length: 100 }, (_, i) => errorEspiado(i ? `e${i}` : 'm'.repeat(1024 * 1024), lecturas));
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const stringify = vi.spyOn(JSON, 'stringify');

    for (const e of errores) sdk.capturar(e);
    expect(lecturas).toEqual([]);
    expect(stringify).not.toHaveBeenCalled();
    expect(timeout.mock.calls).toEqual([[expect.any(Function), 0]]);

    // El trabajo pesado pasa, pero después: el de 1 MB sale recortado.
    await vi.advanceTimersByTimeAsync(0);
    expect(lecturas).toContain('message');
    await sdk.flush();
    expect(lotes()[0][0].mensaje).toBe('m'.repeat(1014) + '…[cortado]');
  });

  it('con requestIdleCallback espera a que el navegador esté ocioso: ningún timer lo procesa antes', async () => {
    const ociosos: Array<() => void> = [];
    const ric = vi.fn((cb: () => void) => ociosos.push(cb));
    vi.stubGlobal('requestIdleCallback', ric);
    const sdk = await iniciado();
    ociosos.shift()!(); // el proceso que programa initMonitor

    sdk.capturar(new Error('x'));
    // Con `timeout`, una página que nunca está ociosa no lo posterga para siempre.
    expect(ric).toHaveBeenLastCalledWith(expect.any(Function), { timeout: expect.any(Number) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(localStorage.getItem('eiai_monitor_cola')).toBeNull();

    ociosos.shift()!();
    expect(localStorage.getItem('eiai_monitor_cola')).toContain('"mensaje":"x"');
  });
});

describe('nunca lanza', () => {
  it('con cualquier cosa que se le tire', async () => {
    const sdk = await iniciado();
    const circular: Record<string, unknown> = {};
    circular.yo = circular;
    const trampa = new Proxy({}, { get() { throw new Error('no'); }, ownKeys() { throw new Error('no'); } });
    // Sin `new Event()`: el de happy-dom no tiene toStringTag (el de Chrome y Node sí; está en test/core).
    const raros = [circular, null, undefined, Symbol('s'), 'm'.repeat(1024 * 1024), trampa, 42, () => 1, new Map()];
    for (const r of raros) {
      expect(() => sdk.capturar(r, { contexto: circular as never })).not.toThrow();
      expect(() => sdk.onErrorQuery(r, trampa as never)).not.toThrow();
      expect(() => sdk.onErrorMutation(r, r, r, trampa as never)).not.toThrow();
    }
    expect(() => sdk.setContext(trampa as never)).not.toThrow();
    await expect(sdk.flush()).resolves.toBeUndefined();
    // Cada cosa rara llega como un evento válido (lo de React Query se colapsa con su gemelo;
    // con una query que lanza al leer la key, ese se pierde, no el SDK).
    const mensajes = lotes().flat().map((e) => e.mensaje).sort();
    expect(mensajes).toEqual(
      ['[object Object]', 'null', 'undefined', 'Symbol(s)', 'm'.repeat(1014) + '…[cortado]', 'Error no legible', '42', '[object Function]', '[object Map]'].sort(),
    );
    for (const e of lotes().flat()) expect(e.id_externo).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('con localStorage que tira: sigue mandando desde memoria', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    });
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await sdk.flush();
    expect(lotes()[0][0]).toMatchObject({ mensaje: 'x' });
    expect(lotes()[0][0].dispositivo_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('con fetch que no existe, que rechaza, o finance que devuelve 500, 429 o no contesta', async () => {
    const sdk = await iniciado();
    const casos: Array<() => Promise<Response>> = [
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(new Response('{}', { status: 500 })),
      () => Promise.resolve(new Response('{"error":"cuota_excedida"}', { status: 429 })),
      () => new Promise(() => {}),
    ];
    for (const caso of casos) {
      fetchMock.mockImplementation(caso);
      sdk.capturar(new Error('x'));
      await vi.advanceTimersByTimeAsync(70_000);
    }
    vi.stubGlobal('fetch', undefined);
    sdk.capturar(new Error('y'));
    await vi.advanceTimersByTimeAsync(70_000);

    // Cuando finance vuelve, lo que quedó en la cola sale: nada se trabó.
    fetchMock.mockImplementation(() => Promise.resolve(new Response('{}', { status: 202 })));
    vi.stubGlobal('fetch', fetchMock);
    await vi.advanceTimersByTimeAsync(35_000); // lo que falte del backoff
    expect(localStorage.getItem('eiai_monitor_cola')).toBe('[]');
    const todos = lotes();
    expect(todos[todos.length - 1].map((e) => e.mensaje)).toContain('y');
  });

  it('un fallo propio no llega a unhandledrejection ni vuelve a entrar como evento', async () => {
    const rechazos: unknown[] = [];
    window.addEventListener('unhandledrejection', (e) => rechazos.push(e));
    const deNode: unknown[] = [];
    const alNode = (r: unknown) => deNode.push(r);
    process.on('unhandledRejection', alNode);
    try {
      fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
      const sdk = await iniciado();
      sdk.capturar(new Error('original'));
      await vi.advanceTimersByTimeAsync(120_000);
      expect(fetchMock.mock.calls.length).toBeGreaterThan(3);
      expect(rechazos).toEqual([]);
      expect(deNode).toEqual([]);
      // Cada reintento manda sólo el error original: ninguno propio se coló en la cola.
      for (const l of lotes()) expect(l.map((e) => e.mensaje)).toEqual(['original']);
    } finally {
      process.off('unhandledRejection', alNode);
    }
  });
});

describe('sin clave, sin window', () => {
  it('sin clave no instala nada, no captura y no toca red ni storage', async () => {
    const sdk = await cargarSdk();
    sdk.initMonitor({ clave: undefined });
    sdk.initMonitor({ clave: '' });
    sdk.capturar(new Error('x'));
    await sdk.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(window.addEventListener).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  it('sin window (SSR, workers) no hace nada', async () => {
    vi.stubGlobal('window', undefined);
    const sdk = await cargarSdk();
    sdk.initMonitor({ clave: 'eiai_mon_dev_x' });
    sdk.capturar(new Error('x'));
    await sdk.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sin console propio, salvo debug', async () => {
    const debug = vi.spyOn(console, 'debug');
    const otros = ['log', 'info', 'warn', 'error'].map((m) => vi.spyOn(console, m as 'log'));
    fetchMock.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    let sdk = await iniciado();
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(debug).not.toHaveBeenCalled();
    sdk = await iniciado({ debug: true });
    sdk.capturar(new Error('x'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(debug).toHaveBeenCalled();
    for (const o of otros) expect(o).not.toHaveBeenCalled();
  });
});
