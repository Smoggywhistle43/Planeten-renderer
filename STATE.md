# STATE

Einzige Wahrheit über den Stand des Repos. Was hier nicht steht, gilt als nicht
abgenommen.

| | |
|---|---|
| Stufe | **01 — Fundament** |
| Stand | abgenommen bis auf Kriterium 6 (siehe unten) |
| Datum | 2026-08-24 |
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
| `renderer.ts` | `WebGPURenderer` mit `reversedDepthBuffer`, plus Zusicherung |
| `post.ts` | `RenderPipeline` über den TSL-Node-Stack |
| `planet.ts` | setzt alles zusammen, platziert Tiles kamerarelativ |

### apps/explorer

Vanilla TS. Graue Kugel, Skriptflug 1e9 → 1e3 m, Overlay mit Frametime,
Knotenbauten pro Frame gegen das Budget, Tiefenpuffer-Konfiguration und den
float32-Auflösungen. `window.__planet` legt eine deterministische
Schrittsteuerung frei, an der der Abnahmelauf hängt.

---

## Präzision

Die vier Regeln aus dem Handoff, und wo sie im Code stehen:

1. **Nie eine absolute Weltposition auf die GPU.** Die einzige Verengung
   float64 → float32 im Renderpfad ist `Frame.toCameraRelative32`
   beziehungsweise `PlanetCamera.cameraRelative`, und sie wirkt immer auf eine
   Differenz, die schon klein ist.
2. **Tile-Vertices relativ zum eigenen Tile-Origin.** `buildTileMeshData`
   rechnet `dir * radius - origin` in float64 und schreibt erst das Ergebnis
   nach float32.
3. **Kamera auf (0,0,0).** `PlanetCamera.update` setzt die `three`-Kamera bei
   jedem Frame auf den Ursprung; die View-Matrix ist eine reine Rotation.
4. **Rebasing** bei 4096 m Drift, `Frame.update`.

Reversed-Z läuft über `reversedDepthBuffer: true`. Three r185 setzt damit die
Projektion auf near→1 / far→0, den Clear-Wert auf 0, `LessEqualDepth` auf
`GreaterEqual` und das Tiefenformat auf `depth32float` — genau die drei
Punkte aus dem Handoff. `assertReversedDepth` bricht ab, wenn die Fahne nicht
greift, damit ein stiller Rückfall nicht Tage später als Renderfehler
auftaucht.

---

## Snapshots und Checksummen

| Name | Ort | Prüfsumme |
|---|---|---|
| `stage-01` | `packages/core/test/golden/stage-01.json` | `0x233c912e` |

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

Der abgenommene Lauf dieser Stufe liegt eingecheckt unter
[`docs/abnahme/stufe-01/`](docs/abnahme/stufe-01/) — Bericht, Rohdaten und
vier Bilder. `artifacts/` selbst ist Arbeitsverzeichnis und nicht versioniert.

| # | Kriterium | Stand |
|---|---|---|
| 1 | `pnpm test` grün, Golden Tests bestehen | **erfüllt** — 161 Tests: 142 in Node, 19 gegen ein echtes WebGPU-Gerät |
| 2 | `pnpm check:deps` bestätigt: `core` ohne `three` | **erfüllt** |
| 3 | Graue Kugel, Radius 6.371e6 m | **erfüllt** — Silhouettenradius gegen die Projektion einer 6.371e6-m-Kugel: Abweichung ≤ 0.04 % bei 1e7 m, ≤ 4 % nur dort, wo die Scheibe wenige Pixel groß ist. Ein Kreisfit durch die Kontur liegt auf 0.24–0.32 px |
| 4 | Flug 1e9 → 1e3 m ohne Zittern, ohne Z-Fighting | **erfüllt** — siehe unten |
| 5 | Overlay zeigt Knotenbauten pro Frame, Wert ≤ Budget | **erfüllt** — Spitze 2 bei Budget 2 über den ganzen Flug |
| 6 | Overlay zeigt Frametime, 60 fps auf dem M5 Air bei dpr 2 | **offen** — hier nicht entscheidbar, siehe offene Punkte |

### Gemessene Werte des letzten Laufs

720 x 450 px, dpr 1, zehn Höhen von 1e9 bis 1e3 m.

| Höhe | Tiefe | Tiles | Fehler | Builds/Frame | Silhouette |
|---|---|---|---|---|---|
| 1e9 m | 0 | 5 | 0.00 px | 0/2 | Scheibe zu klein zum Messen |
| 1e8 m | 0 | 5 | 0.01 px | 0/2 | Kreis auf 0.24 px (RMS 0.10) |
| 3e7 m | 0 | 5 | 0.02 px | 0/2 | Kreis auf 0.31 px (RMS 0.12) |
| 1e7 m | 0 | 5 | 0.06 px | 0/2 | Kreis auf 0.32 px (RMS 0.13) |
| 1e5 m | 2 | 7 | 0.54 px | 2/2 | Horizont: max 0.52 px, Median 0 |
| 1e4 m | 3 | 11 | 1.39 px | 2/2 | Horizont: max 0.52 px, Median 0 |
| 3e3 m | 4 | 6 | 1.18 px | 2/2 | Horizont: max 0.52 px, Median 0 |
| 1e3 m | 5 | 7 | 0.87 px | 2/2 | Horizont: max 0.52 px, Median 0 |

Risse: null Hintergrundpixel im Inneren der Scheibe, überall wo die Messung
etwas taugt. Flimmern: unter 0.01 % der Innenpixel.

Die Silhouette wird je nach Höhe unterschiedlich gemessen, weil sie
unterschiedliche Dinge ist. Ist die Scheibe ganz im Bild, wird ein Kreis durch
die Kontur gefittet und die größte radiale Abweichung ausgewiesen — das ist
Kriterium 3 als Zahl. Füllt der Horizont das Bild, wird der Sprung zwischen
benachbarten Bildspalten gemessen, denn dort und nur dort zeigt sich eine
LOD-Naht.

### Zu Kriterium 4

Zittern wird nicht per Augenschein beurteilt. Der Lauf schiebt die Kamera in
Schritten seitwärts und misst, ob sich das Bild bei **jedem** Schritt ändert.
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
   Umgesetzt ist es als reine Translation in `mesh.matrixWorld`, die jeder
   Frame aus `tileOriginWorld - cameraWorld` in float64 gesetzt und einmal
   nach float32 verengt wird. Der Buchstabe weicht ab, die Sache nicht: der
   Wert ist kamerarelativ und pro Tile, und der WebGPU-Renderer lädt ihn als
   Teil der `modelViewMatrix` ohnehin als Per-Objekt-Uniform hoch. Der Gewinn
   ist, dass **ein** Material alle Tiles bedient statt eines pro Tile.

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

7. **Der Explorer bündelt 870 kB.** Fast alles davon ist `three/webgpu`. Kein
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

- **Ein WebGPU-Canvas lässt sich nur im selben Task zurücklesen**, in dem
  gezeichnet wurde. Ein `await` dazwischen, und `drawImage` liefert
  gelegentlich Schwarz — was wie „der Planet ist verschwunden“ aussieht und
  „der Readback kam zu spät“ heißt. Deshalb `renderFrame` synchron und
  `pump()` getrennt.
