# Abnahme Stufe 01 — BESTANDEN

Lauf: 2026-08-25T08:02:37.624Z → 2026-08-25T08:03:05.560Z
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
| 1.00e+9 | 2.8 / 3.1 | 9.47% | 5 | 0 | 0.00 | 0/2 | 1 Frames | — | 14.286% | — (too few boundary columns) | 1.8 |
| 3.00e+8 | 10.0 / 10.0 | 0.01% | 5 | 0 | 0.00 | 0/2 | 1 Frames | — | 0.000% | — (too few boundary columns) | 1.0 |
| 1.00e+8 | 29.0 / 28.9 | 0.17% | 5 | 0 | 0.01 | 0/2 | 1 Frames | 0 | 0.000% | Ellipse 28.5x28.2 px, Abplattung 0.0103, max 0.33 px, RMS 0.131 px | 1.2 |
| 3.00e+7 | 85.9 / 85.8 | 0.19% | 5 | 0 | 0.02 | 0/2 | 1 Frames | 0 | 0.000% | Ellipse 85.5x85.3 px, Abplattung 0.0024, max 0.41 px, RMS 0.120 px | 1.4 |
| 1.00e+7 | 204.0 / 203.6 | 0.18% | 5 | 0 | 0.06 | 0/2 | 1 Frames | 0 | 0.000% | Ellipse 203.5x203.2 px, Abplattung 0.0012, max 0.27 px, RMS 0.104 px | 0.7 |
| 1.00e+6 | 321.1 / 825.3 (beschnitten) | — | 3 | 0 | 0.57 | 0/2 | 1 Frames | — | 0.000% | — (no sky in frame) | 0.9 |
| 1.00e+5 | 229.7 / 2604.9 (beschnitten) | — | 7 | 2 | 0.54 | 2/2 | 4 Frames | — | 0.000% | Horizont: max 0.45 px, Median 0.000 px | 1.0 |
| 1.00e+4 | 253.4 / 6357.6 (beschnitten) | — | 11 | 3 | 1.40 | 2/2 | 3 Frames | — | 0.000% | Horizont: max 0.46 px, Median 0.000 px | 1.4 |
| 3.00e+3 | 259.5 / 8091.1 (beschnitten) | — | 6 | 4 | 1.19 | 2/2 | 3 Frames | — | 0.000% | Horizont: max 0.46 px, Median 0.000 px | 0.9 |
| 1.00e+3 | 262.4 / 8918.4 (beschnitten) | — | 8 | 5 | 0.87 | 2/2 | 3 Frames | — | 0.000% | Horizont: max 0.46 px, Median 0.000 px | 0.9 |

Die Silhouetten-Spalte misst je nach Höhe zwei verschiedene Dinge, beide subpixelgenau aus der Deckung des Übergangspixels. Ist die Scheibe ganz im Bild, wird ein Kreis durch die Kontur gefittet und die größte radiale Abweichung ausgewiesen (`Kreis`) — das ist Kriterium 3, gemessen statt betrachtet. Füllt der Horizont das Bild, wird der Sprung zwischen benachbarten Bildspalten gemessen (`Horizont`); eine LOD-Naht taucht dort auf und darf das Fehlerbudget nicht reißen.

## Zittern der Silhouette

Wird nicht mehr hier gemessen. Ein 8-Bit-Canvas nach Tonemapping ist das falsche Messgerät für Bewegungen unterhalb eines Pixels — die Messung lag auf ihrer eigenen Rauschgrenze und konnte eine absichtlich kaputte Pipeline nicht mehr von der echten unterscheiden. Sie läuft jetzt in `packages/render/test/jitter.gpu.test.ts` gegen ein Float-Rendertarget, mit derselben float32-Negativkontrolle.

## Budget

- Spitze 2 von 2 erlaubt
- am Anschlag: 8 von 159 Frames (5.0 %)
- Bauten insgesamt über den Lauf: 21
- längste Einschwingzeit nach Anhalten der Kamera: 4 Frames (0.07 s bei 60 fps)

> Die Spitze sagt nur, dass die Decke einmal berührt wurde. Aussagekräftig sind der Anteil der Frames am Anschlag und die Einschwingzeit.

## Frametime

- Mittel: 1.1 ms, Maximum: 1.8 ms
- Measured on whatever adapter this machine offers. On a host without a GPU that is SwiftShader, which is correct but not fast. Criterion 6 names the M5 Air at dpr 2 and can only be answered there.

