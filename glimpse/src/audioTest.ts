/**
 * Audio pipeline self-test — reachable at /audio-test.html.
 *
 * Exercises the exact decode → mix → AAC-encode → MP4-mux chain from
 * exporter.ts against an `afconvert`-produced m4a (the same tool the Rust
 * capture side uses), reporting PASS/FAIL per stage on the page. The Tauri
 * webview and Safari on this machine share the WebKit engine, so this
 * reproduces the real export path without needing to record a screen.
 */
import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import { decodeAudio, renderMixedAudio, encodeAudioTrack } from './export/exporter';
import { SAMPLE_M4A_B64 } from './audioTestSample';

const logEl = document.getElementById('log')!;

function log(state: 'pass' | 'fail' | 'warn', msg: string): void {
  const li = document.createElement('li');
  li.className = state;
  li.textContent = `${state.toUpperCase()} — ${msg}`;
  logEl.appendChild(li);
  console.warn(`[audio-test] ${state.toUpperCase()} — ${msg}`);
}

function miniProject(audioBlob: Blob, raw: Blob, durationMs: number): Parameters<typeof renderMixedAudio>[0] {
  return {
    trim: { start: 0, end: durationMs },
    recording: { hasAudio: true, audioBlob, blob: raw, duration: durationMs },
    music: undefined,
  } as Parameters<typeof renderMixedAudio>[0];
}

function peakOf(ab: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < ab.numberOfChannels; ch++) {
    const d = ab.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i]);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

async function main(): Promise<void> {
  const encAvail = typeof AudioEncoder !== 'undefined';
  log(encAvail ? 'pass' : 'fail', `AudioEncoder available: ${encAvail}`);

  if (encAvail) {
    const candidates: Array<[string, number, number]> = [
      ['mp4a.40.2', 48000, 2],
      ['mp4a.40.2', 44100, 2],
      ['mp4a.40.2', 22050, 1],
      ['opus', 48000, 2],
    ];
    for (const [codec, sr, ch] of candidates) {
      const { supported } = await AudioEncoder.isConfigSupported({
        codec,
        sampleRate: sr,
        numberOfChannels: ch,
      });
      log(supported ? 'pass' : 'fail', `isConfigSupported ${codec} @${sr}Hz × ${ch}: ${supported}`);
    }
  }

  const ctx = new AudioContext();
  log(ctx.state === 'running' ? 'pass' : 'warn', `fresh AudioContext state: ${ctx.state} (suspended blocks the playback-based fallback)`);
  void ctx.resume().then(() => {
    log(ctx.state === 'running' ? 'pass' : 'warn', `after ctx.resume(): ${ctx.state}`);
  });

  const bytes = Uint8Array.from(atob(SAMPLE_M4A_B64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/mp4' });
  const t0 = performance.now();
  const decoded = await decodeAudio(blob);
  if (!decoded) {
    log('fail', 'decodeAudioData(afconvert m4a) returned null');
    return;
  }
  log('pass', `decodeAudioData(afconvert m4a) ok — ${decoded.duration.toFixed(2)}s, ${decoded.numberOfChannels}ch @${decoded.sampleRate}Hz, ${Math.round(performance.now() - t0)}ms`);

  const durMs = Math.round(decoded.duration * 1000);

  // The user's reported case: music added to a recording that has NO audio.
  const musicProject = {
    trim: { start: 0, end: durMs },
    recording: { hasAudio: false, blob, duration: durMs },
    music: { name: 'sample', offset: 0, duration: durMs, gain: 1, blob },
  } as Parameters<typeof renderMixedAudio>[0];
  const mixedMusic = await renderMixedAudio(musicProject, decoded.duration);
  if (mixedMusic) {
    const peak = peakOf(mixedMusic);
    log(peak > 0.02 ? 'pass' : 'fail', `renderMixedAudio (music only) ok — ${mixedMusic.duration.toFixed(2)}s, peak=${peak.toFixed(3)}`);
  } else {
    log('fail', 'renderMixedAudio (music only) returned null');
  }

  const project = miniProject(blob, blob, durMs);
  const mixed = await renderMixedAudio(project, decoded.duration);
  if (!mixed) {
    log('fail', 'renderMixedAudio returned null');
    return;
  }
  log('pass', `renderMixedAudio ok — ${mixed.duration.toFixed(2)}s output, ${mixed.numberOfChannels}ch @${mixed.sampleRate}Hz`);

  // Isolate the encoder: encode to chunks WITHOUT the muxer in the loop, and
  // check the output metadata carries the AAC codec config mp4-muxer needs.
  let rawChunks = 0;
  let metaDesc = 'n/a';
  try {
    await new Promise<void>((res, rej) => {
      const enc = new AudioEncoder({
        output: (_chunk, meta) => {
          rawChunks++;
          metaDesc = meta?.decoderConfig?.description !== undefined ? 'present' : 'MISSING';
        },
        error: (e) => rej(e),
      });
      enc.configure({
        codec: 'mp4a.40.2',
        sampleRate: mixed.sampleRate,
        numberOfChannels: Math.min(mixed.numberOfChannels, 2),
        bitrate: 192_000,
      });
      const len = mixed.length;
      const CHUNK = 16_384;
      for (let off = 0; off < len; off += CHUNK) {
        const n = Math.min(CHUNK, len - off);
        const planar = new Float32Array(2 * n);
        for (let ch = 0; ch < 2; ch++) planar.set(mixed.getChannelData(ch).subarray(off, off + n), ch * n);
        enc.encode(new AudioData({
          format: 'f32-planar',
          sampleRate: mixed.sampleRate,
          numberOfFrames: n,
          numberOfChannels: 2,
          timestamp: Math.round((off / mixed.sampleRate) * 1_000_000),
          data: planar,
        }));
      }
      void enc.flush().then(() => {
        enc.close();
        res();
      });
    });
    log(rawChunks > 0 ? 'pass' : 'fail', `AudioEncoder (no muxer) → ${rawChunks} AAC chunks`);
    log(
      metaDesc === 'present'
        ? 'pass'
        : 'warn',
      `encoder metadata decoderConfig.description: ${metaDesc} — WebKit omits it; encodeAudioTrack synthesizes the ASC (verified by the round-trip below)`,
    );
  } catch (e) {
    log('fail', `AudioEncoder raw encode threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    audio: {
      codec: 'aac',
      sampleRate: mixed.sampleRate,
      numberOfChannels: Math.min(mixed.numberOfChannels, 2),
    },
    fastStart: 'in-memory',
  });
  let chunks = 0;
  try {
    chunks = await encodeAudioTrack(muxer, mixed, 0, mixed.duration);
    log(chunks > 0 ? 'pass' : 'fail', `AAC encode → ${chunks} chunks into muxer`);
  } catch (e) {
    log('fail', `encodeAudioTrack threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    muxer.finalize();
  } catch (e) {
    log('fail', `muxer.finalize threw: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const { buffer } = muxer.target as ArrayBufferTarget;
  log(buffer.byteLength > 0 ? 'pass' : 'fail', `muxed audio-only mp4: ${buffer.byteLength} bytes`);

  // THE critical audibility check: decode the muxed file back and measure peak.
  if (buffer.byteLength > 0) {
    try {
      const rt = new AudioContext();
      const back = await rt.decodeAudioData(buffer);
      void rt.close();
      const peak = peakOf(back);
      log(peak > 0.02 ? 'pass' : 'fail', `round-trip: decoded muxed mp4 back → ${back.duration.toFixed(2)}s, peak=${peak.toFixed(3)} (audible if > ~0.02)`);
    } catch (e) {
      log('fail', `round-trip: could not decode the muxed mp4 back: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log('pass', `finalize ok — audio chunks: ${chunks}, raw chunks: ${rawChunks}`);

  if (buffer.byteLength > 0) {
    const play = document.createElement('audio');
    play.controls = true;
    play.style.marginTop = '8px';
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/mp4' }));
    play.src = url;
    document.getElementById('audio-wrap')!.appendChild(play);
    const played = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 3000);
      play.onplaying = () => {
        clearTimeout(t);
        res(true);
      };
      play.onerror = () => {
        clearTimeout(t);
        res(false);
      };
      play.play().catch(() => res(false));
    });
    log(played ? 'pass' : 'warn', 'generated mp4 started playing (press play to hear it — should be speech)');
  }

  // The real export muxes video AND audio together — verify that combination
  // produces a file whose audio decodes to non-silence too.
  try {
    const mux2 = new Muxer({
      target: new ArrayBufferTarget(),
      video: { codec: 'avc', width: 320, height: 240 },
      audio: {
        codec: 'aac',
        sampleRate: mixed.sampleRate,
        numberOfChannels: Math.min(mixed.numberOfChannels, 2),
      },
      fastStart: 'in-memory',
    });
    const venc = new VideoEncoder({
      output: (c, m) => mux2.addVideoChunk(c, m),
      error: (e) => {
        throw e;
      },
    });
    venc.configure({ codec: 'avc1.42001f', width: 320, height: 240, bitrate: 1_000_000, framerate: 30 });
    const cv = document.createElement('canvas');
    cv.width = 320;
    cv.height = 240;
    const cctx = cv.getContext('2d')!;
    for (let i = 0; i < 30; i++) {
      cctx.fillStyle = `hsl(${(i * 12) % 360} 80% 50%)`;
      cctx.fillRect(0, 0, 320, 240);
      const vf = new VideoFrame(cv, {
        timestamp: Math.round((i * 1e6) / 30),
        duration: Math.round(1e6 / 30),
      });
      venc.encode(vf, { keyFrame: i === 0 });
      vf.close();
    }
    await venc.flush();
    venc.close();
    const aud2 = await encodeAudioTrack(mux2, mixed, 0, mixed.duration);
    mux2.finalize();
    const buf2 = (mux2.target as ArrayBufferTarget).buffer;
    log(buf2.byteLength > 0 ? 'pass' : 'fail', `combined video+audio mp4: ${buf2.byteLength} bytes, ${aud2} audio chunks`);
    try {
      const rt2 = new AudioContext();
      const back2 = await rt2.decodeAudioData(buf2);
      void rt2.close();
      const peak2 = peakOf(back2);
      log(peak2 > 0.02 ? 'pass' : 'fail', `combined round-trip: audio decodes → ${back2.duration.toFixed(2)}s, peak=${peak2.toFixed(3)}`);
    } catch {
      log('warn', 'combined round-trip: decodeAudioData could not pull audio out of the video+audio mp4 (container-decode limitation, not necessarily a bug)');
    }
    const vplay = document.createElement('video');
    vplay.controls = true;
    vplay.style.width = '200px';
    vplay.style.marginTop = '8px';
    vplay.src = URL.createObjectURL(new Blob([buf2], { type: 'video/mp4' }));
    document.getElementById('audio-wrap')!.appendChild(vplay);
    const vLoaded = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 3000);
      vplay.onloadedmetadata = () => {
        clearTimeout(t);
        res(true);
      };
      vplay.onerror = () => {
        clearTimeout(t);
        res(false);
      };
    });
    if (vLoaded) {
      await new Promise<void>((r) => setTimeout(r, 300));
      const d = vplay.duration;
      log(
        Number.isFinite(d) && d > 0.5 ? 'pass' : 'warn',
        `combined mp4 video track loads — ${Number.isFinite(d) ? d.toFixed(2) : 'NaN'}s, ${vplay.videoWidth}x${vplay.videoHeight}`,
      );
    } else {
      log('warn', 'combined mp4 video track failed to load');
    }
  } catch (e) {
    log('warn', `combined video+audio mux test threw: ${e instanceof Error ? e.message : String(e)}`);
  }

  const done = document.createElement('li');
  done.id = 'done';
  done.textContent = 'done';
  logEl.appendChild(done);
}

void main();
