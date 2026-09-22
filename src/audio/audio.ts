/**
 * 소리 (수정사항 2).
 *
 * **음원 파일을 쓰지 않는다.** 파일을 넣으면 저작권·용량·로딩이 한꺼번에 따라오고,
 * 학교 네트워크에서 첫 로딩이 느려진다. 대신 WebAudio 로 그 자리에서 만든다 —
 * 배경음은 느리게 움직이는 패드 화음, 효과음은 짧은 엔벨로프 하나다. 전부
 * 합쳐 몇 킬로바이트의 코드이고 받아올 것이 없다.
 *
 * 브라우저는 사용자가 한 번 누르기 전에는 소리를 못 내게 한다. 그래서
 * `resume()` 을 첫 입력에서 부른다. 볼륨은 localStorage 에 남긴다 — 사람마다
 * 다르고, 교실에서는 대개 꺼 두기 때문이다.
 */
export type SfxName =
  | 'build'
  | 'demolish'
  | 'grow'
  | 'place'
  | 'deny'
  | 'select'
  | 'levelUp'
  | 'alert';

const STORAGE_KEY = 'cities19.audio';

interface Prefs {
  music: number;
  sfx: number;
}

function loadPrefs(): Prefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Prefs>;
      return {
        music: clamp(v.music ?? 0.35),
        sfx: clamp(v.sfx ?? 0.6),
      };
    }
  } catch {
    // 사생활 보호 모드나 저장소 차단. 기본값으로 계속 간다.
  }
  return { music: 0.35, sfx: 0.6 };
}

const clamp = (v: number) => Math.max(0, Math.min(1, v));

/** 배경음이 도는 화음. 천천히 순환해서 같은 마디가 반복된다는 느낌을 지운다. */
const CHORDS: ReadonlyArray<readonly number[]> = [
  [174.61, 220.0, 261.63], // F  A  C
  [196.0, 246.94, 293.66], // G  B  D
  [164.81, 207.65, 246.94], // E  G# B
  [146.83, 220.0, 261.63], // D  A  C
];
/** 화음 한 개가 유지되는 시간(초). */
const CHORD_SECONDS = 7;

export class GameAudio {
  private ctx: AudioContext | null = null;
  private masterMusic: GainNode | null = null;
  private masterSfx: GainNode | null = null;
  private musicTimer: number | null = null;
  private chordIndex = 0;
  private prefs = loadPrefs();
  /** 같은 효과음이 한 프레임에 수십 번 나지 않게 막는 문지기. */
  private lastAt = new Map<SfxName, number>();

  get musicVolume(): number {
    return this.prefs.music;
  }

  get sfxVolume(): number {
    return this.prefs.sfx;
  }

  setMusicVolume(v: number): void {
    this.prefs.music = clamp(v);
    if (this.masterMusic && this.ctx)
      this.masterMusic.gain.setTargetAtTime(this.prefs.music * 0.25, this.ctx.currentTime, 0.1);
    this.save();
    if (this.prefs.music > 0) this.startMusic();
  }

  setSfxVolume(v: number): void {
    this.prefs.sfx = clamp(v);
    if (this.masterSfx && this.ctx)
      this.masterSfx.gain.setTargetAtTime(this.prefs.sfx, this.ctx.currentTime, 0.05);
    this.save();
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.prefs));
    } catch {
      // 저장이 막혀 있어도 이번 판에는 소리가 나야 한다.
    }
  }

  /** 첫 입력에서 부른다. 두 번째부터는 아무 일도 하지 않는다. */
  resume(): void {
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.masterMusic = this.ctx.createGain();
      this.masterMusic.gain.value = this.prefs.music * 0.25;
      this.masterMusic.connect(this.ctx.destination);
      this.masterSfx = this.ctx.createGain();
      this.masterSfx.gain.value = this.prefs.sfx;
      this.masterSfx.connect(this.ctx.destination);
    }
    void this.ctx.resume();
    if (this.prefs.music > 0) this.startMusic();
  }

  /* ---------------- 배경음 ---------------- */

  private startMusic(): void {
    if (!this.ctx || this.musicTimer !== null) return;
    const tick = () => {
      this.playChord();
      this.musicTimer = window.setTimeout(tick, CHORD_SECONDS * 1000);
    };
    tick();
  }

  stopMusic(): void {
    if (this.musicTimer !== null) window.clearTimeout(this.musicTimer);
    this.musicTimer = null;
  }

  /**
   * 화음 하나. 삼각파 세 개를 아주 느린 엔벨로프로 띄우고 내린다.
   * 저역에 한 옥타브 아래를 깔아 두껍게 만든다.
   */
  private playChord(): void {
    const ctx = this.ctx;
    const out = this.masterMusic;
    if (!ctx || !out || this.prefs.music <= 0) return;
    const now = ctx.currentTime;
    const notes = CHORDS[this.chordIndex % CHORDS.length];
    this.chordIndex++;
    for (const [i, freq] of notes.entries()) {
      for (const [octave, level] of [
        [1, 0.32],
        [0.5, 0.18],
      ] as const) {
        const osc = ctx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = freq * octave;
        // 세 음을 아주 조금씩 어긋나게 들여보내면 기계적인 느낌이 사라진다.
        const start = now + i * 0.12;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0, start);
        gain.gain.linearRampToValueAtTime(level, start + 1.6);
        gain.gain.linearRampToValueAtTime(0, start + CHORD_SECONDS);
        osc.connect(gain).connect(out);
        osc.start(start);
        osc.stop(start + CHORD_SECONDS + 0.1);
      }
    }
  }

  /* ---------------- 효과음 ---------------- */

  play(name: SfxName): void {
    const ctx = this.ctx;
    const out = this.masterSfx;
    if (!ctx || !out || this.prefs.sfx <= 0) return;
    const now = ctx.currentTime;
    // 도로를 길게 그으면 칸마다 소리가 난다. 같은 소리는 50ms 안에 한 번만.
    const last = this.lastAt.get(name) ?? -1;
    if (now - last < 0.05) return;
    this.lastAt.set(name, now);

    switch (name) {
      case 'build':
        this.blip(now, 520, 660, 0.09, 'square', 0.22);
        break;
      case 'place':
        this.blip(now, 380, 520, 0.16, 'triangle', 0.3);
        break;
      case 'grow':
        this.blip(now, 300, 720, 0.28, 'triangle', 0.2);
        break;
      case 'demolish':
        this.noise(now, 0.3, 900, 0.35);
        break;
      case 'deny':
        this.blip(now, 220, 150, 0.18, 'sawtooth', 0.22);
        break;
      case 'select':
        this.blip(now, 700, 700, 0.05, 'sine', 0.16);
        break;
      case 'levelUp':
        this.blip(now, 523, 523, 0.14, 'triangle', 0.26);
        this.blip(now + 0.13, 659, 659, 0.14, 'triangle', 0.26);
        this.blip(now + 0.26, 784, 784, 0.3, 'triangle', 0.28);
        break;
      case 'alert':
        this.blip(now, 440, 330, 0.22, 'square', 0.18);
        break;
    }
  }

  /** 한 음. 주파수가 from 에서 to 로 미끄러진다. */
  private blip(
    at: number,
    from: number,
    to: number,
    seconds: number,
    type: OscillatorType,
    level: number,
  ): void {
    const ctx = this.ctx;
    const out = this.masterSfx;
    if (!ctx || !out) return;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, at);
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), at + seconds);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + seconds + 0.02);
  }

  /** 잡음 한 줌. 철거 먼지에 쓴다. */
  private noise(at: number, seconds: number, cutoff: number, level: number): void {
    const ctx = this.ctx;
    const out = this.masterSfx;
    if (!ctx || !out) return;
    const frames = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(cutoff, at);
    filter.frequency.exponentialRampToValueAtTime(180, at + seconds);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
    src.connect(filter).connect(gain).connect(out);
    src.start(at);
    src.stop(at + seconds);
  }
}

export const audio = new GameAudio();
