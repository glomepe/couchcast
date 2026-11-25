import { ChevronDown, CircleAlert, CircleCheck, Loader, Scissors } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, formatClock, formatSize, type Job, type Status } from '../api';
import { useI18n, type T } from '../i18n';
import { Kbd } from '../ui';

export const CLIP_DURATIONS = [15, 30, 60, 120, 300];

export function clipLabel(s: number) {
  return s < 60 ? `${s} s` : `${s / 60} min`;
}

/** Secondes écoulées depuis une date ISO, rafraîchies chaque seconde. */
export function useElapsed(since?: string): number {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [since]);
  return since ? (Date.now() - new Date(since).getTime()) / 1000 : 0;
}

export async function toggleRecording(status: Status) {
  try {
    if (status.studio?.recording.active) await api.recordStop();
    else await api.recordStart();
  } catch (e) {
    alertToast((e as Error).message);
  }
}

export async function clip(seconds: number) {
  try {
    await api.clip(seconds);
  } catch (e) {
    alertToast((e as Error).message);
  }
}

export function RecButton({ status, big }: { status: Status; big?: boolean }) {
  const { t } = useI18n();
  const rec = status.studio?.recording;
  const elapsed = useElapsed(rec?.active ? rec.startedAt : undefined);
  return (
    <button
      className={`rec-btn ${rec?.active ? 'is-recording' : ''} ${big ? 'big' : ''}`}
      disabled={status.state !== 'streaming' && !rec?.active}
      onClick={() => toggleRecording(status)}
      aria-label={rec?.active ? t('rec.stop') : t('rec.start')}
    >
      <span className="tally" />
      {rec?.active ? (
        <span className="timecode">
          {formatClock(elapsed)}
          <small>{formatSize(rec.bytes)}</small>
        </span>
      ) : (
        <span>REC</span>
      )}
      {!big && <span className="tip">{(rec?.active ? t('rec.stop') : t('rec.start'))} <Kbd>R</Kbd></span>}
    </button>
  );
}

export function ClipButton({ status }: { status: Status }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const available = status.studio?.replaySeconds ?? 0;
  const max = status.studio?.settings.replaySeconds ?? 0;
  const enabled = max > 0 && available >= 1 && status.state === 'streaming';

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="split" ref={ref}>
      <button className="split-main" disabled={!enabled} onClick={() => clip(30)}>
        <Scissors size={16} strokeWidth={1.9} />
        {t('clip.button', { s: '30 s' })}
        <span className="tip">{max ? t('clip.memory', { s: Math.min(Math.floor(available), max) }) : t('clip.disabled')} <Kbd>C</Kbd></span>
      </button>
      <button className="split-caret" disabled={!enabled} onClick={() => setOpen((o) => !o)} aria-label="…">
        <ChevronDown size={15} />
      </button>
      {open && (
        <div className="menu">
          {CLIP_DURATIONS.map((s) => (
            <button
              key={s}
              disabled={s > max}
              onClick={() => {
                clip(s);
                setOpen(false);
              }}
            >
              <span>{t('clip.last', { d: clipLabel(s) })}</span>
              {s === 30 && <Kbd>C</Kbd>}
              {s === 120 && <Kbd>⇧ C</Kbd>}
            </button>
          ))}
          <p className="menu-note">{t('clip.memory', { s: Math.min(Math.floor(available), max) })}</p>
        </div>
      )}
    </div>
  );
}

/** Jauge de ping Mac → PS5 (barres façon réseau mobile + valeur). */
export function PingMeter({ status }: { status: Status }) {
  const { t } = useI18n();
  const p = status.stats.ping;
  if (!p.samples) return null;
  const level = p.lossPct > 0 || p.avgMs > 15 ? 1 : p.avgMs > 8 || p.jitterMs > 3 ? 2 : p.avgMs > 3 ? 3 : 4;
  const tone = level <= 1 ? 'bad' : level === 2 ? 'warn' : 'good';
  return (
    <span className={`ping-meter ${tone}`}>
      <span className="bars" aria-hidden>
        {[1, 2, 3, 4].map((b) => (
          <i key={b} className={b <= level ? 'on' : ''} />
        ))}
      </span>
      <span className="ms">{p.avgMs.toFixed(1)} ms</span>
      <span className="tip">
        {t('stats.ping')} · min {p.minMs.toFixed(1)} / max {p.maxMs.toFixed(1)} ms · ±{p.jitterMs.toFixed(1)} · {p.lossPct.toFixed(0)} %
      </span>
    </span>
  );
}

// --- Notifications -------------------------------------------------------------

type Toast = { id: number; text: string; kind: 'ok' | 'error' | 'info'; href?: string };
let pushToast: ((t: Omit<Toast, 'id'>) => void) | null = null;

export function alertToast(text: string) {
  pushToast?.({ text, kind: 'error' });
}

function jobDoneLabel(t: T, kind: Job['kind']) {
  return t(kind === 'clip' ? 'toast.clip' : kind === 'recording' ? 'toast.recording' : 'toast.vertical');
}

/** Notification à chaque tâche (clip, enregistrement, export) qui démarre ou se termine. */
export function Toasts({ status }: { status: Status | null }) {
  const { t } = useI18n();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seen = useRef<Map<number, string> | null>(null);

  useEffect(() => {
    let n = 0;
    pushToast = (toast) => {
      const id = ++n;
      setToasts((list) => [...list.slice(-3), { ...toast, id }]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), 5000);
    };
    return () => {
      pushToast = null;
    };
  }, []);

  useEffect(() => {
    const jobs = status?.studio?.jobs ?? [];
    if (!seen.current) {
      seen.current = new Map(jobs.map((j) => [j.id, j.state]));
      return;
    }
    for (const j of jobs) {
      const prev = seen.current.get(j.id);
      if (prev === j.state) continue;
      if (j.state === 'running' && !prev) pushToast?.({ text: t('toast.running', { label: j.label }), kind: 'info' });
      if (j.state === 'done') pushToast?.({ text: `${jobDoneLabel(t, j.kind)} · ${j.output}`, kind: 'ok', href: '#/bibliotheque' });
      if (j.state === 'error') pushToast?.({ text: `${j.label} · ${j.error}`, kind: 'error' });
      seen.current.set(j.id, j.state);
    }
  }, [status?.studio?.jobs, t]);

  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((toast) => {
        const Icon = toast.kind === 'ok' ? CircleCheck : toast.kind === 'error' ? CircleAlert : Loader;
        return (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <Icon size={16} className={toast.kind === 'info' ? 'spin' : ''} />
            <span className="toast-text">{toast.text}</span>
            {toast.href && <a href={toast.href}>{t('toast.see')}</a>}
          </div>
        );
      })}
    </div>
  );
}
