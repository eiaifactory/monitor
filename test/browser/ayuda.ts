// Cada test arranca con un SDK nuevo (`vi.resetModules`), un `fetch` falso y el reloj en la mano.
// Los listeners que instala cada instancia se sacan al terminar: si no, un `dispatchEvent` de un
// test le llegaría también a las instancias de los tests anteriores.

import { afterEach, beforeEach, vi, type Mock } from 'vitest';
import type { Evento } from '../../src/core/contrato';

export const CLAVE = 'eiai_mon_dev_' + 'a'.repeat(32);
export const URL_PRUEBA = 'https://finance.test/functions/v1/monitor-ingesta';
export const T0 = Date.UTC(2026, 8, 28, 12, 0, 0);

type Sdk = typeof import('../../src/browser/index');

export let fetchMock: Mock<(url: string, init: RequestInit) => Promise<Response>>;
const instalados: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

export function responder(status: number, cuerpo = '{}', headers?: Record<string, string>) {
  return () => Promise.resolve(new Response(cuerpo, { status, headers }));
}

export const ok = responder(202, '{"recibidos":1,"duplicados":0,"rechazados":[]}');

/** Los eventos de cada llamada a fetch, en orden. */
export function lotes(): Evento[][] {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body as string).eventos);
}

export async function cargarSdk(): Promise<Sdk> {
  vi.resetModules();
  return import('../../src/browser/index');
}

export async function iniciado(opciones: Partial<Parameters<Sdk['initMonitor']>[0]> = {}): Promise<Sdk> {
  const sdk = await cargarSdk();
  sdk.initMonitor({ clave: CLAVE, url: URL_PRUEBA, ...opciones });
  return sdk;
}

beforeEach(() => {
  vi.useFakeTimers({ now: T0 });
  localStorage.clear();
  fetchMock = vi.fn(ok);
  vi.stubGlobal('fetch', fetchMock);
  for (const t of [window, document] as EventTarget[]) {
    const original = t.addEventListener.bind(t);
    vi.spyOn(t, 'addEventListener').mockImplementation((tipo, fn, o) => {
      if (fn) instalados.push([t, tipo, fn]);
      original(tipo, fn, o);
    });
  }
});

afterEach(() => {
  for (const [t, tipo, fn] of instalados.splice(0)) t.removeEventListener(tipo, fn);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
