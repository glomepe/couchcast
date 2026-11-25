import { useEffect, useState } from 'react';

// Fréquence de rafraîchissement de l'écran qui affiche la fenêtre, remesurée en continu :
// déplacer la fenêtre du MacBook (120 Hz ProMotion) vers un écran externe (60 Hz)
// change la cadence des images de l'animation, donc la mesure.
const COMMON = [24, 30, 48, 50, 60, 75, 90, 100, 120, 144, 165, 240];

function measure(frames = 40): Promise<number> {
  return new Promise((resolve) => {
    const deltas: number[] = [];
    let last = 0;
    const tick = (now: number) => {
      if (last) deltas.push(now - last);
      last = now;
      if (deltas.length < frames) requestAnimationFrame(tick);
      else {
        deltas.sort((a, b) => a - b);
        const hz = 1000 / deltas[Math.floor(deltas.length / 2)]; // médiane : insensible aux à-coups
        resolve(COMMON.reduce((best, f) => (Math.abs(f - hz) < Math.abs(best - hz) ? f : best), 60));
      }
    };
    requestAnimationFrame(tick);
  });
}

export function useRefreshRate(): number {
  const [hz, setHz] = useState(60);
  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const run = async () => {
      if (document.visibilityState === 'visible') {
        const v = await measure();
        if (!cancelled) setHz(v);
      }
      timer = window.setTimeout(run, 3000);
    };
    run();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);
  return hz;
}
