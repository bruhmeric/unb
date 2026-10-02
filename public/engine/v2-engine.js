/**
 * ============================================================================
 *  METHOD V2 ENGINE — 100% Client-Side MP4 Container Restructuring
 * ============================================================================
 *
 *  Clean-room re-implementation of the "Method V2" container pipeline.
 *  Everything runs inside the browser (Web Worker). No upload, no server.
 *
 *  WHAT IT DOES (lossless — no re-encoding of video/audio data):
 *
 *  1. FASTSTART        : relocates the `moov` index atom before `mdat`, so the
 *                        container is stream-first (web-upload friendly).
 *  2. UNKNOWN DURATION : rewrites `mvhd` as version 1 and sets the movie
 *                        duration to 0xFFFFFFFFFFFFFFFF ("unknown"). Duration-
 *                        derived bitrate estimates collapse, so upload
 *                        pipelines skip their aggressive re-encode pass.
 *  3. SAMPLE INFLATION : multiplies the audio track's declared sample count
 *                        (stsz) by 10x, appending synthetic 8-byte samples in
 *                        a new chunk placed after `mdat`, and registers the
 *                        chunk in `stco`/`co64`.
 *  4. TIMING ATOMS     : extends `stts` (time-to-sample) and `stsc`
 *                        (sample-to-chunk) tables.
 *  5. EDTS STRIP       : removes all edit-list (`edts`) atoms recursively.
 *  6. METHOD MARK      : injects a QuickTime metadata atom into `udta/meta`:
 *                        name ".gg/maska" + ©cmt "Patched by Compressbase.com".
 *
 *  The result keeps every original video/audio byte intact.
 * ============================================================================
 */

/* ----------------------------- tiny utilities ---------------------------- */

const enc = new TextEncoder();

/** Read a big-endian uint32 at `off` of a Uint8Array. */
function readU32(u8, off) {
  return (u8[off] << 24) | (u8[off + 1] << 16) | (u8[off + 2] << 8) | u8[off + 3];
}

/** Read a big-endian uint64 at `off`, returned as Number. */
function readU64(u8, off) {
  const hi = readU32(u8, off);
  const lo = readU32(u8, off + 4);
  return hi * 4294967296 + lo;
}

/** Read a 4cc box type at `off`. */
function readType(u8, off) {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

/** ASCII string → 4-byte Uint8Array. */
function typeBytes(s) {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = i < s.length ? s.charCodeAt(i) & 0xff : 0;
  return out;
}

/** UTF-8 string → Uint8Array. */
function strBytes(s) {
  return enc.encode(s);
}

/** Concatenate Uint8Arrays. */
function concat(...parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Build a complete box: [size:u32][type:4cc][payload]. */
function buildBox(type, payload) {
  const out = new Uint8Array(8 + payload.length);
  const dv = new DataView(out.buffer, 0, out.length);
  dv.setUint32(0, out.length, false);
  out.set(typeBytes(type), 4);
  out.set(payload, 8);
  return out;
}

/** Always-standalone copy (env-proof: Buffer.slice shares memory in Node). */
function copyOf(u8) {
  const out = new Uint8Array(u8.length);
  out.set(u8);
  return out;
}

/** DataView tightly bound to a typed array, regardless of its byteOffset. */
function viewOf(u8) {
  return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

/* ------------------------------- box model -------------------------------
 * A box node is either:
 *   { name, children: [...], data: null }   — container box
 *   { name, children: [],   data: Uint8Array } — leaf box
 * Container boxes are parsed recursively (see CONTAINER_BOXES).
 * ------------------------------------------------------------------------ */

const CONTAINER_BOXES = new Set([
  'moov', 'trak', 'mdia', 'minf', 'stbl', 'dinf', 'edts',
  'udta', 'mvex', 'moof', 'traf', 'ilst', 'sinf',
]);
// NOTE: `meta` is intentionally NOT treated as a container here. QuickTime
// `meta` is a "full box" — it carries a 4-byte version/flags prefix before
// any children, so naive container parsing would misalign the tree. We keep
// original `meta` boxes opaque (leaf) and build our own as raw payloads.

/** Recursively parse a run of sibling boxes into a node tree. */
export function parseBoxes(bytes) {
  const nodes = [];
  let pos = 0;
  while (pos + 8 <= bytes.length) {
    let size = readU32(bytes, pos);
    const name = readType(bytes, pos + 4);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > bytes.length) break;
      size = readU64(bytes, pos + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = bytes.length - pos;
    }
    if (size < headerLen || pos + size > bytes.length) break;
    const body = bytes.subarray(pos + headerLen, pos + size);
    if (CONTAINER_BOXES.has(name)) {
      nodes.push({ name, children: parseBoxes(body), data: null });
    } else {
      nodes.push({ name, children: [], data: copyOf(body) });
    }
    pos += size;
  }
  return nodes;
}

/** Serialize a node tree back into raw bytes. */
export function serializeBoxes(nodes) {
  const parts = [];
  for (const node of nodes) {
    const body = node.children && node.children.length
      ? serializeBoxes(node.children)
      : node.data || new Uint8Array();
    parts.push(buildBox(node.name, body));
  }
  return concat(...parts);
}

/** Query nodes by path, e.g. findBoxes(tree, ['trak','mdia','minf','stbl']). */
export function findBoxes(nodes, path) {
  if (!path.length) return [];
  const results = [];
  const walk = (list, depth) => {
    for (const node of list) {
      if (node.name === path[depth]) {
        if (depth === path.length - 1) results.push(node);
        else if (node.children) walk(node.children, depth + 1);
      }
    }
  };
  walk(nodes, 0);
  return results;
}

/** Like findBoxes, but throws when the path is mandatory and missing. */
function needBox(nodes, path) {
  const hits = findBoxes(nodes, path);
  if (!hits.length) {
    throw new Error(`Required atom '${path.join('/')}' not found.`);
  }
  return hits[0];
}

/* --------------------------- edts stripping (4) --------------------------- */

/** Recursively remove every `edts` (edit list) box. */
export function stripEditLists(nodes) {
  const out = nodes.filter((n) => n.name !== 'edts');
  for (const node of out) {
    if (node.children && node.children.length) {
      node.children = stripEditLists(node.children);
    }
  }
  return out;
}

/* -------------------------- metadata injection (5) ------------------------ */

/** Build the QuickTime metadata handler box (`hdlr` with 'mdir'/'appl'). */
function buildMetaHandler() {
  const payload = new Uint8Array(29);
  // version/flags(4) + preDefined(4) + handlerType('mdir') + reserved(16)
  payload.set(strBytes('mdir'), 8);
  payload.set(strBytes('appl'), 12);
  // name: empty null-terminated string (last byte stays 0)
  return buildBox('hdlr', payload);
}

/**
 * Inject iTunes-style metadata into the movie: udta → meta → ilst →
 * ©cmt (comment), ©ART (artist), ©wrt (composer).
 * The `meta` box is a full box: [version/flags(4)] [hdlr] [ilst].
 */
export function injectMetadata(nodes, tags) {
  const entries = [];
  if (tags.comment) entries.push(['\u00A9cmt', tags.comment]);
  if (tags.artist) entries.push(['\u00A9ART', tags.artist]);
  if (tags.composer) entries.push(['\u00A9wrt', tags.composer]);
  if (!entries.length) return nodes;

  // Build the ilst children: each `data` payload = type(4) + locale(4) + value
  const ilstChildren = entries.map(([tag, value]) => {
    const valueBytes = strBytes(value);
    const dataPayload = new Uint8Array(8 + valueBytes.length);
    dataPayload.set(new Uint8Array([0, 0, 0, 1]), 0); // type 1 = UTF-8 text
    dataPayload.set(new Uint8Array([0, 0, 0, 0]), 4); // locale = default
    dataPayload.set(valueBytes, 8);
    return { name: tag, children: [{ name: 'data', children: [], data: dataPayload }], data: null };
  });
  const ilstBytes = serializeBoxes([{ name: 'ilst', children: ilstChildren, data: null }]);

  // meta payload: 4-byte version/flags + hdlr(mdir/appl) + ilst
  const handler = buildMetaHandler();
  const metaPayload = new Uint8Array(4 + handler.length + ilstBytes.length);
  metaPayload.set(handler, 4);
  metaPayload.set(ilstBytes, 4 + handler.length);

  // Find or create udta under the root
  let udta = findBoxes(nodes, ['udta'])[0];
  if (!udta) {
    udta = { name: 'udta', children: [], data: null };
    nodes.push(udta);
  }
  // Replace any previous meta box, then append the fresh iTunes-style one
  udta.children = udta.children.filter((c) => c.name !== 'meta');
  udta.children.push({ name: 'meta', children: [], data: metaPayload });
  return nodes;
}

/* ---------------------- unknown movie duration (2) ------------------------ */

/** Build the exact 33-byte QuickTime `hdlr` used by the method (handler 'mdir'). */
function buildMethodHandler() {
  const payload = new Uint8Array(25); // ver/flags(4) + pre_defined(4) + 'mdir' + 13 zeros
  payload.set(strBytes('mdir'), 8);
  return buildBox('hdlr', payload); // 33 bytes
}

/** Build a `data` box (type 1 = UTF-8 text, default locale) for an ilst entry. */
function buildTextData(value) {
  const valueBytes = strBytes(value);
  const payload = new Uint8Array(8 + valueBytes.length);
  payload.set(new Uint8Array([0, 0, 0, 1]), 0); // data type 1: UTF-8 text
  payload.set(new Uint8Array([0, 0, 0, 0]), 4); // locale: default
  payload.set(valueBytes, 8);
  return buildBox('data', payload);
}

/**
 * THE method mark: udta → meta(full box) { hdlr(mdir), name, ilst{ ©cmt } }.
 * Appended after any existing udta children (existing tags are preserved).
 * Byte-identical to the reference output of the original pipeline.
 */
export function injectMethodTags(nodes, opts = {}) {
  const name = opts.name ?? '.gg/maska';
  const comment = opts.comment ?? 'Patched by Compressbase.com';

  const hdlr = buildMethodHandler();                      // 33 bytes
  const nameBox = buildBox('name', strBytes(name));       // 8 + len(name)
  const cmtBox = buildBox('\u00A9cmt', buildTextData(comment));
  const ilst = buildBox('ilst', cmtBox);

  const metaPayload = new Uint8Array(4 + hdlr.length + nameBox.length + ilst.length);
  metaPayload.set(hdlr, 4); // 4-byte version/flags prefix (full box)
  metaPayload.set(nameBox, 4 + hdlr.length);
  metaPayload.set(ilst, 4 + hdlr.length + nameBox.length);

  let udta = findBoxes(nodes, ['udta'])[0];
  if (!udta) {
    udta = { name: 'udta', children: [], data: null };
    nodes.push(udta);
  }
  // Reference quirk: any EXISTING meta atom under udta has its 4-byte
  // version/flags slot rewritten to the atom's own content size. The original
  // pipeline's serializer emits exactly this; we replicate it byte-for-byte.
  for (const child of udta.children) {
    if (child.name === 'meta' && child.data && child.data.length >= 4) {
      viewOf(child.data).setUint32(0, child.data.length, false);
    }
  }
  udta.children.push({ name: 'meta', children: [], data: metaPayload });
  return nodes;
}

/**
 * Rewrite `mvhd` as version 1 with the movie duration set to
 * 0xFFFFFFFFFFFFFFFF ("unknown"). Timescale, rate, volume, matrix,
 * pre_defined and next_track_ID are preserved byte-for-byte.
 */
export function rewriteMvhdUnknownDuration(nodes) {
  for (const mvhd of findBoxes(nodes, ['mvhd'])) {
    if (!mvhd.data || mvhd.data.length < 24) continue;
    const d = mvhd.data;
    let flags; let ctime; let mtime; let timescale; let rest;
    if (d[0] === 1 && d.length >= 32) {
      flags = d.subarray(1, 4);
      ctime = d.subarray(4, 12);
      mtime = d.subarray(12, 20);
      timescale = d.subarray(20, 24);
      rest = d.subarray(32); // everything after the 8-byte duration
    } else {
      flags = d.subarray(1, 4);
      ctime = d.subarray(4, 8);
      mtime = d.subarray(8, 12);
      timescale = d.subarray(12, 16);
      rest = d.subarray(20); // everything after the 4-byte duration
    }
    // v1 content: ver/flags(4) + ctime(8) + mtime(8) + timescale(4) + duration(8) + rest
    const payload = new Uint8Array(32 + rest.length);
    payload[0] = 1;
    payload.set(flags, 1);
    payload.set(new Uint8Array(4), 4); // widen ctime to 64-bit (high word = 0)
    payload.set(ctime, 8);
    payload.set(new Uint8Array(4), 12); // widen mtime to 64-bit (high word = 0)
    payload.set(mtime, 16);
    payload.set(timescale, 20);
    payload.set(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), 24); // unknown duration
    payload.set(rest, 32);
    mvhd.data = payload;
  }
  return nodes;
}

/* ---------------------------- itsscale mode (opt) ------------------------- */

/** Scale down the timescale of every track (mdhd) and the movie (mvhd). */
export function applyItsscale(nodes, factor = 2) {
  const patch = (box) => {
    if (box.data && box.data.length >= 20) {
      const ts = readU32(box.data, 12);
      const patched = copyOf(box.data);
      viewOf(patched).setUint32(12, Math.max(1, Math.floor(ts / factor)), false);
      box.data = patched;
    }
  };
  for (const mvhd of findBoxes(nodes, ['mvhd'])) patch(mvhd);
  for (const mdhd of findBoxes(nodes, ['trak', 'mdia', 'mdhd'])) patch(mdhd);
  return nodes;
}

/* ================================ THE METHOD ============================== */

/**
 * METHOD V2 — restructure an MP4 container, losslessly.
 *
 * @param {ArrayBuffer|Uint8Array} input   raw MP4 file bytes
 * @param {Object} opts
 *   sampleMultiplier {number}  audio sample inflation factor (default 10)
 *   fakeSampleSize  {number}  byte size of each synthetic sample (default 8)
 *   extendTiming    {boolean} append a synthetic stts run (default true)
 *   methodTags      {Object}  { name, comment } for the udta meta mark
 * @returns {Uint8Array} the rebuilt MP4
 */
export function remuxMp4Boxes(input, opts = {}) {
  const {
    sampleMultiplier = 10,
    fakeSampleSize = 8,
    extendTiming = true,
    methodTags = {},
  } = opts;

  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (data.length < 16) throw new Error('File is too small to be a valid MP4.');

  /* ---- 1. Walk top-level boxes ---- */
  const topLevel = [];
  let pos = 0;
  while (pos + 8 <= data.length) {
    let size = readU32(data, pos);
    const name = readType(data, pos + 4);
    let headerLen = 8;
    if (size === 1) {
      if (pos + 16 > data.length) throw new Error('Truncated 64-bit box header.');
      size = readU64(data, pos + 8);
      headerLen = 16;
    } else if (size === 0) {
      size = data.length - pos;
    }
    if (size < headerLen || pos + size > data.length) {
      throw new Error(`Malformed top-level box '${name}'.`);
    }
    topLevel.push({ name, offset: pos, size });
    pos += size;
  }

  const moovBox = topLevel.find((b) => b.name === 'moov');
  const mdatBox = topLevel.find((b) => b.name === 'mdat');
  if (!moovBox || !mdatBox) {
    throw new Error("Mandatory atoms ('moov' or 'mdat') missing.");
  }

  const moovOffset = moovBox.offset;
  const moovSize = moovBox.size;
  const mdatOffset = mdatBox.offset;
  const mdatSize = mdatBox.size;

  /* ---- 2. Split file into head / mdat / tail ---- */
  const contentEnd = Math.max(mdatOffset + mdatSize, moovOffset + moovSize);
  const contentStart = Math.min(mdatOffset, moovOffset);
  const head = concat(...topLevel
    .filter((b) => b.name !== 'moov' && b.name !== 'mdat' && b.offset < contentStart)
    .map((b) => data.subarray(b.offset, b.offset + b.size)));
  const tail = concat(...topLevel
    .filter((b) => b.name !== 'moov' && b.name !== 'mdat' && b.offset >= contentEnd)
    .map((b) => data.subarray(b.offset, b.offset + b.size)));
  const mdatBytes = data.subarray(mdatOffset, mdatOffset + mdatSize);

  /* ---- 3. Parse moov into a tree ---- */
  let moovTree = parseBoxes(data.subarray(moovOffset + 8, moovOffset + moovSize));
  if (!moovTree.length) throw new Error("'moov' box is empty or failed to parse.");

  /* ---- 4. Method marks: edit-list strip, udta meta, unknown duration ---- */
  moovTree = stripEditLists(moovTree);
  injectMethodTags(moovTree, methodTags);
  rewriteMvhdUnknownDuration(moovTree);

  /* ---- 6. Locate the AUDIO track (hdlr 'soun') ---- */
  let audioTrak = null;
  for (const trak of findBoxes(moovTree, ['trak'])) {
    const hdlr = findBoxes(trak.children, ['mdia', 'hdlr']);
    if (hdlr.length && hdlr[0].data && hdlr[0].data.length >= 12) {
      if (readType(hdlr[0].data, 8) === 'soun') {
        audioTrak = trak;
        break;
      }
    }
  }
  if (!audioTrak) throw new Error("No audio track ('soun' handler) found in moov.");

  const stbl = needBox(audioTrak.children, ['mdia', 'minf', 'stbl']);
  const stsz = needBox(stbl.children, ['stsz']);
  const stsc = needBox(stbl.children, ['stsc']);
  const stts = needBox(stbl.children, ['stts']);
  const stcoNodes = findBoxes(stbl.children, ['stco']);
  const co64Nodes = findBoxes(stbl.children, ['co64']);
  if (!stcoNodes.length && !co64Nodes.length) {
    throw new Error("Audio track missing chunk offset tables ('stco'/'co64').");
  }
  const chunkBox = stcoNodes.length ? stcoNodes[0] : co64Nodes[0];

  /* ---- 7. stsz surgery: inflate the sample count ---- */
  if (!stsz.data || stsz.data.length < 12) throw new Error("Malformed 'stsz' box.");
  const constantSize = readU32(stsz.data, 4);
  const sampleCount = readU32(stsz.data, 8);
  if (constantSize !== 0) throw new Error('Constant-size stsz not supported.');
  if (sampleCount === 0) throw new Error('Audio track has zero samples.');

  const extraSamples = Math.floor(sampleCount * sampleMultiplier) - sampleCount;
  if (extraSamples <= 0) throw new Error('Track too short for sample inflation.');

  const sampleSizes = [];
  for (let i = 0; i < sampleCount; i++) sampleSizes.push(readU32(stsz.data, 12 + i * 4));
  const allSizes = [...sampleSizes, ...new Array(extraSamples).fill(fakeSampleSize)];

  const stszPayload = new Uint8Array(12 + allSizes.length * 4);
  const stszDv = viewOf(stszPayload);
  stszPayload.set(stsz.data.subarray(0, 4), 0); // keep version/flags
  stszDv.setUint32(4, 0, false);                // sample size = variable
  stszDv.setUint32(8, allSizes.length, false);  // new sample count
  for (let i = 0; i < allSizes.length; i++) {
    stszDv.setUint32(12 + i * 4, allSizes[i] >>> 0, false);
  }
  stsz.data = stszPayload;

  /* ---- 8. stts surgery: extend the timing table ---- */
  if (extendTiming) {
    if (!stts.data || stts.data.length < 8) throw new Error("Malformed 'stts' box.");
    const entryCount = readU32(stts.data, 4);
    const sttsPayload = new Uint8Array(8 + (entryCount + 1) * 8);
    sttsPayload.set(stts.data.subarray(0, 4), 0);
    const sttsDv = viewOf(sttsPayload);
    sttsDv.setUint32(4, entryCount + 1, false);
    sttsPayload.set(stts.data.subarray(8, 8 + entryCount * 8), 8);
    sttsDv.setUint32(8 + entryCount * 8, extraSamples, false); // run count
    sttsDv.setUint32(12 + entryCount * 8, 1, false);           // delta = 1 tick
    stts.data = sttsPayload;
  }

  /* ---- 9. stsc surgery: register the synthetic chunk ---- */
  if (!stsc.data || stsc.data.length < 8) throw new Error("Malformed 'stsc' box.");
  const stscEntries = readU32(stsc.data, 4);
  const stscRows = [];
  for (let i = 0; i < stscEntries; i++) {
    stscRows.push([
      readU32(stsc.data, 8 + i * 12),
      readU32(stsc.data, 12 + i * 12),
      readU32(stsc.data, 16 + i * 12),
    ]);
  }
  const lastSampleDesc = stscRows.length ? stscRows[stscRows.length - 1][2] : 1;
  const chunkCount = readU32(chunkBox.data, 4); // BEFORE appending

  /* ---- 10. Build the synthetic chunk payload ---- */
  // Each synthetic sample is 8 bytes of an inert, decoder-safe pattern.
  const fakePattern = new Uint8Array([0, 0, 0, 4, 0, 0, 0, 0]);
  const fakeChunk = new Uint8Array(extraSamples * fakeSampleSize);
  for (let i = 0; i < extraSamples; i++) fakeChunk.set(fakePattern, i * fakeSampleSize);

  /* ---- 11. Append a placeholder chunk offset (stco) ---- */
  const appendChunkOffset = (value) => {
    const is64 = chunkBox.name === 'co64';
    const oldCount = readU32(chunkBox.data, 4);
    const entries = [];
    for (let i = 0; i < oldCount; i++) {
      entries.push(is64 ? readU64(chunkBox.data, 8 + i * 8) : readU32(chunkBox.data, 8 + i * 4));
    }
    entries.push(value);
    // Upgrade to co64 when any offset overflows uint32
    if (!is64 && entries.some((v) => v > 4294967295)) {
      chunkBox.name = 'co64';
    }
    const now64 = chunkBox.name === 'co64';
    const newEntrySize = now64 ? 8 : 4;
    const payload = new Uint8Array(8 + entries.length * newEntrySize);
    const dv = viewOf(payload);
    dv.setUint32(4, entries.length, false);
    for (let i = 0; i < entries.length; i++) {
      if (now64) dv.setBigUint64(8 + i * 8, BigInt(entries[i]), false);
      else dv.setUint32(8 + i * 4, entries[i] >>> 0, false);
    }
    chunkBox.data = payload;
  };

  appendChunkOffset(0); // placeholder; patched after final layout is known

  // stsc gains one row pointing at the (chunkCount+1)-th chunk
  stscRows.push([chunkCount + 1, extraSamples, lastSampleDesc]);
  const stscPayload = new Uint8Array(8 + stscRows.length * 12);
  const stscDv = viewOf(stscPayload);
  stscPayload.set(stsc.data.subarray(0, 4), 0);
  stscDv.setUint32(4, stscRows.length, false);
  for (let i = 0; i < stscRows.length; i++) {
    stscDv.setUint32(8 + i * 12, stscRows[i][0] >>> 0, false);
    stscDv.setUint32(12 + i * 12, stscRows[i][1] >>> 0, false);
    stscDv.setUint32(16 + i * 12, stscRows[i][2] >>> 0, false);
  }
  stsc.data = stscPayload;

  /* ---- 12. Two-pass layout: shift offsets, point synth chunk at data ---- */
  const shiftAllOffsets = (delta) => {
    for (const trak of findBoxes(moovTree, ['trak'])) {
      const boxes = findBoxes(trak.children, ['mdia', 'minf', 'stbl', 'stco'])
        .concat(findBoxes(trak.children, ['mdia', 'minf', 'stbl', 'co64']));
      for (const box of boxes) {
        const is64 = box.name === 'co64';
        const count = readU32(box.data, 4);
        const payload = copyOf(box.data);
        const dv = viewOf(payload);
        for (let i = 0; i < count; i++) {
          if (is64) {
            const v = readU64(box.data, 8 + i * 8) + delta;
            dv.setBigUint64(8 + i * 8, BigInt(v), false);
          } else {
            const v = readU32(box.data, 8 + i * 4) + delta;
            if (v <= 4294967295) dv.setUint32(8 + i * 4, v >>> 0, false);
          }
        }
        box.data = payload;
      }
    }
  };

  // Pass 1: serialize to learn the new moov size (offsets not yet shifted)
  let moovBytes = serializeBoxes(moovTree);
  const totalHead = head.length + moovBytes.length + 8;
  const delta = totalHead - mdatOffset;
  const synthChunkOffset = totalHead + mdatSize;

  // Pass 2: shift every chunk offset by the relocation delta, then patch the
  // last (synthetic) entry so it points exactly at the appended fake chunk.
  shiftAllOffsets(delta);
  const is64Now = chunkBox.name === 'co64';
  {
    const count = readU32(chunkBox.data, 4);
    const payload = copyOf(chunkBox.data);
    const dv = viewOf(payload);
    const last = count - 1;
    if (is64Now) dv.setBigUint64(8 + last * 8, BigInt(synthChunkOffset), false);
    else dv.setUint32(8 + last * 4, synthChunkOffset >>> 0, false);
    chunkBox.data = payload;
  }

  moovBytes = serializeBoxes(moovTree); // sizes are stable now — same structure

  /* ---- 13. Assemble: head + moov + mdat + synthetic chunk + tail ---- */
  const moovBoxBytes = buildBox('moov', moovBytes);
  return concat(head, moovBoxBytes, mdatBytes, fakeChunk, tail);
}

/* ------------------------------ MP4 stats probe --------------------------- */

/** Read {timescale, duration} from an mvhd/mdhd payload, version-aware. */
function readTimeFields(d) {
  if (!d || d.length < 20) return { timescale: 0, duration: 0 };
  if (d[0] === 1 && d.length >= 32) {
    return {
      timescale: readU32(d, 20),
      duration: readU64(d, 24),
      unknown: readU64(d, 24) === 18446744073709551615,
    };
  }
  return { timescale: readU32(d, 12), duration: readU32(d, 16), unknown: false };
}

/** Light probe: returns { duration, timescale, tracks } from the moov atom. */
export function probeMp4(input) {
  const data = input instanceof Uint8Array ? input : new Uint8Array(input);
  const topLevel = [];
  let pos = 0;
  while (pos + 8 <= data.length) {
    let size = readU32(data, pos);
    const name = readType(data, pos + 4);
    let headerLen = 8;
    if (size === 1) { size = readU64(data, pos + 8); headerLen = 16; }
    else if (size === 0) { size = data.length - pos; }
    if (size < headerLen || pos + size > data.length) break;
    topLevel.push({ name, offset: pos, size });
    pos += size;
  }
  const moov = topLevel.find((b) => b.name === 'moov');
  if (!moov) return null;
  const tree = parseBoxes(data.subarray(moov.offset + 8, moov.offset + moov.size));
  const mvhd = findBoxes(tree, ['mvhd'])[0];
  const movieTime = readTimeFields(mvhd && mvhd.data);
  const movie = {
    timescale: movieTime.timescale,
    duration: movieTime.duration,
    durationUnknown: movieTime.unknown,
    tracks: [],
  };
  for (const trak of findBoxes(tree, ['trak'])) {
    const hdlr = findBoxes(trak.children, ['mdia', 'hdlr'])[0];
    const mdhd = findBoxes(trak.children, ['mdia', 'mdhd'])[0];
    const handler = hdlr && hdlr.data && hdlr.data.length >= 12 ? readType(hdlr.data, 8) : '';
    const trackTime = readTimeFields(mdhd && mdhd.data);
    movie.tracks.push({
      type: handler === 'soun' ? 'audio' : handler === 'vide' ? 'video' : handler,
      timescale: trackTime.timescale,
      duration: trackTime.duration,
    });
  }
  return movie;
}
