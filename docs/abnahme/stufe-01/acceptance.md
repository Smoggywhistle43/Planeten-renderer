# Abnahme Stufe 01 — BESTANDEN

Lauf: 2026-08-24T17:46:35.487Z → 2026-08-24T17:48:31.058Z
Viewport: 720x450 @ dpr 1

## Tiefenpuffer

- Backend: `webgpu`
- Reversed-Z: `true`
- Clear-Depth: `0`
- Depth-Compare: `greater-equal`

> Hinweis: Der Browser dieses Laufs lehnt das `swizzle`-Feld ab, das three r185 auf jedem Texture-View setzt. Der Harness entfernt es (Identitaets-Swizzle, semantisch folgenlos). Die Engine ist unveraendert. Siehe STATE.md, offene Punkte.

> User-Agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36`

## Kameraflug

| Höhe (m) | Radius ist/soll (px) | Abw. | Tiles | Tiefe | Fehler (px) | Builds/Frame | Einschwingen | Löcher | Speckle | Silhouette | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.00e+9 | 2.9 / 3.1 | 4.03% | 5 | 0 | 0.00 | 0/2 | 1 Frames | 0 | 6.667% | — (too few boundary columns) | 2.6 |
| 3.00e+8 | 9.6 / 10.0 | 3.94% | 5 | 0 | 0.00 | 0/2 | 1 Frames | 0 | 0.000% | — (too few boundary columns) | 1.1 |
| 1.00e+8 | 28.0 / 29.0 | 3.33% | 5 | 0 | 0.01 | 0/2 | 1 Frames | 0 | 0.000% | Kreis: max 0.24 px, RMS 0.103 px | 1.1 |
| 3.00e+7 | 84.6 / 85.8 | 1.49% | 5 | 0 | 0.02 | 0/2 | 1 Frames | 0 | 0.000% | Kreis: max 0.31 px, RMS 0.121 px | 0.9 |
| 1.00e+7 | 203.9 / 203.8 | 0.04% | 5 | 0 | 0.06 | 0/2 | 1 Frames | 0 | 0.000% | Kreis: max 0.32 px, RMS 0.125 px | 0.8 |
| 1.00e+6 | 321.1 / 829.3 (beschnitten) | — | 3 | 0 | 0.57 | 0/2 | 1 Frames | 0 | 0.000% | — (no sky in frame) | 0.9 |
| 1.00e+5 | 229.8 / 2712.7 (beschnitten) | — | 7 | 2 | 0.54 | 2/2 | 5 Frames | 8494 | 0.007% | Horizont: max 0.52 px, Median 0.000 px | 1.1 |
| 1.00e+4 | 253.6 / 8608.5 (beschnitten) | — | 11 | 3 | 1.39 | 2/2 | 4 Frames | 8299 | 0.002% | Horizont: max 0.52 px, Median 0.000 px | 1.7 |
| 3.00e+3 | 259.6 / 15721.2 (beschnitten) | — | 6 | 4 | 1.18 | 2/2 | 4 Frames | 8139 | 0.000% | Horizont: max 0.52 px, Median 0.000 px | 0.8 |
| 1.00e+3 | 262.7 / 27232.1 (beschnitten) | — | 7 | 5 | 0.87 | 2/2 | 3 Frames | 7932 | 0.002% | Horizont: max 0.52 px, Median 0.000 px | 0.9 |

Die Silhouetten-Spalte misst je nach Höhe zwei verschiedene Dinge, beide subpixelgenau aus der Deckung des Übergangspixels. Ist die Scheibe ganz im Bild, wird ein Kreis durch die Kontur gefittet und die größte radiale Abweichung ausgewiesen (`Kreis`) — das ist Kriterium 3, gemessen statt betrachtet. Füllt der Horizont das Bild, wird der Sprung zwischen benachbarten Bildspalten gemessen (`Horizont`); eine LOD-Naht taucht dort auf und darf das Fehlerbudget nicht reißen.

## Zittern der Silhouette

| Höhe (m) | Schritt | erwartete Bildbewegung/Schritt | unter float32-Auflösung | Schritte mit Bildänderung | Abweichung von der Geraden (px) | Builds |
|---|---|---|---|---|---|---|
| 1.00e+5 | 10.362 m x 32 | 0.050 px | nein | 31/31 | 0.0075 | 0 |
| 1.00e+4 | 1.036 m x 32 | 0.050 px | nein | 31/31 | 0.0016 | 0 |
| 1.00e+3 | 0.104 m x 32 | 0.050 px | ja | 31/31 | 0.0002 | 0 |

Der Schritt wird pro Höhe so gewählt, dass er einerseits unter der float32-Auflösung bei Erdradius (~0.5 m) liegt und andererseits überhaupt eine messbare Bildbewegung erzeugt. Beides gleichzeitig geht nur nahe der Oberfläche — dort trägt die Messung die Aussage, weiter oben prüft sie nur noch die Gleichmäßigkeit der Bewegung.

### Negativkontrolle

Derselbe Lauf, aber die Kameraposition wird vor dem Zeichnen durch float32 gerundet — also genau das, was passiert, wenn Weltkoordinaten irgendwo im Pfad float32 werden. Der Test muss hier fehlschlagen, sonst misst er nichts.

- float64 (gebaut): 31/31 Schritte ändern das Bild
- float32 (Kontrolle): 12/31 Schritte ändern das Bild

## Budget

- Spitze 2 von 2 erlaubt
- am Anschlag: 8 von 152 Frames (5.3 %)
- Bauten insgesamt über den Lauf: 20
- längste Einschwingzeit nach Anhalten der Kamera: 5 Frames (0.08 s bei 60 fps)

> Die Spitze sagt nur, dass die Decke einmal berührt wurde. Aussagekräftig sind der Anteil der Frames am Anschlag und die Einschwingzeit.

## Frametime

- Mittel: 1.2 ms, Maximum: 2.6 ms
- Measured on whatever adapter this machine offers. On a host without a GPU that is SwiftShader, which is correct but not fast. Criterion 6 names the M5 Air at dpr 2 and can only be answered there.

