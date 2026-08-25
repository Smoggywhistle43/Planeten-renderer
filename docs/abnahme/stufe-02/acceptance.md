# Abnahme Stufe 02 — BESTANDEN

Lauf: 2026-08-25T09:48:24.973Z → 2026-08-25T09:49:01.521Z
Viewport: 720x450 @ dpr 1

## Tiefenpuffer

- Backend: `webgpu`
- Reversed-Z: `true`
- Clear-Depth: `0`
- Depth-Compare: `greater-equal`

> Hinweis: Der Browser dieses Laufs lehnt das `swizzle`-Feld ab, das three r185 auf jedem Texture-View setzt. Der Harness entfernt es (Identitaets-Swizzle, semantisch folgenlos). Die Engine ist unveraendert. Siehe STATE.md, offene Punkte.

> User-Agent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36`

## Körper

- `earth-reference`
- Äquatorradius 6378137 m, Polradius 6356752 m, Mittel 6371008.8 m
- Abplattung 1/298.257 — 21385 m Unterschied
- Rotationsdauer 23.9345 h, Achsneigung 23.44°
- Reliefamplitude 0 m

## Kameraflug

| Höhe (m) | Radius ist/soll (px) | Abw. | Tiles | Tiefe | Fehler (px) | Builds/Frame | Einschwingen | Löcher | Speckle | Silhouette | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1.00e+9 | 2.9 / 3.1 | 5.77% | 6 | 0 | 0.00 | 0/2 | 1 Frames | — | 0.000% | — (too few boundary columns) | 1.5 |
| 3.00e+8 | 10.0 / 10.0 | 0.01% | 6 | 0 | 0.00 | 0/2 | 1 Frames | — | 0.000% | — (too few boundary columns) | 1.1 |
| 1.00e+8 | 29.0 / 28.9 | 0.20% | 6 | 0 | 0.01 | 0/2 | 1 Frames | 0 | 0.000% | Ellipse 28.5x28.2 px, Abplattung 0.0109, max 0.34 px, RMS 0.123 px | 0.9 |
| 3.00e+7 | 86.0 / 85.8 | 0.23% | 6 | 0 | 0.02 | 0/2 | 1 Frames | 0 | 0.000% | Ellipse 85.6x85.3 px, Abplattung 0.0032, max 0.35 px, RMS 0.121 px | 1.8 |
| 1.00e+7 | 204.2 / 203.7 | 0.21% | 4 | 0 | 0.06 | 0/2 | 1 Frames | 0 | 0.000% | Ellipse 203.6x203.4 px, Abplattung 0.0011, max 0.28 px, RMS 0.104 px | 1.0 |
| 1.00e+6 | 321.1 / 828.2 (beschnitten) | — | 3 | 0 | 0.57 | 0/2 | 1 Frames | — | 0.000% | — (no sky in frame) | 1.4 |
| 1.00e+5 | 229.5 / 2677.4 (beschnitten) | — | 5 | 2 | 1.15 | 2/2 | 3 Frames | — | 0.000% | Horizont: max 0.45 px, Median 0.000 px | 0.9 |
| 1.00e+4 | 253.2 / 7412.9 (beschnitten) | — | 4 | 3 | 1.79 | 2/2 | 3 Frames | — | 0.000% | Horizont: max 0.46 px, Median 0.000 px | 0.8 |
| 3.00e+3 | 259.4 / 10299.1 (beschnitten) | — | 5 | 4 | 1.11 | 2/2 | 1 Frames | — | 0.000% | Horizont: max 0.46 px, Median 0.000 px | 1.1 |
| 1.00e+3 | 262.4 / 11644.0 (beschnitten) | — | 12 | 5 | 0.82 | 2/2 | 5 Frames | — | 0.000% | Horizont: max 0.46 px, Median 0.000 px | 1.3 |

Die Silhouetten-Spalte misst je nach Höhe zwei verschiedene Dinge, beide subpixelgenau aus der Deckung des Übergangspixels. Ist die Scheibe ganz im Bild, wird ein Kreis durch die Kontur gefittet und die größte radiale Abweichung ausgewiesen (`Kreis`) — das ist Kriterium 3, gemessen statt betrachtet. Füllt der Horizont das Bild, wird der Sprung zwischen benachbarten Bildspalten gemessen (`Horizont`); eine LOD-Naht taucht dort auf und darf das Fehlerbudget nicht reißen.

## Zittern der Silhouette

Wird nicht mehr hier gemessen. Ein 8-Bit-Canvas nach Tonemapping ist das falsche Messgerät für Bewegungen unterhalb eines Pixels — die Messung lag auf ihrer eigenen Rauschgrenze und konnte eine absichtlich kaputte Pipeline nicht mehr von der echten unterscheiden. Sie läuft jetzt in `packages/render/test/jitter.gpu.test.ts` gegen ein Float-Rendertarget, mit derselben float32-Negativkontrolle.

## Budget

- Spitze 2 von 2 erlaubt
- am Anschlag: 8 von 176 Frames (4.5 %)
- Bauten insgesamt über den Lauf: 20
- längste Einschwingzeit nach Anhalten der Kamera: 5 Frames (0.08 s bei 60 fps)

> Die Spitze sagt nur, dass die Decke einmal berührt wurde. Aussagekräftig sind der Anteil der Frames am Anschlag und die Einschwingzeit.

## Frametime

- Mittel: 1.2 ms, Maximum: 1.8 ms
- Measured on whatever adapter this machine offers. On a host without a GPU that is SwiftShader, which is correct but not fast. Criterion 6 names the M5 Air at dpr 2 and can only be answered there.

