/**
 * METHOD V2 WORKER — background processing thread.
 * Imports the engine module and executes the V2 pipeline off the main thread.
 * Protocol:
 *   main → worker : { type: 'process', buffer: ArrayBuffer, fileName, options }
 *   worker → main : { type: 'progress', percent, stage, log }
 *                   { type: 'done', buffer, fileName, stats }
 *                   { type: 'error', error }
 */

import { remuxMp4Boxes, probeMp4 } from './v2-engine.js';

const yieldControl = () => new Promise((r) => setTimeout(r, 10));

function notify(percent, stage, log) {
  self.postMessage({ type: 'progress', percent, stage, log });
}

self.onmessage = async (event) => {
  const { type, buffer, fileName, options } = event.data || {};
  if (type !== 'process' || !buffer) {
    self.postMessage({ type: 'error', error: 'No video buffer provided' });
    return;
  }
  const safeName = typeof fileName === 'string' && fileName ? fileName : 'input.mp4';

  try {
    notify(10, 'Initializing Method V2 pipeline...', '[*] Worker thread active. Loading V2 engine...');
    await yieldControl();

    /* ---------- probe the source container ---------- */
    notify(18, 'Reading container structure...', '[*] Parsing MP4 atom tree...');
    await yieldControl();
    const before = probeMp4(buffer);
    if (!before) {
      throw new Error('Unsupported MP4 structure: no moov atom found. Please use a valid MP4/MOV file.');
    }
    const audioTrack = before.tracks.find((t) => t.type === 'audio');
    if (!audioTrack) {
      throw new Error('No audio track found in this file. Method V2 requires an audio track (soun handler).');
    }
    notify(22, 'Container validated',
      `[+] Found ${before.tracks.length} track(s): ${before.tracks.map((t) => t.type).join(', ')}`);
    await yieldControl();

    /* ---------- run the V2 container surgery ---------- */
    notify(35, 'Restructuring container atoms...', '[*] Executing Method V2 container surgery...');
    await yieldControl();

    const output = remuxMp4Boxes(buffer, {
      sampleMultiplier: options?.sampleMultiplier ?? 10,
      fakeSampleSize: options?.fakeSampleSize ?? 8,
      extendTiming: options?.extendTiming ?? true,
    });

    notify(65, 'Setting unknown movie duration...', '[+] mvhd → version 1, duration = unknown');
    await yieldControl();
    notify(80, 'Writing FastStart index & synthetic chunk...', '[*] Rebuilding stts/stsc/stco tables...');
    await yieldControl();

    /* ---------- verify + finish ---------- */
    const after = probeMp4(output);
    notify(92, 'Stamping method signature...', '[+] udta/meta: name ".gg/maska" + \u00A9cmt "Patched by Compressbase.com"');
    await yieldControl();

    const stats = {
      inputBytes: buffer.byteLength,
      outputBytes: output.byteLength,
      tracksBefore: before,
      tracksAfter: after,
    };

    notify(100, 'Done!',
      `[SUCCESS] Method V2 container built with 100% original quality! (${(output.byteLength / 1048576).toFixed(2)} MB)`);

    const outName = (safeName.replace(/\.[^.]+$/, '') || 'video') + '_v2_optimized.mp4';
    self.postMessage(
      { type: 'done', buffer: output.buffer, fileName: outName, stats },
      [output.buffer],
    );
  } catch (err) {
    self.postMessage({ type: 'error', error: err?.message || String(err) });
  }
};
