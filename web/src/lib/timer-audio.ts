/**
 * timer-audio.ts — Procedural Web Audio API sounds for the timer system.
 *
 * 10 distinct LCARS-themed sounds, zero file dependencies.
 * Each sound is synthesized via OscillatorNode / GainNode.
 */

export const SOUND_NAMES: readonly string[] = [
  "Bridge Bell",   // 0
  "Bosun Whistle", // 1
  "Red Alert",     // 2
  "Hail",          // 3
  "Warp",          // 4
  "Chime",         // 5
  "Drum",          // 6
  "Beacon",        // 7
  "Klaxon",        // 8
  "Sonar",         // 9
] as const;

// Lazily-created AudioContext shared across all playback calls.
let _ctx: AudioContext | null = null;

function getCtx(): AudioContext {
  if (!_ctx || _ctx.state === "closed") {
    _ctx = new AudioContext();
  }
  return _ctx;
}

/** Resume the AudioContext if it was suspended (browser autoplay policy). */
async function ensureRunning(ctx: AudioContext): Promise<void> {
  if (ctx.state === "suspended") {
    await ctx.resume();
  }
}

// ─── Sound Definitions ──────────────────────────────────────

function playBridgeBell(ctx: AudioContext, at: number): void {
  const notes = [880, 1100];
  notes.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, at + i * 0.25);
    gain.gain.setValueAtTime(0.4, at + i * 0.25);
    gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.25 + 0.5);
    osc.start(at + i * 0.25);
    osc.stop(at + i * 0.25 + 0.55);
  });
}

function playBosunWhistle(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(600, at);
  osc.frequency.linearRampToValueAtTime(1200, at + 0.6);
  osc.frequency.linearRampToValueAtTime(900, at + 1.0);
  gain.gain.setValueAtTime(0.35, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 1.1);
  osc.start(at);
  osc.stop(at + 1.15);
}

function playRedAlert(ctx: AudioContext, at: number): void {
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(440, at + i * 0.3);
    osc.frequency.setValueAtTime(880, at + i * 0.3 + 0.15);
    gain.gain.setValueAtTime(0.3, at + i * 0.3);
    gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.3 + 0.28);
    osc.start(at + i * 0.3);
    osc.stop(at + i * 0.3 + 0.3);
  }
}

function playHail(ctx: AudioContext, at: number): void {
  const freqs = [1200, 900, 1500, 1200];
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, at + i * 0.1);
    gain.gain.setValueAtTime(0.35, at + i * 0.1);
    gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.1 + 0.09);
    osc.start(at + i * 0.1);
    osc.stop(at + i * 0.1 + 0.1);
  });
}

function playWarp(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(80, at);
  osc.frequency.exponentialRampToValueAtTime(600, at + 0.8);
  gain.gain.setValueAtTime(0.25, at);
  gain.gain.setValueAtTime(0.25, at + 0.6);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.9);
  osc.start(at);
  osc.stop(at + 0.95);
}

function playChime(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "triangle";
  osc.frequency.setValueAtTime(1047, at);
  gain.gain.setValueAtTime(0.5, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.7);
  osc.start(at);
  osc.stop(at + 0.75);
}

function playDrum(ctx: AudioContext, at: number): void {
  for (let i = 0; i < 2; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(120, at + i * 0.2);
    osc.frequency.exponentialRampToValueAtTime(40, at + i * 0.2 + 0.15);
    gain.gain.setValueAtTime(0.6, at + i * 0.2);
    gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.2 + 0.18);
    osc.start(at + i * 0.2);
    osc.stop(at + i * 0.2 + 0.2);
  }
}

function playBeacon(ctx: AudioContext, at: number): void {
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, at + i * 0.35);
    gain.gain.setValueAtTime(0.4, at + i * 0.35);
    gain.gain.exponentialRampToValueAtTime(0.001, at + i * 0.35 + 0.3);
    osc.start(at + i * 0.35);
    osc.stop(at + i * 0.35 + 0.32);
  }
}

function playKlaxon(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "square";
  osc.frequency.setValueAtTime(220, at);
  gain.gain.setValueAtTime(0.2, at);
  gain.gain.setValueAtTime(0.2, at + 0.7);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.9);
  osc.start(at);
  osc.stop(at + 0.95);
}

function playSonar(ctx: AudioContext, at: number): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.type = "sine";
  osc.frequency.setValueAtTime(1000, at);
  osc.frequency.exponentialRampToValueAtTime(400, at + 0.8);
  gain.gain.setValueAtTime(0.4, at);
  gain.gain.exponentialRampToValueAtTime(0.001, at + 0.85);
  osc.start(at);
  osc.stop(at + 0.9);
}

const SOUND_FNS: readonly ((ctx: AudioContext, at: number) => void)[] = [
  playBridgeBell,
  playBosunWhistle,
  playRedAlert,
  playHail,
  playWarp,
  playChime,
  playDrum,
  playBeacon,
  playKlaxon,
  playSonar,
];

/**
 * Play a timer sound by ID (0–9).
 * Safe to call from any async context; silently ignores invalid IDs.
 */
export async function playSound(soundId: number): Promise<void> {
  if (soundId < 0 || soundId >= SOUND_FNS.length) return;
  try {
    const ctx = getCtx();
    await ensureRunning(ctx);
    const fn = SOUND_FNS[soundId];
    fn(ctx, ctx.currentTime);
  } catch {
    // Audio errors (e.g., no hardware) should never crash the app.
  }
}
