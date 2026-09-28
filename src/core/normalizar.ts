// Cualquier cosa que se tire → un evento del contrato, recortado a sus topes y sin PII.
// Nada de acá lanza: un `throw` de un objeto raro no puede romper al que lo reporta.

import { MAX_BYTES_CONTEXTO, TOPES, recortar, type Evento, type OrigenExterno, type ValorContexto } from './contrato';
import { nuevoId } from './id';
import { limpiar } from './pii';

export interface ErrorNormalizado {
  mensaje: string;
  tipo_error?: string;
  codigo?: string;
  stack?: string;
}

function texto(v: unknown, tope: number): string | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t ? recortar(t, tope) : undefined;
}

/**
 * Un objeto sin `message`. Uno plano o un array, su JSON; cualquier otro (un `Event` rechazado
 * en una promesa, que en JSON es `{"isTrusted":false}`), su etiqueta: `[object Event]`.
 */
function describir(o: object): string {
  const etiqueta = Object.prototype.toString.call(o);
  if (etiqueta === '[object Object]' || etiqueta === '[object Array]') {
    try {
      const json = JSON.stringify(o);
      if (json && json !== '{}') return json;
    } catch {
      // circular o con getters que lanzan: cae a la etiqueta
    }
  }
  return etiqueta;
}

/**
 * Entiende `Error` y sus subclases, los errores de Supabase (PostgREST trae `code`, `message`,
 * `details` y `hint`; Auth y Functions traen `status` o `context.status`), strings y cualquier
 * otra cosa. `details` y `hint` no se mandan: traen valores de filas.
 */
export function normalizar(error: unknown): ErrorNormalizado {
  try {
    if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
      return { mensaje: texto(String(error), TOPES.mensaje) ?? 'Error sin mensaje' };
    }
    const o = error as Record<string, unknown>;
    const ctx = o.context as { status?: unknown } | undefined;
    const esPostgrest = typeof o.code === 'string' && ('details' in o || 'hint' in o);
    return {
      mensaje: texto(o.message, TOPES.mensaje) ?? recortar(describir(o), TOPES.mensaje),
      tipo_error: texto(o.name, TOPES.tipo_error) ?? (esPostgrest ? 'PostgrestError' : undefined),
      codigo: texto(o.code ?? o.status ?? o.statusCode ?? ctx?.status, TOPES.codigo),
      stack: texto(o.stack, TOPES.stack),
    };
  } catch {
    return { mensaje: 'Error no legible' };
  }
}

/** Sólo escalares, strings de hasta 256, y no más de 2 KB: si no entra, se cortan claves del final. */
export function contextoPlano(v: unknown): Record<string, ValorContexto> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, ValorContexto> = {};
  for (const k of Object.keys(v)) {
    const val = (v as Record<string, unknown>)[k];
    if (val === null || typeof val === 'boolean') out[k] = val;
    else if (typeof val === 'number') out[k] = Number.isFinite(val) ? val : null;
    else if (typeof val === 'string') out[k] = recortar(val, 256);
  }
  const claves = Object.keys(out);
  if (!claves.length) return undefined;
  while (claves.length && new TextEncoder().encode(JSON.stringify(out)).length > MAX_BYTES_CONTEXTO) {
    delete out[claves.pop()!];
    out._cortado = true;
  }
  return out;
}

/** La ruta sin query ni hash: ahí viajan tokens y emails, y no hacen al error. */
function ruta(v: string | undefined): string | undefined {
  return texto(v?.split(/[?#]/)[0], TOPES.ruta);
}

export interface Captura {
  error: unknown;
  origen: OrigenExterno;
  /** `Date.now()` del momento en que ocurrió. */
  ocurrido: number;
  ruta?: string;
  ubicacion?: string;
  release?: string;
  usuario_id?: string;
  rol?: string;
  dispositivo_id?: string;
  user_agent?: string;
  contexto?: Record<string, unknown>;
}

export function armarEvento(c: Captura): Evento {
  return limpiar({
    id_externo: nuevoId(),
    origen: c.origen,
    ...normalizar(c.error),
    ocurrido_at: new Date(c.ocurrido).toISOString(),
    ubicacion: texto(c.ubicacion, TOPES.ubicacion),
    ruta: ruta(c.ruta),
    release: texto(c.release, TOPES.release),
    usuario_id: texto(c.usuario_id, TOPES.usuario_id),
    rol: texto(c.rol, TOPES.rol),
    dispositivo_id: texto(c.dispositivo_id, TOPES.dispositivo_id),
    user_agent: texto(c.user_agent, TOPES.user_agent),
    contexto: contextoPlano(c.contexto),
    repeticiones: 1,
  });
}
