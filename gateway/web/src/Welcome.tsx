import { ArrowLeft, ArrowRight, Cable, Clapperboard, Gauge, Headphones, Moon, MonitorPlay, Radio, ShieldAlert, Sparkles, UserRound, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n, type Lang } from './i18n';
import { Segmented } from './ui';

// Écran d'accueil du premier lancement : ce qu'est Couchcast, ses limites, les
// prérequis (second compte PSN, mode repos) et les conseils pour la meilleure expérience.
const KEY = 'couchcast.welcomed';

export function hasSeenWelcome(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return true;
  }
}

export function resetWelcome() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignoré */
  }
}

type Slide = { icon: LucideIcon; title: string; body: string; points?: Array<{ icon: LucideIcon; text: string; tone?: 'ok' | 'warn' }> };

export function Welcome({ onDone }: { onDone: () => void }) {
  const { t, lang, setLang } = useI18n();
  const [i, setI] = useState(0);

  const slides: Slide[] = [
    {
      icon: MonitorPlay,
      title: t('welcome.1.title'),
      body: t('welcome.1.body'),
      points: [
        { icon: Clapperboard, text: t('welcome.1.p1') },
        { icon: Radio, text: t('welcome.1.p2') },
        { icon: Sparkles, text: t('welcome.1.p3') },
      ],
    },
    {
      icon: ShieldAlert,
      title: t('welcome.2.title'),
      body: t('welcome.2.body'),
      points: [
        { icon: Sparkles, text: t('welcome.2.good'), tone: 'ok' },
        { icon: Zap, text: t('welcome.2.bad'), tone: 'warn' },
        { icon: Gauge, text: t('welcome.2.limits') },
      ],
    },
    { icon: UserRound, title: t('welcome.3.title'), body: t('welcome.3.body') },
    {
      icon: Moon,
      title: t('welcome.4.title'),
      body: t('welcome.4.body'),
      points: [
        { icon: Moon, text: t('welcome.4.p1') },
        { icon: MonitorPlay, text: t('welcome.4.p2') },
      ],
    },
    {
      icon: Gauge,
      title: t('welcome.5.title'),
      body: t('welcome.5.body'),
      points: [
        { icon: Cable, text: t('welcome.5.p1') },
        { icon: Headphones, text: t('welcome.5.p2') },
        { icon: MonitorPlay, text: t('welcome.5.p3') },
      ],
    },
  ];
  const slide = slides[i];
  const last = i === slides.length - 1;

  const finish = () => {
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignoré */
    }
    onDone();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') last ? finish() : setI(i + 1);
      if (e.key === 'ArrowLeft' && i > 0) setI(i - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const Icon = slide.icon;
  return (
    <main className="welcome">
      <header className="welcome-head">
        <span className="brand big">
          <span className="brand-mark" />
          <span className="brand-name">couchcast</span>
        </span>
        <span className="spacer" />
        <Segmented<Lang> value={lang} onChange={setLang} items={[{ id: 'fr', label: 'FR' }, { id: 'en', label: 'EN' }]} />
        <button className="btn ghost small" onClick={finish}>
          {t('welcome.skip')}
        </button>
      </header>

      <section className="welcome-card" key={i}>
        <div className="welcome-icon">
          <Icon size={30} strokeWidth={1.6} />
        </div>
        <p className="eyebrow">
          {i + 1} / {slides.length}
        </p>
        <h1>{slide.title}</h1>
        <p className="welcome-body">{slide.body}</p>
        {slide.points && (
          <ul className="welcome-points">
            {slide.points.map(({ icon: P, text, tone }) => (
              <li key={text} className={tone}>
                <P size={18} strokeWidth={1.8} />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <footer className="welcome-foot">
        <div className="dots">
          {slides.map((_, k) => (
            <button key={k} className={k === i ? 'is-active' : ''} onClick={() => setI(k)} aria-label={`${k + 1}`} />
          ))}
        </div>
        <span className="spacer" />
        {i > 0 && (
          <button className="btn" onClick={() => setI(i - 1)} aria-label="←">
            <ArrowLeft size={16} />
          </button>
        )}
        <button className="btn primary" onClick={() => (last ? finish() : setI(i + 1))}>
          {last ? t('welcome.start') : t('cal.next')} <ArrowRight size={16} />
        </button>
      </footer>
    </main>
  );
}
