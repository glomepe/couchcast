// Son basse latence : paquets Opus reçus par canal de données, décodés avec WebCodecs
// et joués par un AudioWorklet avec un tampon court et maîtrisé. Le tampon audio
// standard de WebRTC (NetEq) vise la sécurité des appels et ajoute ~50 ms.

const WORKLET = `
// Tampon circulaire lu à vitesse légèrement variable (±0,5 %) : on garde une petite
// marge au point le plus bas du tampon sans jamais jeter de son ni couper net.
class CouchcastPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000 * 2;
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.write = 0; this.pos = 0; this.fill = 0; // pos : position de lecture fractionnaire
    this.margin = 480;   // marge visée au creux du tampon (10 ms), adaptative
    this.startAt = 1920; // remplissage avant de (re)démarrer (40 ms)
    this.playing = false;
    this.gain = 0;       // fondu d'entrée/sortie
    this.lastL = 0; this.lastR = 0;
    this.winMin = Infinity; this.winN = 0; this.lowEma = -1;
    this.ratio = 1;
    this.underruns = 0; this.dropped = 0; this.tick = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.margin) { this.margin = d.margin; this.startAt = Math.max(1920, d.margin + 1440); return; }
      const [L, R] = d;
      for (let i = 0; i < L.length; i++) {
        this.l[this.write] = L[i]; this.r[this.write] = R[i];
        this.write = (this.write + 1) % this.cap;
      }
      this.fill += L.length;
      // Garde-fou seulement (onglet en arrière-plan, gros décrochage) : plus de 250 ms d'avance.
      if (this.fill > 12000) {
        const drop = this.fill - this.startAt;
        this.pos = (this.pos + drop) % this.cap; this.fill -= drop; this.dropped += drop;
        this.lowEma = -1;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], n = out[0].length, cap = this.cap;
    if (!this.playing && this.fill >= this.startAt) { this.playing = true; this.gain = 0; }
    for (let i = 0; i < n; i++) {
      let L = 0, R = 0;
      if (this.playing && this.fill >= 2) {
        const i0 = Math.floor(this.pos), f = this.pos - i0, i1 = (i0 + 1) % cap;
        L = this.l[i0] + (this.l[i1] - this.l[i0]) * f;
        R = this.r[i0] + (this.r[i1] - this.r[i0]) * f;
        this.pos += this.ratio; if (this.pos >= cap) this.pos -= cap;
        this.fill -= this.ratio;
        if (this.gain < 1) this.gain = Math.min(1, this.gain + 1 / 240); // 5 ms
        this.lastL = L; this.lastR = R;
      } else {
        if (this.playing) { this.playing = false; this.underruns++; }
        // Trou : on s'éteint en douceur sur le dernier échantillon au lieu d'un clic.
        this.gain *= 0.97; L = this.lastL; R = this.lastR;
      }
      out[0][i] = L * this.gain; if (out[1]) out[1][i] = R * this.gain;
    }
    // Creux du tampon sur des fenêtres de ~0,5 s, lissé : c'est lui qu'on asservit.
    if (this.playing) this.winMin = Math.min(this.winMin, this.fill);
    if (++this.winN >= 188) {
      if (this.winMin !== Infinity) this.lowEma = this.lowEma < 0 ? this.winMin : this.lowEma * 0.7 + this.winMin * 0.3;
      this.winMin = Infinity; this.winN = 0;
      if (this.lowEma >= 0) {
        const err = this.lowEma - this.margin; // échantillons d'avance au-delà de la marge
        this.ratio = 1 + Math.max(-0.005, Math.min(0.005, err * 0.000006));
      }
    }
    if (++this.tick % 40 === 0)
      this.port.postMessage({ fill: this.fill, low: this.lowEma, ratio: this.ratio, underruns: this.underruns, dropped: this.dropped });
    return true;
  }
}
registerProcessor('couchcast-player', CouchcastPlayer);
`;

let activeAudio: LowLatencyAudio | null = null;

/** Latence propre au périphérique de sortie (haut-parleurs d'écran, Bluetooth…), en ms. */
export function outputDeviceLatencyMs(): number | null {
  return activeAudio ? activeAudio.outputLatencyMs() : null;
}

// Son « direct » par défaut : la piste WebRTC jouée telle quelle par le navigateur, sans
// aucun traitement de notre part. Le son basse latence (−50 ms environ) est une option.
const MODE_KEY = 'couchcast.lowLatencyAudio';

export function lowLatencyAudioEnabled(): boolean {
  try {
    return localStorage.getItem(MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setLowLatencyAudio(on: boolean) {
  try {
    localStorage.setItem(MODE_KEY, on ? '1' : '0');
  } catch {
    /* ignoré */
  }
  window.dispatchEvent(new Event('couchcast:audiomode'));
}

export function lowLatencyAudioSupported(): boolean {
  return typeof AudioDecoder !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
}

export class LowLatencyAudio {
  private ctx: AudioContext;
  private gain: GainNode;
  private node: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private marginMs = 10;
  private lastUnderruns = 0;
  private calmSince = performance.now();
  private fillAvg = -1;
  private lastSeq = -1;
  private lost = 0;
  private late = 0;
  private lastArrival = 0;
  private winGap = 0;
  private gapWinStart = 0;
  private maxGapMs = 0;
  stats = { fillMs: 0, marginMs: 10, underruns: 0, droppedMs: 0, ratePct: 0, lost: 0, late: 0, maxGapMs: 0 };

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
    activeAudio = this;
  }

  async start() {
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await this.ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    this.node = new AudioWorkletNode(this.ctx, 'couchcast-player', { outputChannelCount: [2] });
    this.node.connect(this.gain);
    this.node.port.onmessage = (e) => this.onStats(e.data);
    this.decoder = new AudioDecoder({
      output: (data) => this.onDecoded(data),
      error: () => this.resetDecoder(),
    });
    this.resetDecoder();
  }

  private resetDecoder() {
    if (!this.decoder || this.decoder.state === 'closed') {
      this.decoder = new AudioDecoder({ output: (d) => this.onDecoded(d), error: () => this.resetDecoder() });
    }
    this.decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2 });
  }

  /** Message du canal : u16 numéro de séquence + paquet Opus (10 ms). */
  push(buf: ArrayBuffer) {
    if (!this.decoder || this.decoder.state !== 'configured' || buf.byteLength < 3) return;
    const seq = new DataView(buf).getUint16(0);
    // Canal non ordonné : un paquet arrivé après son suivant est trop tard, on l'ignore.
    if (this.lastSeq >= 0) {
      const diff = (seq - this.lastSeq + 65536) % 65536;
      if (diff === 0 || diff > 32768) {
        this.late++;
        return;
      }
      if (diff > 1) this.lost += diff - 1;
    }
    this.lastSeq = seq;
    // Écart d'arrivée le plus long sur 5 s : c'est lui qui impose la taille du tampon.
    const now = performance.now();
    if (this.lastArrival) this.winGap = Math.max(this.winGap, now - this.lastArrival);
    this.lastArrival = now;
    if (now - this.gapWinStart > 5000) {
      this.maxGapMs = this.winGap;
      this.winGap = 0;
      this.gapWinStart = now;
    }
    this.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: seq * 10000, data: new Uint8Array(buf, 2) }));
  }

  private onDecoded(data: AudioData) {
    const n = data.numberOfFrames;
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    data.copyTo(L, { planeIndex: 0, format: 'f32-planar' });
    data.copyTo(R, { planeIndex: data.numberOfChannels > 1 ? 1 : 0, format: 'f32-planar' });
    data.close();
    this.node?.port.postMessage([L, R], [L.buffer, R.buffer]);
  }

  // Marge adaptative au creux du tampon : +4 ms à chaque trou, −1 ms après 15 s sans trou
  // (entre 6 et 40 ms). La latence vaut à peu près marge + taille des rafales de la PS5.
  private onStats(s: { fill: number; low: number; ratio: number; underruns: number; dropped: number }) {
    const now = performance.now();
    if (s.underruns > this.lastUnderruns) {
      this.marginMs = Math.min(40, this.marginMs + 4);
      this.calmSince = now;
      this.node?.port.postMessage({ margin: Math.round(this.marginMs * 48) });
    } else if (now - this.calmSince > 15000 && this.marginMs > 6) {
      this.marginMs = Math.max(6, this.marginMs - 1);
      this.calmSince = now;
      this.node?.port.postMessage({ margin: Math.round(this.marginMs * 48) });
    }
    this.lastUnderruns = s.underruns;
    // Moyenne glissante du remplissage (il oscille avec les rafales).
    this.fillAvg = this.fillAvg < 0 ? s.fill : this.fillAvg * 0.9 + s.fill * 0.1;
    this.stats = {
      fillMs: this.fillAvg / 48,
      marginMs: this.marginMs,
      underruns: s.underruns,
      droppedMs: s.dropped / 48,
      ratePct: (s.ratio - 1) * 100,
      lost: this.lost,
      late: this.late,
      maxGapMs: this.maxGapMs,
    };
  }

  outputLatencyMs(): number {
    return ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }

  /** Délai total du son : tampon + latence de sortie du système. */
  latencyMs(): number {
    return this.stats.fillMs + ((this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0)) * 1000;
  }

  setMuted(muted: boolean) {
    this.gain.gain.value = muted ? 0 : 1;
  }

  resume() {
    if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  close() {
    if (activeAudio === this) activeAudio = null;
    this.decoder?.state !== 'closed' && this.decoder?.close();
    this.ctx.close().catch(() => {});
  }
}
