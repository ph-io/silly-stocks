# silly-stocks

Logos werden als iPhone-Bildschirmbilder aufbereitet. Danach zeigt das iPhone sie nacheinander an, und die Kamera fotografiert jedes einzelne.

## Voraussetzungen

```sh
brew install gphoto2           # Kamera per USB
brew install exiftool          # für --embed und yarn tag
yarn install
```

Für `yarn tag` außerdem: eingeloggte `claude` CLI.
```

iPhone-App zur Anzeige: `ios/SillyStocksApp.xcodeproj` (Safari geht zum Testen auch).

## Befehle

| Befehl | Was passiert |
| --- | --- |
| `yarn logos` | SVGs aus `logos/src` zu Light/Dark-PNGs in `logos/output` |
| `yarn shoot` | Logos aus `logos/output/png` anzeigen und fotografieren |
| `yarn shoot:screenshots` | Bilder aus `screenshots` anzeigen und fotografieren |
| `yarn shoot:dry` | Nur Anzeige testen, ohne Kamera |
| `yarn shoot:web [urls.txt]` | Websites in Safari öffnen, Logo in die Bildschirmmitte schieben, fotografieren |
| `yarn tag <ordner>` | CR3s per Claude verschlagworten (Caption + Keywords) |

Ein anderer Bildordner geht als Argument: `yarn shoot logos/output/png/centered` oder  `yarn shoot "screenshots/mit Header"`.

## Ausgabe

Zu Beginn und am Ende des Durchlaufs spielt der Mac einen Ton.

Die Fotos landen in `ingest/` und sind fortlaufend nummeriert, zum Beispiel `0001.CR3` mit `0001.xmp`. Titel und Beschreibung im XMP sind der Logoname. `ingest/shots.csv` hält fest, welches Logo zu welcher Datei gehört.

## Optionen für `yarn shoot`

```
--out <dir>        Zielordner                                  [./ingest]
--start <n>        Mit Bild Nr. n beginnen (zum Fortsetzen)     [1]
--shots <n>        Aufnahmen pro Logo                          [1]
--settle <ms>      Wartezeit nach Anzeige vor dem Auslösen      [800]
--fit <cover|contain>  Darstellung auf dem iPhone              [cover]
--port <n>         Port des Webservers                         [8080]
--embed            XMP in die CR3 schreiben statt Sidecar
--dry-run          Ohne Kamera
--no-pause         Vor dem Start nicht auf Enter warten
```

Beispiel: `yarn shoot --start 42 --shots 2`

Optionen für `yarn logos`: `--width 1206 --height 2622 --logo 1072`

## Websites fotografieren mit `yarn shoot:web`

`yarn shoot:web urls.txt` liest eine URL pro Zeile. Leere Zeilen und Zeilen mit `#` werden ignoriert, ein Beispiel steht in `urls.example.txt`. Für jede URL:

1. Das Script schaltet auf hell: Das System geht in den Light Mode, und die Bildschirme werden weiß. Alle Apps außer Safari werden ausgeblendet, Dock und Menüleiste blenden sich automatisch aus. Den weißen Hintergrund liefert ein randloses Fenster über Schreibtischbild, Icons und Widgets. Das Schreibtischbild selbst bleibt unverändert.
2. Safari lädt die Seite in einem Fenster mit fester Größe (1440×900 pt).
3. Cookie-Banner werden automatisch weggeklickt, soweit das geht. Banner in fremden iframes, etwa von Sourcepoint, bleiben stehen.
4. Das Script sucht das Logo der Seite. Dann verschiebt es das Fenster so, dass der Mittelpunkt des Logos genau in der Bildschirmmitte liegt. Den Mittelpunkt bestimmt es pixelgenau aus einem Bildschirmausschnitt, transparente Ränder zählen nicht mit.
5. Das Script holt das Terminal nach vorn und wartet auf Enter. Vorher kannst du übrig gebliebene Banner von Hand wegklicken. Mit `s` + Enter überspringst du die Seite.
6. Das Script blendet das Terminal wieder aus, misst neu und löst die Kamera aus. Das ist das helle Foto.
7. Das Script schaltet auf dunkel: Das System geht in den Dark Mode, die Bildschirme werden schwarz. Seiten mit eigenem Dark Mode stellen dabei um. Das Logo wird neu gesucht und neu platziert, dann löst die Kamera ein zweites Mal aus.

Die URL landet im XMP als Titel, Beschreibung und `dc:source`. `yarn tag` ersetzt Titel und Beschreibung später, `dc:source` bleibt.

Die Fotos landen nummeriert in `ingest/`, das Protokoll mit der Spalte `modus` (hell/dunkel) in `ingest/web-shots.csv`. Seiten ohne erkennbares Logo werden übersprungen und mit Grund protokolliert.

Am Ende, bei einem Fehler und bei Ctrl-C setzt das Script alles zurück: Dark Mode, Dock, Menüleiste und die ausgeblendeten Apps. Nur ein hartes Beenden (`kill -9`) lässt den Hintergrund stehen. Dann hilft `pkill -f "osascript -l JavaScript"`.

Tipp: Fokus „Nicht stören“ einschalten. Mitteilungen liegen sonst über allem und landen im Foto.

Einmalig einrichten:

1. Safari: Einstellungen > Erweitert > „Funktionen für Webentwickler anzeigen“. Dann Entwickler > Entwickler-Einstellungen > **„JavaScript von Apple Events erlauben“**.
2. Beim ersten Lauf erlauben, dass VS Code bzw. das Terminal Safari und System Events steuert.
3. Systemeinstellungen > Datenschutz & Sicherheit > **Bildschirmaufnahme**: VS Code bzw. das Terminal erlauben. Ohne diese Berechtigung nimmt das Script die Mitte der Element-Box, und Ränder im Logo-Bild verschieben die Mitte.
4. Safari-Zoom auf 100 % (Cmd-0). Seitenleiste und Statusleiste aus, kein Vollbild.

```
--display <n>      Bildschirm für die Mitte (Liste beim Start)  [1 = Hauptbildschirm]
--light            Nur das helle Foto
--dark             Nur das dunkle Foto (ohne beide: hell und dunkel)
--window <WxH>     Fenstergröße in Punkten                      [1440x900]
--settle <ms>      Wartezeit nach dem Laden                     [1500]
--start <n>        Mit URL Nr. n beginnen (zum Fortsetzen)      [1]
--shots <n>        Aufnahmen pro URL und Modus (hell/dunkel)    [1]
--out <dir>        Zielordner                                   [./ingest]
--embed            XMP in die CR3 schreiben statt Sidecar
--dry-run          Ohne Kamera (Hell/Dunkel und Ausblenden laufen trotzdem)
--no-pause         Nicht auf Enter warten, voll automatisch
```

Beispiel: `yarn shoot:web urls.txt --display 2 --dry-run`

## Verschlagworten mit `yarn tag`

`yarn tag ingest` geht über alle CR3-Dateien im Ordner und seinen Unterordnern. Für jede Datei:

1. Die eingebettete Vorschau wird mit sharp zu einem Thumbnail.
2. `claude -p` erkennt darauf die App bzw. Firma. Vorhandene Titel, Beschreibungen und Keywords aus CR3 und XMP gehen als Hinweis mit.
3. Die deutsche Caption landet in Titel und Beschreibung, die Keywords ersetzen die alten. Geschrieben wird in die CR3 und, falls vorhanden, in die XMP-Sidecar-Datei.

Modell, Effort und Thumbnail-Größe stehen als Konstanten oben in `tagger.mjs` (`MODEL`, `EFFORT`, `THUMB_EDGE`).

Das Script überschreibt die Originale ohne Backup. Erst an einer Kopie testen.
