/** Sound playback and conversion. The game's samples are 22,050 Hz mono unsigned 8-bit PCM. */

export const SAMPLE_RATE = 22050;
/** Longest custom sound the Workshop will add to a map, in seconds. */
export const MAX_SOUND_SECONDS = 20;

let context: AudioContext | null = null;
let playing: AudioBufferSourceNode | null = null;

function play(samples: Uint8Array): void {
  context ??= new AudioContext();
  playing?.stop();
  const buffer = context.createBuffer(1, Math.max(1, samples.length), SAMPLE_RATE);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) channel[i] = (samples[i] - 128) / 128;
  const node = context.createBufferSource();
  node.buffer = buffer;
  node.connect(context.destination);
  node.start();
  playing = node;
}

/** Play one of the game's headerless samples. */
export const playRaw = (bytes: Uint8Array): void => play(bytes);

export function stopSound(): void {
  playing?.stop();
  playing = null;
}

const WAV_HEADER = 44;

/** Wrap 8-bit mono samples in a WAV file. An odd number of samples is rounded down: chunks must be an even length. */
export function encodeWav(input: Uint8Array): Uint8Array {
  const samples = input.subarray(0, input.length & ~1);
  const out = new Uint8Array(WAV_HEADER + samples.length);
  const view = new DataView(out.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE, true); // bytes per second
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits
  text(36, 'data');
  view.setUint32(40, samples.length, true);
  out.set(samples, WAV_HEADER);
  return out;
}

/** The samples of a WAV written by `encodeWav`. */
export const wavSamples = (wav: Uint8Array): Uint8Array => wav.subarray(WAV_HEADER);

/** Play a WAV written by `encodeWav`. */
export const playWav = (wav: Uint8Array): void => play(wavSamples(wav));

export const wavSeconds = (wav: Uint8Array): number => Math.max(0, wav.length - WAV_HEADER) / SAMPLE_RATE;

/**
 * Convert any audio file the browser can decode (WAV, MP3, OGG, FLAC...) to
 * the game's format: mixed to mono, resampled to 22,050 Hz, 8 bits.
 */
export async function audioFileToWav(file: File): Promise<Uint8Array> {
  context ??= new AudioContext();
  const decoded = await context.decodeAudioData(await file.arrayBuffer());
  const seconds = Math.min(MAX_SOUND_SECONDS, decoded.duration);
  const frames = Math.max(1, Math.floor(seconds * SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const mono = (await offline.startRendering()).getChannelData(0);
  const samples = new Uint8Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = Math.max(0, Math.min(255, Math.round(mono[i] * 127 + 128)));
  return encodeWav(samples);
}
