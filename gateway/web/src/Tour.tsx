import { ArrowRight, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from './i18n';

// Visite guidée : un projecteur s'arrête sur chaque élément marqué data-tour="…".
const KEY = 'couchcast.toured';

export function hasSeenTour(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

export function resetTour() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignoré */
  }
}

const STEPS = ['status', 'rec', 'clip', 'stats', 'library', 'settings', 'shortcuts', 'global'] as const;
type StepId = (typeof STEPS)[number];

export function Tour({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  // Étapes dont l'élément existe à l'écran (la dernière, « global », est centrée).
  // Calculé après le montage : la barre d'outils est insérée dans le même rendu que la visite.
  const [steps, setSteps] = useState<StepId[]>([]);
  useLayoutEffect(() => {
    setSteps(STEPS.filter((s) => s === 'global' || document.querySelector(`[data-tour="${s}"]`)));
  }, []);
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const step: StepId = steps[i];

  useLayoutEffect(() => {
    const update = () => {
      const el = step === 'global' ? null : document.querySelector(`[data-tour="${step}"]`);
      setRect(el ? el.getBoundingClientRect() : null);
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [step]);

  const finish = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignoré */
    }
    onDone();
  };
  const next = () => (i < steps.length - 1 ? setI(i + 1) : finish());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === 'Escape') finish();
      if (e.key === 'ArrowRight' || e.key === 'Enter') next();
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  if (!step) return null;
  const pad = 8;
  const spot = rect && { left: rect.left - pad, top: rect.top - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 };
  // Bulle sous l'élément, gardée dans l'écran.
  const bubbleLeft = spot ? Math.min(Math.max(16, spot.left + spot.width / 2 - 170), window.innerWidth - 356) : undefined;

  return createPortal(
    <div className="tour" onClick={(e) => e.target === e.currentTarget && next()}>
      {spot ? <div className="tour-spot" style={spot} /> : <div className="tour-dim" />}
      <div
        className={`tour-bubble ${spot ? '' : 'centered'}`}
        style={spot ? { left: bubbleLeft, top: spot.top + spot.height + 14 } : undefined}
        key={step}
      >
        <p className="eyebrow">
          {i + 1} / {steps.length}
        </p>
        <h3>{t(`tour.${step}.title` as never)}</h3>
        <p>{t(`tour.${step}.body` as never)}</p>
        <div className="row">
          <button className="btn ghost small" onClick={finish}>
            <X size={14} /> {t('tour.skip')}
          </button>
          <span className="spacer" />
          <button className="btn primary small" onClick={next}>
            {i < steps.length - 1 ? t('cal.next') : t('tour.done')} <ArrowRight size={14} />
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
