# silly-stocks

Logos werden als iPhone-Bildschirmbilder aufbereitet. Danach zeigt das iPhone sie nacheinander an, und die Kamera fotografiert jedes einzelne.

## Voraussetzungen

```sh
brew install gphoto2           # Kamera per USB
brew install exiftool          # für --embed und yarn tag
yarn install
```

iPhone-App zur Anzeige: `ios/SillyStocksApp.xcodeproj` (Safari geht zum Testen auch).

## Befehle

| Befehl | Was passiert |
| --- | --- |
| `yarn logos` | SVGs aus `logos/src` zu Light/Dark-PNGs in `logos/output` |
| `yarn shoot` | Logos aus `logos/output/png` anzeigen und fotografieren |
| `yarn shoot:screenshots` | Bilder aus `screenshots` anzeigen und fotografieren |
| `yarn shoot:dry` | Nur Anzeige testen, ohne Kamera |
| `yarn tag <ordner>` | CR3s per Claude verschlagworten (Caption + Keywords) |

Ein anderer Bildordner geht als Argument: `yarn shoot logos/output/png/centered` oder  `yarn shoot "screenshots/mit Header"`.

## Ausgabe

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

## Verschlagworten mit `yarn tag`

`yarn tag ingest` geht über alle CR3-Dateien im Ordner und seinen Unterordnern. Für jede Datei:

1. Die eingebettete Vorschau wird mit sharp zu einem Thumbnail.
2. `claude -p` erkennt darauf die App bzw. Firma. Vorhandene Titel, Beschreibungen und Keywords aus CR3 und XMP gehen als Hinweis mit.
3. Die deutsche Caption landet in Titel und Beschreibung, die Keywords ersetzen die alten. Geschrieben wird in die CR3 und, falls vorhanden, in die XMP-Sidecar-Datei.

Voraussetzung: eingeloggte `claude` CLI.
