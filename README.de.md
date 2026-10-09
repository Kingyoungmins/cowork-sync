# cowork-sync

cowork-sync ist ein Claude-Code-Plugin, das das Arbeitsverzeichnis eines
git-Branches zwischen mehreren Klonen in Echtzeit synchron hält. Jedes
Teammitglied arbeitet an seinem eigenen PC, in seinem eigenen Klon und mit
seiner eigenen Claude-Code-Sitzung. Wenn jemand eine Datei speichert, kommt die
Änderung in den Arbeitsverzeichnissen aller anderen an. Der einzige
Übertragungsweg ist das git-Remote des Projekts selbst. Es gibt keinen Server.

cowork-sync ist ein persönliches Projekt mit einsehbarem Quellcode
(source-available). Es steht in keiner Verbindung zu einem Unternehmen oder
Arbeitgeber und wird von keinem gesponsert oder empfohlen. Es steht unter der
Lizenz FSL-1.1-ALv2 (siehe [LICENSE.md](LICENSE.md)), und für Beiträge ist die
in [CONTRIBUTING.md](CONTRIBUTING.md) beschriebene CLA nötig.

## Status: v0.1.0-preview

Dies ist eine frühe Vorschau, kein fertiges Produkt. Was jetzt funktioniert:
die Synchronisations-Engine. Pro Klon läuft ein Hintergrundprozess (der
Daemon), der gespeicherte Änderungen aufnimmt, sie zum Remote veröffentlicht
und die Änderungen der Teammitglieder in dein Arbeitsverzeichnis schreibt. Sie
wurde mit einem echten GitHub-Repository und zwei Klonen getestet: Änderungen
an verschiedenen Dateien, an derselben Datei in zehn Zeilen Abstand und an
derselben Zeile endeten auf beiden Klonen im selben Zustand, auf einer
einzigen Fast-Forward-Historie. Der Kern des schreibgeschützten Viewers, der
die Aktivität des Teams im Browser darstellt, ist ebenfalls enthalten. Noch
nicht enthalten sind: die Oberfläche für Konflikt-Sperren (eine verdrängte
Version wird aufbewahrt, aber es gibt keinen Befehl, um sie anzusehen oder
wiederherzustellen), Beanspruchungen auf Funktionsebene (function-level
claims), Hooks für Claude-Code-Sitzungen und die Abstimmung zwischen
Claude-Instanzen (in dieser Vorschau weiß Claude nichts von der
Synchronisation; seine Änderungen werden wie jede andere gespeicherte Datei
synchronisiert), die vollständige Befehlszeile (save, doctor,
Start-Prüfungen wie die Prüfung auf ein privates Remote, Pause und Fortsetzen)
und Viewer 2 (sechs Sprachen, Aufzeichnung, Highlight-Zusammenschnitt).
Verwende die Vorschau nur mit einem Test-Repository.
[docs/STATUS.md](docs/STATUS.md) listet auf, was fertig ist und was als
Nächstes kommt.

## Voraussetzungen

- Claude Code 2.1.270 oder neuer.
- Node.js 20 oder neuer im `PATH` (20.6 oder neuer, um aus dem Quellcode zu
  bauen).
- git 2.43 oder neuer. Der Start verweigert ein älteres git.
- Windows, macOS oder Linux.
- Ein **privates** git-Remote, das eigene Refs (`refs/cowork/*`) annimmt und
  `--force-with-lease` durchsetzt. GitHub kann beides. Der Start prüft den Host
  und verweigert einen, der das nicht kann.
- Zugangsdaten von einem git-Credential-Helper. cowork-sync schaltet die
  Abfragen von git ab, sodass fehlende Zugangsdaten zu einer klaren Ablehnung
  statt zu einem Hänger führen.

## Installation

Jeder teilnehmende PC installiert das Plugin und hat seinen eigenen Klon des
Repositorys.

In einer Claude-Code-Sitzung:

```text
/plugin marketplace add Kingyoungmins/cowork-sync
/plugin install cowork-sync@cowork-sync
```

Oder in einer Shell:

```sh
claude plugin marketplace add Kingyoungmins/cowork-sync
claude plugin install cowork-sync@cowork-sync
```

Führe `/reload-plugins` aus (oder starte Claude Code neu), um es zu laden.
Updates erfolgen für diesen Marketplace nicht automatisch. Zum Aktualisieren
führst du `/plugin marketplace update cowork-sync` aus und danach
`claude plugin update cowork-sync@cowork-sync`. Zum Entfernen des Plugins
führst du `claude plugin uninstall cowork-sync@cowork-sync` aus.

## Benutzung

Öffne Claude Code in deinem Klon und gib die folgenden Befehle ein. Claude Code
nennt den Befehl des Plugins `/cowork-sync:cowork`; tippe diesen Namen
vollständig. Dieselben Verben laufen auch in einem Terminal, als
`node "<plugin folder>/dist/cli.js" <verb>`; `/cowork-sync:cowork view` gibt
diesen Pfad aus.

| Befehl | Was er tut |
| :- | :- |
| `/cowork-sync:cowork start [--branch <b>]` | Startet die Synchronisation für dieses Repository, auf dem aktuellen Branch. Der erste PC legt das gemeinsame Board auf dem Remote an; jeder weitere PC tritt ihm bei. Der Daemon läuft im Hintergrund weiter. |
| `/cowork-sync:cowork status` | Gibt eine kurze Zusammenfassung aus: den Zustand (`ok`, `degraded`, `offline`, `frozen`, `down` und so weiter), den Branch und was noch auf Veröffentlichung oder Anwendung wartet. |
| `/cowork-sync:cowork view` | Gibt den Befehl aus, der den schreibgeschützten Viewer öffnet. Der Viewer lässt sich nur von einem Terminal aus öffnen: Führe den Befehl dort aus, dann öffnet er sich in deinem Browser. Wenn dein Build den Viewer-Prozess noch nicht enthält, lehnt er mit `RF_VIZ_START_FAILED` ab (siehe [CHANGELOG.md](CHANGELOG.md)). |
| `/cowork-sync:cowork stop` | Beendet den Daemon sauber. Deine Dateien bleiben, wie sie sind. |
| `/cowork-sync:cowork help` | Listet die Befehle auf. |

Wenn ein Befehl ablehnt, gibt er den Grund mit einem Code aus, dazu eine Zeile
`next:` mit dem Befehl, den du ausführen sollst. Wenn der Daemon selbst den
Start verweigert, folgen seine eigenen Zeilen auf
`the daemon did not start; it said:`.

Was `start` prüft:

- Er läuft im Haupt-Klon. Ein verknüpftes Worktree oder ein Submodul wird
  abgelehnt.
- Der Branch ist ausgecheckt, existiert auf dem Remote und ist ihm weder voraus
  noch hinterher. Führe vorher Push oder Pull aus. Es darf kein Merge und kein
  Rebase im Gange sein.
- Die Fetch-URL des Remotes ist gleich seiner Push-URL, und es greift keine
  `insteadOf`-Umschreibung.
- Pro Klon läuft nur ein Daemon.
- Wenn du beim ersten Start nicht committete Änderungen hast, hält er an und
  bittet dich um eine Entscheidung: mit dem Team teilen oder auf diesem PC
  behalten.

Während die Synchronisation läuft:

- Speichere Dateien wie gewohnt. Deine gespeicherten Änderungen werden
  veröffentlicht, und die Änderungen der Teammitglieder werden in deine Dateien
  geschrieben.
- Führe in einem synchronisierten Klon keine git-Befehle aus, die `HEAD`
  bewegen (commit, switch, checkout, pull, merge, rebase, stash). Die
  Synchronisation friert ein, bis `HEAD` wieder dort steht, wo er war. Beende
  zuerst die Synchronisation.
- Es gibt noch keinen Schritt `save`, der die gemeinsame Arbeit in einen Commit
  auf dem Branch umwandelt. Der kommt mit der vollständigen Befehlszeile.
  Betrachte die Vorschau als Möglichkeit, die Live-Synchronisation auf einem
  Test-Branch auszuprobieren.

Jeder Klon legt seine eigenen Dateien unter `.git/cowork/` ab: `status.json`
(der aktuelle Zustand) und `log/daemon-0.jsonl` (das Daemon-Protokoll).

## Wie es funktioniert

1. Jeder Klon betreibt einen Daemon. Er liest deine gespeicherten Dateien über
   seinen eigenen privaten git-Index und berührt deinen nie.
2. Der gemeinsame Zustand liegt in zwei eigenen Refs auf deinem Remote:
   `refs/cowork/<branch>/board`, eine reine Fast-Forward-Kette von
   Board-Commits, die maßgeblich ist, und `refs/cowork/<branch>/code`, ein
   Spiegel des neuesten gemeinsamen Baums. Branch-Namen sind in diesen Refs
   prozentkodiert (percent-encoded).
3. Jeder Push ist ein Fast-Forward, der durch ein Lease (`--force-with-lease`)
   abgesichert ist, sodass kein PC die Aktualisierung eines anderen
   überschreiben kann. Wer verliert, holt neu und versucht es erneut. Ein
   teamweites Budget (12 Pushes pro Minute, 6 für eine halbe Stunde nach jeder
   Drosselung) hält die Last auf dem Host gering.
4. Eingehende Änderungen werden mit `git merge-tree` unter Angabe expliziter
   Merge-Basen zusammengeführt.
5. Eine Datei wird nur geschrieben, wenn sie noch die Bytes enthält, die der
   Daemon zuletzt gelesen hat, sodass eine Änderung, die du gerade gespeichert
   hast, nie überschrieben wird. Eine Gruppe von Dateien wird ganz oder gar
   nicht geschrieben.
6. Wenn zwei Personen dieselbe Zeile ändern, gewinnt eine Version, und die
   andere wird als Sperr-Eintrag (hold record) in deinem Klon aufbewahrt. Sie
   wird nie weggeworfen.
7. Einstellungen, Hooks und CI-Dateien (`.claude/`, `.github/workflows/`,
   `.gitattributes` und Ähnliches) werden nie live synchronisiert. Wenn die
   Historie des Boards jemals umgeschrieben wird, friert jeder PC ein, bis sie
   wiederhergestellt ist.
8. Die Vorschau pusht nie auf deinen Branch (`refs/heads/<branch>`). Ein
   einfaches `git fetch` lädt die eigenen Refs nicht herunter, sodass deine
   normale git-Historie sauber bleibt.

## Sicherheitshinweise

- cowork-sync schreibt in dein Arbeitsverzeichnis, und die Änderungen deiner
  Teammitglieder ebenso. Probiere es zuerst an einem Test-Repository aus und
  sichere alles, was dir wichtig ist.
- Verwende nur ein **privates** Remote. Alles, was du in einem
  synchronisierten Klon speicherst, wird nach `refs/cowork/*` gepusht, und
  jeder, der das Repository lesen kann, kann es abrufen. Die Vorschau prüft
  noch nicht, ob das Remote privat ist.
- Neue Dateien, deren Namen nach Geheimnissen aussehen (`.env`, `*.pem`,
  `*.key`, `id_rsa*`, `*credentials*` und weitere), werden nicht geteilt. Der
  Inhalt von Dateien wird noch nicht auf Geheimnisse durchsucht, also lege
  keine Geheimnisse in synchronisierten Dateien ab.
- Dateien über 1 MiB werden, wenn sie neu sind, nicht geteilt, und Dateien ab
  50 MiB werden nie live synchronisiert.
- Das Beenden der Synchronisation oder das Deinstallieren des Plugins lässt die
  eigenen Refs auf dem Remote zurück. Nachdem jeder PC gestoppt hat, kannst du
  sie von Hand löschen, zum Beispiel mit
  `git push origin --delete refs/cowork/main/board refs/cowork/main/code`.

## Lizenz

cowork-sync wird unter der Functional Source License 1.1 veröffentlicht, mit
der Apache License 2.0 als künftiger Lizenz (FSL-1.1-ALv2,
[LICENSE.md](LICENSE.md)). Kurz gesagt: Du darfst es für jeden Zweck nutzen,
kopieren, ändern und weitergeben, außer für eine konkurrierende Nutzung. Das
heißt, es oder etwas, das im Wesentlichen dasselbe tut, anderen als
kommerzielles Produkt oder kommerzielle Dienstleistung anzubieten. Interne
Nutzung, Bildung, Forschung und professionelle Dienstleistungen für einen
Lizenznehmer sind erlaubt. Jede Version wird zwei Jahre nach ihrer
Veröffentlichung unter der Apache License 2.0 verfügbar.

Für Beiträge ist die Contributor License Agreement in [CLA.md](CLA.md)
nötig. In [CONTRIBUTING.md](CONTRIBUTING.md) steht, wie du sie unterzeichnest
und wie du am Code arbeitest.

## Kontakt

Fragen: minzbusiness0204@gmail.com. Bitte melde Sicherheitsprobleme über die
private Meldefunktion für Sicherheitslücken des Repositorys (private
vulnerability reporting), nicht per E-Mail. Siehe [SECURITY.md](SECURITY.md).
