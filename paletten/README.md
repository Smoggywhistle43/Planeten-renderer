# Paletten

Hier liegt das **Aussehen**. Die Mechanik liegt im Code, das Aussehen liegt
hier, und die Grenze dazwischen ist scharf gezogen: der Renderer weiß, *dass* ein
Körper Flüssigkeit, Eis und nackten Boden hat und wie eins ins andere übergeht.
Er entscheidet nicht, wie das aussieht.

Eine Palette ist reine Daten. Kein Code, kein Verhalten. Sie lässt sich von Hand
schreiben, erzeugen, hier ablegen und **im laufenden Bild austauschen** — der
Unterschied ist sofort zu sehen, ohne Neubau und ohne Shader-Kompilierung.

## Die sechs Rollen

Der Shader kennt sechs Rollen und keine siebte. Eine siebte hinzuzufügen ist eine
Änderung an der Mechanik, keine an einer Palette.

Sie sind danach benannt, was sie **sind**, nicht danach, wie die Erde sie zufällig
einkleidet:

| Rolle | Was sie ist | Auf der Erde |
|---|---|---|
| `water` | was an der Oberfläche flüssig ist | Ozean |
| `ice` | dieselbe Flüssigkeit, gefroren | Meereis |
| `snow` | gefrorener Niederschlag auf Land | Schnee |
| `barren` | nackter Boden, der Rückfall | Fels, Erde |
| `arid` | trockenes Land | Wüstensand |
| `fertile` | feuchtes Land | Vegetation |

Deshalb ist eine Lavawelt **keine neue Mechanik**: `water` auf glühendes Orange
und `ice` auf schwarze Kruste gelegt, und derselbe Code rendert sie.

## Die Zahlen

`albedo` ist **keine Farbe von einem Bildschirm.** Es ist der Anteil des roten,
grünen und blauen Lichts, den die Oberfläche zurückschickt, linear, 0 bis 1. Er
wird direkt in den Renderer gegeben, wo er Beleuchtungsstärke in Leuchtdichte
verwandelt — ein Wert über 1 würde mehr Licht zurückgeben, als ankommt.

Zwei Fallen, beide schon zugeschlagen:

- **Breitband ist nicht sichtbar.** Die veröffentlichten Albedo-Zahlen (Wald
  0.17) sind Breitband, also über das ganze Sonnenspektrum. Hier stehen
  *sichtbare* Reflektanzen. Bei Vegetation ist der Unterschied riesig: ein Blatt
  reflektiert etwa 12 % des sichtbaren Lichts und etwa 50 % des nahen Infrarots.
  Genau diese Lücke ist die Grundlage der Vegetationskartierung von Satelliten,
  und der Grund, warum ein Wald für das Auge dunkel ist.
- **Rauheit unter 0.2 ist ein schwarzes Loch.** Eine zu glatte Fläche wirft ein
  Glanzlicht, das den Halbfloat-Framebuffer bei 65 504 cd/m² sprengt; geschrieben
  wird Unendlich, und das Tonemapping macht daraus Schwarz. Bei 0.08 erreicht das
  Glanzlicht etwa fünf Millionen. Wasser ist deshalb 0.5 und nicht 0: aus dem
  Orbit deckt ein Pixel Kilometer Meeresoberfläche ab, und was das Licht trifft,
  ist die Hangverteilung der Wellen — Cox und Munk haben die 1954 gemessen.

`parseSurfacePalette` weist beides zurück und sagt jedes Mal, **warum** — und
zwar alle Fehler auf einmal, nicht den ersten. Eine halb gültige Palette rendert
einen halb falschen Körper, und herauszufinden welche Hälfte, indem man ihn
anschaut, ist schlimmer als es gesagt zu bekommen. Eine kaputte Palette
verhindert den Start; sie wird nie halb angewendet.

## Die Übergänge

`thresholds` sagt, wo eine Rolle der nächsten weicht und wie scharf.

| | Einheit | Was passiert |
|---|---|---|
| `coastBlendMetres` | Meter Höhe | Küstenlinie. Zu schmal: ein Pixel breit und kriecht bei Kamerabewegung. Zu breit: ein Strand von hundert Kilometern |
| `snowBlendKelvin` | Kelvin | Schneegrenze auf Land |
| `iceBlendKelvin` | Kelvin | Eiskante auf dem Wasser |
| `aridBelow` | 0..1 Feuchte | darunter ganz trocken |
| `fertileAbove` | 0..1 Feuchte | darüber ganz feucht |
| `fertileNeedsKelvin` | Kelvin über Gefrierpunkt | darunter wächst nichts, egal wie feucht. Ohne das sieht Tundra aus wie Dschungel |

`aridBelow` muss unter `fertileAbove` liegen, sonst überlappen trocken und
feucht.

## Was **nicht** hier steht

Wo die Übergänge *liegen*, entscheidet die Physik, nicht die Palette: die
Temperatur fällt zu den Polen und fällt mit der Höhe, und daraus folgt alles
andere. Eine Palette verschiebt keine Eiskappe an einen anderen Ort — sie sagt,
welche Farbe die Eiskappe hat und wie weich ihre Kante ist. Das Klima steht in
`SurfaceParams` am Körper.

## Benutzen

```
paletten/erde.json      der Ausgangspunkt, identisch mit EARTH_PALETTE im Code
paletten/lava.json      derselbe Körper, dieselbe Physik, nur andere Daten
```

`lava.json` ist der Beleg, dass die Grenze hält: `water` auf glühendes Orange,
`ice` und `snow` auf dunkle Kruste, die Küstenüberblendung von 60 auf 400 Meter
— und aus der Erde wird eine Lavawelt, ohne dass eine Zeile Shader angefasst
wurde. Die Eiskappe liegt weiterhin da, wo die Temperatur sie hinlegt.

Dieses Verzeichnis wird vom Explorer direkt ausgeliefert (`publicDir` in
`apps/explorer/vite.config.ts`), also liegt `erde.json` unter `/erde.json`.

Im Explorer laden: `?palette=/erde.json`, oder in der Konsole

```js
window.__planet.setPalette(await (await fetch('/erde.json')).json())
```

Das Bild ändert sich im nächsten Frame.
