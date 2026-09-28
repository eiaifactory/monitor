// La primera línea de PII: nada que parezca un dato de una persona sale del dispositivo.
// Es la misma regla que la segunda línea, en finance
// (`supabase/functions/_shared/monitor/pii.ts`): estricto, sólo lo técnico.

import type { Evento, ValorContexto } from './contrato';

export const REDACTADO = '[redactado]';

/** Claves de `contexto` cuyo VALOR no se manda nunca, sea lo que sea. */
const CLAVE_SENSIBLE = /mail|tel|phone|dni|cuit|pass|token|secret|key|clave/i;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * Un teléfono: 8 a 15 dígitos, con espacios o guiones sueltos entre medio, y sin letras,
 * puntos ni guiones pegados a los costados (así no se come un uuid, un `línea:columna` ni una IP).
 * Finance usa un lookbehind para el borde izquierdo; acá se captura el carácter previo, porque
 * un lookbehind es un error de sintaxis en Safari < 16.4 y rompería el bundle del cliente.
 */
const TELEFONO = /(^|[^\w.-])\+?\d(?:[\s-]?\d){7,14}(?![\w.-])/g;

export function redactarTexto(s: string): string {
  return s.replace(EMAIL, REDACTADO).replace(TELEFONO, `$1${REDACTADO}`);
}

function redactarOpcional(s: string | undefined): string | undefined {
  return s === undefined ? s : redactarTexto(s);
}

export function limpiar(e: Evento): Evento {
  let contexto: Record<string, ValorContexto> | undefined;
  if (e.contexto) {
    contexto = {};
    for (const k of Object.keys(e.contexto)) {
      const v = e.contexto[k];
      contexto[k] = CLAVE_SENSIBLE.test(k) ? REDACTADO : typeof v === 'string' ? redactarTexto(v) : v;
    }
  }

  return {
    ...e,
    mensaje: redactarTexto(e.mensaje),
    stack: redactarOpcional(e.stack),
    ruta: redactarOpcional(e.ruta),
    // El usuario tiene que ser un id opaco. Un email acá es un cliente mal configurado.
    usuario_id: e.usuario_id && e.usuario_id.includes('@') ? REDACTADO : e.usuario_id,
    contexto,
  };
}
