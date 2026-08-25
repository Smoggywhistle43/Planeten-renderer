# STATE

Einzige Wahrheit über den Stand des Repos. Was hier nicht steht, gilt als nicht
abgenommen.

| | |
|---|---|
| Stufe | **02 — Der Körper**, Teil 1 bis 3 von 5 |
| Stand | Stufe 01 abgenommen bis auf Kriterium 6. Stufe 02: Licht, Belichtung und Form stehen |
| Datum | 2026-08-25 |
| Three.js | r185 (`three@0.185.1`), `three/webgpu` + `three/tsl` |
| TypeScript | 5.9.3, `strict: true` |
| Node | ≥ 22 |

---

## Was steht

### packages/core

Kein `three`, kein DOM, in Node lauffähig. Erzwungen durch `pnpm check:deps`
und durch ESLint, nicht durch Verabredung.

| Datei | Inhalt |
|---|---|
| `vec3d.ts` | `Vec3d` in float64, mutierende Methoden plus reine Varianten, `tangentBasis` |
| `frame.ts` | `Frame` — Weltkoordinate → kamerarelativ, Origin-Rebasing mit Schwellwert (Standard 4096 m), `float32PrecisionAt` |
| `hash.ts` | **die** Hashfunktion: PCG-XSH-RR 64/32 über `BigInt`. `hash`, `randFloat`, `randRange`, `randInt`, `randPick`, `Pcg32` |
| `seed.ts` | `deriveSeed` plus die Kette Universum → Sektor → System → Körper → Oberfläche, `resolveSeedPath` |
| `body.ts` | `Body` als reines, gefrorenes Parameterobjekt. Freie Funktionen für abgeleitete Größen. Keine Vererbung, keine Methoden |
| `photometry.ts` | Die Lichtphysik: Sonne als `Star`, Abstandsgesetz, Lambert, EV100, Kamera-Dreieck, gemessene Albedos |
| `shape.ts` | Die **Form**: Rotationsellipsoid, `surfaceRadius`, `geodeticNormal`, `curvatureRadius`, `altitudeAbove`, `hydrostaticFlattening` |
| `orientation.ts` | Die **Drehung**: `BodyPose` (körperfeste Achsen in Weltkoordinaten), Achsneigung, Spinwinkel aus absoluter Zeit, `surfaceVelocity` |

`Math.random()` ist in `core` verboten und wird an zwei Stellen geblockt.
`hash` wirft bei nicht-ganzzahligen Eingaben, statt sie stillschweigend zu
schneiden — sonst hinge die Welterzeugung an der Plattform.

### packages/field

Eine Höhenfunktion, einmal geschrieben, in TSL. Es gibt **keine** zweite
Implementierung des Rauschens in TypeScript.

- `height.ts` — `surfaceHeight` als TSL-`Fn` über `mx_fractal_noise_float`,
  Uniform-Bündel pro Körper, `surfaceNormalNode` (Gradient aus vier weiteren
  Abgriffen derselben Funktion).
- `sampler.ts` — `HeightSampler`: derselbe Node als Compute-Kernel mit
  Readback.

Abnehmer 1 ist das Material in `@planet/render`, Abnehmer 2 der Compute-Pfad.
Beide rufen dasselbe Node-Objekt.

### packages/render

| Datei | Inhalt |
|---|---|
| `cube-sphere.ts` | Quadtree je Würfelseite, Knotenschlüssel `(face, depth, x, y)` → ID `f0d3x5y2`, Mapping mit Tangens-Warp, Knotenschranken, `distanceToPatch`, geometrischer Fehler |
| `tile-mesh.ts` | Vertexerzeugung relativ zum Tile-Origin, Skirt. Kein `three`, in Node testbar |
| `tile-geometry.ts` | Typed Arrays → `BufferGeometry` |
| `lod-scheduler.ts` | Auswahl mit harter Obergrenze an Knotenbauten pro Frame (**Standard 2**), Prioritätswarteschlange nach Bildschirmfehler, asynchroner Bau, Verwerfen verspäteter Ergebnisse, Freigabe ungenutzter Teilbäume |
| `planet-camera.ts` | float64-Position, `three`-Kamera bleibt auf (0,0,0) |
| `planet-material.ts` | TSL-Material, ein Material für alle Tiles |
| `renderer.ts` | `WebGPURenderer` mit `reversedDepthBuffer` und `highPrecision`, plus Zusicherungen für beides |
| `post.ts` | `RenderPipeline` über den TSL-Node-Stack |
| `planet.ts` | setzt alles zusammen, platziert Tiles kamerarelativ |

### apps/explorer

Vanilla TS. Graue Kugel, Skriptflug 1e9 → 1e3 m, Overlay mit Frametime,
Knotenbauten pro Frame gegen das Budget, Tiefenpuffer-Konfiguration und den
float32-Auflösungen. `window.__planet` legt eine deterministische
Schrittsteuerung frei, an der der Abnahmelauf hängt.

---

## Stufe 02 — Der Körper

Die Stufe hieß ursprünglich „Licht und Luft". Umbenannt und neu geschnitten,
auf Entscheidung des Auftraggebers und mit einer Begründung, die trägt:

> Wir bauen erstmal nur das, was **alle** Himmelskörper haben und haben müssen.
> Nicht alle Planeten haben eine Atmosphäre, nicht alle haben Ringe.

Also erst das Fundament, das jeder Körper braucht — Licht, Form, Drehung,
Oberfläche, Bildruhe. Die Atmosphäre ist Ausrüstung und rückt nach hinten.

Fünf Teile, in Baureihenfolge. Drei stehen.

| | Inhalt | Stand |
|---|---|---|
| 2.1 | Licht in echten Einheiten | **fertig** |
| 2.2 | Belichtung und Tonemapping | **fertig**, Automatik fehlt noch |
| 2.3 | Form: Ellipsoid statt Kugel, Drehung, Achsneigung, körperfestes System | **fertig** |
| 2.4 | Oberfläche: Helligkeit und Ausrichtung auf jeder Stufe, Eigenverschattung | offen |
| 2.5 | Bildruhe (TAA) | offen |

Danach Stufe 03: echte Erddaten in diese Mechanik. Atmosphäre später.

### Licht in echten Einheiten

Nichts im Bild ist mehr eine ausgedachte 0..1-Helligkeit. Die Kette:

```
Beleuchtungsstärke E (lux)    Sonnenlicht, das auf die Fläche trifft
x cos(Einfallswinkel)          wie schräg die Fläche zur Sonne steht
x Albedo / pi                  Lambert-Reflexion
= Leuchtdichte L (cd/m²)       was Auge oder Sensor sieht
```

`packages/core/src/photometry.ts` hält die Physik, ohne `three`: Sonne als
`Star` mit 128 000 lx bei 1 AE, Abstandsgesetz, Lambert, EV100,
Kamera-Dreieck aus Blende/Zeit/ISO, Augenanpassung, gemessene Albedos.

Three rechnet exakt dieselbe Kette (`lightColor = color × intensity`, dann
`× cos`, dann `× albedo/π`). Also gilt: **Lichtintensität in Lux gesetzt und
Materialfarbe als echtes Albedo gesetzt heißt, im Framebuffer steht
Leuchtdichte in cd/m²** — ohne Korrekturfaktor.

Nachgewiesen statt behauptet, `packages/render/test/photometry.gpu.test.ts`:
Kugel rendern, hellsten Punkt auslesen, über fünf Albedos eine Gerade fitten.

| | |
|---|---|
| gemessene Steigung | 40 692 cd/m² pro Albedo |
| vorhergesagt (E/π) | 40 744 |
| Abweichung | **0.13 %** |
| Achsenabschnitt | ~390 cd/m², albedo-unabhängig — der Spekular-Anteil |

Ein verirrter Gammawert wäre um Faktor vier daneben, ein fehlendes 1/π um
Faktor drei. Die Kette stimmt.

`material.color` wird mit `setRGB` gesetzt, nicht mit `setHex`: letzteres
liest den Wert als sRGB und legt still eine Gammakurve drüber, was aus einem
gemessenen Albedo von 0.30 eine 0.07 machen würde.

### Belichtung

Die Tagseite eines Planeten und seine mondlose Nachtseite liegen sieben
Größenordnungen auseinander. Kein Bildschirm zeigt das, also muss etwas
auswählen — genau das, was eine Kamera oder ein Auge tut.

- Belichtung als `1 / (1.2 · 2^EV100)`, also Blende, Zeit und ISO.
- Tonemapping mit **AgX**: hält den Farbton beim Ausbrennen, statt alles
  Richtung Gelbweiß zu schieben wie Reinhard und ACES.
- Beides im TSL-Node-Graph, nicht in `renderer.toneMapping`. Damit kann die
  Belichtung später von einem Compute-Pass gesteuert werden, der das Bild
  misst, ganz ohne Rückgabe an die CPU. `assertLinearOutput` bricht ab, wenn
  jemand three's eigenes Tonemapping wieder einschaltet — es liefe danach und
  würde doppelt abbilden.

Der Explorer belichtet auf die sonnenbeschienene Oberfläche: EV 16.58 bei
Erdalbedo. `+`/`-` verschieben um eine Blende, `0` setzt zurück.

**Noch keine Automatik.** Die Belichtung ist die analytische Vorhersage, keine
Messung des Bildes. Der Histogramm-Compute-Pass ist der nächste kleine Schritt.

### Form: der Körper ist keine Kugel

Ein Körper, der sich dreht, wölbt sich am Äquator. Das ist keine Eigenschaft
mancher Planeten, sondern das, was Rotation und Masse mit allem machen, was
groß genug ist, rund zu sein. Deshalb steht es im Fundament neben Licht und
Masse — und deshalb wird die Abplattung *aus* Rotation und Masse gerechnet,
nicht als freier Parameter gewürfelt.

| Körper | Abplattung | in Zahlen |
|---|---|---|
| Erde | 1/298 | 21 km Unterschied, 0.34 % — drei Pixel auf einer 1000-Pixel-Scheibe |
| Jupiter | 1/15 | 6.5 % |
| Saturn | 1/10 | 9.8 %, nicht zu übersehen |

`Body` erbt jetzt von `Ellipsoid` und `Spinning`. **Das Feld `radius` wurde
ersatzlos entfernt**, damit der Compiler jede der 33 Stellen findet, an denen
bisher „ein Radius" angenommen wurde — statt sie stillschweigend weiterlaufen
zu lassen. Ersetzt haben es `equatorialRadius` + `flattening` und die freien
Funktionen `meanRadius`, `polarRadius`, `surfaceRadius(shape, richtung)`.

Drei Größen, die auf einer Kugel dasselbe sind und hier nicht:

| | |
|---|---|
| **geozentrisch** | die Richtung vom Mittelpunkt zum Punkt |
| **geodätisch** | die Richtung senkrecht auf der Oberfläche — das, was Beschattung braucht |
| **Krümmungsradius** | wie stark sich die Fläche biegt — das, was die LOD-Fehlerschätzung braucht |

Auf der Erde weichen die ersten beiden um bis zu 11.5 Bogenminuten voneinander
ab, bei 45 Grad Breite. Der Krümmungsradius geht *andersherum* als die
Intuition: am Pol ist der Körper flacher als sein kurzer Polradius nahelegt
(a²/b = 6399 km), am Äquator biegt er sich stärker als sein langer
Äquatorradius nahelegt (b²/a = 6335 km). Die Tile-Normalen sind jetzt die
geodätischen; `normals` ist deshalb kein Alias von `directions` mehr.

Die Abplattung eines Körpers ist eine **Messung**, keine Eingabe:
`hydrostaticFlattening` sagt für eine homogene Erde 1/232 voraus, gemessen ist
1/298. Der Unterschied ist kein schlechter Näherungswert, sondern Physik — die
Masse der Erde sitzt im Kern, also wölben sich ihre äußeren Schichten weniger
als bei gleichmäßiger Dichte. Erzeugte Körper bekommen die Vorhersage, Körper
mit gemessenem Wert behalten ihren.

### Drehung und Achsneigung

`BodyPose` sind drei orthonormale Achsen — die körperfesten Achsen in
Weltkoordinaten. Kein Quaternion, keine Matrixklasse: das ist das Kleinste,
was die Aufgabe erledigt, und hält `core` frei von einer Mathebibliothek.

Die Drehung wird **aus der absoluten Zeit neu aufgebaut, nie aufaddiert**.
Eine aufaddierte Rotation driftet aus der Orthonormalität heraus und, schlimmer,
macht die Welt von der Bildrate abhängig. Ein Test prüft, dass tausend kleine
Schritte auf 1e-12 genau dort landen wie ein großer Sprung.

Das Quadtree lebt jetzt im **körperfesten** System: ein Tile liegt über
demselben Stück Boden, egal wie weit der Planet gedreht ist. Es wird einmal
gebaut und gedreht, nicht bei jeder Drehung neu gebaut. Pro Frame wandert
stattdessen die Kamera einmal in dieses System — dieselbe Bewegung, aber
einmal statt pro Knoten. Die Objektmatrix eines Tiles ist deshalb nicht mehr
eine reine Translation, sondern die Drehung des Körpers plus die
kamerarelative Translation.

Im Explorer: `,` und `.` ändern den Zeitraffer, `;` setzt die Uhr zurück. Bei
1x dreht sich die Erde 15 Grad pro Stunde, also sichtbar gar nicht; bei 3600x
dauert ein Tag 24 Sekunden.

### Ansichten

`pnpm portrait` rendert einen Satz Bilder nach `artifacts/portrait/` —
Terminator, Sichel, Horizont, Blick von oben auf die geneigte Achse, eine
Belichtungsreihe über vier Blenden und eine Drehreihe über einen Tag. Kein
Gatter, nur zum Anschauen. Für einen Renderer, der echt aussehen soll, ist
Hinsehen das eigentliche Prüfverfahren.

**Zur Drehreihe, unumwunden:** ein glatter grauer Körper kann nicht zeigen,
dass er sich dreht. Kamera fest, Sonne fest, keine Merkmale — jede Stunde sieht
gleich aus. Die Reihe schaltet deshalb das Höhenfeld ein und **überhöht es
20-fach auf 240 km**; real sind es 20 km vom Marianengraben zum Everest, also
ein Fünftel Prozent des Radius und aus dieser Entfernung unsichtbar. Auch so
ist die Drehung nur an der Kontur zu erkennen, nicht auf der Fläche. Das
überzeugende Bild kommt mit Teil 2.4, wenn die Oberfläche Helligkeit hat. Was
die Drehung *beweist*, sind bis dahin die Tests, nicht die Bilder — unter
anderem: derselbe Boden wird zu jeder Tageszeit ausgewählt, und eine feststehende
Kamera sieht sechs Stunden später anderen Boden.

---

## Präzision

Die vier Regeln aus dem Handoff, und wo sie im Code stehen:

1. **Nie eine absolute Weltposition auf die GPU.** Die einzige Verengung
   float64 → float32 im Renderpfad ist `Frame.toCameraRelative32`
   beziehungsweise `PlanetCamera.cameraRelative`, und sie wirkt immer auf eine
   Differenz, die schon klein ist.
2. **Tile-Vertices relativ zum eigenen Tile-Origin.** `buildTileMeshData`
   rechnet `dir * surfaceRadius(körper, dir) - origin` in float64 und schreibt
   erst das Ergebnis nach float32. Der Radius ist seit Stufe 2.3 pro Vertex
   verschieden, die Rechnung bleibt dieselbe.
3. **Kamera auf (0,0,0).** `PlanetCamera.update` setzt die `three`-Kamera bei
   jedem Frame auf den Ursprung; die View-Matrix ist eine reine Rotation.
   Das Produkt aus View- und Objektmatrix entsteht auf der CPU in float64 und
   wird einmal verengt (`renderer.highPrecision`), nicht aus zwei einzeln
   verengten Matrizen im Shader — siehe Abweichung 2. Die Objektmatrix trägt
   seit Stufe 2.3 zusätzlich die Drehung des Körpers; ein GPU-Test prüft, dass
   sie starr bleibt (Spalten normiert, senkrecht, Determinante +1), denn eine
   eingeschlichene Skalierung würde den Planeten strecken.
4. **Rebasing** bei 4096 m Drift, `Frame.update`.

Reversed-Z läuft über `reversedDepthBuffer: true`. Three r185 setzt damit die
Projektion auf near→1 / far→0, den Clear-Wert auf 0, `LessEqualDepth` auf
`GreaterEqual` und das Tiefenformat auf `depth32float` — genau die drei
Punkte aus dem Handoff. `assertReversedDepth` bricht ab, wenn die Fahne nicht
greift, damit ein stiller Rückfall nicht Tage später als Renderfehler
auftaucht.

---

## Snapshots und Checksummen

| Name | Ort | Prüfsumme | Stufe |
|---|---|---|---|
| `parameters` | `packages/core/test/golden/parameters.json` | `0xeffcac24` | 02 (aktuell) |
| `stage-01` | `docs/abnahme/stufe-01/parameter-snapshot.json` | `0x233c912e` | 01, archiviert |

Die Prüfsumme hat sich in Stufe 2.3 geändert, und zwar mit Absicht: `Body`
trägt statt `radius` nun `equatorialRadius` und `flattening`, und die
Abplattung wird aus Masse und Rotationsdauer gerechnet. Damit sehen alle
erzeugten Körper anders aus als in Stufe 01. Der alte Snapshot liegt
unverändert im Abnahmeordner der Stufe 01, damit nachvollziehbar bleibt, was
sich geändert hat.

Der Snapshot deckt ab: rohe Hash-Vektoren, drei vollständige Seed-Ketten,
sieben aus Seeds erzeugte Körper mit ihren abgeleiteten Größen, je einen
Körper pro Klasse und den Referenzkörper.

Zwei unabhängige Wächter:

- `toMatchFileSnapshot` gegen die eingecheckte Datei. Neu erzeugen mit
  `pnpm test -u`, was einen sichtbaren Diff produziert.
- Die Prüfsumme steht **von Hand** in `packages/core/test/golden.test.ts`.
  Neuerzeugen des Snapshots ändert sie nicht; jemand muss die neue Zahl
  eintippen.

**Jede Änderung an `hash.ts`, an der Erzeugung in `body.ts`, an den Salzen in
`seed.ts` oder an der Rauschfunktion bricht diese Tests. Das ist der Zweck.
Solche Änderungen gehören mit neuer Prüfsumme hierher, nie stillschweigend.**

---

## Abnahme

Belege erzeugt `pnpm acceptance`; sie landen unter `artifacts/`
(`acceptance.json`, `acceptance.md`, Screenshots je Höhe mit und ohne Overlay
sowie mit LOD-Einfärbung). Der Lauf steppt den Flug frameweise, hängt also
nicht an der Wanduhr und ist wiederholbar.

Die abgenommenen Läufe liegen eingecheckt unter
[`docs/abnahme/stufe-01/`](docs/abnahme/stufe-01/) und
[`docs/abnahme/stufe-02/`](docs/abnahme/stufe-02/) — Bericht, Rohdaten, der
archivierte Parameter-Snapshot der Stufe 01 und ausgewählte Bilder.
`artifacts/` selbst ist Arbeitsverzeichnis und nicht versioniert.

| # | Kriterium | Stand |
|---|---|---|
| 1 | `pnpm test` grün, Golden Tests bestehen | **erfüllt** — 301 Tests: 267 in Node, 34 gegen ein echtes WebGPU-Gerät |
| 2 | `pnpm check:deps` bestätigt: `core` ohne `three` | **erfüllt** |
| 3 | Körper mit mittlerem Radius 6.371e6 m | **erfüllt, neu gemessen** — siehe unten. Das Kriterium hieß in Stufe 01 „graue Kugel"; seit Stufe 2.3 ist der Körper ein Ellipsoid mit demselben mittleren Radius |
| 4 | Flug 1e9 → 1e3 m ohne Zittern, ohne Z-Fighting | **erfüllt** — siehe unten |
| 5 | Overlay zeigt Knotenbauten pro Frame, Wert ≤ Budget | **erfüllt** — Spitze 2 bei Budget 2, davon 5 % der Frames am Anschlag; Einschwingzeit ≤ 4 Frames im Abnahmelauf, ≤ 12 aus kaltem Baum |
| 6 | Overlay zeigt Frametime, 60 fps auf dem M5 Air bei dpr 2 | **offen** — hier nicht entscheidbar, siehe offene Punkte |

### Zwei Messfehler im Abnahmelauf, gefunden und behoben

Der Abnahmelauf ist beim ersten Start dieser Stufe **durchgefallen** — zu Recht,
und aus zwei Gründen, die beide älter waren als die Form:

1. **Er hat Licht gezählt, nicht Körper.** Der Scheibenradius kommt aus der Zahl
   der Pixel über der Himmelsschwelle. Seit Stufe 2.1 ist die Nachtseite
   wirklich dunkel (Sternenlicht, 0.002 lx) statt von einem Fülllicht
   aufgehellt — also zählte die Messung nur noch die *Tagseite*. Ergebnis: der
   Radius fiel um 2 bis 11 % zu klein aus, und die unbeleuchtete Hälfte wurde
   als 8500 „Löcher zwischen Tiles" ausgewiesen. Der Harness stellt die Sonne
   für die Messaufnahmen jetzt hinter die Kamera (`setSunBehindCamera`). Die
   sehenswerten Lichtstimmungen leben in `pnpm portrait`, wo nichts gezählt
   wird. Danach: Radiusabweichung 0.01 bis 0.19 %.

2. **Eine Zusicherung war stumm gestorben.** Der Lauf prüfte
   `Math.abs(body.radius - 6.371e6) > 1`. Seit `radius` entfernt ist, ist das
   `NaN > 1`, also `false` — die Prüfung war noch da und hat nichts mehr
   geprüft. Ersetzt durch mittleren Radius **und** Abplattung.

Beides zeigt dieselbe Sache: eine Kennzahl, die einmal gestimmt hat, stimmt
nicht weiter, nur weil niemand hinsieht.

### Gemessene Werte des letzten Laufs

720 x 450 px, dpr 1, zehn Höhen von 1e9 bis 1e3 m, Sonne für die Messaufnahmen
hinter der Kamera.

| Höhe | Tiefe | Tiles | Fehler | Builds/Frame | Radius ist/soll | Silhouette |
|---|---|---|---|---|---|---|
| 1e9 m | 0 | 5 | 0.00 px | 0/2 | 2.8 / 3.1 px | Scheibe zu klein |
| 3e8 m | 0 | 5 | 0.00 px | 0/2 | 10.0 / 10.0 px (0.01 %) | zu wenige Randspalten |
| 1e8 m | 0 | 5 | 0.01 px | 0/2 | 29.0 / 28.9 px (0.17 %) | Ellipse 28.5x28.2 px, max 0.33 px |
| 3e7 m | 0 | 5 | 0.02 px | 0/2 | 85.9 / 85.8 px (0.19 %) | Ellipse 85.5x85.3 px, max 0.41 px |
| 1e7 m | 0 | 5 | 0.06 px | 0/2 | 204.0 / 203.6 px (0.18 %) | Ellipse 203.5x203.2 px, max 0.27 px |
| 1e6 m | 0 | 3 | 0.57 px | 0/2 | beschnitten | Horizont füllt das Bild |
| 1e5 m | 2 | 7 | 0.54 px | 2/2 | beschnitten | Horizont: max 0.45 px, Median 0 |
| 1e4 m | 3 | 11 | 1.40 px | 2/2 | beschnitten | Horizont: max 0.46 px, Median 0 |
| 3e3 m | 4 | 6 | 1.19 px | 2/2 | beschnitten | Horizont: max 0.46 px, Median 0 |
| 1e3 m | 5 | 8 | 0.87 px | 2/2 | beschnitten | Horizont: max 0.46 px, Median 0 |

Risse: null Hintergrundpixel im Inneren der Scheibe, überall wo die Messung
etwas taugt. Flimmern: unter 0.01 % der Innenpixel.

### Kriterium 3 als Form, nicht nur als Größe

Der Kreisfit von Stufe 01 ist ein **Ellipsenfit** geworden. Ein Kreis würde die
Abplattung selbst als Fehler ausweisen — auf der Erde 0.34 % des Radius, mehr
als die Toleranz, die der Test halten soll. Gemessen wird jetzt die allgemeine
Kegelschnittform durch die Kontur, fünf Unbekannte, kleinste Quadrate.

Zwei Dinge waren dafür nötig und beide sind lehrreich:

- **Die Kontur muss ganz sein.** Der alte Fit nahm pro Bildspalte nur den
  *oberen* Übergang. Für einen Kreis (drei Unbekannte) reicht ein Bogen; für
  eine Ellipse (fünf) nicht — auf einer 29-Pixel-Scheibe las der Fit die
  Abplattung als 0.051 statt 0.0034, weil er den Kegelschnitt frei kippen
  konnte. Mit oberem *und* unterem Rand ist er stabil.
- **Die lange Achse ist die belastbare Zahl.** Wie ein abgeplatteter Körper
  auch steht: die größte Ausdehnung seiner Kontur ist immer der Äquatordurch-
  messer. Dagegen wird geprüft.

| Scheibe | lange Achse ist/soll | abgelesene Abplattung |
|---|---|---|
| 29 px | 28.5 / 28.9 px | 0.0103 |
| 86 px | 85.5 / 85.8 px | 0.0024 |
| 204 px | 203.5 / 203.6 px | 0.0012 |

Die lange Achse stimmt auf 0.2 %. Die abgelesene Abplattung streut um den
wahren Wert 0.00335, und das ist ehrlich der Rand des Messbaren: 0.34 % von
203 px sind 0.7 Pixel Unterschied zwischen den Achsen, und der Subpixel-Rand
wird an den Flanken schlechter geschätzt als oben und unten. Der Test prüft
deshalb nur, dass die abgelesene Abplattung zwischen null und der wahren liegt
— mehr gibt das Bild bei diesen Scheibengrößen nicht her. Ein Körper wie Saturn
wäre eine ganz andere Ansage.

### Budget-Auslastung und Einschwingzeit

„Spitze 2 bei Budget 2“ heißt **nicht**, dass der Scheduler durchgehend am
Anschlag stand — eine Spitze sagt nur, dass die Decke einmal berührt wurde.
Dass mein erster Bericht nur die Spitze auswies, war ein Berichtsfehler; das
Overlay und der Abnahmebericht zeigen jetzt zusätzlich den Anteil der Frames
am Anschlag, die Gesamtzahl der Bauten und die Einschwingzeit.

Gemessen (`packages/render/test/lod-settle.test.ts`, screenHeight 1080):

| Flugdauer | Frames am Anschlag | max. Tiefenrückstand | Bauten gesamt | ruhig nach Stopp |
|---|---|---|---|---|
| 90 s | 11 von 5401 (0.2 %) | 0 | 26 | 0 Frames |
| 20 s | 11 von 1201 (1 %) | 0 | 26 | 0 Frames |
| 10 s | 11 von 601 (2 %) | 0 | 26 | 0 Frames |
| 5 s | 12 von 301 (4 %) | 1 Stufe | 26 | 0 Frames |
| 2 s | 12 von 121 (10 %) | 1 Stufe | 25 | 1 Frame |

Einschwingzeit aus einem kalten Baum, also der pessimistische Fall — die
Kamera steht still und nur die sechs Wurzeln existieren:

| Höhe | screenHeight 450 | 1080 | 2160 (dpr 2) | Zieltiefe bei 2160 |
|---|---|---|---|---|
| 1e6 m | 1 Frame | 1 | 4 | 1 |
| 1e5 m | 6 | 7 | 8 | 3 |
| 1e4 m | 6 | 8 | 8 | 4 |
| 1e3 m | 9 | 12 | 12 | 6 |

Der schlechteste Fall sind 12 Frames, also 0.20 s bei 60 fps. Das ist die
Zahl, die später Pop-in vorhersagt, und sie steht als Schranke im Test.

Im echten Abnahmelauf, gemessen ab dem Frame, in dem die Kamera auf der Höhe
ankommt (der Baum ist von der vorigen Höhe teilweise warm), sind es 1 bis 5
Frames; am Anschlag standen 8 von 152 Frames, insgesamt 20 Bauten.

**Vorbehalt:** all das gilt für die flache Referenzkugel. Ihre Zieltiefe ist
gering (6 bei 1e3 m und dpr 2) und der eingeschwungene Baum klein (16 Tiles,
26 Bauten über den ganzen Flug). Mit echtem Terrain wachsen Zieltiefe und
Tile-Zahl deutlich, und beide Tabellen sind neu zu messen — nicht die
Schranken zu lockern.

Die Silhouette wird je nach Höhe unterschiedlich gemessen, weil sie
unterschiedliche Dinge ist. Ist die Scheibe ganz im Bild, wird ein Kreis durch
die Kontur gefittet und die größte radiale Abweichung ausgewiesen — das ist
Kriterium 3 als Zahl. Füllt der Horizont das Bild, wird der Sprung zwischen
benachbarten Bildspalten gemessen, denn dort und nur dort zeigt sich eine
LOD-Naht.

### Zu Kriterium 4

Zittern wird nicht per Augenschein beurteilt. Die Kamera wird in Schritten
seitwärts geschoben, und gemessen wird, ob sich das Bild bei **jedem** Schritt
ändert.

**Diese Messung ist in Stufe 02 umgezogen**, von `scripts/acceptance.mjs` nach
`packages/render/test/jitter.gpu.test.ts`. Grund: sie las den Canvas zurück,
also durch Tonemapping und einen 8-Bit-Quantisierer hindurch. Mit Belichtung
und AgX änderte ein Fünf-Zentimeter-Schritt noch drei von 432 000 Pixeln — die
Messung lag auf der Rauschgrenze ihres eigenen Messgeräts und konnte eine
absichtlich kaputte Pipeline nicht mehr von der echten unterscheiden. Der Test
rendert jetzt in ein Float-Rendertarget, wo ein Unterschied von 1e-6 anschlägt.
Die float32-Negativkontrolle ist mitgezogen. Was im Abnahmelauf bleibt, ist
das, was ein Bild wirklich beantworten kann: Silhouette, Risse, Flimmern.
Die Schrittweite wird pro Höhe so gewählt, dass sie unter der
float32-Auflösung bei Erdradius (~0.5 m) bleibt und trotzdem eine messbare
Bildbewegung erzeugt; nahe der Oberfläche geht beides zugleich, und dort trägt
die Messung die Aussage.

Dazu läuft eine **Negativkontrolle**: dieselbe Messung, aber die
Kameraposition wird vor dem Zeichnen durch float32 gerundet — genau das, was
passiert, wenn Weltkoordinaten irgendwo im Pfad float32 werden. Die Kontrolle
muss fehlschlagen, sonst hat der Test keine Aussagekraft. Gemessen bei 1e3 m:
30 von 31 Schritten ändern das Bild im gebauten Zustand, 6 von 31 in der
Kontrolle.

Z-Fighting und LOD-Risse werden über das Bild geprüft: Anteil
Hintergrundpixel im Inneren der Scheibe (Risse) und Anteil Pixel, die stark
von ihrer Nachbarschaft abweichen (Flimmern). Beide Prüfungen laufen nur,
wenn die Scheibe vollständig im Bild und groß genug ist — bei einer
zweipixeligen Scheibe messen sie nichts.

---

## Abweichungen vom Handoff-Dokument

Der Reihe nach, mit Begründung.

1. **`sampleHeight(dir, body) -> number` ist asynchron geworden.**
   Das Dokument verlangt zugleich eine synchrone Signatur und den Weg über den
   Compute-Pfad; WebGPU-Readback ist zwingend asynchron. Nach Rückfrage
   entschieden: `sampleHeights(dirs) -> Promise<Float64Array>` ist der echte
   Aufruf, `sampleHeightCached(x, y, z) -> number` ist die synchrone Form aus
   dem Dokument und wirft für Punkte, die nie gesampelt wurden. Eine
   TS-Zweitimplementierung wäre die Alternative gewesen und ist genau das, was
   das Dokument ausschließt.

2. **Das Tile-Origin geht nicht als eigenes Uniform, sondern als
   Objekt-Matrix.**
   Das Dokument sagt „Das Tile-Origin geht als kamerarelatives Uniform rein“.
   Umgesetzt ist es als reine Translation in `mesh.matrixWorld`, die jeden
   Frame aus `tileOriginWorld - cameraWorld` in float64 gesetzt und einmal
   nach float32 verengt wird. Der Buchstabe weicht ab, die Sache nicht: der
   Wert ist kamerarelativ und pro Tile. Der Gewinn ist, dass **ein** Material
   alle Tiles bedient statt eines pro Tile.

   **Dazu gehört zwingend `renderer.highPrecision = true`**, sonst rettet die
   Konstruktion die Präzision nicht: three bildet `modelViewMatrix`
   standardmäßig als `cameraViewMatrix.mul(modelWorldMatrix)`, also aus zwei
   *einzeln* nach float32 verengten Matrizen, multipliziert im Shader. Mit der
   Fahne rechnet three das Produkt in JS — `Matrix4.elements` ist ein
   gewöhnliches Array, also float64 — und verengt einmal am Ende.

   Gemessen (`packages/render/test/model-view-precision.test.ts`): solange
   beide Operanden klein sind, sind die zwei Wege ununterscheidbar — bei einem
   Tile in 1 km Entfernung landen beide innerhalb von ~3e-5 m am exakten
   Ergebnis, und mal ist der eine, mal der andere vorn. Der Unterschied
   entsteht erst, wenn ein Operand groß wird: mit dem Tile an einer absoluten
   Weltposition ist der Shader-Weg bei jeder Kameralage schlechter, um Faktor
   zwei bis acht. Die Fahne kauft hier also keine Pixel, sondern
   Unabhängigkeit von einer Invariante, die eine spätere Änderung stumm
   brechen könnte. `assertHighPrecisionModelView` bricht ab, wenn sie fehlt.

   Ende zu Ende belegt: `render.gpu.test.ts` rendert denselben Blick auf
   denselben Körper einmal im Weltursprung und einmal bei 4.1e11 m und
   vergleicht die Pixel. Bei 4e11 m beträgt der float32-Abstand rund 32 km —
   ein durchgesickerter absoluter Weltwert wäre nicht „etwas anders“, sondern
   unkenntlich.

3. **`PostProcessing` heißt `RenderPipeline`.**
   Three hat die Klasse in r183 umbenannt; `PostProcessing` existiert nur noch
   als veralteter Wrapper. Der Node-Stack ist derselbe.

4. **Reversed-Z kommt von three, nicht von Hand.**
   `reversedDepthBuffer: true` setzt Tiefenbereich, Vergleich und Clear-Wert
   genau so, wie das Dokument sie fordert. Eine eigene Implementierung wäre
   dieselbe Sache mit mehr Angriffsfläche gewesen.

5. **Tangens-Warp auf dem Würfel-Mapping.** Nicht im Dokument. Ohne ihn decken
   Eckzellen einer Würfelseite etwa das Vierfache des Raumwinkels der
   Mittelzellen ab, und die LOD-Fehlerschätzung liegt um denselben Faktor
   daneben.

6. **Skirts an den Tile-Rändern.** Nicht im Dokument. Ohne sie reißt jede
   LOD-Grenze sichtbar auf, was Kriterium 4 nicht überstanden hätte.

7. **Der geometrische Fehler enthält einen Terrain-Anteil.**
   `unresolvedRelief` rechnet aus, welche fBm-Oktaven ein Tile bei seiner
   Auflösung nicht mehr abbilden kann. Für Stufe 01 ist der Wert null, weil
   der Referenzkörper keine Amplitude hat; für die nächste Stufe ist die
   Schätzung damit schon richtig statt geraten.

8. **Der Referenzkörper hat `terrain.amplitude = 0`.** Kriterium 3 verlangt
   eine Kugel mit Radius 6.371e6 m, und das ist dann exakt eine. Das
   Höhenfeld läuft trotzdem in jedem Vertex-Shader mit und lässt sich im
   Explorer mit `H` zuschalten, damit der Pfad nicht bloß behauptet wird.

9. **Tests laufen in zwei Vitest-Projekten.** `node` für alles Kopflose,
   `gpu` im Vitest-Browser-Modus gegen ein echtes WebGPU-Gerät — der
   Determinismus-Test aus dem Dokument braucht eines. Nach Rückfrage
   entschieden, dass `pnpm test` beides ausführt. Das zieht Playwright als
   Entwicklungsabhängigkeit nach.

10. **Die Bauten laufen asynchron, aber auf dem Hauptthread.** `build()` gibt
    vor der Arbeit die Kontrolle über einen `MessageChannel` an die
    Ereignisschleife zurück, sodass das Frame-Budget wirklich greift. Ein
    Worker ist der nächste Schritt und offen (siehe unten); `tile-mesh.ts` ist
    dafür schon frei von `three` und liefert übertragbare Typed Arrays.

11. **`randRange(min, max, seed, ...ints)`.** Das Dokument nennt nur den
    Namen. Die Reihenfolge stellt die Grenzen nach vorn, damit die variadische
    Liste hinten bleiben kann.

12. **Versionen bewusst nicht die neuesten.** TypeScript 5.9 statt 7.0,
    ESLint 9 statt 10, Vite 7 statt 8, Vitest 3 statt 4 — jeweils die Reihe
    mit tragfähigem Ökosystem. `three` ist r185, also über der geforderten
    r184.

---

## Offene Punkte

1. **Kriterium 6 ist hier nicht entscheidbar.** Dieser Container hat keine GPU;
   Chromium fällt auf SwiftShader zurück. Die Frametime im Abnahmebericht ist
   deshalb protokolliert, aber nicht bewertet. Auf dem M5 Air mit dpr 2 muss
   sie einmal gemessen werden — `pnpm dev`, Overlay ablesen, oder
   `pnpm acceptance` dort laufen lassen.

2. **Der Chromium dieses Containers ist zu alt für three r185.**
   Three setzt auf jedem Texture-View `swizzle: 'rgba'`; Chromium 141
   implementiert einen älteren Entwurf, in dem das Feld ein Objekt sein
   musste, und lehnt den String ab. Der Abnahme-Harness entfernt das Feld im
   Browser (Identitäts-Swizzle, semantisch folgenlos) und protokolliert, dass
   er es getan hat. **Die Engine ist nicht angefasst.** Auf aktuellem Chrome
   oder Safari entfällt der Eingriff; der Bericht zeigt dann
   `swizzleShimApplied: false`. Ein passender Chromium ließ sich hier nicht
   nachinstallieren, weil `cdn.playwright.dev` von der Egress-Policy blockiert
   ist.

3. **Tile-Bau gehört in einen Worker.** Bei Budget 2 und ~1200 Vertices pro
   Tile ist das heute unkritisch, wird es aber, sobald das Höhenfeld auf der
   CPU gebraucht wird oder das Budget steigt.

4. **Der Fehler-Schwellwert von 2 px ist gesetzt, nicht gemessen.** Mit
   `gridResolution: 32` ergibt das bei 1e3 m Höhe Tiefe 5–8, je nach
   Viewport. Für die graue Kugel sichtbar korrekt; sobald Terrain dazukommt,
   sollte der Wert an echtem Material nachjustiert werden.

5. **Kein Frustum-Culling mit echten Ebenen.** Die Sichtprüfung ist ein
   Kegeltest gegen die Bildschirmdiagonale, also leicht konservativ. Genügt
   für diese Stufe.

6. **`sampleHeightCached` hat keine Verdrängung.** Der Cache wächst, bis der
   Körper wechselt. Für Stufe 01 mit ein paar tausend Testpunkten egal.

7. **Die Silhouette ist keine Kreislinie mehr.** Der Abnahmelauf fittet einen
   Kreis durch die Kontur; auf einem um 1/298 abgeplatteten Körper ist die
   Kontur eine Ellipse, also enthält die ausgewiesene Abweichung jetzt einen
   systematischen Anteil von bis zu 0.34 % des Radius. Kriterium 3 aus Stufe 01
   („graue Kugel, Radius 6.371e6 m") ist damit bewusst überholt: der mittlere
   Radius liegt weiter bei 6 371 008.8 m, der Körper ist aber keine Kugel mehr.
   Der Fit gehört auf eine Ellipse umgestellt.

8. **Der Explorer bündelt 870 kB.** Fast alles davon ist `three/webgpu`. Kein
   Code-Splitting, weil es nichts zu splitten gibt.

---

## Fallstricke, die schon zugeschlagen haben

Notiert, weil sie beide stumm waren — nichts stürzte ab, das Bild war nur
falsch.

- **Der Abstand Kamera → Tile darf weder über die Hüllkugel noch über
  Stützpunkte laufen.** Die Hüllkugel eines Tiles in Tiefe 0 hat 5000 km
  Radius, verschluckt also die Kamera, und der Abstand fällt auf null: der
  Fehler wird unendlich und alles teilt sich bis zur Maximaltiefe. Neun
  Stützpunkte auf dem Patch sind bis zu 2000 km auseinander: eine Kamera 10 km
  über der Oberfläche zwischen zwei Stützpunkten meldet 1700 km Abstand, der
  Fehler wird hundertfach zu klein, und der Planet bleibt ein Würfel.
  `distanceToPatch` projiziert stattdessen auf die eigene Würfelseite und
  klemmt ins Parameterrechteck. Regressionstests in
  `packages/render/test/cube-sphere.test.ts`.

- **Knotenschranken sind körperzentriert, die Kamera ist es nicht.** Der
  Scheduler rechnet die Kamera einmal pro Frame in den körperzentrierten Raum
  und vergleicht dort. Solange der Körper im Weltursprung liegt, fällt eine
  Verwechslung nicht auf — deshalb prüft ein Test die Auswahl mit einem
  Körper bei 4e11 m.

- **Ein optionaler Parameter, der die Antwort um Kilometer verschiebt.**
  `placeAtAltitude` und `altitudeAbove` bekamen die `BodyPose` erst als
  optionales Argument. Wer sie vergisst, behandelt eine Weltrichtung als
  körperfeste — und bei 23.4 Grad Achsneigung liegt der Boden dann bis zu
  6.5 km woanders. Genau das ist im GPU-Jitter-Test passiert: eine Kamera, die
  auf 1000 m stehen sollte, stand auf 5800 m, der Baum schwang zwei Stufen
  flacher ein, und das Bild reagierte fünfmal schwächer auf Kamerabewegung.
  Nichts warf, nichts loggte. Der Parameter ist jetzt **Pflicht**; ein Körper
  ohne Neigung übergibt ein frisches `new BodyPose()`. Regressionstests in
  `packages/render/test/planet-camera.test.ts`.

- **Alle sechs Würfelseiten teilen sich in Tiefe 0 dieselben acht Ecken.** Ein
  Mittelwert über die Ecken eines Wurzelknotens ist deshalb für alle sechs
  Seiten identisch — die Polseite und die Äquatorseite kämen auf denselben
  Radius. Auf der Erde sind das 21 km Fehler, auf Saturn 6000 km.
  `nodeSurfaceRadius` mittelt deshalb über Ecken **und** Mitte.

- **Der Horizont eines abgeplatteten Körpers ist kein Kreis.** Ein einzelner
  Radius im Horizonttest ist entweder zu klein (dann verschwindet sichtbarer
  Boden) oder zu groß (dann bleibt unnötig viel stehen — gemessen 40 % mehr
  Tiles am Rand). Gelöst, indem der Körper durch seine zwei Radien geteilt und
  damit auf die Einheitskugel gestaucht wird; dort ist der Horizont wieder eine
  Ebene und der Test ein Skalarprodukt. Danach wählt der Scheduler auf dem
  Ellipsoid Tile für Tile dasselbe wie auf der Kugel.

- **Ein WebGPU-Canvas lässt sich nur im selben Task zurücklesen**, in dem
  gezeichnet wurde. Ein `await` dazwischen, und `drawImage` liefert
  gelegentlich Schwarz — was wie „der Planet ist verschwunden“ aussieht und
  „der Readback kam zu spät“ heißt. Deshalb `renderFrame` synchron und
  `pump()` getrennt.
