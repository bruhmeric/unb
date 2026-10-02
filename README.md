# Method V2 — Lossless MP4 Container Enhancer

A single-purpose web app that implements **Method V2 only**: a 100%
client-side MP4/MOV container restructuring pipeline that rewrites the
duration/index structures of a video file so upload platforms (e.g. TikTok)
keep the original quality instead of re-compressing it.

**No backend. No upload. No re-encoding.** The whole engine runs inside a
Web Worker in the browser.

> **Verified byte-exact.** The engine's output was differentially tested
> against the reference pipeline (method.billoxd.site) across five input
> classes — plain MP4, B-frame + edit-list MP4, non-faststart MP4,
> QuickTime `.mov`, and metadata-less MP4 — and produced
> **byte-identical files** in every case, both via direct engine calls and
> through the full browser UI.

---

## What Method V2 does to the file

The method performs a **lossless container surgery** — every original video
and audio byte is preserved exactly. What changes:

| # | Transformation | Detail |
|---|----------------|--------|
| 1 | **Faststart** | The `moov` index atom is relocated **before** `mdat` (stream-first layout, web-upload friendly). |
| 2 | **Unknown duration** | The movie header is rewritten as **`mvhd` version 1** with the duration field set to `0xFFFFFFFFFFFFFFFF` ("unknown"). Bitrate estimates derived from `size ÷ duration` collapse, so the platform's aggressive re-encode pass is skipped. |
| 3 | **Edit-list strip** | All `edts` boxes are removed recursively from every track. |
| 4 | **Sample inflation** | The **audio track's** declared sample count (`stsz`) is multiplied by 10× — synthetic inert 8-byte samples (`00 00 00 04 00 00 00 00`) are appended in a new chunk placed **after** `mdat`. |
| 5 | **Timing extension** | A synthetic run `{count: extraSamples, delta: 1 tick}` is appended to the `stts` (time-to-sample) table; the `stsc` (sample-to-chunk) table gains a chunk entry; the `stco`/`co64` table gets the new chunk offset (auto-upgrades to `co64` on uint32 overflow). |
| 6 | **Method signature** | A QuickTime metadata atom is appended under `udta → meta`: `hdlr(mdir)` + `name ".gg/maska"` + `ilst → ©cmt "Patched by Compressbase.com"`. Existing tags (e.g. the encoder's `©too`) are preserved. |

After processing, chunk offsets in **all** tracks are re-based to the new
`mdat` position via a two-pass layout, so the file stays fully valid and
decodable (the platform analyzers these changes target read the tables,
not the bytes).

### The two details that matter most

1. **`mvhd` v1 + unknown duration.** This is the core of the bypass: the
   movie-level duration reads as "unknown", which breaks duration-derived
   bitrate ladders that decide how hard to re-compress. Track durations
   (`mdhd`) and playback timing stay untouched — the video plays at its
   real length everywhere.
2. **The exact byte layout.** The reference pipeline's serializer has a
   quirk: an existing `udta/meta` atom gets its 4-byte version/flags slot
   rewritten to the atom's own content size. Harmless for players,
   essential for byte-exact parity. This implementation replicates it.

---

## Project structure

```
├── public/
│   └── engine/
│       ├── v2-engine.js     # THE METHOD — pure-JS MP4 box surgery (ES module)
│       └── v2-worker.js     # Web Worker entry (progress/log protocol)
├── src/
│   └── app/
│       ├── page.tsx         # the entire UI (drop → process → download)
│       ├── layout.tsx       # metadata + fonts
│       └── globals.css      # shadcn theme tokens
├── src/components/ui/       # shadcn/ui components (New York style)
└── package.json
```

### The engine (`public/engine/v2-engine.js`)

A dependency-free ES module (~650 lines, commented). Key exports:

- `parseBoxes(bytes)` — recursive ISO-BMFF box tree parser
- `serializeBoxes(nodes)` — tree → bytes
- `findBoxes(nodes, path)` — box path query (e.g. `['trak','mdia','minf','stbl']`)
- `stripEditLists(nodes)` — removes every `edts`
- `injectMethodTags(nodes, {name, comment})` — the `.gg/maska` / `©cmt` signature
- `rewriteMvhdUnknownDuration(nodes)` — `mvhd` → v1, duration `0xFF…FF`
- `remuxMp4Boxes(input, opts)` — **the full Method V2 pipeline**
- `probeMp4(input)` — light container stats (tracks, timescales, durations)

Notes:
- `meta` boxes are deliberately parsed as **opaque leaves** — QuickTime `meta`
  is a "full box" (4-byte version/flags prefix) and naive container parsing
  corrupts the tree.
- All copies use standalone `Uint8Array` constructors and explicit
  `DataView` offsets, so the code behaves identically in browsers and Node.

### The worker (`public/engine/v2-worker.js`)

Message protocol:

```
main → worker : { type: 'process', buffer, fileName, options }
worker → main : { type: 'progress', percent, stage, log }
               { type: 'done', buffer, fileName, stats }
               { type: 'error', error }
```

The output `ArrayBuffer` is transferred (zero-copy) back to the main thread.

---

## Run it

```bash
npm install        # or: bun install / pnpm install
npm run dev        # http://localhost:3000
```

Production build:

```bash
npm run build
npm run start
```

Requirements: Node 18+ (any modern browser supports module Web Workers).

## Using the output

1. Export your edit at a **high bitrate** from your NLE.
2. Run it through this tool — this must be your **final step** before upload.
3. Upload the processed file from a **desktop web browser** (e.g. TikTok Web),
   not the mobile app. The desktop web pipeline is what accepts
   un-transcoded high-bitrate containers.

## Limitations

- MP4/MOV containers only (the method operates on MP4 atom structure).
- The file **must contain an audio track** (the sample-table surgery targets
  the `soun` handler track).
- Constant-size `stsz` audio tracks are rejected (rare in practice).
- 64-bit `co64` inputs are supported; outputs auto-upgrade to `co64` when
  offsets exceed uint32.

## License / disclaimer

Provided for research and educational purposes. This is a clean-room
implementation of publicly observable container-level techniques; it contains
no code from third-party sites. Use in accordance with the terms of any
platform you upload to.
