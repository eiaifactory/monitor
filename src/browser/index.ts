// La entrada del navegador. Regla 0 del spec: invisible para el usuario final.
//
// `capturar` sólo guarda el error crudo en memoria y retorna: nada de red, nada de storage,
// nada de trabajo en el mismo tick. Normalizar, limpiar, colapsar, persistir y mandar corre
// después, cuando el navegador está ocioso. Nada de acá lanza, nada se muestra, y si finance no
// contesta el sistema del cliente anda igual.

import { deserializar, encolar, serializar, crearCola, type Cola } from '../core/cola';
import { MAX_EVENTOS_POR_LOTE, URL_FINANCE, type ValorContexto } from '../core/contrato';
import { ESPERAS_MS, armarLote, postear, type Resultado } from '../core/envio';
import { esEsperado, ignorado } from '../core/esperado';
import { nuevoId } from '../core/id';
import { armarEvento } from '../core/normalizar';

export { esEsperado };
export type { ValorContexto };

export interface OpcionesMonitor {
  /** `VITE_MONITOR_CLAVE`. Sin clave, el SDK no hace nada (desarrollo local, tests). */
  clave: string | undefined;
  /** Por defecto, la ingesta de finance. */
  url?: string;
  /** El sha corto del build. */
  release?: string;
  /** Mensajes que no se reportan: texto contenido en el mensaje, o una regex. */
  ignorar?: ReadonlyArray<string | RegExp>;
  /** Tope de la cola del dispositivo. Default 50. */
  maxBuffer?: number;
  /** Tope de eventos nuevos por minuto. Default 20. */
  maxPorMinuto?: number;
  /** Loguea a `console.debug` lo que hace. Para integrar, nunca en producción. */
  debug?: boolean;
}

export interface Extra {
  ruta?: string;
  ubicacion?: string;
  contexto?: Record<string, ValorContexto>;
}

export interface Usuario {
  /** Un id opaco (uuid), nunca un email. */
  id: string;
  rol?: string;
}

const K_COLA = 'eiai_monitor_cola';
const K_DISPOSITIVO = 'eiai_monitor_dispositivo';
const CADA_MS = 2000;
const AL_JUNTAR = 10;
const TIMEOUT_MS = 3000;
/** Errores crudos que esperan ser procesados. Una tormenta no puede comerse la memoria. */
const MAX_CRUDOS = 100;

interface Config {
  clave: string;
  url: string;
  release?: string;
  ignorar: ReadonlyArray<string | RegExp>;
  maxBuffer: number;
  maxPorMinuto: number;
  debug: boolean;
}

interface Crudo {
  error: unknown;
  t: number;
  ruta: string;
  extra?: Extra;
  contexto: Record<string, ValorContexto>;
  usuario?: Usuario;
}

let cfg: Config | undefined;
let crudos: Crudo[] = [];
let cola: Cola | undefined;
let dispositivo: string | undefined;
let contexto: Record<string, ValorContexto> = {};
let usuario: Usuario | undefined;
let procesando = false;
let procesoProgramado = false;
let timerEnvio: ReturnType<typeof setTimeout> | undefined;
let timerEn = 0;
let enCurso: Promise<Resultado | undefined> | undefined;
let apagado = false;
let fallos = 0;
let esperarHasta = 0;
let limite = MAX_EVENTOS_POR_LOTE;

function log(...a: unknown[]): void {
  try {
    if (cfg?.debug) console.debug('[monitor]', ...a);
  } catch {
    // un console roto no es asunto nuestro
  }
}

function leer(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

function escribir(k: string, v: string): void {
  try {
    localStorage.setItem(k, v);
  } catch {
    // storage bloqueado o lleno: la cola sigue en memoria
  }
}

export function initMonitor(o: OpcionesMonitor): void {
  try {
    if (cfg) return;
    if (typeof window === 'undefined' || !o?.clave) {
      if (o?.debug) console.debug('[monitor] no-op: sin clave');
      return;
    }
    cfg = {
      clave: o.clave,
      url: o.url ?? URL_FINANCE,
      release: o.release,
      ignorar: o.ignorar ?? [],
      maxBuffer: o.maxBuffer ?? 50,
      maxPorMinuto: o.maxPorMinuto ?? 20,
      debug: !!o.debug,
    };
    addEventListener('error', alError);
    addEventListener('unhandledrejection', alRechazo);
    addEventListener('pagehide', alIrse);
    document.addEventListener('visibilitychange', alOcultarse);
    // Lo que quedó de la carga anterior se recupera fuera de este tick, como todo lo demás.
    programarProceso();
    log('iniciado', cfg.url);
  } catch {
    // Regla 0
  }
}

export function capturar(error: unknown, extra?: Extra): void {
  try {
    if (!cfg || apagado || procesando || crudos.length >= MAX_CRUDOS) return;
    crudos.push({ error, extra, t: Date.now(), ruta: location.pathname, contexto, usuario });
    programarProceso();
  } catch {
    // Regla 0
  }
}

/** Suma claves al contexto de los próximos eventos. Una clave en `undefined` se saca. */
export function setContext(c: Record<string, ValorContexto | undefined>): void {
  try {
    contexto = { ...contexto, ...c } as Record<string, ValorContexto>;
  } catch {
    // Regla 0
  }
}

export function setUsuario(u: Usuario): void {
  usuario = u;
}

export function limpiarUsuario(): void {
  usuario = undefined;
}

/** Procesa lo capturado y manda todo lo que haya, ahora. Nunca rechaza. */
export async function flush(): Promise<void> {
  try {
    if (!cfg) return;
    procesar();
    for (;;) {
      const r = await enviar();
      if (!r || (r.r !== 'ok' && r.r !== 'descartar' && r.r !== 'partir')) return;
    }
  } catch {
    // Regla 0
  }
}

/** Para `new QueryCache({ onError: onErrorQuery })`. Aditivo: no reemplaza los `onError` de cada query. */
export function onErrorQuery(error: unknown, query?: { queryKey?: readonly unknown[] }): void {
  try {
    capturar(error, { ubicacion: nombre(query?.queryKey) });
  } catch {
    // Regla 0
  }
}

/** Para `new MutationCache({ onError: onErrorMutation })`. */
export function onErrorMutation(
  error: unknown,
  _variables?: unknown,
  _contexto?: unknown,
  mutation?: { options?: { mutationKey?: readonly unknown[] } },
): void {
  try {
    capturar(error, { ubicacion: nombre(mutation?.options?.mutationKey) });
  } catch {
    // Regla 0
  }
}

/** Sólo el primer elemento de la key, si es un string: el resto puede traer ids o filtros. */
function nombre(key: readonly unknown[] | undefined): string | undefined {
  return Array.isArray(key) && typeof key[0] === 'string' ? key[0] : undefined;
}

function alError(ev: ErrorEvent): void {
  try {
    // Sin `error` (un script de otro origen: «Script error.»), lo que haya en el evento.
    capturar(
      ev.error ?? {
        message: ev.message,
        stack: ev.filename ? `at ${ev.filename}:${ev.lineno}:${ev.colno}` : undefined,
      },
    );
  } catch {
    // Regla 0
  }
}

function alRechazo(ev: PromiseRejectionEvent): void {
  try {
    capturar(ev.reason);
  } catch {
    // Regla 0
  }
}

/** Irse: lo pendiente se procesa ya, se persiste, y sale en un `fetch` que sobrevive a la pestaña. */
function alIrse(): void {
  try {
    procesar();
    clearTimeout(timerEnvio);
    timerEnvio = undefined;
    void enviar(true);
  } catch {
    // Regla 0
  }
}

/** En el celular el sistema mata pestañas en segundo plano sin `pagehide`: ocultarse es el último aviso. */
function alOcultarse(): void {
  if (document.visibilityState === 'hidden') alIrse();
}

function programarProceso(): void {
  if (procesoProgramado) return;
  procesoProgramado = true;
  if (typeof requestIdleCallback === 'function') requestIdleCallback(procesar, { timeout: 1000 });
  else setTimeout(procesar, 0);
}

function cargar(): Cola {
  if (cola) return cola;
  cola = crearCola();
  cola.items = deserializar(leer(K_COLA));
  dispositivo = leer(K_DISPOSITIVO) ?? undefined;
  if (!dispositivo) {
    dispositivo = nuevoId();
    escribir(K_DISPOSITIVO, dispositivo);
  }
  if (cola.items.length) log('recuperados', cola.items.length);
  return cola;
}

function persistir(): void {
  if (cola) escribir(K_COLA, serializar(cola.items));
}

function procesar(): void {
  procesoProgramado = false;
  if (!cfg || procesando) return;
  procesando = true;
  try {
    const c = cargar();
    const lote = crudos;
    crudos = [];
    let agregados = 0;
    for (const x of lote) {
      try {
        if (esEsperado(x.error)) continue;
        const e = armarEvento({
          error: x.error,
          origen: 'browser',
          ocurrido: x.t,
          ruta: x.extra?.ruta ?? x.ruta,
          ubicacion: x.extra?.ubicacion,
          release: cfg.release,
          usuario_id: x.usuario?.id,
          rol: x.usuario?.rol,
          dispositivo_id: dispositivo,
          user_agent: navigator.userAgent,
          contexto: { ...x.contexto, ...x.extra?.contexto },
        });
        if (ignorado(e.mensaje, cfg.ignorar)) continue;
        const r = encolar(c, e, x.t, cfg.maxBuffer, cfg.maxPorMinuto);
        log(r, e.mensaje);
        if (r !== 'tope_por_minuto') agregados++;
      } catch {
        // un error que no se pudo armar se pierde solo, no se lleva a los demás
      }
    }
    if (agregados) persistir();
    if (c.items.length) programarEnvio(c.items.length >= AL_JUNTAR ? 0 : CADA_MS);
  } catch {
    // Regla 0
  } finally {
    procesando = false;
  }
}

/** Un único timer de envío; uno nuevo sólo lo reemplaza si tiene que salir antes. */
function programarEnvio(ms: number): void {
  if (apagado) return;
  const en = Math.max(Date.now() + ms, esperarHasta);
  if (timerEnvio !== undefined) {
    if (en >= timerEn) return;
    clearTimeout(timerEnvio);
  }
  timerEn = en;
  timerEnvio = setTimeout(() => {
    timerEnvio = undefined;
    void enviar();
  }, en - Date.now());
}

/** Un solo envío a la vez: si ya hay uno en curso, se devuelve ese. Nunca rechaza. */
function enviar(keepalive = false): Promise<Resultado | undefined> {
  return (enCurso ??= mandar(keepalive)
    .catch(() => undefined)
    .finally(() => {
      enCurso = undefined;
    }));
}

async function mandar(keepalive: boolean): Promise<Resultado | undefined> {
  try {
    if (!cfg || !cola || apagado) return;
    const c = cola;
    if (Date.now() < esperarHasta) {
      programarEnvio(0);
      return;
    }
    const lote = armarLote(c.items, limite);
    if (!lote.length) return;

    for (const i of lote) i.v = true;
    const r = await postear({
      url: cfg.url,
      clave: cfg.clave,
      eventos: lote.map((i) => i.e),
      timeoutMs: TIMEOUT_MS,
      keepalive,
      debug: cfg.debug ? log : undefined,
    });
    for (const i of lote) i.v = false;

    const sacar = () => {
      c.items = c.items.filter((i) => !lote.includes(i));
    };
    if (r.r === 'ok' || r.r === 'descartar' || (r.r === 'partir' && lote.length === 1)) {
      sacar();
      if (r.r === 'ok') fallos = 0;
      limite = MAX_EVENTOS_POR_LOTE;
    } else if (r.r === 'partir') {
      limite = lote.length >> 1;
    } else if (r.r === 'apagar') {
      // Clave inválida o revocada: insistir es martillar a finance para nada. Hasta la próxima carga.
      apagado = true;
      clearTimeout(timerEnvio);
      log('clave rechazada: apagado');
    } else {
      esperarHasta = Date.now() + (r.r === 'cuota' ? r.esperaMs : ESPERAS_MS[Math.min(fallos++, ESPERAS_MS.length - 1)]);
    }
    persistir();
    // Tras un fallo manda la espera (`esperarHasta`), no los 2 s de siempre.
    if (c.items.length) programarEnvio(c.items.length >= AL_JUNTAR || (r.r !== 'ok' && r.r !== 'descartar') ? 0 : CADA_MS);
    return r;
  } catch {
    return undefined;
  }
}
