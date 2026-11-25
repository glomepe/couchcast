import { useSyncExternalStore } from 'react';

// Réglages d'image appliqués à l'affichage (filtres CSS/SVG exécutés par le GPU).
// Ils n'affectent ni les clips, ni les enregistrements, ni les lives.
export interface ImageSettings {
  brightness: number; // 1 = neutre
  contrast: number;
  saturation: number;
  sharpness: number; // 0 = aucune accentuation
  gamma: number; // < 1 éclaircit les ombres sans délaver les blancs (niveau des noirs)
}

export const NEUTRAL: ImageSettings = { brightness: 1, contrast: 1, saturation: 1, sharpness: 0, gamma: 1 };

// Préréglage « TV » : compense un peu l'aspect terne du flux SDR compressé.
export const PRESETS: Record<'neutral' | 'vivid' | 'cinema', ImageSettings> = {
  neutral: NEUTRAL,
  vivid: { brightness: 1.03, contrast: 1.1, saturation: 1.25, sharpness: 0.35, gamma: 0.95 },
  cinema: { brightness: 0.97, contrast: 1.06, saturation: 1.05, sharpness: 0.15, gamma: 1.05 },
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

// Flux HDR en cours (renseigné par le lecteur) : les réglages sont alors suspendus.
let streamHdr = false;
const hdrListeners = new Set<() => void>();
export function setStreamHdr(v: boolean) {
  if (v === streamHdr) return;
  streamHdr = v;
  queueMicrotask(() => hdrListeners.forEach((l) => l()));
}
export function useStreamHdr(): boolean {
  return useSyncExternalStore(
    (l) => {
      hdrListeners.add(l);
      return () => hdrListeners.delete(l);
    },
    () => streamHdr,
  );
}

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

/** Valeur CSS `filter` correspondante (gamma et netteté passent par le filtre SVG #cc-image). */
export function cssFilter(s: ImageSettings): string {
  const parts: string[] = [];
  if (s.gamma !== 1 || s.sharpness > 0) parts.push('url(#cc-image)');
  if (s.brightness !== 1) parts.push(`brightness(${s.brightness})`);
  if (s.contrast !== 1) parts.push(`contrast(${s.contrast})`);
  if (s.saturation !== 1) parts.push(`saturate(${s.saturation})`);
  return parts.join(' ') || 'none';
}

/** Noyau 3×3 d'accentuation : centre 1 + 4a, voisins -a. */
export function sharpenKernel(amount: number): string {
  const a = (amount * 0.3).toFixed(3);
  const c = (1 + 4 * amount * 0.3).toFixed(3);
  return `0 -${a} 0 -${a} ${c} -${a} 0 -${a} 0`;
}

/** Filtre SVG commun : courbe gamma (ombres) puis accentuation de la netteté. */
export function ImageFilterDefs({ s }: { s: ImageSettings }) {
  return (
    <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
      <filter id="cc-image" colorInterpolationFilters="sRGB">
        <feComponentTransfer>
          <feFuncR type="gamma" amplitude="1" exponent={s.gamma} offset="0" />
          <feFuncG type="gamma" amplitude="1" exponent={s.gamma} offset="0" />
          <feFuncB type="gamma" amplitude="1" exponent={s.gamma} offset="0" />
        </feComponentTransfer>
        {s.sharpness > 0 && <feConvolveMatrix order="3" kernelMatrix={sharpenKernel(s.sharpness)} preserveAlpha="true" />}
      </filter>
    </svg>
  );
}
