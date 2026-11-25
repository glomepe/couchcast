// Mesures sur une fenêtre glissante d'une seconde + cumul depuis le démarrage.
export class FrameStats {
  source = null;
  dropped = 0;
  #last = { format: null, width: 0, height: 0, frameBytes: 0 };
  #window = this.#emptyWindow();
  #lastFrameAt = 0;
  #totalFrames = 0;
  #startedAt = performance.now();
  #current = null;

  #emptyWindow() {
    return { frames: 0, bytes: 0, intervalSum: 0, intervalCount: 0, intervalMax: 0, since: performance.now() };
  }

  addBytes(n) {
    this.#window.bytes += n;
  }

  addFrame(f) {
    const now = performance.now();
    if (this.#lastFrameAt) {
      const dt = now - this.#lastFrameAt;
      this.#window.intervalSum += dt;
      this.#window.intervalCount++;
      this.#window.intervalMax = Math.max(this.#window.intervalMax, dt);
    }
    this.#lastFrameAt = now;
    this.#window.frames++;
    this.#totalFrames++;
    const frameBytes = f.format === 'nv12' ? f.y.length + f.uv.length : f.rgb.length;
    this.#last = { format: f.format, width: f.width, height: f.height, frameBytes };
  }

  // Clôt la fenêtre courante et retourne ses mesures.
  tick(viewers) {
    const w = this.#window;
    const seconds = (performance.now() - w.since) / 1000;
    this.#current = {
      source: this.source,
      ...this.#last,
      fps: w.frames / seconds,
      mbps: (w.bytes * 8) / seconds / 1e6,
      intervalAvgMs: w.intervalCount ? w.intervalSum / w.intervalCount : 0,
      intervalMaxMs: w.intervalMax,
      totalFrames: this.#totalFrames,
      uptimeS: Math.round((performance.now() - this.#startedAt) / 1000),
      dropped: this.dropped,
      viewers,
    };
    this.#window = this.#emptyWindow();
    return this.#current;
  }

  snapshot(viewers) {
    return this.#current ?? this.tick(viewers);
  }
}
