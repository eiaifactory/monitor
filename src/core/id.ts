// `id_externo` y `dispositivo_id`: uuid v4, el formato que valida finance.
//
// `crypto.randomUUID` sólo existe en contextos seguros: un sistema servido por http en la red
// del local (un POS en 192.168.x.x) no lo tiene. `getRandomValues` sí, y si tampoco, Math.random:
// el uuid es para no contar dos veces, no un secreto.

export function nuevoId(): string {
  const c = typeof crypto === 'undefined' ? undefined : crypto;
  if (c && typeof c.randomUUID === 'function') {
    try {
      return c.randomUUID();
    } catch {
      // fuera de un contexto seguro lanza en algunos navegadores: sigue abajo
    }
  }
  const b = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = (Math.random() * 256) | 0;
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
