import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BYTES_CUERPO, MAX_BYTES_LOTE, TOPES, type Evento } from '../../src/core/contrato';
import { armarLote, decidir, hastaProximoMinuto, postear } from '../../src/core/envio';

let n = 0;
const evento = (over: Partial<Evento> = {}): Evento => ({
  id_externo: `00000000-0000-4000-8000-${String(n++).padStart(12, '0')}`,
  origen: 'browser',
  mensaje: 'x',
  ...over,
});

/** El evento más pesado que permiten los topes del contrato. */
const pesado = () =>
  evento({
    mensaje: 'm'.repeat(TOPES.mensaje),
    stack: 's'.repeat(TOPES.stack),
    user_agent: 'u'.repeat(TOPES.user_agent),
    ruta: '/'.repeat(TOPES.ruta),
    contexto: Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`k${i}`, 'v'.repeat(256)])),
  });

const bytes = (eventos: Evento[]) => new TextEncoder().encode(JSON.stringify({ eventos })).length;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('armarLote', () => {
  it('hasta 20 eventos', () => {
    const items = Array.from({ length: 30 }, () => ({ e: evento() }));
    expect(armarLote(items)).toHaveLength(20);
    expect(armarLote(items, 7)).toHaveLength(7);
  });

  it('20 eventos al tope pasarían los 64 KB de la ingesta: el lote corta antes de 60 KB', () => {
    const items = Array.from({ length: 20 }, () => ({ e: pesado() }));
    expect(bytes(items.map((i) => i.e))).toBeGreaterThan(MAX_BYTES_CUERPO);
    const lote = armarLote(items);
    expect(lote.length).toBeGreaterThan(1);
    expect(lote.length).toBeLessThan(20);
    expect(bytes(lote.map((i) => i.e))).toBeLessThanOrEqual(MAX_BYTES_LOTE);
  });

  it('el primero va siempre, aunque solo no entre', () => {
    const enorme = { e: evento({ stack: 's'.repeat(MAX_BYTES_LOTE) }) };
    expect(armarLote([enorme, { e: evento() }])).toEqual([enorme]);
  });
});

describe('decidir', () => {
  const ahora = Date.UTC(2026, 8, 28, 12, 0, 45);

  it('mapea cada status del contrato', () => {
    expect(decidir(202, null, ahora)).toEqual({ r: 'ok' });
    expect(decidir(400, null, ahora)).toEqual({ r: 'descartar' });
    expect(decidir(401, null, ahora)).toEqual({ r: 'apagar' });
    expect(decidir(405, null, ahora)).toEqual({ r: 'descartar' });
    expect(decidir(413, null, ahora)).toEqual({ r: 'partir' });
    expect(decidir(500, null, ahora)).toEqual({ r: 'reintentar' });
    expect(decidir(503, null, ahora)).toEqual({ r: 'reintentar' });
  });

  it('429: Retry-After si se puede leer; si no, hasta el próximo minuto de reloj', () => {
    expect(decidir(429, '7', ahora)).toEqual({ r: 'cuota', esperaMs: 7000 });
    expect(decidir(429, null, ahora)).toEqual({ r: 'cuota', esperaMs: 15_000 });
    expect(decidir(429, 'basura', ahora)).toEqual({ r: 'cuota', esperaMs: 15_000 });
    expect(hastaProximoMinuto(Date.UTC(2026, 8, 28, 12, 1, 0))).toBe(60_000);
  });
});

describe('postear', () => {
  const base = { url: 'https://finance.test/monitor-ingesta', clave: 'eiai_mon_dev_' + '0'.repeat(32), timeoutMs: 3000 };

  it('POST con Bearer y el lote; la clave nunca en la URL', async () => {
    const fetch = vi.fn(async () => new Response('{"recibidos":1,"duplicados":0,"rechazados":[]}', { status: 202 }));
    vi.stubGlobal('fetch', fetch);
    const e = evento();
    expect(await postear({ ...base, eventos: [e] })).toEqual({ r: 'ok' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(base.url);
    expect(url).not.toContain('eiai_mon');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${base.clave}`);
    expect(JSON.parse(init.body as string)).toEqual({ eventos: [e] });
    expect(init.keepalive).toBe(false);
  });

  it('lee Retry-After cuando el server lo expone', async () => {
    vi.stubGlobal('fetch', async () => new Response('{"error":"cuota_excedida"}', { status: 429, headers: { 'Retry-After': '12' } }));
    expect(await postear({ ...base, eventos: [evento()] })).toEqual({ r: 'cuota', esperaMs: 12_000 });
  });

  it('red caída, fetch inexistente o timeout: reintentar, sin lanzar', async () => {
    vi.stubGlobal('fetch', async () => { throw new TypeError('Failed to fetch'); });
    expect(await postear({ ...base, eventos: [evento()] })).toEqual({ r: 'reintentar' });

    vi.stubGlobal('fetch', undefined);
    expect(await postear({ ...base, eventos: [evento()] })).toEqual({ r: 'reintentar' });

    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_u: string, init: RequestInit) =>
      new Promise((_, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const p = postear({ ...base, eventos: [evento()] });
    await vi.advanceTimersByTimeAsync(3000);
    expect(await p).toEqual({ r: 'reintentar' });
  });
});
