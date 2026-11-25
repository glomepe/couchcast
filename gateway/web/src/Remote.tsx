import { Clapperboard, Power, Radio, Scissors } from 'lucide-react';
import { api, type Status } from './api';
import { useI18n } from './i18n';
import { PingMeter, RecButton, clip, clipLabel } from './studio/Controls';

// Télécommande pour téléphone : clips et enregistrement sans quitter la partie des yeux.
export function Remote({ status }: { status: Status }) {
  const { t } = useI18n();
  const replay = status.studio?.settings.replaySeconds ?? 0;
  const available = status.studio?.replaySeconds ?? 0;
  const streaming = status.state === 'streaming';
  const lives = (status.studio?.live ?? []).filter((l) => l.state === 'live');
  const lastJob = [...(status.studio?.jobs ?? [])].reverse()[0];

  return (
    <main className="page remote">
      <header className="remote-head">
        <span className={`state-pill s-${status.state}`}>
          <span className="led" />
          {t(`state.${status.state}` as never)}
        </span>
        <strong>{status.console?.name}</strong>
        <span className="spacer" />
        <PingMeter status={status} />
      </header>

      {(status.state === 'idle' || status.state === 'error') && (
        <button className="btn primary huge" onClick={() => api.start()}>
          <Power size={20} /> {t('remote.start')}
        </button>
      )}
      {status.state === 'error' && <p className="error">{status.error}</p>}

      <RecButton status={status} big />

      <section className="clip-pad">
        {[30, 15, 60, 120, 300].map((s) => (
          <button key={s} disabled={!streaming || s > replay || available < 1} onClick={() => clip(s)}>
            <Scissors size={16} />
            <small>{t('remote.clip')}</small>
            <strong className="mono">{clipLabel(s)}</strong>
          </button>
        ))}
      </section>

      <div className="remote-meta">
        <span className="muted small">{replay ? t('remote.memory', { s: Math.min(Math.floor(available), replay), max: replay }) : t('remote.noReplay')}</span>
        {lives.length > 0 && (
          <span className="on-air-line small">
            <Radio size={13} /> {t('remote.lives', { n: lives.length })}
          </span>
        )}
        {lastJob && (
          <span className={`small ${lastJob.state === 'error' ? 'error' : 'muted'}`}>
            {t('remote.last', { label: lastJob.state === 'done' ? lastJob.output ?? lastJob.label : lastJob.label })}
          </span>
        )}
      </div>
      {!status.studio?.settings.keepAlive && <p className="hint-card small">{t('remote.keepAlive')}</p>}
      <a href="#/bibliotheque" className="btn ghost">
        <Clapperboard size={16} /> {t('lib.title')}
      </a>
    </main>
  );
}
