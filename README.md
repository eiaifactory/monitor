# @eiaifactory/monitor

Manda los errores de un sistema de cliente al Monitor de EI AI Factory, sin que el usuario final
lo note.

Este README **es el contrato**: el SDK es una forma de emitir, pero cualquier cosa que sepa hacer
un `POST` con JSON y una clave emite igual (un `curl` en un workflow, un `net.http_post` desde un
cron, un servicio en otro lenguaje). La definición de la que se copia vive en
[`eiaifactory-finance`](https://github.com/eiaifactory/eiaifactory-finance/blob/main/supabase/functions/_shared/monitor/tipos.ts).

## La regla que manda: invisible para el usuario final

- `capturar()` guarda el error en memoria y retorna (en menos de 1 ms): nada de red ni de
  `localStorage` en el mismo tick. Lo demás corre después, cuando el navegador está ocioso.
- Nunca lanza, nunca muestra nada, no escribe en la consola (salvo `debug: true`).
- Si finance no contesta, el sistema del cliente anda igual: la cola espera, con tope.
- Sin clave no hace nada. Así corre en desarrollo local, en tests y en SSR.

## Instalar

```bash
npm install @eiaifactory/monitor
```

La clave de cada ambiente se crea en finance → **Monitor → Proyectos y claves**, y se ve una sola
vez. Es un secreto: va en variables de entorno, nunca en el repo.

| Dónde | Variable |
|---|---|
| Front (Vite) | `VITE_MONITOR_CLAVE` |
| Edge functions | secreto `MONITOR_CLAVE` |
| Crons de la base | `monitor_clave` en el vault |

## Navegador

```ts
// src/main.tsx
import { initMonitor, onErrorQuery, onErrorMutation, setUsuario } from '@eiaifactory/monitor';
import { QueryCache, MutationCache, QueryClient } from '@tanstack/react-query';

initMonitor({
  clave: import.meta.env.VITE_MONITOR_CLAVE,
  release: import.meta.env.VITE_RELEASE,
  // Opcional: lo que no es un incidente para este sistema.
  ignorar: ['Failed to fetch dynamically imported module'],
});

// Aditivos: los onError de cada query o mutation siguen andando igual.
export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onErrorQuery }),
  mutationCache: new MutationCache({ onError: onErrorMutation }),
});

// Cuando hay sesión. Un id opaco (uuid), nunca un email.
setUsuario({ id: session.user.id, rol: perfil.rol });
```

`release` es el sha corto del build. En Railway, `RAILWAY_GIT_COMMIT_SHA` existe durante el build,
pero Vite sólo expone las variables con prefijo `VITE_`:

```ts
// vite.config.ts
define: {
  'import.meta.env.VITE_RELEASE': JSON.stringify(process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local'),
},
```

Instalado, captura solo los errores no manejados (`error`) y las promesas rechazadas sin atajar
(`unhandledrejection`), sin `preventDefault` y sin pisar los handlers de la página.

| Función | Qué hace |
|---|---|
| `initMonitor({ clave, url?, release?, ignorar?, maxBuffer?, maxPorMinuto?, debug? })` | Instala los listeners. Una sola vez por página; las siguientes se ignoran. |
| `capturar(error, { ruta?, ubicacion?, contexto? })` | Reporta un error atajado a mano (el `catch` de un flujo que igual querés ver). |
| `setContext({ clave: valor })` | Suma datos a los próximos eventos (`sucursal`, `terminal`…). Sólo escalares; `undefined` saca la clave. |
| `setUsuario({ id, rol? })` / `limpiarUsuario()` | Quién estaba usando el sistema. |
| `onErrorQuery` / `onErrorMutation` | Para `QueryCache` / `MutationCache`. De la key se manda sólo el primer elemento si es texto (el nombre de la consulta), como `ubicacion`: el resto puede traer ids o filtros. |
| `esEsperado(error)` | La misma regla que usa el SDK para no reportar (ver abajo). |
| `flush()` | Procesa y manda lo pendiente ya. Nunca rechaza. |

## Edge functions (Supabase)

```ts
import { initMonitor, withHandler } from 'npm:@eiaifactory/monitor@0.1.0/deno';

const monitor = initMonitor({
  clave: Deno.env.get('MONITOR_CLAVE'),
  funcion: 'cobrar',
  release: Deno.env.get('RELEASE'), // si el deploy lo define
});

Deno.serve(
  withHandler(
    monitor,
    async (req) => {
      // …la función de siempre
      return new Response(JSON.stringify(resultado), { headers: corsHeaders });
    },
    // Si la función lanza, esto es lo que se devuelve. Con los CORS de la función: sin ellos,
    // el navegador ve un error de CORS en vez del 500.
    { aRespuesta: () => new Response('{"error":"interno"}', { status: 500, headers: corsHeaders }) },
  ),
);
```

`withHandler` devuelve la respuesta de la función tal cual y manda **después**, en
`EdgeRuntime.waitUntil`: el usuario no espera al Monitor. Reporta lo que la función lanza y las
respuestas 5xx (como `cobrar: respondió 503`, **sin el cuerpo**: puede traer datos). Las 4xx son
la función contestando que no, y no se reportan. Lo que se capture a mano con
`monitor.capturar(error)` durante el request también sale al final.

| Opción de `withHandler` | |
|---|---|
| `esEsperado(error)` | Además de los esperados de siempre. |
| `aRespuesta(error)` | La respuesta cuando la función lanza. Default: `500 {"error":"error_interno"}`. |

**Node (Railway u otro servidor):** la misma entrada (`import … from '@eiaifactory/monitor/deno'`),
con `origen: 'servidor'`. Sin `EdgeRuntime`, el envío sale sin esperarlo.

## Qué no se reporta

Decisión del spec: los rechazos de negocio y los `toast.error` no son incidentes.

- **`PT4xx`**: el `RAISE` de negocio de las funciones de la base (`raise exception using errcode = 'PT402'`).
- **`AbortError`**: una petición cancelada a propósito.
- **401 / 403**: sesión vencida o sin permiso. También los `Auth*` de Supabase con status 4xx
  (contraseña mal escrita, mail sin confirmar).
- Lo que el cliente declare en `ignorar` (texto contenido en el mensaje, o una regex).

## Frenos del lado del cliente

| | Navegador | Servidor |
|---|---|---|
| Colapso | El mismo error en 10 s viaja una vez, con `repeticiones` | — |
| Tope | 20 eventos nuevos por minuto (`maxPorMinuto`) | — |
| Cola | 50 (`maxBuffer`) en `localStorage`, hasta 128 KB; descarta lo más viejo | 50 en memoria |
| Envío | Cada 2 s o al juntar 10; lotes de hasta 20 eventos y 60 KB | Al terminar el request |
| Timeout | 3 s | 2 s |
| Red caída o 5xx | Espera 1 → 2 → 4 → 30 s | Un reintento |
| `429` | Espera `Retry-After`; si el navegador no lo puede leer, hasta el próximo minuto | Espera `Retry-After` (hasta 10 s) y reintenta una vez |
| `413` | Parte el lote a la mitad | Parte el lote a la mitad |
| `401` | Se apaga hasta la próxima carga | Se apaga |

Un reintento manda los mismos `id_externo`: finance lo cuenta como duplicado, no suma dos veces.
Al irse de la página (`pagehide`, o la pestaña pasa a segundo plano), lo pendiente se guarda y
sale en un `fetch` con `keepalive`; si el navegador no lo deja salir, va en la próxima carga.

PII, primera línea (la segunda es finance): los valores de `contexto` cuyas claves parecen
sensibles (`mail`, `tel`, `phone`, `dni`, `cuit`, `pass`, `token`, `secret`, `key`, `clave`) se
reemplazan por `[redactado]`; emails y teléfonos se redactan en el mensaje, el stack, la ruta y
el contexto; la ruta viaja sin query ni hash; un `usuario_id` con `@` se redacta.

## El contrato HTTP v1

Congelado: cambiarlo es versionar (`/v2`), no editar.

**Endpoint.** `POST https://qoyskdjcjyjxcnhruhni.supabase.co/functions/v1/monitor-ingesta`.
CORS abierto (`*`), `OPTIONS` → 204.

**Auth.** `Authorization: Bearer eiai_mon_<ambiente>_<32 hex>`. La clave es la única autoridad
sobre proyecto y ambiente: el cuerpo no los declara, y si los declara se ignoran. Nunca en la URL.

**Cuerpo.** Siempre un lote: `{ "eventos": [ … ] }`, **hasta 20 eventos** (los que sobran se
rechazan uno por uno con `lote_excedido`) y **hasta 64 KB** (si no, `413` y se rechaza entero).

| Campo | Tipo | Req | Tope | Qué es |
|---|---|---|---|---|
| `id_externo` | uuid | sí | — | Idempotencia: repetido cuenta como `duplicados`, no suma |
| `origen` | `browser` · `edge` · `servidor` · `db` · `ci` · `deploy` | sí | — | `latido` es reservado de finance |
| `mensaje` | string | sí | 1024 | Se recorta, no se rechaza |
| `ocurrido_at` | ISO-8601 | no | — | Default: cuándo llegó |
| `tipo_error` | string | no | 128 | `TypeError`, `PostgrestError`, `XX000`… |
| `codigo` | string | no | 64 | SQLSTATE, status HTTP, code de PostgREST |
| `stack` | string | no | 8192 | Crudo |
| `ubicacion` | string | no | 256 | Función edge, nombre del cron, consulta |
| `ruta` | string | no | 512 | `pathname`, sin query |
| `release` | string | no | 64 | Sha corto del build |
| `usuario_id` | string | no | 64 | Id opaco; con `@` se redacta |
| `rol` | string | no | 64 | |
| `dispositivo_id` | string | no | 64 | Uuid del dispositivo |
| `user_agent` | string | no | 512 | |
| `contexto` | objeto plano de escalares | no | 2 KB | Claves sensibles → `[redactado]` |
| `repeticiones` | entero ≥ 1 | no | — | Colapso local. Default 1 |
| `huella_manual` | string | no | 128 | Reemplaza la agrupación calculada (`cron:offers-expire`) |

Los topes son en caracteres. Un texto más largo se recorta con la marca `…[cortado]`.

**Respuestas.**

| Status | Cuerpo | Cuándo |
|---|---|---|
| `202` | `{ "recibidos": n, "duplicados": n, "rechazados": [{ "i": 0, "motivo": "…" }] }` | La clave vale. Motivos por evento: `sin_id_externo` · `id_externo_invalido` · `origen_invalido` · `sin_mensaje` · `lote_excedido` · `evento_invalido` |
| `400` | `{ "error": "cuerpo_invalido" }` | No es JSON o no tiene `eventos[]` |
| `401` | `{ "error": "clave_invalida" }` | Sin header, clave desconocida o revocada |
| `413` | `{ "error": "cuerpo_excedido" }` | Más de 64 KB |
| `429` | `{ "error": "cuota_excedida" }` + `Retry-After` | Cuota por clave y minuto de reloj agotada |
| `405` | — | Método que no es `POST` ni `OPTIONS` |

Cómo se agrupa (lo hace finance, no el emisor): mismo origen, tipo, mensaje (sin ids, hashes ni
números) y primer frame del stack (sin el hash del chunk de Vite ni línea y columna) son el mismo
problema. `huella_manual` reemplaza ese cálculo.

### Con `curl`

```bash
curl -X POST "https://qoyskdjcjyjxcnhruhni.supabase.co/functions/v1/monitor-ingesta" \
  -H "Authorization: Bearer $MONITOR_CLAVE" \
  -H "Content-Type: application/json" \
  -d "{\"eventos\":[{\"id_externo\":\"$(uuidgen)\",\"origen\":\"ci\",\"mensaje\":\"falló el build\",\"ubicacion\":\"deploy.yml\"}]}"
```

### Desde un cron de la base (`net.http_post`)

El patrón es envolver cada job en una función que ataja el error y avisa, con la clave en el vault
del cliente:

```sql
create or replace function app.run_job(p_fn text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_estado text;
  v_mensaje text;
begin
  execute format('select %s()', p_fn::regproc);
exception when others then
  get stacked diagnostics v_estado = returned_sqlstate, v_mensaje = message_text;
  -- PT4xx es un rechazo de negocio, no un incidente.
  if v_estado not like 'PT4%' then
    perform net.http_post(
      url := 'https://qoyskdjcjyjxcnhruhni.supabase.co/functions/v1/monitor-ingesta',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'monitor_clave'),
        'Content-Type', 'application/json'
      ),
      body := jsonb_build_object('eventos', jsonb_build_array(jsonb_build_object(
        'id_externo', gen_random_uuid(),
        'origen', 'db',
        'mensaje', v_mensaje,
        'codigo', v_estado,
        'ubicacion', p_fn,
        'huella_manual', 'cron:' || p_fn
      )))
    );
  end if;
  -- Sin re-raise: `net.http_post` encola en una tabla, y si la transacción se revierte el
  -- aviso se revierte con ella.
end;
$$;

-- select cron.schedule('offers-expire', '*/5 * * * *', $$select app.run_job('app.offers_expire')$$);
```

## Qué NO hace

- **Sin sourcemaps**: el stack llega minificado; se agrupa igual por frame normalizado.
- **Sin breadcrumbs, performance ni session replay.** Errores, nada más.
- **No reintenta los eventos que finance rechaza** en un `202` (`rechazados`): un evento inválido
  no se arregla reenviándolo.
- **Varias pestañas comparten la cola guardada**: la última que guarda gana. Se puede perder algo
  pendiente de una pestaña que se cierra dentro de los 2 s de otra; el resto ya salió.
- **El envío al irse es un intento**: si el navegador no deja salir el `keepalive`, sale en la
  próxima carga del mismo dispositivo.

## Desarrollo

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run tamano
```

`tamano` falla si la entrada del navegador pasa de **4 KB gzip** (presupuesto del spec).
Publicar es crear un tag `vX.Y.Z` igual a la versión de `package.json`: el workflow `publish.yml`
publica en npm con provenance.

## Licencia

[MIT](LICENSE)
