# cowork-sync

cowork-sync es un plugin de Claude Code que mantiene sincronizado, en tiempo
real, el árbol de trabajo de una rama de git entre varios clones. Cada
compañero trabaja en su propio PC, en su propio clone, con su propia sesión de
Claude Code. Cuando alguien guarda un archivo, el cambio llega al árbol de
trabajo de todos los demás. El único medio de transporte es el remoto git del
propio proyecto. No hay ningún servidor.

cowork-sync es un proyecto personal de código fuente disponible. No está
afiliado a ninguna empresa o empleador, ni patrocinado ni respaldado por ellos.
Está licenciado bajo FSL-1.1-ALv2 (véase [LICENSE.md](LICENSE.md)), y las
contribuciones requieren el CLA descrito en [CONTRIBUTING.md](CONTRIBUTING.md).

## Estado: v0.1.0-preview

Esta es una versión preliminar temprana, no un producto terminado. Lo que
funciona ahora: el motor de sincronización. Un proceso en segundo plano (el
daemon) por clone recoge las ediciones guardadas, las publica en el remoto y
escribe las ediciones de tus compañeros en tu árbol de trabajo. Se probó en un
repositorio real de GitHub con dos clones: las ediciones en archivos
distintos, en el mismo archivo con diez líneas de distancia y en la misma línea
terminaron en el mismo estado en ambos clones, sobre un único historial de
avance rápido (fast-forward). También está incluido el núcleo del visor de solo
lectura, que muestra en un navegador la actividad del equipo. Lo que todavía no
está: la experiencia de uso de las retenciones por conflicto (se conserva la
versión desplazada, pero no hay ningún comando para verla ni restaurarla), las
reclamaciones a nivel de función, los hooks de sesión de Claude Code y la
coordinación entre instancias de Claude (en esta versión preliminar Claude no
sabe nada de la sincronización; sus ediciones se sincronizan como las de
cualquier otro archivo guardado), la línea de comandos completa (save, doctor,
las comprobaciones al iniciar, como la de remoto privado, y pausar y reanudar)
y el visor 2 (seis idiomas, grabación, resumen de momentos destacados). Usa la
versión preliminar solo en un repositorio de prueba.
[docs/STATUS.md](docs/STATUS.md) enumera lo que está hecho y lo que viene.

## Requisitos

- Claude Code 2.1.270 o superior.
- Node.js 20 o superior en el `PATH` (20.6 o superior para compilar desde el
  código fuente).
- git 2.43 o superior. Start rechaza una versión de git más antigua.
- Windows, macOS o Linux.
- Un remoto git **privado** que acepte refs personalizadas (`refs/cowork/*`) y
  haga cumplir `--force-with-lease`. GitHub hace ambas cosas. Start sondea el
  host y rechaza uno que no lo haga.
- Credenciales de un asistente de credenciales de git (credential helper).
  cowork-sync desactiva las solicitudes interactivas de git, así que si falta
  una credencial recibirás un rechazo claro en lugar de un bloqueo.

## Instalación

Cada PC que participe instala el plugin y tiene su propio clone del
repositorio.

En una sesión de Claude Code:

```text
/plugin marketplace add Kingyoungmins/cowork-sync
/plugin install cowork-sync@cowork-sync
```

O desde una shell:

```sh
claude plugin marketplace add Kingyoungmins/cowork-sync
claude plugin install cowork-sync@cowork-sync
```

Ejecuta `/reload-plugins` (o reinicia Claude Code) para cargarlo. Las
actualizaciones no son automáticas en este marketplace. Para actualizar,
ejecuta `/plugin marketplace update cowork-sync` y después
`claude plugin update cowork-sync@cowork-sync`. Para quitar el plugin, ejecuta
`claude plugin uninstall cowork-sync@cowork-sync`.

## Uso

Abre Claude Code en tu clone y escribe los comandos de abajo. Claude Code
nombra el comando del plugin `/cowork-sync:cowork`; escribe ese nombre
completo. Los mismos verbos también se ejecutan en una terminal, como
`node "<plugin folder>/dist/cli.js" <verb>`; `/cowork-sync:cowork view`
imprime esa ruta.

| Comando | Qué hace |
| :- | :- |
| `/cowork-sync:cowork start [--branch <b>]` | Inicia la sincronización de este repositorio, en la rama actual. El primer PC crea el tablero compartido en el remoto; los siguientes se unen a él. El daemon sigue ejecutándose en segundo plano. |
| `/cowork-sync:cowork status` | Imprime un resumen breve: el estado (`ok`, `degraded`, `offline`, `frozen`, `down`, etc.), la rama y lo que aún está pendiente de publicar o aplicar. |
| `/cowork-sync:cowork view` | Imprime el comando que abre el visor de solo lectura. El visor solo se abre desde una terminal: ejecuta ese comando allí y se abrirá en tu navegador. Si tu compilación aún no tiene el proceso del visor, lo rechaza con `RF_VIZ_START_FAILED` (véase [CHANGELOG.md](CHANGELOG.md)). |
| `/cowork-sync:cowork stop` | Detiene el daemon de forma limpia. Tus archivos se quedan como están. |
| `/cowork-sync:cowork help` | Lista los comandos. |

Cuando un comando se rechaza, imprime el motivo con un código y una línea
`next:` con el comando que debes ejecutar. Cuando es el propio daemon el que se
niega a iniciar, sus propias líneas siguen a `the daemon did not start; it said:`.

Qué comprueba `start`:

- Se ejecuta en el clone principal. Un worktree enlazado o un submódulo se
  rechaza.
- La rama está desprotegida (checked out), existe en el remoto y no está ni
  por delante ni por detrás de él. Haz push o pull antes. No puede haber un
  merge o rebase en curso.
- La URL de fetch del remoto es igual a su URL de push, y no se aplica ninguna
  reescritura `insteadOf`.
- Solo se ejecuta un daemon por clone.
- Si tienes cambios sin confirmar en el primer inicio, se detiene y te pide
  elegir: compartirlos con el equipo o mantenerlos en este PC.

Mientras la sincronización está activa:

- Guarda los archivos como siempre. Tus ediciones guardadas se publican y las
  ediciones de tus compañeros se escriben en tus archivos.
- No ejecutes comandos de git que muevan `HEAD` en un clone sincronizado
  (commit, switch, checkout, pull, merge, rebase, stash). La sincronización se
  congela hasta que `HEAD` vuelva a donde estaba. Detén primero la
  sincronización.
- Todavía no existe un paso `save` que convierta el trabajo compartido en un
  commit de la rama. Eso llegará con la línea de comandos completa. Considera
  la versión preliminar como una forma de probar la sincronización en vivo en
  una rama de prueba.

Cada clone guarda sus propios archivos en `.git/cowork/`: `status.json` (el
estado actual) y `log/daemon-0.jsonl` (el registro del daemon).

## Cómo funciona

1. Cada clone ejecuta un daemon. Lee tus archivos guardados a través de su
   propio índice git privado y nunca toca el tuyo.
2. El estado compartido vive en dos refs personalizadas de tu remoto:
   `refs/cowork/<branch>/board`, una cadena de commits del tablero que solo
   avanza por fast-forward y que es la autoridad, y
   `refs/cowork/<branch>/code`, un espejo del último árbol compartido. Los
   nombres de rama se codifican con porcentaje (percent-encoding) en estas
   refs.
3. Cada push es un fast-forward protegido por un lease (`--force-with-lease`),
   de modo que ningún PC puede sobrescribir la actualización de otro. El que
   pierde hace fetch y vuelve a intentarlo. Un presupuesto para todo el equipo
   (12 pushes por minuto, 6 durante media hora tras cualquier limitación) mantiene
   baja la carga sobre el host.
4. Los cambios entrantes se fusionan con `git merge-tree` usando bases de
   fusión explícitas.
5. Un archivo se escribe solo si todavía contiene los bytes que el daemon leyó
   por última vez, así que una edición que acabas de guardar nunca se
   sobrescribe. Un grupo de archivos se escribe completo o no se escribe nada.
6. Cuando dos personas cambian la misma línea, una versión gana y la otra se
   conserva como registro de retención (hold) en tu clone. Nunca se descarta.
7. Los ajustes, los hooks y los archivos de CI (`.claude/`,
   `.github/workflows/`, `.gitattributes` y similares) nunca se sincronizan en
   vivo. Si alguna vez se reescribe el historial del tablero, todos los PC se
   congelan hasta que se recupere.
8. La versión preliminar nunca hace push a tu rama (`refs/heads/<branch>`). Un
   simple `git fetch` no descarga las refs personalizadas, así que tu historial
   normal de git se mantiene limpio.

## Notas de seguridad

- cowork-sync escribe en tu árbol de trabajo, y también lo hacen las ediciones
  de tus compañeros. Pruébalo primero en un repositorio de prueba y haz copia
  de seguridad de lo que te importe.
- Usa únicamente un remoto **privado**. Todo lo que guardes en un clone
  sincronizado se envía a `refs/cowork/*`, y cualquiera que pueda leer el
  repositorio puede descargarlo. La versión preliminar todavía no comprueba que
  el remoto sea privado.
- Los archivos nuevos cuyos nombres parecen secretos (`.env`, `*.pem`, `*.key`,
  `id_rsa*`, `*credentials*` y más) no se comparten. Todavía no se analiza el
  contenido de los archivos en busca de secretos, así que no pongas secretos en
  archivos sincronizados.
- Los archivos de más de 1 MiB no se comparten cuando son nuevos, y los
  archivos de 50 MiB o más nunca se sincronizan en vivo.
- Detener la sincronización o desinstalar el plugin deja las refs
  personalizadas en el remoto. Cuando todos los PC se hayan detenido, puedes
  borrarlas a mano, por ejemplo
  `git push origin --delete refs/cowork/main/board refs/cowork/main/code`.

## Licencia

cowork-sync se publica bajo la Functional Source License 1.1 con la Apache
License 2.0 como licencia futura (FSL-1.1-ALv2, [LICENSE.md](LICENSE.md)). En
resumen: puedes usarlo, copiarlo, modificarlo y compartirlo para cualquier
propósito, excepto un uso competidor, es decir, ofrecerlo a otros, o algo que
haga sustancialmente lo mismo, como producto o servicio comercial. Se permiten
el uso interno, la educación, la investigación y los servicios profesionales
para un licenciatario. Cada versión pasa a estar disponible bajo la Apache
License 2.0 dos años después de su publicación.

Las contribuciones requieren el acuerdo de licencia de contribuidor de
[CLA.md](CLA.md). Consulta [CONTRIBUTING.md](CONTRIBUTING.md) para saber cómo
firmarlo y cómo trabajar en el código.

## Contacto

Preguntas: minzbusiness0204@gmail.com. Informa de los problemas de seguridad a
través del sistema privado de informe de vulnerabilidades del repositorio, no
por correo electrónico. Véase [SECURITY.md](SECURITY.md).
