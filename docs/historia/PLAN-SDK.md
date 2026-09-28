# Plan — SDK `@eiaifactory/monitor` v0.1.0

**Progreso General:** `3%`

**Spec:** [`SPEC-MONITOR.md`](https://github.com/eiaifactory/eiaifactory-finance/blob/main/docs/historia/SPEC-MONITOR.md)
(repo `eiaifactory-finance`, §«El contrato HTTP v1» y §«SDK») · **Plan de finance:**
[`PLAN-MONITOR.md`](https://github.com/eiaifactory/eiaifactory-finance/blob/main/docs/historia/PLAN-MONITOR.md)
(este SDK va entre su PR A, ya mergeado, y el piloto de Fratelli) · **Revisado con `/plan-review` el
2026-09-27** · **Estado:** aprobado por Mariano el 2026-09-28, en ejecución

## TLDR

Una librería TypeScript sin dependencias que manda los errores de un sistema de cliente al
Monitor de finance, contra el contrato HTTP v1 que ya está en producción (`monitor-ingesta`).
Dos entradas: **navegador** (captura sola los errores no manejados y los de React Query) y
**servidor** (`./deno`: envuelve una edge function de Supabase; anda en cualquier runtime con
`fetch`). La regla que manda sobre todo lo demás es la **Regla 0 del spec: invisible para el usuario
final** — capturar no hace red ni escribe storage en el mismo tick, nunca lanza, nunca muestra
nada, y si finance no contesta el sistema del cliente anda igual. Se publica en npm como
`@eiaifactory/monitor` para que el piloto de Fratelli lo instale.

## Decisiones Críticas

**Ya tomadas en el spec** (no se reabren acá): paquete npm público `@eiaifactory/monitor`, semver;
`exports` con `"."` (navegador) y `"./deno"` (la resolución de subpaths `npm:` en Supabase Edge está
verificada: finance ya despliega `npm:react@18.3.1/jsx-runtime`); clave en `Authorization: Bearer`,
nunca en la URL; sin `sendBeacon`; la huella la calcula el server; el SDK redacta PII como
**primera línea** (la segunda es finance); sin dependencias; ≤ 4 KB gzip la entrada del navegador.

**Decididas por Mariano (27-sep):**

1. **El repo pasa a público**, para publicar con provenance (npm no la genera desde repos
   privados desde julio de 2023). El cambio lo hace Mariano en GitHub.
2. **Licencia MIT.**
3. **`url` es opcional** y apunta por defecto a
   `https://qoyskdjcjyjxcnhruhni.supabase.co/functions/v1/monitor-ingesta`: cada cliente configura
   sólo la clave. Si finance cambia de URL, sale una versión nueva del SDK.

**Del plan:**

- **El contrato se copia, no se importa.** `src/core/contrato.ts` es una copia de
  `supabase/functions/_shared/monitor/tipos.ts` de finance (orígenes, topes, tamaño de lote y de
  cuerpo), con el link a la fuente en la cabecera. El server es la autoridad: si el SDK manda algo
  de más, finance lo recorta o lo rechaza por evento, nunca el lote entero.
- **Capturar sólo encola en memoria.** `capturar()` guarda el error crudo y retorna. Normalizar,
  limpiar, colapsar, persistir y mandar corre después, en `requestIdleCallback` (con
  `setTimeout(0)` donde no existe, Safari). Es lo que hace que no se note.
- **Los lotes se arman por cantidad Y por tamaño.** Hasta 20 eventos y hasta 60 KB serializados.
  *(Revisión: con los topes del contrato un evento puede pesar ~12 KB —mensaje 1 KB, stack 8 KB,
  contexto 2 KB—, así que 20 juntos pasan de los 64 KB de la ingesta, que contesta 413 por el lote
  entero. El plan original descartaba ese lote: se perdían 20 errores reales.)* Si igual llega un
  413, el lote se parte a la mitad y se reintenta; sólo un evento que por sí solo no entra se
  descarta, y con los topes del contrato eso no puede pasar.
- **`Retry-After` no se puede leer desde el navegador.** La ingesta no manda
  `Access-Control-Expose-Headers`, y `Retry-After` no es un header que CORS deje ver por defecto
  (verificado en `monitor-ingesta/index.ts:40-47`). El SDK usa el header si lo ve (servidor) y, si
  no, espera al próximo minuto de reloj, que es como se cuenta la cuota. Finance suma el
  `Expose-Headers` en su PR B (se anota en su plan en el paso 8).
- **Los lotes normales van con `fetch` común, sin `keepalive`.** El `Authorization` fuerza un
  preflight de CORS, y Chrome rechazó históricamente `keepalive` con preflight. Sólo el envío al
  irse de la página usa `keepalive`; si el navegador no lo deja, lo pendiente ya está en
  `localStorage` y sale en la próxima carga (el respaldo que el spec acepta). El paso 7 prueba en
  Chrome real cuál de los dos pasa.
- **Irse de la página es `pagehide` y también `visibilitychange` a oculto.** *(Revisión: en el
  celular el sistema mata pestañas en segundo plano sin disparar `pagehide`; ocultarse es el último
  momento seguro.)*
- **El SDK no puede reportarse a sí mismo.** Toda promesa que crea tiene su `catch`, y un guard de
  reentrada ignora lo que se captura mientras el SDK procesa. *(Revisión: sin esto, un `fetch`
  fallido sin atajar dispara `unhandledrejection`, el SDK lo captura, vuelve a fallar al mandarlo…
  un bucle en el navegador del cliente.)*
- **Frenos del lado del cliente:** colapso de repetidos en una ventana de 10 s (`repeticiones`, sólo
  sobre lo que todavía está en la cola), tope de 20 eventos por minuto por dispositivo, cola de 50
  en `localStorage` que descarta lo más viejo, envío cada 2 s o al juntar 10, timeout de 3 s. Ante
  red caída o 5xx, espera 1 → 2 → 4 → 30 s. Ante 401 (clave inválida o revocada) **se apaga** hasta
  la próxima carga: insistir con una clave mala es martillar a finance para nada. Un reintento
  manda los mismos `id_externo`, así que finance lo cuenta como duplicado y no suma dos veces.
- **Servidor: responde primero, manda después.** `withHandler` devuelve la respuesta que
  devolvería la función y manda en `EdgeRuntime.waitUntil`, con un intento de 2 s y un reintento.
  Si no hay `EdgeRuntime` (Deno o Node fuera de Supabase), lo manda sin esperarlo. Reporta lo que
  lanza la función y **las respuestas 5xx**, con el mensaje `<función>: respondió <status>` y nunca
  el cuerpo (puede traer datos). `origen` es `edge` por defecto y `servidor` para Node/Railway: una
  opción de una línea que evita otra entrada cuando se sume la landing.
- **Qué es «esperado» y no se reporta:** errores de negocio de PostgREST (`PT4xx`, los `RAISE`
  del cliente), `AbortError`, 401/403 de auth, y lo que el cliente declare con `ignorar`
  (Fratelli: el chunk viejo después de un deploy). Es la decisión del spec: los `toast.error` y los
  rechazos de negocio no son incidentes. De React Query se toma sólo el primer elemento de la
  `queryKey`, si es un string (el nombre de la consulta), como `ubicacion`: el resto puede traer ids
  o filtros.
- **No-op sin clave y sin `window`** (desarrollo local, SSR, tests del cliente).
- **Sin `console` propio**, salvo `debug: true`, que loguea a `console.debug` para integrar.
- **Los nombres de las variables son los de la pantalla de finance** («Dónde va»):
  `VITE_MONITOR_CLAVE` en el front, secreto `MONITOR_CLAVE` en las edge, `monitor_clave` en el vault.
- **Herramientas:** `tsup` (esbuild) para el build, `vitest` + `happy-dom` para los tests, TypeScript
  estricto. En esta máquina los tests corren con el Node de 64 bits portable (el instalado es de
  32 bits y vitest 4 no arranca); en CI, Ubuntu con Node 22.
- **El primer commit va directo a `main`, con tu OK**: el repo está vacío y un PR necesita una rama
  base. Lleva sólo este plan, el README mínimo y la licencia. Todo lo demás va en `feat/sdk-v0` con
  su PR. La rama local se renombra de `master` a `main`, como en el resto de los repos.

## Tareas

- [ ] 🟨 **Paso 0: Prerrequisitos** (Mariano; bloquean sólo el paso 8, salvo el primero)
  - [x] 🟩 OK para el primer push a `main` (plan, README mínimo, `LICENSE` MIT). Dado el 2026-09-28.
  - [ ] 🟥 Pasar el repo `eiaifactory/monitor` a público (GitHub → Settings → Danger Zone).
  - [ ] 🟥 Cuenta de npm y organización `eiaifactory` (gratis para paquetes públicos). Hoy no hay
    nada publicado bajo `@eiaifactory` y desde esta máquina no hay sesión de npm.
  - [ ] 🟥 La **primera** publicación la hace Mariano con su cuenta (`npm publish --access public`
    desde el repo, después del paso 7): npm exige que el paquete exista antes de configurar
    trusted publishing. Después, en npmjs.com → el paquete → Trusted publisher: organización
    `eiaifactory`, repo `monitor`, workflow `publish.yml`. De ahí en más publica el CI con un tag,
    sin token.

- [ ] 🟥 **Paso 1: Andamiaje** (en `feat/sdk-v0`)
  - [ ] 🟥 `package.json`: `@eiaifactory/monitor` 0.1.0, `type: module`, `exports` `"."` →
    `dist/browser.js` y `"./deno"` → `dist/deno.js` (con `types`), `files: ["dist"]`,
    `sideEffects: false`, `publishConfig.access: public`, `repository` exacto (lo exige provenance),
    `license: MIT`.
  - [ ] 🟥 `tsconfig.json` estricto; `tsup.config.ts` (dos entradas, ESM, `dts`, minificado,
    `target` es2020 para el navegador); `vitest.config.ts` (`happy-dom` para `test/browser`,
    `node` para el resto); `.gitignore`.
  - [ ] 🟥 `npm ci`, `npm run typecheck`, `npm test` (vacío) y `npm run build` corriendo con el Node
    de 64 bits.

- [ ] 🟥 **Paso 2: El núcleo** (`src/core/`, sin DOM ni Deno, con test cada uno)
  - [ ] 🟥 `contrato.ts`: copia de los tipos y topes de finance, con el link a la fuente.
  - [ ] 🟥 `normalizar.ts`: cualquier cosa → `{ mensaje, tipo_error, stack, codigo }`. Entiende
    `Error`, errores de Supabase/PostgREST (`code`, `message`, `details`, `hint`), strings, objetos
    raros, `null` y objetos circulares, sin lanzar nunca. Recorta a los topes del contrato.
  - [ ] 🟥 `pii.ts`: primera línea de PII, la misma regla que el server (claves sensibles de
    `contexto` → `[redactado]`, emails y teléfonos en mensaje, stack, ruta y valores; `usuario_id`
    con `@`). Copia de la lógica de `_shared/monitor/pii.ts` de finance, con sus casos de test.
  - [ ] 🟥 `colapso.ts`: hash corto (FNV-1a) de origen + tipo + mensaje + primer frame; dentro de
    10 s, suma `repeticiones` al evento que todavía está en la cola en vez de encolar otro.
  - [ ] 🟥 `cola.ts`: cola con tope (descarta lo más viejo), serializable, con el tope por minuto.
  - [ ] 🟥 `envio.ts`: arma lotes de hasta 20 **y hasta 60 KB**, `fetch` con timeout
    (`AbortController`), y decide por status: 202 → saca de la cola; 429 → pausa hasta
    `Retry-After` o hasta el próximo minuto; 5xx o red → backoff 1 → 2 → 4 → 30 s; 413 → parte el
    lote a la mitad; 400 → descarta ese lote (el SDK no manda cuerpos inválidos, sería un bug);
    401 → apaga el cliente. Toda promesa atajada.
  - [ ] 🟥 `esperado.ts`: `esEsperado(e)` (PT4xx, `AbortError`, 401/403 de auth) + el `ignorar` del
    cliente. `id.ts`: `crypto.randomUUID` con respaldo que respeta el formato que valida finance.

- [ ] 🟥 **Paso 3: Entrada del navegador** (`src/browser/`)
  - [ ] 🟥 `initMonitor({ clave, url?, release?, ignorar?, maxBuffer?, maxPorMinuto?, debug? })`.
    Sin clave o sin `window` → no-op. Instalar es sumar dos listeners (`error`,
    `unhandledrejection`) que no llaman a `preventDefault` ni pisan handlers existentes.
  - [ ] 🟥 `capturar(error, { ruta?, contexto? })`, `setContext()`, `setUsuario({ id, rol })`,
    `limpiarUsuario()`, `flush()`, `esEsperado()`, y `onErrorQuery` / `onErrorMutation` para pasar a
    `QueryCache` / `MutationCache` de React Query (aditivos: no reemplazan los `onError` de cada
    feature). La ruta sale de `location.pathname`, el user agent de `navigator` y `ocurrido_at` del
    reloj, en el momento de capturar.
  - [ ] 🟥 Procesamiento diferido (`requestIdleCallback` o `setTimeout(0)`), con guard de
    reentrada: normalizar → descartar esperados → PII → colapsar → encolar → persistir.
    `dispositivo_id` se lee o crea en `localStorage` ahí, no al iniciar.
  - [ ] 🟥 Envío cada 2 s o al juntar 10; en `pagehide` y en `visibilitychange` a oculto, un último
    `fetch` con `keepalive` y la cola persistida; al iniciar, recupera lo que quedó de la carga
    anterior.
  - [ ] 🟥 Todo envuelto: `localStorage` inaccesible o lleno, `fetch` inexistente, JSON circular,
    errores de 1 MB — el SDK se degrada, nunca lanza.

- [ ] 🟥 **Paso 4: Entrada de servidor** (`src/deno/`)
  - [ ] 🟥 `initMonitor({ clave, url?, release?, funcion, origen? })` + `capturar` + `flush` (2 s de
    timeout, un reintento, `Retry-After` si viene).
  - [ ] 🟥 `withHandler(monitor, handler, { esEsperado?, aRespuesta? })`: si el handler responde,
    devuelve esa respuesta tal cual y reporta las 5xx; si lanza, reporta y devuelve
    `aRespuesta(error)` o un 500 JSON; el envío va en `EdgeRuntime.waitUntil`.
  - [ ] 🟥 Sin globals de Deno obligatorios: se puede probar en Node con un `EdgeRuntime` falso.

- [ ] 🟥 **Paso 5: Tests de la Regla 0 y de robustez** (los que pide el spec)
  - [ ] 🟥 `capturar()` retorna en < 1 ms y en el mismo tick no llama a `fetch` ni a `localStorage`
    (espías con orden de llamadas).
  - [ ] 🟥 Nunca lanza: circulares, `null`, `undefined`, símbolos, strings de 1 MB, `localStorage`
    que tira, `fetch` que rechaza, finance que devuelve 500, 429 y timeout. **Un fallo propio no
    dispara `unhandledrejection`** (no hay bucle).
  - [ ] 🟥 Cola, colapso, tope por minuto, lotes que no pasan 60 KB, 413 que parte el lote, 429 sin
    header legible que espera al próximo minuto, backoff, 401 que apaga, `pagehide` y
    `visibilitychange`, no-op sin clave, React Query que ignora lo esperado y no manda la
    `queryKey` entera. Servidor: respuesta idéntica, envío después de responder, 5xx reportado sin
    cuerpo, esperado no reportado.
  - [ ] 🟥 Tamaño: `scripts/tamano.mjs` mide la entrada del navegador en gzip y falla por encima de
    4 KB. `npm pack --dry-run` confirma que el paquete lleva sólo `dist`, README y LICENSE.

- [ ] 🟥 **Paso 6: README y CI**
  - [ ] 🟥 `README.md` **es el contrato**: endpoint, auth, el evento campo por campo con sus topes,
    las respuestas, y ejemplos en `curl`, en `net.http_post` (el `app.run_job` de un cron) y con el
    SDK (navegador, React Query, edge). Con los nombres de variables de la pantalla de finance, la
    Regla 0 y qué NO hace.
  - [ ] 🟥 `.github/workflows/ci.yml`: en cada PR y en `main`, `npm ci` → typecheck → test → build →
    tamaño → `npm pack --dry-run`.
  - [ ] 🟥 `.github/workflows/publish.yml`: en un tag `v*`, lo mismo y `npm publish` con
    `id-token: write` (trusted publishing con provenance), Node 22.14+ y npm 11.5.1+.

- [ ] 🟥 **Paso 7: Contra finance de verdad, antes de publicar** (con la clave de prueba del
  ambiente «Eiai Factory Finance · dev», que ya existe y se borra en el paso 8 del plan de finance)
  - [ ] 🟥 Entrada de servidor, corrida en Node contra `monitor-ingesta` de producción: un error
    llega, se agrupa, y el reintento no duplica (lectura de la base para confirmarlo).
  - [ ] 🟥 Entrada del navegador en Chrome real (Playwright, página local con el build): `throw`,
    promesa rechazada y un error de React Query llegan con ruta, release y dispositivo; un error
    esperado no llega; y **el envío al irse**: tirar un error y navegar enseguida, y ver si llega
    por `keepalive` o en la carga siguiente. El resultado se anota acá.
  - [ ] 🟥 Finance inalcanzable (la ruta bloqueada en Playwright): la página no cambia, `capturar`
    sigue en < 1 ms, la cola persiste y el SDK deja de insistir según el backoff.

- [ ] 🟥 **Paso 8: Publicar v0.1.0 y cerrar**
  - [ ] 🟥 Mariano: primera publicación y trusted publisher (paso 0).
  - [ ] 🟥 `npm view @eiaifactory/monitor` muestra 0.1.0 con los dos `exports`. La prueba de que
    `npm:@eiaifactory/monitor@0.1.0/deno` resuelve **en Supabase Edge** es el primer deploy del
    piloto de Fratelli en staging (su plan).
  - [ ] 🟥 PR en finance: `PLAN-MONITOR.md` marca el SDK hecho y linkeado, y suma al PR B
    `Access-Control-Expose-Headers: Retry-After` en `monitor-ingesta`.
