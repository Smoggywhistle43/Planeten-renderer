# Planeten-Renderer

Ein Planeten-Renderer auf Three.js WebGPU und TSL. Dieses Repo ist bei
**Stufe 01 — Fundament**: eine ungetexturierte graue Kugel in Erdgröße, ein
Kameraflug von 1e9 m bis 1e3 m über der Oberfläche, ohne Zittern und ohne
Z-Fighting.

Was zu dieser Stufe gehört, was offen ist und wovon abgewichen wurde, steht in
**[`STATE.md`](STATE.md)**. Das ist die einzige Wahrheit über den Stand; was
nicht dort steht, gilt als nicht abgenommen.

## Schnellstart

```bash
pnpm install
pnpm dev          # Explorer auf http://127.0.0.1:5173
```

Der Explorer braucht einen Browser mit WebGPU. Chrome 141+ und Safari 26+
genügen; ein WebGL-Fallback existiert bewusst nicht und der Renderer bricht
lieber ab, als still auf etwas anderes auszuweichen.

Tastatur im Explorer:

| Taste | Wirkung |
|---|---|
| Leertaste | Flug pausieren / fortsetzen |
| `R` | Flug neu starten |
| `[` `]` | Höhe schrittweise ändern |
| `T` | Blick zwischen Nadir und Horizont umschalten |
| `L` | Tiles nach LOD-Tiefe einfärben |
| `H` | Höhenfeld zuschalten (Stufe 01 rendert sonst die exakte Kugel) |
| Maus ziehen | umsehen |

## Kommandos

| Kommando | Zweck |
|---|---|
| `pnpm test` | Vitest, beide Projekte: Node und Browser/WebGPU |
| `pnpm test -- --project node` | nur die Node-Tests, ohne Browser |
| `pnpm check:deps` | Architekturgatter (siehe unten) |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | `tsc --noEmit` über das ganze Monorepo |
| `pnpm check` | alle vier hintereinander |
| `pnpm acceptance` | Abnahmelauf, schreibt Belege nach `artifacts/` |
| `pnpm acceptance:fast` | derselbe Lauf, grob, für zwischendurch |
| `pnpm dev` / `pnpm build` | Explorer |

`pnpm test` und `pnpm acceptance` starten Chromium. Einmalig:

```bash
pnpm exec playwright install chromium
```

Auf einem Rechner ohne GPU fällt Chromium auf SwiftShader zurück — korrekt,
aber langsam. Mit `PLANET_CHROMIUM_PATH` lässt sich ein vorhandener Chromium
verwenden, mit `PLANET_SKIP_GPU_TESTS=1` laufen nur die Node-Tests.

## Pakete

```
packages/core      Vec3d, Frame, hash, Seeds, Body.  Kein three, kein DOM.
packages/field     Die Höhenfunktion. Einmal in TSL, zwei Abnehmer.
packages/render    three/webgpu, CubeSphere, LOD, Kamera, Passes.
apps/explorer      Vanilla TS. Kugel, Flug, Overlay.
```

Die Schichtung ist keine Verabredung, sondern ein Gatter: `pnpm check:deps`
prüft, dass `@planet/core` nichts aus `three` importiert — weder direkt noch
über ein anderes Paket —, dass `Math.random()` dort nicht vorkommt, dass keine
Schicht nach oben greift, und dass nirgends `ShaderMaterial`,
`onBeforeCompile`, `EffectComposer` oder `WebGLRenderer` auftaucht. Das Script
hat keine Abhängigkeiten und läuft auch vor `pnpm install`.

## Die drei Regeln, um die es geht

1. **Nie eine absolute Weltposition auf die GPU.** Die einzige Verengung von
   float64 auf float32 im Renderpfad steht in `Frame.toCameraRelative32`, und
   sie passiert immer auf einer Differenz, die schon klein ist.
2. **Tile-Vertices relativ zum eigenen Tile-Origin.** Ein Tile in Tiefe 20 ist
   zehn Meter groß; seine Vertices sind Meterbeträge, wo float32 Mikrometer
   auflöst. Dieselben Vertices absolut wären 6 371 000 m, wo float32 einen
   halben Meter auflöst.
3. **Die Kamera steht auf (0, 0, 0).** Die Welt bewegt sich. Die View-Matrix
   ist eine reine Rotation, das Modell-Matrix-Translation ist bereits
   kamerarelativ.

Der Abnahmelauf misst das, statt es zu behaupten: er läuft dieselbe Messung
zweimal, einmal wie gebaut und einmal mit absichtlich auf float32 gerundeter
Kameraposition. Die Kontrolle muss fehlschlagen, sonst misst der Test nichts.

## Determinismus

Eine Hashfunktion (PCG32, `packages/core/src/hash.ts`), eine Rauschfunktion
(TSL, `packages/field/src/height.ts`). Keine zweite Implementierung von
beidem. Wenn die CPU eine Höhe braucht, geht sie über den Compute-Pfad mit
Readback.

Die Golden Tests in `packages/core/test/golden.test.ts` legen einen Snapshot
aller erzeugten Parameter fest plus eine von Hand eingetragene Prüfsumme. Jede
Änderung am Hash bricht beides. Das ist beabsichtigt und gehört ins `STATE.md`.
