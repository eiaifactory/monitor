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

/**
 * Origen + tipo + mensaje + la primera línea de stack que es un frame (`at …` o `f@…`) +
 * `ubicacion` + `codigo`, lo mismo que separa la huella v3 de finance. Sin la `ubicacion`, el mismo
 * timeout de 12 RPC distintas salía como UN evento con el endpoint de la primera; sin el `codigo`,
 * dos fallas del mismo endpoint con códigos distintos salían como una, con el código de la primera,
 * y finance ya no las puede separar.
 */
export function huellaLocal(e: Evento): number {
  const frame = (e.stack ?? '').split('\n').find((l) => /^\s*at\s|@/.test(l)) ?? '';
  return fnv1a([e.origen, e.tipo_error ?? '', e.mensaje, frame.trim(), e.ubicacion ?? '', e.codigo ?? ''].join('|'));
}
