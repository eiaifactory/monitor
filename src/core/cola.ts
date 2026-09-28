// La cola del dispositivo: con tope, con freno por minuto, y serializable para sobrevivir a
// una recarga. Lo que no entra se pierde con criterio: primero lo más viejo.

import { huellaLocal, VENTANA_COLAPSO_MS } from './colapso';
import type { Evento } from './contrato';

export interface Item {
  e: Evento;
  /** Huella local, para el colapso. */
  h: number;
  /** Cuándo entró (ms): abre la ventana de colapso. */
  t: number;
  /** En vuelo: ya salió en un lote y todavía no hay respuesta. No se colapsa sobre él. */
  v?: boolean;
}

export interface Cola {
  items: Item[];
  minuto: number;
  enMinuto: number;
}

export function crearCola(): Cola {
  return { items: [], minuto: 0, enMinuto: 0 };
}

export type Encolado = 'encolado' | 'colapsado' | 'tope_por_minuto';

export function encolar(c: Cola, e: Evento, ahora: number, max: number, maxPorMinuto: number): Encolado {
  const h = huellaLocal(e);
  const previo = c.items.find((i) => !i.v && i.h === h && ahora - i.t < VENTANA_COLAPSO_MS);
  if (previo) {
    previo.e.repeticiones = (previo.e.repeticiones ?? 1) + 1;
    return 'colapsado';
  }

  const minuto = Math.floor(ahora / 60_000);
  if (minuto !== c.minuto) {
    c.minuto = minuto;
    c.enMinuto = 0;
  }
  if (c.enMinuto >= maxPorMinuto) return 'tope_por_minuto';
  c.enMinuto++;

  c.items.push({ e, h, t: ahora });
  if (c.items.length > max) c.items.splice(0, c.items.length - max);
  return 'encolado';
}

/**
 * Lo que se guarda no pasa de este tamaño (el `localStorage` guarda UTF-16: 2 bytes por
 * carácter). El `localStorage` es del cliente, no nuestro: llenárselo rompería su sistema.
 */
export const MAX_BYTES_PERSISTIDOS = 128 * 1024;

/** A JSON, sin la marca de en vuelo, quedándose con lo más nuevo que entre. */
export function serializar(items: Item[]): string {
  const partes = items.map(({ e, h, t }) => JSON.stringify({ e, h, t }));
  let caracteres = 2;
  let desde = partes.length;
  while (desde > 0 && (caracteres + partes[desde - 1].length + 1) * 2 <= MAX_BYTES_PERSISTIDOS) {
    caracteres += partes[--desde].length + 1;
  }
  return `[${partes.slice(desde).join(',')}]`;
}

/** Lo guardado por una carga anterior. Si no tiene la forma esperada, se ignora entero. */
export function deserializar(s: string | null): Item[] {
  try {
    const v: unknown = s ? JSON.parse(s) : [];
    if (!Array.isArray(v)) return [];
    return v.filter(
      (i): i is Item =>
        !!i && typeof i === 'object' && !!i.e && typeof i.e.id_externo === 'string' &&
        typeof i.e.mensaje === 'string' && typeof i.h === 'number' && typeof i.t === 'number',
    );
  } catch {
    return [];
  }
}
