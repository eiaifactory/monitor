// El contrato HTTP v1 del Monitor, del lado de quien emite.
//
// Es una COPIA de `supabase/functions/_shared/monitor/tipos.ts` (y de `recortar` en
// `validar.ts`) del repo eiaifactory/eiaifactory-finance:
// https://github.com/eiaifactory/eiaifactory-finance/blob/main/supabase/functions/_shared/monitor/tipos.ts
// El server es la autoridad: si esto se desfasa, finance recorta o rechaza por evento, nunca
// el lote entero. Cambiar el contrato es versionar (`/v2`), no editar.

export const URL_FINANCE = 'https://qoyskdjcjyjxcnhruhni.supabase.co/functions/v1/monitor-ingesta';

/** Lo que un emisor externo puede declarar. `latido` no está: lo genera finance, nunca afuera. */
export const ORIGENES_EXTERNOS = ['browser', 'edge', 'servidor', 'db', 'ci', 'deploy'] as const;
export type OrigenExterno = (typeof ORIGENES_EXTERNOS)[number];

export const MAX_EVENTOS_POR_LOTE = 20;
export const MAX_BYTES_CUERPO = 64 * 1024;
export const MAX_BYTES_CONTEXTO = 2 * 1024;

/** Lo que el SDK se permite por lote: debajo de `MAX_BYTES_CUERPO`, con margen para el envoltorio. */
export const MAX_BYTES_LOTE = 60 * 1024;

/**
 * Topes por campo, en caracteres. Un string más largo se RECORTA (con `…[cortado]`), no se
 * rechaza: un stack de 20 KB sigue siendo un error que hay que ver.
 */
export const TOPES = {
  mensaje: 1024,
  tipo_error: 128,
  codigo: 64,
  stack: 8192,
  ubicacion: 256,
  ruta: 512,
  release: 64,
  usuario_id: 64,
  rol: 64,
  dispositivo_id: 64,
  user_agent: 512,
  huella_manual: 128,
} as const;

export type ValorContexto = string | number | boolean | null;

/** Un evento tal como viaja. Lo que no se sabe, no se manda. */
export interface Evento {
  id_externo: string;
  origen: OrigenExterno;
  mensaje: string;
  ocurrido_at?: string;
  tipo_error?: string;
  codigo?: string;
  stack?: string;
  ubicacion?: string;
  ruta?: string;
  release?: string;
  usuario_id?: string;
  rol?: string;
  dispositivo_id?: string;
  user_agent?: string;
  contexto?: Record<string, ValorContexto>;
  repeticiones?: number;
  huella_manual?: string;
}

const CORTE = '…[cortado]';

/** Recorta al tope dejando la marca de que se cortó: un stack truncado sin aviso engaña. */
export function recortar(s: string, tope: number): string {
  return s.length <= tope ? s : s.slice(0, tope - CORTE.length) + CORTE;
}
