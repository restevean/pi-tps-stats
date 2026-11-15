# pi-tps-stats

[Inglés](README.md)

> **Hecho con [Gentle Shell](https://github.com/Gentleman-Programming/gentle-shell),
> para Gentle Shell.** También funciona con Pi sin Gentle Shell.

> **Basado en un fork de
> [pi-live-throughput](https://github.com/apetersson/pi-live-throughput)** de
> Andreas Petersson (MIT), a partir de la versión 0.3.0
> (`dcedab3 chore(release): 0.3.0`). Este proyecto es independiente y no está
> afiliado ni respaldado por el autor original.

Una línea con los tokens por segundo en vivo sobre el editor de prompts del
[agente de programación Pi](https://pi.dev).

Requiere pi 1.x. El widget usa un color de texto propio, `#7E86AE`, sin cambiar
el tema activo ni el resto de la interfaz.

En modo terminal, el widget se registra una sola vez mientras está visible. Las
actualizaciones durante el streaming, las respuestas siguientes y los reinicios
de una medición activa repintan ese mismo componente en lugar de registrarlo de
nuevo. Las líneas largas se recortan al ancho del terminal, de modo que el texto
de TPS ocupa una sola fila, seguida de una fila en blanco. Pasar al modo status,
ocultar la línea o terminar la sesión elimina solo el widget de esta extensión.

Así las actualizaciones de TPS no mueven el widget respecto a los demás. El
widget usa la zona sobre el editor y se monta, vacío, al iniciar la sesión,
porque Pi coloca los widgets en el orden en que se registran. Eso lo mantiene
por delante de los widgets que otra extensión registra o vuelve a publicar más
tarde, como un banner de estado. Cada extensión sigue controlando sus propios
widgets, y esta nunca los modifica ni modifica el host. El modo RPC mantiene el
widget como lista de cadenas, porque allí no se admiten componentes de terminal
personalizados.

Mientras se recibe una respuesta del asistente, el widget muestra estos campos
en orden: **TPS → promedio de la sesión → TTFT → TTFT promedio de la sesión → caché
leída/escrita → % de caché leída/escrita → total → duración**. Cuando termina
el streaming, el resumen final sigue visible hasta que la siguiente respuesta
empieza a medirse (consulta [Ventana de medición](#ventana-de-medición)):

```text
TPS 11.4 tok/s, avg 11.4 tok/s, TTFT 0.82s, avg 1.10s, cache 0/85,571, cache % 0.0%/100.0%, total 85,606, 2.9s
```

`/tps out-in on` añade los contadores de salida y entrada entre el TTFT promedio y
los contadores de caché. Están desactivados por defecto; `/tps out-in off` los
vuelve a ocultar y `/tps out-in` sin argumento los alterna. El interruptor solo
afecta a `out` e `in`: `cache`, `cache %` y `total` se muestran siempre, y
`total` siempre incluye la salida y la entrada, se muestren o no:

```text
TPS 11.4 tok/s, avg 11.4 tok/s, TTFT 0.82s, avg 1.10s, out 33, in 2, cache 0/85,571, cache % 0.0%/100.0%, total 85,606, 2.9s
```

### Qué significa cada valor

Valores de los ejemplos anteriores, de izquierda a derecha:

| Campo                    | Ejemplo       | Significado                                                                                                                                                    |
| ------------------------ | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TPS`                    | `11.4 tok/s`  | Tokens de salida por segundo: la tasa móvil durante el streaming y el promedio de la respuesta al terminar.                                                    |
| `avg` (tras TPS)         | `11.4 tok/s`  | TPS promedio de la sesión: todos los tokens de salida entre todo el tiempo de generación, ponderado por tiempo.                                                |
| `TTFT`                   | `0.82s`       | Tiempo hasta el primer token de esta respuesta: desde la petición al proveedor (o el inicio del turno) hasta la primera salida. `--` hasta que llega.          |
| `avg` (tras TTFT)        | `1.10s`       | TTFT promedio de la sesión: promedio simple de las respuestas hasta ahora, incluida la actual en cuanto llega su primera salida. `--` hasta que hay una.       |
| `out` (`/tps out-in on`) | `33`          | Tokens de salida que generó el modelo en esta respuesta. Oculto por defecto.                                                                                   |
| `in` (`/tps out-in on`)  | `2`           | Tokens de entrada sin caché de esta respuesta, aparte de las lecturas y escrituras de caché. Oculto por defecto.                                               |
| `cache`                  | `0/85,571`    | Tokens del prompt leídos de la caché / escritos en la caché en esta respuesta.                                                                                 |
| `cache %`                | `0.0%/100.0%` | Caché leída / caché escrita como parte del prompt (`input + cacheRead + cacheWrite`).                                                                          |
| `total`                  | `85,606`      | Todos los tokens de esta respuesta: salida + entrada + caché leída + caché escrita. Se muestra siempre.                                                        |
| duración                 | `2.9s`        | Ventana de generación medida, normalmente desde el segundo token de salida, así que no incluye el TTFT (consulta [Ventana de medición](#ventana-de-medición)). |

Un `~` delante de `TPS`, `out` o `total` indica una estimación hecha a partir del
texto recibido mientras el proveedor aún no ha informado del uso.

El TTFT (time to first token, tiempo hasta el primer token) es el tiempo desde
la petición al proveedor hasta la primera salida de la respuesta: texto,
thinking o una llamada a una herramienta. Con los proveedores que no emiten el
evento de petición, como `claude-bridge`, que delega la petición en Claude Code,
se mide desde el inicio del turno, así que incluye también su propio tiempo de
arranque. Un segundo mensaje dentro del mismo turno, sin ninguno de los dos,
cuenta desde el inicio de ese mensaje. Muestra `--` hasta que llega la primera
salida. Su `avg` es el promedio simple del TTFT de las respuestas completadas de
la sesión, incluida la respuesta en curso en cuanto llega su primera salida. Las
respuestas sin salida y las que Pi marca como abortadas o fallidas quedan fuera
de ese promedio, pero su propia línea sí muestra su TTFT. Una sesión nueva o
`/reload` reinician el promedio, y `/tps reset` no lo borra.

Los contadores usan enteros completos con separadores de miles en inglés.
`total` es la suma de los tokens de salida, entrada, caché leída y caché escrita
de la respuesta actual, no de la sesión, se muestren o no `out` e `in`. Los dos
modos muestran los mismos campos; un cero en la entrada o la caché refleja el
uso normalizado de Pi y no demuestra que el proveedor informara de un cero.

`cache %` va justo después de los contadores de caché. Cada porcentaje usa
`input + cacheRead + cacheWrite` como denominador, sin contar la salida, y se
redondea a un decimal. Por ejemplo, entrada 100, caché leída 800 y caché escrita
100 da `80.0%/10.0%`. Sin tokens de prompt muestra `0.0%/0.0%`.

`avg` es el promedio de la sesión: todos los tokens de salida divididos entre todo
el tiempo de generación desde que la extensión arrancó en esta sesión, incluida
la respuesta en curso. Está ponderado por tiempo, así que una respuesta larga y
lenta pesa más que una corta y rápida; no es el promedio de los promedios de cada
respuesta. Una sesión reanudada empieza desde cero, porque las respuestas
anteriores no se reproducen. `/tps reset` borra solo el resumen mostrado o la
medición actual, nunca el promedio de la sesión, y una sesión nueva o `/reload` lo
reinician.

El TPS en vivo es la tasa móvil; el TPS final es el promedio sobre la ventana de
generación medida. Las cifras en vivo usan el `usage.output` acumulado que
informa el proveedor a través de Pi cuando avanza. Si no, los fragmentos de
texto, thinking y llamadas a herramientas dan una estimación, marcada con `~`
delante del TPS, la salida y el total. Los contadores finales usan siempre el
uso que informa el proveedor. Los campos de entrada y caché se actualizan cuando
Pi los expone, lo que puede ocurrir solo al terminar.

`/tps status` publica exactamente la misma línea mediante la API de status de Pi
en lugar de un widget. El host decide dónde aparece un status: Gentle Shell lo
muestra en el panel lateral, en Status → Integrations, no debajo de la entrada,
y le aplica su propio color, así que `#7E86AE` solo se aplica al widget.

## Ventana de medición

Las tasas de TPS en vivo y final empiezan a medir solo después de observar un
segundo token de salida. Dejar el tiempo hasta el primer token (que se muestra
aparte como TTFT) fuera de la ventana de medición hace que las tasas móvil y
promedio describan la velocidad de decodificación, no el procesamiento del
prompt, la cola del proveedor ni la latencia de red. Solo los tokens observados
después de empezar la medición cuentan para una tasa; los contadores de tokens
siguen mostrando la salida acumulada de la respuesta.

La línea nunca sustituye una lectura real por otra cuya tasa de TPS sea `0.0`:
mientras la tasa actual fuera a marcar cero, por ejemplo mientras un subagente
trabaja en otro proceso o mientras el proveedor hace una pausa, sigue mostrando
la última lectura con una tasa mayor que cero hasta que aparece una nueva. La
primera respuesta de una sesión y la primera tras `/tps reset` no tienen una
lectura anterior, así que muestran sus ceros. Esto incluye el TTFT: mientras la
siguiente respuesta espera su primer token, la línea sigue mostrando el TTFT de
la respuesta anterior, así que `TTFT --` solo aparece en esas primeras
respuestas. Solo se retiene lo que se muestra; las estadísticas no se ven
afectadas.

Cuando una respuesta termina antes de que llegue un segundo token de salida, o
cuando la ventana medida captura menos de un token de salida completo, el
resumen final usa el tiempo de toda la respuesta en lugar de mostrar una tasa
engañosa cercana a cero. Como el uso del proveedor es acumulado, al pasar de la
estimación heurística al uso informado por el proveedor se adopta el recuento
del proveedor para la respuesta hasta ese momento, que puede incluir los pocos
tokens observados justo antes de abrirse la ventana.

La duración al final de la línea es la ventana de generación medida, no
necesariamente el tiempo total de la respuesta.

Tras `/tps reset` durante una respuesta, las tasas en vivo y final usan solo la
salida posterior al reinicio. Mientras la respuesta llega, `out` y `total`
tampoco cuentan la salida anterior al reinicio, así que bajan al reiniciar; el
total final de tokens sigue describiendo la respuesta completa. El reinicio no
cambia el TTFT de la respuesta ni el TTFT promedio de la sesión. Si el uso del
proveedor no está disponible en el momento del reinicio, la salida anterior se
estima a partir de sus fragmentos y se resta del cálculo de la tasa final.

## Estadísticas de la sesión

También puedes abrir el panel **haciendo clic en la línea de TPS** (clic
izquierdo en la fila de datos, no en la fila en blanco de debajo). El clic es
una capacidad del widget: es un evento de ratón sobre su fila, así que en modo
status, o con la línea oculta, no hay fila en la que hacer clic. Necesita la
interfaz de terminal en modo pantalla completa, el modo por defecto de Pi,
porque el modo normal deja el ratón al terminal y no envía clics a las
extensiones; `/tps stats` funciona siempre. No hay nada en lo que hacer clic
mientras la línea no se dibuja: antes de que empiece la primera respuesta y
después de que `/tps reset` haya borrado un resumen final. Mientras la línea se
dibuja, un clic abre el panel, o avisa de que no hay datos cuando todavía no se
ha registrado ninguna respuesta en las estadísticas (las respuestas abortadas,
fallidas y vacías no se registran). Con el panel abierto, un clic en la línea lo
cierra. El panel se dibuja sobre la pantalla, así que el clic tiene que caer en
la parte de la línea que el panel no tapa. Dentro del panel, solo un clic en su
indicación `esc close` lo cierra; un clic en cualquier otro punto del panel no
hace nada. La indicación se vuelve amarilla mientras el puntero está encima. El
terminal solo informa a la extensión de los movimientos del puntero dentro del
panel, así que un puntero que sale del panel de un salto rápido puede dejar la
indicación en amarillo hasta que vuelva a moverse dentro del panel.

`/tps stats` abre un panel con marco, centrado en la pantalla como el panel de
uso de Claude. Se cierra con Esc, `q` o Ctrl+C, con cualquier tecla que hayas
asignado a cancelar, o haciendo clic en su indicación `esc close` o en la línea
de TPS (fuera del panel, como se describe arriba); los dos clics necesitan el
modo pantalla completa. Es estrecho: el 26.25% del terminal, con un mínimo de 57
columnas. Tiene una entrada por cada mensaje del asistente completado que
produjo salida desde que empezó la sesión. Los mensajes abortados, fallidos o
vacíos, y los que quedan con menos de un token tras un `/tps reset`, se omiten,
y también quedan fuera del `avg` de la línea del widget. El panel contiene:

- Dos gráficos de barras compactos con eje de valores, uno para el TPS y otro
  para el % de caché leída, dibujados del más antiguo al más reciente. Cada
  mensaje es una barra de dos columnas de ancho, separada por una columna en
  blanco, y las barras miden seis filas de alto; cuando hay más mensajes de los
  que caben, solo se dibujan los más recientes, y en un terminal bajo (menos de
  27 filas) los gráficos se reducen a tres filas. La cabecera de cada gráfico
  muestra su promedio, luego su máximo y su mínimo (no hay una fila aparte de
  resumen del TPS). Una fila en blanco separa el título de la línea de alcance,
  y otra separa la línea de alcance del primer gráfico.
- **Cache write %**: promedio, máximo y mínimo (en el mismo orden que las cabeceras
  de los gráficos) en una línea debajo del gráfico de caché leída, tras una fila
  en blanco; no tiene gráfico propio.
- Una línea de referencia punteada (`┄`) en cada gráfico a la altura de su
  máximo y de su mínimo, con los dos valores en el título del gráfico. Las
  líneas y las barras terminan cuatro columnas antes del borde derecho. Cuando
  las dos coinciden en la misma fila (por ejemplo, con un solo mensaje) solo se
  dibuja una línea.

**Qué cubre el panel.** Las cifras (`avg`, `max`, `min`, las líneas de
referencia y la línea de caché escrita) cubren siempre **toda la sesión**. Las
barras muestran solo **las respuestas más recientes que caben** en el ancho del
panel, y la línea de alcance bajo el título lo indica:
`Stats: whole session · bars: last 16 of 200`, o `Stats and bars: whole session`
cuando caben todas las respuestas. El número de ese texto es el número de
barras dibujadas.

**Escala.** El gráfico de TPS se escala a las barras dibujadas: el tope de su
eje es la barra visible más alta, así que aprovechan toda la altura. La
cabecera sigue mostrando el `max` y el `min` de la sesión; una línea de
referencia punteada solo se dibuja cuando su valor cae dentro de la escala
visible, así que un récord de una respuesta antigua que ya no se dibuja no
tiene línea. El gráfico de caché leída es un porcentaje y va siempre de 0 a 100.

Las etiquetas del eje de los dos gráficos comparten un margen de cuatro columnas
que crece cuando la etiqueta superior del TPS es más larga, como con un pico de
`13550`. El eje se mantiene como una sola línea recta, y las columnas extra se
restan de las barras.

El mínimo y el máximo son por mensaje. Los promedios son ponderados: el TPS es el
total de tokens de salida entre el tiempo total de generación, y el % de caché
es el total de tokens de caché entre el total de tokens de prompt
(`input + cacheRead + cacheWrite`), no un promedio de porcentajes. Los datos solo
viven en memoria; una sesión nueva, `/reload` o una sesión reanudada empiezan
desde cero, y `/tps reset` no los borra. Sin componentes de terminal (modo RPC),
el mismo texto se envía como notificación.

## Métricas de prompt y caché

Pi normaliza el uso del prompt en contadores separados: `input`, `cacheRead` y
`cacheWrite`. `input` es la parte que ni se leyó de la caché ni se escribió en
ella; los tokens leídos de la caché se muestran aparte y nunca se presentan como
tokens procesados por el modelo. Como Pi inicializa a cero los campos de uso no
disponibles, un cero se muestra como `0` y no como un dato confirmado por el
proveedor. La tasa aproximada de procesamiento del prompt no se muestra.

## Instalación

Instálala desde npm. Con Gentle Shell, que reenvía `install` a Pi sobre su
propio directorio (`~/.gentle-shell/agent`, salvo que uses `--link`):

```bash
gentle-shell install npm:pi-tps-stats
```

Con Pi sin Gentle Shell, que usa `~/.pi/agent`:

```bash
pi install npm:pi-tps-stats
```

Sin versión se instala la última publicada. Para fijar una, añádela al origen,
como en `npm:pi-tps-stats@<version>`; Pi trata un origen npm con versión como
fijado. npm tiene todas las versiones desde la 0.1.5; las
[releases](https://github.com/restevean/pi-tps-stats/releases) las listan todas,
y cualquiera de ellas, también las antiguas, se puede instalar desde git fijada
a su etiqueta: `git:github.com/restevean/pi-tps-stats@v<version>`. Sin
etiqueta, una instalación desde git sigue el último `main`, que puede cambiar.

Instálala desde un solo origen. Pi distingue los paquetes npm por su nombre y
los de git por la URL del repositorio, así que una instalación desde npm y otra
desde git de esta extensión se cargarían las dos. Para cambiar desde una
instalación con git, elimínala primero; la versión se puede omitir:

```bash
pi remove git:github.com/restevean/pi-tps-stats
pi install npm:pi-tps-stats
```

Usa `gentle-shell` en lugar de `pi` para una instalación en Gentle Shell.

Para instalar una copia local, usa cualquiera de estos comandos:

```bash
gentle-shell install /absolute/path/to/pi-tps-stats
pi install /absolute/path/to/pi-tps-stats
```

Usa `/reload` si Pi ya estaba en marcha cuando instalaste o cambiaste la
extensión.

## Comandos

Ejecuta `/tps` solo para abrir un menú: muévete con las flechas, elige una
acción con Enter o sal con Esc (no cambia nada). Sin interfaz de terminal (modo
print) no hay a quién preguntar, así que `/tps` sin argumento muestra el modo de
uso y no cambia nada.

El widget persistente en `#7E86AE` está activado por defecto sobre el editor de
prompts. Usa `/tps status` para publicar el mismo texto como status, y
`/tps widget` para volver.

| Comando           | Efecto                                                         |
| ----------------- | -------------------------------------------------------------- |
| `/tps`            | Abre un menú con las acciones siguientes (flechas, Enter, Esc) |
| `/tps on`         | Activa el modo de visualización elegido antes                  |
| `/tps off`        | Oculta la línea                                                |
| `/tps widget`     | Activa el widget persistente sobre el editor                   |
| `/tps status`     | Publica la misma línea como status del host                    |
| `/tps stats`      | Abre un panel con estadísticas de la sesión y gráficos         |
| `/tps reset`      | Reinicia la medición activa o borra el resumen final           |
| `/tps out-in on`  | Muestra `out` e `in` en la línea (`total` se muestra siempre)  |
| `/tps out-in off` | Vuelve a ocultar `out` e `in` (por defecto)                    |
| `/tps out-in`     | Alterna `out` e `in`                                           |

## Desarrollo

Este proyecto usa solo pnpm. El comando de verificación comprueba el formato con
Prettier, la compilación estricta de TypeScript, ESLint sin avisos y la batería
de tests:

```bash
pnpm install --frozen-lockfile
pnpm run verify
```

Aplica el formato con `pnpm run format`. Ejecuta cada comprobación por separado
con `pnpm run format:check`, `pnpm run check`, `pnpm run lint` o
`pnpm run test`.

Para cargar la extensión local sin instalarla:

```bash
cd /path/to/pi-tps-stats
gentle-shell -e ./src/index.ts
```

Esto carga el código local para una sola ejecución, sin añadirlo a tu
configuración permanente de paquetes. Usa `pi` en lugar de `gentle-shell` para
Pi sin Gentle Shell, y no lo cargues junto a una copia instalada de esta
extensión.

## Diferencias con el original

- El comando es `/tps` (el original usa `/throughput`); solo, abre un menú en
  lugar de alternar.
- `/tps stats` muestra un panel de estadísticas con gráficos.
- El widget también muestra el promedio de la sesión (`avg`), ponderado por el
  tiempo de generación.
- El widget se dibuja sobre el editor en `#7E86AE` y muestra una línea fija:
  `TPS`, TTFT con su promedio, caché leída/escrita, `cache %`, total y duración;
  `/tps out-in on` añade la salida y la entrada.
- `/tps status` publica esa misma línea en lugar del formato compacto original.
- El widget se monta una vez y se repinta en su sitio, en lugar de registrarse
  de nuevo en cada actualización.
- La tasa aproximada de procesamiento del prompt no se muestra.

## Seguridad

La extensión lee solo los contadores de uso que Pi informa para cada mensaje del
asistente. No lee ni escribe archivos, no abre conexiones de red, no inicia
procesos ni lee variables de entorno, y nunca muestra texto del modelo: la
pantalla recibe números formateados y mensajes fijos. Un contador que no es un
número finito se muestra como 0, y uno muy grande se limita a 10^15. Como
cualquier extensión de Pi, se ejecuta con tus permisos, así que fija la versión
que hayas revisado: `npm:pi-tps-stats@<version>`, o una etiqueta de git.

El paquete no tiene dependencias en tiempo de ejecución ni scripts de
instalación, y publica solo `src`, `README.md`, `README.es.md`, `LICENSE` y el
`package.json` que npm incluye siempre. Los scripts de compilación de las
dependencias están denegados en `pnpm-workspace.yaml`, y los tests hacen cumplir
todo lo anterior.

## Licencia

Publicado bajo la licencia MIT. El aviso de copyright original de Andreas
Petersson se conserva en [LICENSE](LICENSE), como exige la licencia, seguido del
aviso de las modificaciones de este fork (restevean).

[MIT](LICENSE)
