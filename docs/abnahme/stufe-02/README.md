# Abnahme Stufe 02 — Der Körper

Erzeugt mit `pnpm acceptance` und `pnpm portrait` am 2026-08-25.
Der Bericht steht in [`acceptance.md`](acceptance.md), die Rohdaten in
`acceptance.json`.

## Belege des Abnahmelaufs

| Datei | Was es zeigt |
|---|---|
| `altitude-1e7.png` | Volle Scheibe aus 1e7 m. Die Aufnahme, an der Kriterium 3 gemessen wird |
| `altitude-3e7.png` | Dieselbe Scheibe aus 3e7 m |
| `hud-1e3.png` | Overlay aus 1e3 m Höhe: Knotenbauten gegen Budget, Frametime, Tiefenpuffer, Drehung |
| `lod-1e4.png` | LOD-Einfärbung — welche Tiefe wo gezeichnet wird |

Für die Messaufnahmen steht die Sonne hinter der Kamera. Das ist das
langweiligste Bild, das ein Planetenrenderer machen kann, und genau das
richtige zum Zählen von Pixeln: mit einem Terminator im Bild misst „wie viele
Pixel sind hell" nicht mehr „wie groß ist der Körper", und die Nachtseite
zählt als Loch zwischen Tiles.

## Ansichten

Kein Gatter — Bilder zum Anschauen, aus `pnpm portrait`.

| Datei | Was es zeigt |
|---|---|
| `01-voll-beleuchtet.png` | Sonne hinter der Kamera. Volle Scheibe, kein Terminator |
| `02-terminator.png` | Sonne 75 Grad seitlich. Der Übergang von Tag zu Nacht |
| `06-pol.png` | Sonne fast von oben. Die Achsneigung von 23.4 Grad steht im Bild |
| `drehung-00h.png`, `drehung-12h.png` | Derselbe Blick, zwölf Stunden auseinander |
| `belichtung-m4.png`, `belichtung-p4.png` | Vier Blenden heller und vier dunkler als gemessen |

**Zur Drehreihe:** das Relief ist 20-fach überhöht (240 km statt 20 km), sonst
wäre auf einem glatten grauen Körper von der Drehung nichts zu sehen — Kamera
fest, Sonne fest, keine Merkmale. Auch so zeigt sie sich nur an der Kontur.
Das überzeugende Bild kommt mit Teil 2.4. Bewiesen wird die Drehung bis dahin
von den Tests, nicht von den Bildern.

## Was hier nicht drin ist

Kriterium 6 (60 fps auf dem M5 Air bei dpr 2). Der Abnahmecontainer hat keine
GPU; Chromium fällt auf SwiftShader zurück. Die Frametime ist protokolliert,
aber nicht bewertet.
