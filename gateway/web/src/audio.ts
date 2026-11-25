// Son basse latence : paquets Opus reçus par canal de données, décodés avec WebCodecs
// et joués par un AudioWorklet avec un tampon court et maîtrisé. Le tampon audio
// standard de WebRTC (NetEq) vise la sécurité des appels et ajoute ~50 ms.

const WORKLET = `
class CouchcastPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = 48000; // 1 s de capacité
    this.l = new Float32Array(this.cap);
    this.r = new Float32Array(this.cap);
    this.read = 0; this.write = 0; this.fill = 0;
    this.target = 1680; // 35 ms
    this.playing = false;
    this.underruns = 0; this.dropped = 0; this.tick = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.target) { this.target = d.target; return; }
      const [L, R] = d;
      for (let i = 0; i < L.length; i++) {
        this.l[this.write] = L[i]; this.r[this.write] = R[i];
        this.write = (this.write + 1) % this.cap;
      }
      this.fill = Math.min(this.cap, this.fill + L.length);
      // Retard accumulé (rafale réseau, dérive d'horloge) : on rattrape d'un coup.
      if (this.fill > this.target + 1440) {
        const drop = this.fill - this.target;
        this.read = (this.read + drop) % this.cap; this.fill -= drop; this.dropped += drop;
      }
    };
  }
  process(inputs, outputs) {
    const out = outputs[0], n = out[0].length;
    if (!this.playing && this.fill >= this.target) this.playing = true;
    if (this.playing && this.fill >= n) {
      for (let i = 0; i < n; i++) {
        out[0][i] = this.l[this.read]; if (out[1]) out[1][i] = this.r[this.read];
        this.read = (this.read + 1) % this.cap;
      }
      this.fill -= n;
    } else if (this.playing) {
      this.playing = false; this.underruns++; // trou : on se remet à remplir jusqu'à la cible
    }
    if (++this.tick % 40 === 0) this.port.postMessage({ fill: this.fill, underruns: this.underruns, dropped: this.dropped });
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

export function lowLatencyAudioSupported(): boolean {
  return typeof AudioDecoder !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
}

export class LowLatencyAudio {
  private ctx: AudioContext;
  private gain: GainNode;
  private node: AudioWorkletNode | null = null;
  private decoder: AudioDecoder | null = null;
  private targetMs = 35;
  private lastUnderruns = 0;
  private calmSince = performance.now();
  stats = { fillMs: 0, targetMs: 35, underruns: 0 };

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

  // Cible adaptative : +5 ms à chaque trou, −2 ms après 10 s sans trou (entre 30 et 70 ms).
  // La PS5 envoie le son par rafales espacées de 20 à 35 ms : en dessous de 30 ms, trous assurés.
  private onStats(s: { fill: number; underruns: number }) {
    const now = performance.now();
    if (s.underruns > this.lastUnderruns) {
      this.targetMs = Math.min(70, this.targetMs + 5);
      this.calmSince = now;
    } else if (now - this.calmSince > 10000 && this.targetMs > 30) {
      this.targetMs = Math.max(30, this.targetMs - 2);
      this.calmSince = now;
    }
    this.lastUnderruns = s.underruns;
    this.node?.port.postMessage({ target: Math.round(this.targetMs * 48) });
    this.stats = { fillMs: s.fill / 48, targetMs: this.targetMs, underruns: s.underruns };
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
