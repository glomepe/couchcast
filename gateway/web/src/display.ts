import { useEffect, useState } from 'react';

/** Fréquence de rafraîchissement de l'écran (Hz), mesurée sur une seconde d'animation. */
export function useRefreshRate(): number {
  const [hz, setHz] = useState(60);
  useEffect(() => {
    let frames = 0;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      frames++;
      if (now - start < 1000) raf = requestAnimationFrame(tick);
      else setHz(Math.round((frames * 1000) / (now - start) / 10) * 10 || 60);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return hz;
}
