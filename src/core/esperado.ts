// Qué NO es un incidente. Decisión del spec: los rechazos de negocio y los `toast.error` no se
// reportan; el Monitor es para lo que se rompió, no para lo que el sistema dijo que no.

function status(o: Record<string, unknown>): unknown {
  return o.status ?? o.statusCode ?? (o.context as { status?: unknown } | undefined)?.status;
}

/**
 * - `PT4xx`: el `RAISE` de negocio de las funciones de la base, que PostgREST devuelve como 4xx.
 * - `AbortError`: una petición cancelada a propósito (el usuario se fue, un timeout del cliente).
 * - 401/403: sesión vencida o sin permiso. Y los `Auth*` de Supabase con status < 500
 *   (contraseña mal escrita, mail sin confirmar): son del usuario, no del sistema.
 */
export function esEsperado(error: unknown): boolean {
  try {
    if (!error || typeof error !== 'object') return false;
    const o = error as Record<string, unknown>;
    if (o.name === 'AbortError') return true;
    if (typeof o.code === 'string' && o.code.startsWith('PT4')) return true;
    const s = Number(status(o));
    if (s === 401 || s === 403) return true;
    return typeof o.name === 'string' && o.name.startsWith('Auth') && s >= 400 && s < 500;
  } catch {
    return false;
  }
}

/**
 * Lo que el cliente declara que no quiere ver: un texto (contenido en el mensaje) o una regex.
 * `search` y no `test`: una regex con `/g` guarda estado entre llamadas y fallaría una de cada dos.
 */
export function ignorado(mensaje: string, ignorar: ReadonlyArray<string | RegExp>): boolean {
  return ignorar.some((p) => (typeof p === 'string' ? mensaje.includes(p) : mensaje.search(p) >= 0));
}
