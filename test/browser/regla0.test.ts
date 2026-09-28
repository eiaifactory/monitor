// Regla 0 del spec: invisible para el usuario final. Capturar no hace red ni storage en el
// mismo tick, nunca lanza, y un fallo propio no vuelve a entrar al SDK.

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

  it('retorna en menos de 1 ms, aun con un error de 1 MB', async () => {
    vi.useRealTimers();
    const sdk = await iniciado();
    const enorme = new Error('m'.repeat(1024 * 1024));
    let peor = 0;
    for (let i = 0; i < 100; i++) {
      const t = process.hrtime.bigint();
      sdk.capturar(i % 2 ? enorme : new Error(`e${i}`));
      peor = Math.max(peor, Number(process.hrtime.bigint() - t) / 1e6);
    }
    expect(peor).toBeLessThan(1);
    await sdk.flush(); // que no quede un timer real mandando después del test
  });

  it('usa requestIdleCallback cuando existe (y setTimeout(0) cuando no, como en Safari)', async () => {
    const ric = vi.fn((cb: () => void) => setTimeout(cb, 50));
    vi.stubGlobal('requestIdleCallback', ric);
    const sdk = await iniciado();
    sdk.capturar(new Error('x'));
    expect(ric).toHaveBeenCalled();
    expect(localStorage.getItem('eiai_monitor_cola')).toBeNull();
    await vi.advanceTimersByTimeAsync(50);
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
