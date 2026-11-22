// La entrada de servidor: edge functions de Supabase (Deno) y cualquier runtime con `fetch`
// (Node en Railway, con `origen: 'servidor'`).
//
// Responde primero, manda después: la respuesta de la función sale tal cual y el envío va en
// `EdgeRuntime.waitUntil`. Nada de acá lanza hacia la función del cliente.

import { MAX_EVENTOS_POR_LOTE, URL_FINANCE, type Evento, type ValorContexto } from '../core/contrato';
import { armarLote, postear, type Resultado } from '../core/envio';
import { esEsperado } from '../core/esperado';
import { armarEvento } from '../core/normalizar';

export { esEsperado };
export type { ValorContexto };

export interface OpcionesServidor {
  /** El secreto `MONITOR_CLAVE`. Sin clave, no hace nada. */
  clave: string | undefined;
  /** Por defecto, la ingesta de finance. */
  url?: string;
  release?: string;
  /** El nombre de la función: va como `ubicacion` de cada evento. */
  funcion: string;
  /** `edge` (default) o `servidor` (Node, Railway). */
  origen?: 'edge' | 'servidor';
}

export interface Extra {
  ruta?: string;
  ubicacion?: string;
  contexto?: Record<string, ValorContexto>;
}

export interface Monitor {
  readonly funcion: string;
  capturar(error: unknown, extra?: Extra): void;
  /** Manda lo capturado: 2 s por intento y un reintento. Nunca rechaza. */
  flush(): Promise<void>;
}

const TIMEOUT_MS = 2000;
/** Lo que se acumula sin mandar. Una función que tira en bucle no puede comerse la memoria. */
const MAX_PENDIENTES = 50;

function esperar(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function initMonitor(o: OpcionesServidor): Monitor {
  const pendientes: Evento[] = [];
  let apagado = !o.clave;
  let enCurso: Promise<void> | undefined;

  const intentar = (eventos: Evento[]) =>
    postear({ url: o.url ?? URL_FINANCE, clave: o.clave ?? '', eventos, timeoutMs: TIMEOUT_MS });

  async function mandar(): Promise<void> {
    let limite = MAX_EVENTOS_POR_LOTE;
    while (pendientes.length && !apagado) {
      const lote = armarLote(pendientes.map((e) => ({ e })), limite).map((i) => i.e);
      let r: Resultado = await intentar(lote);
      if (r.r === 'reintentar' || r.r === 'cuota') {
        // Un solo reintento. Ya se respondió: esto no lo espera nadie, pero la función tiene un
        // tope de vida, así que la cuota se espera hasta 10 s y no más.
        await esperar(r.r === 'cuota' ? Math.min(r.esperaMs, 10_000) : 1000);
        r = await intentar(lote);
      }
      if (r.r === 'apagar') {
        apagado = true;
        pendientes.length = 0;
        return;
      }
      if (r.r === 'partir' && lote.length > 1) {
        limite = lote.length >> 1;
        continue;
      }
      // Mandado, descartado o perdido tras el reintento: sale de la cola.
      pendientes.splice(0, lote.length);
    }
  }

  return {
    funcion: o.funcion,
    capturar(error, extra) {
      try {
        if (apagado || esEsperado(error)) return;
        if (pendientes.length >= MAX_PENDIENTES) pendientes.shift();
        pendientes.push(
          armarEvento({
            error,
            origen: o.origen ?? 'edge',
            ocurrido: Date.now(),
            ruta: extra?.ruta,
            ubicacion: extra?.ubicacion ?? o.funcion,
            release: o.release,
            contexto: extra?.contexto,
          }),
        );
      } catch {
        // Regla 0
      }
    },
    flush() {
      return (enCurso ??= mandar()
        .catch(() => undefined)
        .finally(() => {
          enCurso = undefined;
        }));
    },
  };
}

export interface OpcionesHandler {
  /** Además de los esperados de siempre (PT4xx, AbortError, 401/403). */
  esEsperado?: (error: unknown) => boolean;
  /** La respuesta cuando la función lanza (con los headers de CORS de la función). Default: 500 JSON. */
  aRespuesta?: (error: unknown) => Response;
}

/** Qué paso de la función falló y con qué código: lo lee `withHandler` al reportar una 5xx. */
export interface Falla {
  /** Un identificador fijo del código: la RPC, la tabla o el servicio de afuera. Nunca un valor. */
  paso: string;
  /**
   * El SQLSTATE (`57014`) o el `PGRSTnnn` que devolvió la base, o un texto fijo del programa en
   * minúscula (`timeout`, `anthropic_status_529`). Nunca algo que escribió una persona. Con
   * `tercero`, es lo que devolvió el servicio de afuera (`http_503`, `timeout`, `red`), no el status
   * de esta función.
   */
  codigo?: string;
  /**
   * (0.1.5) El servicio de afuera que falló (`interbanking`, `flete47`): viaja como
   * `contexto.tercero`. Finance lo manda a Terceros sólo si el servicio está en su lista y el código
   * en su vocabulario (`http_500`…`http_599`, `http_429`, `timeout`, `red`, `servidor`); si no, entra
   * como error, como siempre. Con la forma del paso; si no la tiene, no viaja.
   */
  tercero?: string;
  /**
   * (0.1.5) Si es el último intento. Con `false`, `withHandler` devuelve la respuesta igual y no la
   * reporta: quien reintenta va a volver a pedir. Por defecto (y con cualquier cosa que no sea
   * `false`) se reporta: si no se dice qué intento es, nunca se pierde.
   */
  final?: boolean;
}

/**
 * Fuera de banda a propósito: ni el body (trae el mensaje crudo de Postgres y los `issues` de zod)
 * ni un header (llegaría al navegador). Débil: la respuesta se libera sola.
 */
const fallas = new WeakMap<Response, Falla>();

/** Lo que finance sabe leer del mensaje (`en ([A-Za-z_][\w.]*)`): con un `/` o un `-` lo cortaría. */
const PASO = /^[A-Za-z_][\w.]{0,63}$/;
/**
 * El texto en minúscula (0.1.4) no deja pasar nada que el paso no acepte ya: sin espacios, `@`,
 * puntos ni guiones, y no empieza con un dígito. Finance lee la misma regla del mensaje.
 */
const CODIGO = /^(?:[0-9A-Z]{5}|PGRST\d{3}|[a-z][a-z0-9_]{0,63})$/;

/**
 * Anota en qué paso falló una respuesta 5xx, sin tocarla: devuelve la misma instancia, con el mismo
 * body y los mismos headers. Lo que no tiene forma de identificador o de código se descarta al
 * reportar. Nunca lanza.
 */
export function marcarFalla(respuesta: Response, falla: Falla): Response {
  try {
    fallas.set(respuesta, falla);
  } catch {
    // Regla 0: una respuesta rara no rompe a la función
  }
  return respuesta;
}

/** Un identificador que pasa la regla, o nada: lo que no la pasa no viaja. */
function forma(v: unknown, regla: RegExp): string | undefined {
  return typeof v === 'string' && regla.test(v) ? v : undefined;
}

/** `contexto.tercero` (0.1.5), sólo si el servicio tiene la forma del paso. */
function deTercero(servicio: unknown): { tercero: string } | undefined {
  const tercero = forma(servicio, PASO);
  return tercero ? { tercero } : undefined;
}

/** «stock-loss: respondió 500 en stock_loss_apply (57014)», con lo que pase la validación. */
function http5xx(funcion: string, res: Response, f: Falla | undefined): Record<string, unknown> {
  const paso = forma(f?.paso, PASO);
  const codigo = forma(f?.codigo, CODIGO);
  return {
    name: 'HttpError',
    message: `${funcion}: respondió ${res.status}${paso ? ` en ${paso}` : ''}${codigo ? ` (${codigo})` : ''}`,
    status: res.status,
    // Sin SQLSTATE, el código es el status. Un PT4xx queda sólo en el mensaje: el usuario vio un
    // 5xx, y `esEsperado` lo descartaría como rechazo de negocio.
    code: codigo && !codigo.startsWith('PT4') ? codigo : undefined,
  };
}

interface EdgeRuntimeGlobal {
  EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
}

/** El envío, después de responder. Sin `EdgeRuntime` (Deno o Node sueltos), sale sin esperarlo. */
function despachar(monitor: Monitor): void {
  const p = monitor.flush();
  try {
    (globalThis as EdgeRuntimeGlobal).EdgeRuntime?.waitUntil(p);
  } catch {
    // sin waitUntil, la promesa corre igual
  }
}

function rutaDe(req: Request): string | undefined {
  try {
    return new URL(req.url).pathname;
  } catch {
    return undefined;
  }
}

function respuestaDeError(error: unknown, opciones: OpcionesHandler): Response {
  try {
    if (opciones.aRespuesta) return opciones.aRespuesta(error);
  } catch {
    // cae al 500 de siempre
  }
  return new Response(JSON.stringify({ error: 'error_interno' }), {
    status: 500,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Envuelve el handler de `Deno.serve`. Si responde, devuelve esa respuesta tal cual y reporta
 * las 5xx (sin el cuerpo: puede traer datos), con el paso de `marcarFalla` si lo tiene, salvo las
 * marcadas con `final: false`. Si lanza,
 * lo reporta y devuelve `aRespuesta(error)`
 * o un 500 JSON. Al final manda todo lo capturado en el request, también lo que la función
 * capturó a mano antes de contestar un 200.
 */
export function withHandler<A extends unknown[]>(
  monitor: Monitor,
  handler: (req: Request, ...args: A) => Response | Promise<Response>,
  opciones: OpcionesHandler = {},
): (req: Request, ...args: A) => Promise<Response> {
  return async (req, ...args) => {
    try {
      const res = await handler(req, ...args);
      if (res.status >= 500) {
        try {
          const f = fallas.get(res);
          // Un intento que no es el último (0.1.5): el que reintenta va a volver a pedir.
          if (f?.final !== false) {
            monitor.capturar(http5xx(monitor.funcion, res, f), { ruta: rutaDe(req), contexto: deTercero(f?.tercero) });
          }
        } catch {
          // Regla 0: reportar nunca cambia la respuesta de la función
        }
      }
      return res;
    } catch (error) {
      let esperado = false;
      try {
        esperado = !!opciones.esEsperado?.(error);
      } catch {
        // un esEsperado roto no decide nada
      }
      if (!esperado) monitor.capturar(error, { ruta: rutaDe(req) });
      return respuestaDeError(error, opciones);
    } finally {
      despachar(monitor);
    }
  };
}

/** Lo que `reportarTercero` necesita saber (0.1.5). */
export interface FallaDeTercero {
  /** El servicio de afuera (`interbanking`, `flete47`): va como `contexto.tercero`. */
  servicio: string;
  /**
   * Lo que devolvió el servicio, como texto fijo del programa: `http_429`, `http_401`, `timeout`,
   * `red`, `servidor`, `http_503`. Nunca un status numérico ni algo que escribió una persona.
   */
  codigo: string;
  /** En qué paso de la función, como en `Falla.paso`. */
  paso?: string;
  /** Con `false` no se reporta: hay otro intento. Por defecto, sí. */
  final?: boolean;
}

/**
 * (0.1.5) Reporta la falla de un servicio de afuera que `withHandler` no ve: lo que la función no
 * contesta como 5xx (el 429 que frena el día, un 401/403 del servicio, una falla que se maneja y
 * se responde 200). Captura un error **sin `status`**, con el código como texto: así `esEsperado`
 * no descarta un 401/403, que es nuestro (una credencial vencida) y finance lo deja como error.
 * «interbanking-sync: interbanking falló en saldos (http_429)». Sale con lo demás al terminar el
 * request de `withHandler`; fuera de él, con `monitor.flush()`. Lo que no tiene forma no viaja (un
 * servicio raro va sin `contexto.tercero`: entra como error), y el evento sale igual. Nunca lanza.
 */
export function reportarTercero(monitor: Monitor, f: FallaDeTercero): void {
  try {
    if (f.final === false) return;
    const servicio = forma(f.servicio, PASO);
    const paso = forma(f.paso, PASO);
    const codigo = forma(f.codigo, CODIGO);
    monitor.capturar(
      {
        name: 'TerceroError',
        message: `${monitor.funcion}: ${servicio ?? 'un servicio de afuera'} falló${paso ? ` en ${paso}` : ''}${codigo ? ` (${codigo})` : ''}`,
        // Sin `status`, a propósito. Un PT4xx queda sólo en el mensaje, como en `http5xx`.
        code: codigo && !codigo.startsWith('PT4') ? codigo : undefined,
      },
      { contexto: deTercero(servicio) },
    );
  } catch {
    // Regla 0
  }
}
