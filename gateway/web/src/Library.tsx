import { ArrowLeft, Clapperboard, Download, Film, FolderOpen, Layers, Loader, Play, Smartphone, Trash2, Video, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, formatClock, formatSize, mediaUrl, thumbUrl, type MediaItem, type Status, type VerticalLayout } from './api';
import { useI18n } from './i18n';
import { useShortcuts } from './shortcuts';
import { FFmpegWarning, Segmented } from './ui';

type Filter = 'all' | MediaItem['kind'];

export function Library({ status }: { status: Status }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<MediaItem[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [playing, setPlaying] = useState<MediaItem | null>(null);
  const [error, setError] = useState('');
  const jobsKey = JSON.stringify((status.studio?.jobs ?? []).map((j) => [j.id, j.state]));

  const load = useCallback(() => {
    api
      .library()
      .then((r) => setItems(r.items))
      .catch((e) => setError(e.message));
  }, []);

  // Rechargement à chaque fin de tâche (nouveau clip, export…).
  useEffect(load, [load, jobsKey]);

  useShortcuts(
    useCallback(
      (action) => {
        if (action === 'close') {
          if (playing) setPlaying(null);
          else location.hash = '#/';
        }
      },
      [playing],
    ),
  );

  const running = (status.studio?.jobs ?? []).filter((j) => j.state === 'running');
  const shown = (items ?? []).filter((i) => filter === 'all' || i.kind === filter);
  const count = (k: Filter) => (items ?? []).filter((i) => k === 'all' || i.kind === k).length;
  const date = (iso: string) => new Date(iso).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <main className="page library">
      <header className="page-head">
        <a href="#/" className="btn ghost">
          <ArrowLeft size={16} /> {t('lib.player')}
        </a>
        <h1>
          <Clapperboard size={22} strokeWidth={1.7} /> {t('lib.title')}
        </h1>
        <span className="spacer" />
        <Segmented
          value={filter}
          onChange={setFilter}
          items={[
            { id: 'all' as Filter, label: `${t('lib.all')} ${count('all')}`, icon: Layers },
            { id: 'clip' as Filter, label: `${t('lib.clips')} ${count('clip')}`, icon: Film },
            { id: 'recording' as Filter, label: `${t('lib.recordings')} ${count('recording')}`, icon: Video },
            { id: 'vertical' as Filter, label: `${t('lib.verticals')} ${count('vertical')}`, icon: Smartphone },
          ]}
        />
      </header>
      <p className="muted small mono folder">
        <FolderOpen size={14} /> {status.studio?.mediaDir}
      </p>

      <FFmpegWarning ok={status.studio?.ffmpeg} os={status.studio?.os} t={t} />
      {running.map((j) => (
        <div key={j.id} className="job-line">
          <Loader size={15} className="spin" /> {j.label}…
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      {items?.length === 0 && (
        <div className="empty-state big">
          <Film size={40} strokeWidth={1.3} />
          <p>{t('lib.empty')}</p>
        </div>
      )}

      <div className="grid">
        {shown.map((item, i) => (
          <Card key={item.name} item={item} index={i} date={date(item.createdAt)} defaultLayout={status.studio?.settings.vertical} onPlay={() => setPlaying(item)} onChange={load} />
        ))}
      </div>

      {playing && (
        <div className="modal" onClick={() => setPlaying(null)}>
          <div className="viewer" onClick={(e) => e.stopPropagation()}>
            <video className={playing.kind === 'vertical' ? 'portrait' : ''} src={mediaUrl(playing.name)} controls autoPlay />
            <div className="viewer-bar">
              <span className="mono small">{playing.name}</span>
              <span className="spacer" />
              <a className="btn ghost" href={`${mediaUrl(playing.name)}?download`} download>
                <Download size={15} /> {t('lib.download')}
              </a>
              <button className="icon-btn plain" onClick={() => setPlaying(null)} aria-label={t('common.close')}>
                <X size={18} />
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function Card(props: { item: MediaItem; index: number; date: string; defaultLayout?: VerticalLayout; onPlay: () => void; onChange: () => void }) {
  const { t } = useI18n();
  const { item } = props;
  const [menu, setMenu] = useState(false);
  const cropPos = props.defaultLayout?.mode === 'crop' ? props.defaultLayout.position : 0.5;

  const del = async () => {
    if (!confirm(t('lib.deleteConfirm', { name: item.name }))) return;
    await api.deleteMedia(item.name);
    props.onChange();
  };

  return (
    <article className={`media-card k-${item.kind}`} style={{ animationDelay: `${Math.min(props.index, 12) * 35}ms` }}>
      <button className="thumb" onClick={props.onPlay}>
        {item.thumb ? <img src={thumbUrl(item.name)} alt="" loading="lazy" /> : <div className="nothumb" />}
        <span className="play">
          <Play size={22} fill="currentColor" />
        </span>
        <span className="duration mono">{formatClock(item.duration)}</span>
        <span className={`kind k-${item.kind}`}>{t(`lib.kind.${item.kind}` as never)}</span>
      </button>
      <div className="meta">
        <span className="name" title={item.name}>
          {item.name.replace('.mp4', '')}
        </span>
        <span className="muted small">
          {props.date} · {formatSize(item.size)}
        </span>
      </div>
      <div className="actions">
        <a className="icon-btn plain" href={`${mediaUrl(item.name)}?download`} download aria-label={t('lib.download')} title={t('lib.download')}>
          <Download size={16} />
        </a>
        {item.kind !== 'vertical' && (
          <div className="menu-anchor">
            <button className="btn ghost small" onClick={() => setMenu((m) => !m)}>
              <Smartphone size={14} /> {t('lib.vertical')}
            </button>
            {menu && (
              <div className="menu up">
                <button
                  onClick={() => {
                    api.vertical(item.name, { mode: 'blur', position: 0.5 });
                    setMenu(false);
                  }}
                >
                  {t('lib.verticalBlur')}
                </button>
                <button
                  onClick={() => {
                    api.vertical(item.name, { mode: 'crop', position: cropPos });
                    setMenu(false);
                  }}
                >
                  {t('lib.verticalCrop', { p: Math.round(cropPos * 100) })}
                </button>
              </div>
            )}
          </div>
        )}
        <span className="spacer" />
        <button className="icon-btn plain" onClick={() => api.reveal(item.name)} aria-label={t('lib.finder')} title={t('lib.finder')}>
          <FolderOpen size={16} />
        </button>
        <button className="icon-btn plain tone-danger" onClick={del} aria-label={t('common.delete')} title={t('common.delete')}>
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}
