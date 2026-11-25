import { useSyncExternalStore } from 'react';

// Réglages d'image appliqués à l'affichage (filtres CSS/SVG exécutés par le GPU).
// Ils n'affectent ni les clips, ni les enregistrements, ni les lives.
export interface ImageSettings {
  brightness: number; // 1 = neutre
  contrast: number;
  saturation: number;
  sharpness: number; // 0 = aucune accentuation
}

export const NEUTRAL: ImageSettings = { brightness: 1, contrast: 1, saturation: 1, sharpness: 0 };

// Préréglage « TV » : compense un peu l'aspect terne du flux SDR compressé.
export const PRESETS: Record<'neutral' | 'vivid' | 'cinema', ImageSettings> = {
  neutral: NEUTRAL,
  vivid: { brightness: 1.03, contrast: 1.1, saturation: 1.25, sharpness: 0.35 },
  cinema: { brightness: 0.97, contrast: 1.06, saturation: 1.05, sharpness: 0.15 },
};

const KEY = 'couchcast.image';
const listeners = new Set<() => void>();

function read(): ImageSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...NEUTRAL, ...JSON.parse(raw) };
  } catch {
    /* stockage indisponible */
  }
  return NEUTRAL;
}

let current = read();

export function setImageSettings(next: ImageSettings) {
  current = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignoré */
  }
  listeners.forEach((l) => l());
}

export function useImageSettings(): ImageSettings {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/** Valeur CSS `filter` correspondante (l'accentuation utilise le filtre SVG #cc-sharpen). */
export function cssFilter(s: ImageSettings): string {
  const parts: string[] = [];
  if (s.brightness !== 1) parts.push(`brightness(${s.brightness})`);
  if (s.contrast !== 1) parts.push(`contrast(${s.contrast})`);
  if (s.saturation !== 1) parts.push(`saturate(${s.saturation})`);
  if (s.sharpness > 0) parts.push('url(#cc-sharpen)');
  return parts.join(' ') || 'none';
}

/** Noyau 3×3 d'accentuation : centre 1 + 4a, voisins -a. */
export function sharpenKernel(amount: number): string {
  const a = (amount * 0.6).toFixed(3);
  const c = (1 + 4 * amount * 0.6).toFixed(3);
  return `0 -${a} 0 -${a} ${c} -${a} 0 -${a} 0`;
}
