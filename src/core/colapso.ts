// El colapso local: el mismo error repetido en ráfaga viaja como UN evento con `repeticiones`.
// No reemplaza a la huella de finance (que agrupa de verdad); sólo ahorra red y cuota.

import type { Evento } from './contrato';

export const VENTANA_COLAPSO_MS = 10_000;

/** FNV-1a de 32 bits: corto, sin dependencias y suficiente para comparar dentro de una cola de 50. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Origen + tipo + mensaje + la primera línea de stack que es un frame (`at …` o `f@…`). */
export function huellaLocal(e: Evento): number {
  const frame = (e.stack ?? '').split('\n').find((l) => /^\s*at\s|@/.test(l)) ?? '';
  return fnv1a([e.origen, e.tipo_error ?? '', e.mensaje, frame.trim()].join('|'));
}
