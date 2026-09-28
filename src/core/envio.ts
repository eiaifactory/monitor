// El envío: armar un lote que finance acepte, mandarlo, y traducir la respuesta a qué hacer.
// Nada de acá lanza ni deja una promesa sin atajar: un fallo propio que llegue a
// `unhandledrejection` lo capturaría el mismo SDK, y eso es un bucle en el navegador del cliente.

import { MAX_BYTES_LOTE, MAX_EVENTOS_POR_LOTE, type Evento } from './contrato';

/** Espera tras cada fallo seguido de red o 5xx. */
export const ESPERAS_MS = [1000, 2000, 4000, 30_000];

export type Resultado =
  | { r: 'ok' }
  | { r: 'cuota'; esperaMs: number }
  | { r: 'reintentar' }
  | { r: 'partir' }
  | { r: 'descartar' }
  | { r: 'apagar' };

const bytes = (s: string) => new TextEncoder().encode(s).length;

/**
 * Los primeros items que entran en un lote: hasta `maxEventos` y hasta `MAX_BYTES_LOTE`
 * serializado. Con los topes del contrato un evento pesa hasta ~12 KB y 20 juntos pasarían los
 * 64 KB de la ingesta. El primero va siempre: si solo no entra, el 413 lo descarta.
 */
export function armarLote<T extends { e: Evento }>(items: T[], maxEventos = MAX_EVENTOS_POR_LOTE): T[] {
  const lote: T[] = [];
  let total = bytes('{"eventos":[]}');
  for (const it of items) {
    if (lote.length >= maxEventos) break;
    const n = bytes(JSON.stringify(it.e)) + (lote.length ? 1 : 0);
    if (lote.length && total + n > MAX_BYTES_LOTE) break;
    total += n;
    lote.push(it);
  }
  return lote;
}

/** Hasta el próximo minuto de reloj: así cuenta finance la cuota. */
export function hastaProximoMinuto(ahora: number): number {
  return 60_000 - (ahora % 60_000);
}

/**
 * `Retry-After` sólo se puede leer si el server lo expone por CORS; en el navegador hoy no
 * (finance no manda `Access-Control-Expose-Headers`). Sin header, al próximo minuto.
 */
export function decidir(status: number, retryAfter: string | null, ahora: number): Resultado {
  if (status >= 200 && status < 300) return { r: 'ok' };
  if (status === 429) {
    const s = Number(retryAfter);
    return { r: 'cuota', esperaMs: retryAfter && s > 0 ? s * 1000 : hastaProximoMinuto(ahora) };
  }
  if (status === 401) return { r: 'apagar' };
  if (status === 413) return { r: 'partir' };
  if (status >= 500) return { r: 'reintentar' };
  // 400 (el SDK no manda cuerpos inválidos: sería un bug) y cualquier otro 4xx: reintentar
  // el mismo lote daría lo mismo.
  return { r: 'descartar' };
}

export interface Envio {
  url: string;
  clave: string;
  eventos: Evento[];
  timeoutMs: number;
  /** Sólo al irse de la página: la petición sobrevive a la pestaña. */
  keepalive?: boolean;
  debug?: (...a: unknown[]) => void;
}

/**
 * El plazo corta por su cuenta y además aborta: un `fetch` que ignora la señal (un polyfill)
 * no puede dejar el envío colgado para siempre.
 */
export async function postear(o: Envio): Promise<Resultado> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : undefined;
    const plazo = new Promise<Resultado>((fin) => {
      timer = setTimeout(() => {
        o.debug?.('timeout');
        ctrl?.abort();
        fin({ r: 'reintentar' });
      }, o.timeoutMs);
    });
    const intento = (async (): Promise<Resultado> => {
      try {
        const res = await fetch(o.url, {
          method: 'POST',
          headers: { authorization: `Bearer ${o.clave}`, 'content-type': 'application/json' },
          body: JSON.stringify({ eventos: o.eventos }),
          keepalive: !!o.keepalive,
          signal: ctrl?.signal,
        });
        // El cuerpo se lee siempre: en Deno, una respuesta sin consumir retiene la conexión.
        const cuerpo = await res.text();
        o.debug?.(res.status, cuerpo);
        return decidir(res.status, res.headers.get('retry-after'), Date.now());
      } catch (e) {
        o.debug?.('sin respuesta', e);
        return { r: 'reintentar' };
      }
    })();
    return await Promise.race([intento, plazo]);
  } catch {
    return { r: 'reintentar' };
  } finally {
    clearTimeout(timer);
  }
}
