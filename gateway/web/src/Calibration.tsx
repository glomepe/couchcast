import { ArrowLeft, ArrowRight, Check, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from './i18n';
import { cssFilter, setImageSettings, useImageSettings, type ImageSettings } from './image';

// Assistant de calibrage « à la Rockstar » : pour chaque réglage, une mire et une consigne
// simple (« réglez jusqu'à ce que le logo de gauche soit à peine visible »). La mire passe
// par exactement le même filtre que la vidéo, donc ce qu'on voit est ce qu'on obtient.

type Step = {
  key: 'gamma' | 'brightness' | 'saturation' | 'sharpness';
  title: string;
  hint: string;
  min: number;
  max: number;
  // Valeur du curseur ↔ réglage (les ombres sont inversées : vers la droite = plus clair).
  toSetting: (v: number) => number;
  fromSetting: (s: number) => number;
  pattern: 'blacks' | 'whites' | 'colors' | 'game';
};

function Mark({ color, size }: { color: string; size: number }) {
  return (
    <span className="cal-mark" style={{ width: size, height: size, borderColor: color }}>
      <span style={{ background: color }} />
    </span>
  );
}

function Pattern({ kind, stream }: { kind: Step['pattern']; stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream, kind]);

  if (kind === 'blacks') {
    // Noirs à 3 %, 6 % et 10 % : seul le premier doit être à la limite du visible.
    return (
      <div className="cal-pattern" style={{ background: '#000' }}>
        <Mark color="rgb(8,8,8)" size={120} />
        <Mark color="rgb(15,15,15)" size={120} />
        <Mark color="rgb(26,26,26)" size={120} />
      </div>
    );
  }
  if (kind === 'whites') {
    return (
      <div className="cal-pattern" style={{ background: '#fff' }}>
        <Mark color="rgb(249,249,249)" size={120} />
        <Mark color="rgb(240,240,240)" size={120} />
        <Mark color="rgb(228,228,228)" size={120} />
      </div>
    );
  }
  if (kind === 'colors') {
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const skins = ['#f1c27d', '#e0ac69', '#c68642', '#8d5524', '#5c3a1e'];
    return (
      <div className="cal-pattern colors">
        <div className="bars">
          {bars.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
        </div>
        <div className="skins">
          {skins.map((c) => (
            <i key={c} style={{ background: c }} />
          ))}
          <i style={{ background: 'linear-gradient(90deg, #000, #fff)' }} />
        </div>
      </div>
    );
  }
  // Netteté : le jeu lui-même, agrandi au centre (là où les contours se voient).
  return (
    <div className="cal-pattern game">
      {stream ? (
        <video ref={videoRef} autoPlay muted playsInline />
      ) : (
        <div className="lines">
          {Array.from({ length: 40 }, (_, i) => (
            <i key={i} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Calibration({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const current = useImageSettings();
  const initial = useRef(current); // pour « Annuler »
  const [index, setIndex] = useState(0);
  const stream = (document.querySelector('.player video') as HTMLVideoElement | null)?.srcObject as MediaStream | null;

  const steps: Step[] = [
    {
      key: 'gamma', title: t('cal.blacks'), hint: t('cal.blacksHint'), min: 0.6, max: 1.4, pattern: 'blacks',
      toSetting: (v) => +(2 - v).toFixed(2), fromSetting: (s) => 2 - s,
    },
    {
      key: 'brightness', title: t('cal.whites'), hint: t('cal.whitesHint'), min: 0.8, max: 1.2, pattern: 'whites',
      toSetting: (v) => v, fromSetting: (s) => s,
    },
    {
      key: 'saturation', title: t('cal.colors'), hint: t('cal.colorsHint'), min: 0.5, max: 1.6, pattern: 'colors',
      toSetting: (v) => v, fromSetting: (s) => s,
    },
    {
      key: 'sharpness', title: t('cal.sharpness'), hint: t('cal.sharpnessHint'), min: 0, max: 1, pattern: 'game',
      toSetting: (v) => v, fromSetting: (s) => s,
    },
  ];
  const step = steps[index];
  const value = step.fromSetting(current[step.key]);
  const set = (v: number) => setImageSettings({ ...current, [step.key]: step.toSetting(v) } as ImageSettings);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') set(Math.min(step.max, value + (step.max - step.min) / 50));
      if (e.key === 'ArrowLeft') set(Math.max(step.min, value - (step.max - step.min) / 50));
      if (e.key === 'Enter') index < steps.length - 1 ? setIndex(index + 1) : onClose();
      if (e.key === 'Escape') {
        setImageSettings(initial.current);
        onClose();
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // Portail : le tiroir (backdrop-filter) piégerait un élément en position fixe.
  return createPortal(
    <div className="calibration">
      <div className="cal-stage" style={{ filter: cssFilter(current) }}>
        <Pattern kind={step.pattern} stream={stream} />
      </div>
      <div className="cal-panel">
        <div className="cal-steps">
          {steps.map((s, i) => (
            <button key={s.key} className={i === index ? 'is-active' : i < index ? 'is-done' : ''} onClick={() => setIndex(i)}>
              {i < index ? <Check size={12} /> : i + 1}
            </button>
          ))}
        </div>
        <h2>{step.title}</h2>
        <p>{step.hint}</p>
        <input
          type="range"
          min={step.min}
          max={step.max}
          step={(step.max - step.min) / 100}
          value={value}
          onChange={(e) => set(Number(e.target.value))}
          autoFocus
        />
        <p className="cal-keys muted small">{t('cal.keys')}</p>
        <div className="row">
          <button className="btn ghost" onClick={() => { setImageSettings(initial.current); onClose(); }}>
            <X size={15} /> {t('common.cancel')}
          </button>
          <span className="spacer" />
          {index > 0 && (
            <button className="btn" onClick={() => setIndex(index - 1)}>
              <ArrowLeft size={15} />
            </button>
          )}
          {index < steps.length - 1 ? (
            <button className="btn primary" onClick={() => setIndex(index + 1)}>
              {t('cal.next')} <ArrowRight size={15} />
            </button>
          ) : (
            <button className="btn primary" onClick={onClose}>
              <Check size={15} /> {t('cal.done')}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
