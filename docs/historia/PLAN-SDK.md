# Plan — SDK `@eiaifactory/monitor` v0.1.0

**Progreso General:** `91%`

**Spec:** [`SPEC-MONITOR.md`](https://github.com/eiaifactory/eiaifactory-finance/blob/main/docs/historia/SPEC-MONITOR.md)
(repo `eiaifactory-finance`, §«El contrato HTTP v1» y §«SDK») · **Plan de finance:**
[`PLAN-MONITOR.md`](https://github.com/eiaifactory/eiaifactory-finance/blob/main/docs/historia/PLAN-MONITOR.md)
(este SDK va entre su PR A, ya mergeado, y el piloto de Fratelli) · **Revisado con `/plan-review` el
2026-09-27** · **Estado:** v0.1.0 publicada en npm el 2026-09-28; falta la prueba en Supabase Edge (piloto de Fratelli)

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

- [x] 🟩 **Paso 0: Prerrequisitos** (Mariano, 2026-09-28)
  - [x] 🟩 OK para el primer push a `main` (plan, README mínimo, `LICENSE` MIT).
  - [x] 🟩 Repo `eiaifactory/monitor` público.
  - [x] 🟩 Cuenta de npm (con verificación en dos pasos: sin ella npm rechaza el publish con 403) y
    organización `eiaifactory`.
  - [x] 🟩 Primera publicación a mano desde `main` (sin provenance: la pone sólo el CI) y trusted
    publisher configurado en npmjs.com (organización `eiaifactory`, repo `monitor`, workflow
    `publish.yml`). La configuración se prueba de verdad con el primer tag que publique el CI.

- [x] 🟩 **Paso 1: Andamiaje** (en `feat/sdk-v0`)
  - [x] 🟩 `package.json`: `@eiaifactory/monitor` 0.1.0, `type: module`, `exports` `"."` →
    `dist/browser.js` y `"./deno"` → `dist/deno.js` (con `types`), `files: ["dist"]`,
    `sideEffects: false`, `publishConfig.access: public`, `repository` exacto, `license: MIT`.
  - [x] 🟩 `tsconfig.json` estricto; `tsup.config.ts` (dos entradas, ESM, `dts`, minificado, es2020,
    sin chunks compartidos); `vitest.config.ts` (proyecto `browser` con `happy-dom`, `node` para el
    resto); `.gitignore` y `.gitattributes` (LF).
  - [x] 🟩 `npm install` (con el npm del sistema corriendo sobre el Node x64 portable: el npm del
    portable quedó roto), typecheck, test y build en verde. Versiones: vitest 4.1 y TypeScript 5.9
    (vitest 5 pide Node 22 y TS 7 es el port nativo, sin garantía con el `dts` de tsup).

- [x] 🟩 **Paso 2: El núcleo** (`src/core/`, sin DOM ni Deno, con test cada uno)
  - [x] 🟩 `contrato.ts`: copia de tipos, topes y `recortar` de finance, con el link a la fuente.
  - [x] 🟩 `normalizar.ts`: `Error`, PostgREST (`code` → `codigo`; `details` y `hint` NO se mandan:
    traen valores de filas), Functions/Auth (`status`, `context.status`), strings, primitivos,
    circulares, Proxies que lanzan. Un objeto plano o array va como JSON; cualquier otro (un `Event`
    rechazado) como su etiqueta (`[object Event]`). `armarEvento` aplica topes y PII.
  - [x] 🟩 `pii.ts`: la regla de finance con sus mismos casos de test. El teléfono **sin
    lookbehind**: es error de sintaxis en Safari < 16.4 y rompería el bundle del cliente.
  - [x] 🟩 `colapso.ts`: FNV-1a de origen + tipo + mensaje + primer frame, ventana de 10 s.
  - [x] 🟩 `cola.ts`: tope con descarte de lo más viejo, tope por minuto de reloj, sin colapsar sobre
    lo que está en vuelo; persistencia con **tope de 128 KB** (el `localStorage` es del cliente).
  - [x] 🟩 `envio.ts`: lotes de hasta 20 y 60 KB; 202/400/401/413/429/5xx según el contrato. El
    timeout **corta por su cuenta además de abortar**: un `fetch` que ignora la señal (un
    polyfill) dejaba el envío colgado para siempre (lo encontró un test).
  - [x] 🟩 `esperado.ts` (PT4xx, `AbortError`, 401/403, y los `Auth*` de Supabase con 4xx:
    contraseña mal escrita) e `ignorar` con `search` (una regex con `/g` alternaba con `test`);
    `id.ts` con respaldo `getRandomValues` → `Math.random` (http en la red del local).

- [x] 🟩 **Paso 3: Entrada del navegador** (`src/browser/`)
  - [x] 🟩 `initMonitor` (una vez por página; sin clave o sin `window`, no-op), listeners con
    `addEventListener` (no pisa `window.onerror`).
  - [x] 🟩 `capturar`, `setContext` (suma; `undefined` saca), `setUsuario`, `limpiarUsuario`, `flush`,
    `esEsperado`, `onErrorQuery` / `onErrorMutation`.
  - [x] 🟩 Procesamiento diferido con guard de reentrada; `dispositivo_id` y la cola se leen al
    procesar, no al iniciar. Hasta 100 errores crudos esperando (freno de memoria en una ráfaga).
  - [x] 🟩 Envío cada 2 s o al juntar 10; tras un fallo manda la espera del backoff (un test
    encontró que la pisaban los 2 s); `pagehide` y `visibilitychange` con `keepalive`.
  - [x] 🟩 Todo envuelto: storage que tira, `fetch` inexistente, circulares, 1 MB.

- [x] 🟩 **Paso 4: Entrada de servidor** (`src/deno/`)
  - [x] 🟩 `initMonitor({ clave, url?, release?, funcion, origen? })` + `capturar` + `flush` (2 s por
    intento, un reintento a 1 s; ante 429 espera `Retry-After` hasta 10 s). Flushes concurrentes
    comparten el envío en curso.
  - [x] 🟩 `withHandler`: la misma respuesta; 5xx reportada sin cuerpo; si lanza, `aRespuesta` o 500
    JSON (y si `aRespuesta` lanza, el 500). **Al terminar manda todo lo capturado en el request**,
    también lo capturado a mano antes de un 200. Pasa los argumentos extra de `Deno.serve`.
  - [x] 🟩 Probado en Node con un `EdgeRuntime` falso.

- [x] 🟩 **Paso 5: Tests de la Regla 0 y de robustez** — 93 tests en 9 archivos.
  - [x] 🟩 `capturar()` < 1 ms (peor de 100, con errores de 1 MB) y sin red ni storage en el mismo tick.
  - [x] 🟩 Nunca lanza; un fallo propio no llega a `unhandledrejection` (ni al de Node) ni vuelve
    a entrar como evento.
  - [x] 🟩 Cola, colapso, tope por minuto, 60 KB, 413, 429 sin header, backoff y su reinicio, 401,
    `pagehide`, `visibilitychange`, no-op, React Query; servidor completo.
  - [x] 🟩 `scripts/tamano.mjs`: **4081 B gzip** de 4096 (quedan 15 B; se recortaron los textos de
    `debug`). `npm pack --dry-run`: `dist`, README, LICENSE y package.json.
  - [x] 🟩 Mutaciones: 16 cambios de comportamiento aplicados de a uno; los 16 rompen la suite.

- [ ] 🟨 **Paso 6: README y CI**
  - [x] 🟩 `README.md` es el contrato, con ejemplos (navegador + React Query + `release` en
    Railway, edge, Node, `curl`, `app.run_job` con `net.http_post`) y qué NO hace. **El SQL de
    `app.run_job` no se ejecutó**: lo valida el piloto de Fratelli.
  - [x] 🟩 `.github/workflows/ci.yml`: en verde en eiaifactory/monitor#1 (mergeado el 2026-09-28).
  - [ ] 🟨 `.github/workflows/publish.yml` escrito (con chequeo de que el tag coincide con la
    versión); se prueba recién en el paso 8.

- [x] 🟩 **Paso 7: Contra finance de verdad** (2026-09-28, clave del ambiente fixture)
  - [x] 🟩 Servidor, en Node con el build: la primera respuesta se «perdió» a propósito y el
    reintento volvió `duplicados: 1`; en la base, el evento está una vez y los dos `throw` son un
    problema con `conteo 2`; la 503 llegó como `e2e-servidor: respondió 503`, sin el cuerpo, y
    la ruta sin query.
  - [x] 🟩 Navegador (Chromium de Playwright, página local con el build y un `QueryClient` real):
    `throw`, promesa rechazada, query y mutation llegaron con ruta, release, dispositivo, user
    agent y tipo; de la key, sólo el nombre; el PT402 no llegó; 200 `capturar` viajaron como 2
    eventos con `repeticiones`; `capturar` ≤ 0,2 ms. **Envío al irse: llega por `keepalive`**
    (1 s después, con la página ya en otra URL), también en un contexto limpio sin el preflight
    cacheado. Como la pestaña muere antes de la respuesta, la carga siguiente lo reenvía y finance
    lo cuenta como duplicado.
  - [x] 🟩 Finance bloqueado: página intacta, `capturar` en 0,2 ms, cola persistida, reintentos a
    +1, +2, +4 y +30 s; al desbloquear, un lote con `recibidos: 3, duplicados: 1` y la cola vacía.
  - Hallazgo del arnés, no del SDK: un loop de 200 `capturar` sincrónicos llenó el tope de 100
    crudos antes de que Chrome disparara un `throw` y un rechazo, que se perdieron. Es el freno de
    ráfaga; quedó documentado en el README.

- [ ] 🟨 **Paso 8: Publicar v0.1.0 y cerrar**
  - [x] 🟩 Mariano: primera publicación y trusted publisher (paso 0).
  - [x] 🟩 `npm view @eiaifactory/monitor` (2026-09-28): 0.1.0, `latest`, MIT, 8 archivos, los dos
    `exports` con sus tipos; la integridad coincide con el tarball que armó Mariano. Instalado desde
    npm en una carpeta aparte, las dos entradas importan y exportan lo esperado.
  - [ ] 🟥 Que `npm:@eiaifactory/monitor@0.1.0/deno` resuelve **en Supabase Edge**: lo prueba el
    primer deploy del piloto de Fratelli en staging (su plan).
  - [ ] 🟨 PR en finance: `PLAN-MONITOR.md` marca el SDK hecho y linkeado, y suma al PR B
    `Access-Control-Expose-Headers: Retry-After` en `monitor-ingesta`.

## Pendiente conocido

- `npm audit`: esbuild 0.27.x (dependencia de tsup, sólo desarrollo) tiene un aviso bajo sobre su
  servidor de desarrollo en Windows, que acá no se usa. El arreglo está en 0.28.1 y tsup fija
  `^0.27`: se resuelve cuando tsup suba, o con un `overrides`.
