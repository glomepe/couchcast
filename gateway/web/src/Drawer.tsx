import {
  AppWindow,
  Check,
  Clapperboard,
  Copy,
  Gamepad2,
  Link2,
  MonitorPlay,
  Pencil,
  Plus,
  Radio,
  RotateCcw,
  Smartphone,
  SunMedium,
  Trash2,
  Unlink,
  Video,
  X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, formatClock, type LiveDestination, type LiveStatus, type Status, type StreamSettings, type StudioSettings } from './api';
import { useI18n } from './i18n';
import { useRefreshRate } from './display';
import { Calibration } from './Calibration';
import { NEUTRAL, PRESETS, setImageSettings, useImageSettings, type ImageSettings } from './image';
import { ShortcutList } from './shortcuts';
import { useElapsed } from './studio/Controls';
import { FFmpegWarning, Field, Segmented, Tabs, Toggle } from './ui';

export type DrawerTab = 'stream' | 'image' | 'clips' | 'live' | 'links' | 'app';

export function Drawer({ status, tab, onTab, onClose }: { status: Status; tab: DrawerTab; onTab: (t: DrawerTab) => void; onClose: () => void }) {
  const { t } = useI18n();
  const tabs: Array<{ id: DrawerTab; label: string; icon: LucideIcon }> = [
    { id: 'stream', label: t('tab.stream'), icon: MonitorPlay },
    { id: 'image', label: t('tab.image'), icon: SunMedium },
    { id: 'clips', label: t('tab.clips'), icon: Clapperboard },
    { id: 'live', label: t('tab.live'), icon: Radio },
    { id: 'links', label: t('tab.links'), icon: Link2 },
    { id: 'app', label: t('tab.app'), icon: AppWindow },
  ];
  return (
    <aside className="drawer" aria-label={t('bar.settings')}>
      <header className="drawer-head">
        <Tabs value={tab} onChange={onTab} items={tabs} />
        <button className="icon-btn plain" onClick={onClose} aria-label={t('common.close')}>
          <X size={18} />
        </button>
      </header>
      <div className="drawer-body" key={tab}>
        {(tab === 'clips' || tab === 'live') && <FFmpegWarning ok={status.studio?.ffmpeg} os={status.studio?.os} t={t} />}
        {tab === 'stream' && <StreamTab status={status} />}
        {tab === 'image' && <ImageTab hdr={status.settings.codec === 'h265-hdr'} />}
        {tab === 'clips' && status.studio && <ClipsTab settings={status.studio.settings} replayMB={status.studio.replayMB} available={status.studio.replaySeconds} />}
        {tab === 'live' && <LiveTab status={status} />}
        {tab === 'links' && <LinksTab />}
        {tab === 'app' && <AppTab />}
      </div>
    </aside>
  );
}

/** Le navigateur sait-il recevoir du H.265 en WebRTC ? */
function supportsH265(): boolean {
  try {
    return (RTCRtpReceiver.getCapabilities('video')?.codecs ?? []).some((c) => c.mimeType.toLowerCase() === 'video/h265');
  } catch {
    return false;
  }
}

// --- Flux ----------------------------------------------------------------------

function StreamTab({ status }: { status: Status }) {
  const { t } = useI18n();
  const [s, setS] = useState<StreamSettings>(status.settings);
  const [msg, setMsg] = useState('');
  const dirty = JSON.stringify(s) !== JSON.stringify(status.settings);

  const save = async () => {
    try {
      await api.settings(s);
      setMsg(status.state === 'streaming' ? t('stream.restart') : t('common.saved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <Field label={t('stream.resolution')}>
        <Segmented
          value={s.resolution}
          onChange={(v) => setS({ ...s, resolution: v })}
          items={[1080, 720, 540, 360].map((r) => ({ id: r as StreamSettings['resolution'], label: `${r}p` }))}
        />
      </Field>
      <Field label={t('stream.fps')}>
        <Segmented value={s.fps} onChange={(v) => setS({ ...s, fps: v })} items={[{ id: 60 as const, label: '60' }, { id: 30 as const, label: '30' }]} />
      </Field>
      <Field label={t('stream.bitrate')} hint={t('stream.bitrateHint')}>
        <select value={s.bitrate} onChange={(e) => setS({ ...s, bitrate: Number(e.target.value) })}>
          <option value={0}>{t('stream.auto')}</option>
          {[5000, 10000, 15000, 20000, 30000, 40000].map((b) => (
            <option key={b} value={b}>
              {b / 1000} Mbit/s
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('stream.codec')} hint={t('stream.codecHint')}>
        <Segmented
          value={s.codec || 'h264'}
          onChange={(codec) => setS({ ...s, codec })}
          items={[
            { id: 'h264' as const, label: 'H.264' },
            { id: 'h265' as const, label: 'H.265' },
            { id: 'h265-hdr' as const, label: 'H.265 HDR' },
          ]}
        />
      </Field>
      {(s.codec === 'h265' || s.codec === 'h265-hdr') && !supportsH265() && <p className="error small">{t('stream.codecUnsupported')}</p>}
      {s.codec === 'h265-hdr' && !matchMedia('(dynamic-range: high)').matches && <p className="hint">{t('stream.hdrUnsupported')}</p>}
      <Toggle checked={s.control} onChange={(v) => setS({ ...s, control: v })} label={t('stream.control')} hint={t('stream.controlHint')} />
      <div className="row">
        <button className="btn primary" disabled={!dirty} onClick={save}>
          <Check size={16} /> {t('common.apply')}
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
      <hr />
      <LatencyTips status={status} />
      <hr />
      <div className="console-card">
        <Gamepad2 size={20} />
        <div>
          <strong>{status.console?.name}</strong>
          <span className="muted small mono">{status.console?.host}</span>
        </div>
        <span className="spacer" />
        <button
          className="btn ghost danger"
          onClick={() => {
            if (confirm(t('stream.unpairConfirm'))) api.unpair();
          }}
        >
          <Unlink size={15} /> {t('stream.unpair')}
        </button>
      </div>
    </div>
  );
}

/** Conseils calculés à partir des mesures réelles (ping, gigue, taille des images, écran). */
function LatencyTips({ status }: { status: Status }) {
  const { t } = useI18n();
  const hz = useRefreshRate();
  const p = status.stats.ping;
  const s = status.stats;
  const tips: string[] = [];
  if (p.samples && p.avgMs > 2.5) tips.push(t('tips.ethernet', { ms: p.avgMs.toFixed(1) }));
  if (p.samples && p.jitterMs > 1.5) tips.push(t('tips.jitter', { ms: p.jitterMs.toFixed(1) }));
  if (p.samples && p.avgMs > 2.5 && s.videoKbps > 22000) tips.push(t('tips.bitrate', { kb: s.frameKB.toFixed(0), mbps: (s.videoKbps / 1000).toFixed(0) }));
  if (s.framesLost > 0) tips.push(t('tips.loss', { n: s.framesLost }));
  if (hz < 100) tips.push(t('tips.refresh', { hz }));
  return (
    <div className="stack tips">
      <h3>{t('tips.title')}</h3>
      {tips.length === 0 ? <p className="ok-line">{t('tips.ok')}</p> : (
        <ul>
          {tips.map((tip) => (
            <li key={tip}>{tip}</li>
          ))}
        </ul>
      )}
      <p className="hint">{t('tips.keyframes')}</p>
    </div>
  );
}

// --- Image ---------------------------------------------------------------------

function ImageTab({ hdr }: { hdr: boolean }) {
  const { t } = useI18n();
  const s = useImageSettings();
  const [calibrating, setCalibrating] = useState(false);
  const set = (patch: Partial<ImageSettings>) => setImageSettings({ ...s, ...patch });
  const preset = (Object.keys(PRESETS) as Array<keyof typeof PRESETS>).find((k) => JSON.stringify(PRESETS[k]) === JSON.stringify(s));
  const sliders: Array<{ key: keyof ImageSettings; label: string; min: number; max: number; fmt: (v: number) => string }> = [
    { key: 'gamma', label: t('image.gamma'), min: 0.6, max: 1.4, fmt: (v) => `${Math.round((2 - v) * 100)} %` },
    { key: 'brightness', label: t('image.brightness'), min: 0.7, max: 1.3, fmt: (v) => `${Math.round(v * 100)} %` },
    { key: 'contrast', label: t('image.contrast'), min: 0.7, max: 1.4, fmt: (v) => `${Math.round(v * 100)} %` },
    { key: 'saturation', label: t('image.saturation'), min: 0, max: 2, fmt: (v) => `${Math.round(v * 100)} %` },
    { key: 'sharpness', label: t('image.sharpness'), min: 0, max: 1, fmt: (v) => `${Math.round(v * 100)} %` },
  ];
  return (
    <div className="stack">
      <p className="hint">{t('image.intro')}</p>
      <button className="btn primary" onClick={() => setCalibrating(true)}>
        <SunMedium size={16} /> {t('image.calibrate')}
      </button>
      <p className="hint">{t('image.calibrateHint')}</p>
      {hdr && <p className="hint warn-text">{t('image.hdrNote')}</p>}
      {calibrating && <Calibration onClose={() => setCalibrating(false)} />}
      <Field label={t('image.presets')}>
        <Segmented
          value={preset ?? ('custom' as never)}
          onChange={(k) => setImageSettings(PRESETS[k])}
          items={[
            { id: 'neutral' as const, label: t('image.neutral') },
            { id: 'vivid' as const, label: t('image.vivid') },
            { id: 'cinema' as const, label: t('image.cinema') },
          ]}
        />
      </Field>
      {sliders.map(({ key, label, min, max, fmt }) => (
        <Field key={key} label={`${label} · ${fmt(s[key])}`}>
          <input type="range" min={min} max={max} step={0.01} value={s[key]} onChange={(e) => set({ [key]: Number(e.target.value) })} onDoubleClick={() => set({ [key]: NEUTRAL[key] })} />
        </Field>
      ))}
      <div className="row">
        <button className="btn ghost" onClick={() => setImageSettings(NEUTRAL)}>
          <RotateCcw size={15} /> {t('image.reset')}
        </button>
      </div>
      <p className="hint">{t('image.quality')}</p>
    </div>
  );
}

// --- Clips -----------------------------------------------------------------------

const REPLAY_OPTIONS = [0, 30, 60, 120, 180, 300, 600];

function ClipsTab({ settings, replayMB, available }: { settings: StudioSettings; replayMB: number; available: number }) {
  const { t } = useI18n();
  const [s, setS] = useState(settings);
  const [msg, setMsg] = useState('');
  useEffect(() => setS(settings), [settings]);
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);

  const save = async () => {
    try {
      await api.studioSettings(s);
      setMsg(t('common.saved'));
    } catch (e) {
      setMsg((e as Error).message);
    }
  };

  return (
    <div className="stack">
      <Field label={t('clips.memory')} hint={t('clips.memoryHint', { s: Math.floor(available), mb: replayMB.toFixed(0) })}>
        <select value={s.replaySeconds} onChange={(e) => setS({ ...s, replaySeconds: Number(e.target.value) })}>
          {REPLAY_OPTIONS.map((v) => (
            <option key={v} value={v}>
              {v === 0 ? t('clips.off') : v < 60 ? `${v} s` : `${v / 60} min`}
            </option>
          ))}
        </select>
      </Field>
      <Toggle checked={s.clipVertical} onChange={(v) => setS({ ...s, clipVertical: v })} label={t('clips.vertical')} />
      <Toggle checked={s.keepAlive} onChange={(v) => setS({ ...s, keepAlive: v })} label={t('clips.keepAlive')} hint={t('clips.keepAliveHint')} />
      <hr />
      <Field label={t('clips.layout')}>
        <Segmented
          value={s.vertical.mode}
          onChange={(mode) => setS({ ...s, vertical: { ...s.vertical, mode } })}
          items={[
            { id: 'blur' as const, label: t('clips.blur') },
            { id: 'crop' as const, label: t('clips.crop') },
          ]}
        />
      </Field>
      {s.vertical.mode === 'crop' && (
        <Field label={`${t('clips.position')} · ${Math.round(s.vertical.position * 100)} %`}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={s.vertical.position}
            onChange={(e) => setS({ ...s, vertical: { ...s.vertical, position: Number(e.target.value) } })}
          />
        </Field>
      )}
      <VerticalPreview mode={s.vertical.mode} position={s.vertical.position} />
      <div className="row">
        <button className="btn primary" disabled={!dirty} onClick={save}>
          <Check size={16} /> {t('common.apply')}
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </div>
  );
}

/** Aperçu schématique : zone 16:9 de la PS5 et rendu 9:16. */
function VerticalPreview({ mode, position }: { mode: string; position: number }) {
  const { t } = useI18n();
  const cropWidth = (9 / 16) * (9 / 16) * 100;
  return (
    <div className="vpreview">
      <div className="frame169">
        {mode === 'crop' ? (
          <div className="cropzone" style={{ width: `${cropWidth}%`, left: `${position * (100 - cropWidth)}%` }} />
        ) : (
          <div className="cropzone full" />
        )}
      </div>
      <span className="arrow">→</span>
      <div className={`frame916 ${mode}`}>
        <div className="inner" />
      </div>
      <span className="muted small">{mode === 'crop' ? t('clips.previewCrop') : t('clips.previewBlur')}</span>
    </div>
  );
}

// --- Live --------------------------------------------------------------------------

const PLATFORMS: Record<LiveDestination['platform'], { label: string; server: string; bitrate: number; help: string }> = {
  twitch: { label: 'Twitch', server: 'rtmp://live.twitch.tv/app', bitrate: 6000, help: 'live.help.twitch' },
  youtube: { label: 'YouTube', server: 'rtmp://a.rtmp.youtube.com/live2', bitrate: 9000, help: 'live.help.youtube' },
  tiktok: { label: 'TikTok LIVE', server: '', bitrate: 6000, help: 'live.help.tiktok' },
  custom: { label: 'RTMP', server: 'rtmp://', bitrate: 6000, help: 'live.help.custom' },
};

const EMPTY: LiveDestination = { name: 'Twitch', platform: 'twitch', server: PLATFORMS.twitch.server, key: '', format: 'horizontal', reencode: true, bitrate: 6000 };

function LiveTab({ status }: { status: Status }) {
  const { t } = useI18n();
  const [dests, setDests] = useState<LiveDestination[]>([]);
  const [editing, setEditing] = useState<LiveDestination | null>(null);
  const [error, setError] = useState('');
  const liveById = new Map((status.studio?.live ?? []).map((l) => [l.id, l]));

  useEffect(() => {
    api.liveList().then((r) => setDests(r.destinations ?? []));
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="stack">
      {dests.length === 0 && !editing && (
        <div className="empty-state">
          <Radio size={28} strokeWidth={1.5} />
          <p>{t('live.empty')}</p>
        </div>
      )}
      {dests.map((d) => (
        <LiveRow
          key={d.id}
          dest={d}
          live={liveById.get(d.id!)}
          canStart={status.state === 'streaming'}
          onStart={() => run(() => api.liveStart(d.id!))}
          onStop={() => run(() => api.liveStop(d.id!))}
          onEdit={() => setEditing({ ...d, key: '' })}
        />
      ))}
      {editing ? (
        <DestinationForm
          initial={editing}
          onCancel={() => setEditing(null)}
          onSave={(d) =>
            run(async () => {
              setDests((await api.liveSave(d)).destinations ?? []);
              setEditing(null);
            })
          }
          onDelete={
            editing.id
              ? () =>
                  run(async () => {
                    setDests((await api.liveDelete(editing.id!)).destinations ?? []);
                    setEditing(null);
                  })
              : undefined
          }
        />
      ) : (
        <button className="btn" onClick={() => setEditing({ ...EMPTY })}>
          <Plus size={16} /> {t('live.add')}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </div>
  );
}

function LiveRow(props: { dest: LiveDestination; live?: LiveStatus; canStart: boolean; onStart: () => void; onStop: () => void; onEdit: () => void }) {
  const { t } = useI18n();
  const { dest, live } = props;
  const on = live?.state === 'live' || live?.state === 'connecting';
  const elapsed = useElapsed(on ? live?.startedAt : undefined);
  return (
    <div className={`live-row ${live?.state === 'live' ? 'on-air' : ''}`}>
      <div className="live-info">
        <strong>{dest.name}</strong>
        <span className="muted small">
          {PLATFORMS[dest.platform].label} · {dest.format === 'vertical' ? '9:16' : '16:9'} ·{' '}
          {dest.format === 'horizontal' && !dest.reencode ? t('live.copyMode') : `${dest.bitrate / 1000} Mbit/s`}
        </span>
        {live?.state === 'live' && (
          <span className="on-air-line mono">
            <span className="tally" /> {t('live.onAir')} {formatClock(elapsed)} · {(live.kbps / 1000).toFixed(1)} Mbit/s
          </span>
        )}
        {live?.state === 'connecting' && <span className="muted small">{t('live.connecting')}</span>}
        {live?.state === 'error' && <span className="error small">{live.error}</span>}
      </div>
      <div className="row">
        <button className="icon-btn plain" onClick={props.onEdit} aria-label={t('common.edit')}>
          <Pencil size={16} />
        </button>
        {on ? (
          <button className="btn danger" onClick={props.onStop}>
            {t('live.stop')}
          </button>
        ) : (
          <button className="btn primary" disabled={!props.canStart} onClick={props.onStart} title={props.canStart ? '' : t('live.needStream')}>
            <Radio size={15} /> {t('live.go')}
          </button>
        )}
      </div>
    </div>
  );
}

function DestinationForm(props: { initial: LiveDestination; onSave: (d: LiveDestination) => void; onCancel: () => void; onDelete?: () => void }) {
  const { t } = useI18n();
  const [d, setD] = useState(props.initial);
  const p = PLATFORMS[d.platform];
  const copy = d.format === 'horizontal' && !d.reencode;

  return (
    <div className="card stack">
      <Field label={t('live.platform')}>
        <Segmented
          value={d.platform}
          onChange={(platform) => setD({ ...d, platform, server: PLATFORMS[platform].server, bitrate: PLATFORMS[platform].bitrate, name: PLATFORMS[platform].label })}
          items={(Object.keys(PLATFORMS) as LiveDestination['platform'][]).map((k) => ({ id: k, label: PLATFORMS[k].label }))}
        />
      </Field>
      <Field label={t('live.name')}>
        <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
      </Field>
      <Field label={t('live.server')}>
        <input className="mono" value={d.server} onChange={(e) => setD({ ...d, server: e.target.value })} placeholder="rtmp://…" />
      </Field>
      <Field label={t('live.key')} hint={t(p.help as never)}>
        <input
          className="mono"
          type="password"
          value={d.key}
          onChange={(e) => setD({ ...d, key: e.target.value })}
          placeholder={props.initial.id ? t('live.keyUnchanged') : 'live_…'}
          autoComplete="off"
        />
      </Field>
      <Segmented
        value={d.format}
        onChange={(format) => setD({ ...d, format, reencode: format === 'vertical' ? true : d.reencode })}
        items={[
          { id: 'horizontal' as const, label: t('live.horizontal'), icon: MonitorPlay },
          { id: 'vertical' as const, label: t('live.vertical'), icon: Smartphone },
        ]}
      />
      {d.format === 'horizontal' && <Toggle checked={!d.reencode} onChange={(v) => setD({ ...d, reencode: !v })} label={t('live.copy')} />}
      {!copy && (
        <Field label={t('live.bitrate')} hint={t('live.encodeHint')}>
          <select value={d.bitrate} onChange={(e) => setD({ ...d, bitrate: Number(e.target.value) })}>
            {[3000, 4500, 6000, 8000, 9000, 12000, 15000].map((b) => (
              <option key={b} value={b}>
                {b / 1000} Mbit/s
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="row">
        <button className="btn primary" disabled={!d.name || !d.server || (!d.key && !props.initial.id)} onClick={() => props.onSave(d)}>
          <Check size={16} /> {t('common.save')}
        </button>
        <button className="btn ghost" onClick={props.onCancel}>
          {t('common.cancel')}
        </button>
        <span className="spacer" />
        {props.onDelete && (
          <button className="icon-btn plain tone-danger" onClick={props.onDelete} aria-label={t('common.delete')}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </div>
  );
}

// --- Liens -------------------------------------------------------------------------

function LinksTab() {
  const { t } = useI18n();
  const base = `${location.protocol}//${location.host}`;
  const [copied, setCopied] = useState('');
  const copy = async (url: string) => {
    await navigator.clipboard.writeText(url);
    setCopied(url);
    setTimeout(() => setCopied(''), 2000);
  };
  const rows: Array<{ icon: LucideIcon; label: string; url: string; hint: string }> = [
    { icon: Video, label: t('links.obs'), url: `${base}/#/obs`, hint: t('links.obsHint') },
    { icon: Smartphone, label: t('links.remote'), url: `${base}/#/telecommande`, hint: t('links.remoteHint') },
    { icon: Clapperboard, label: t('links.library'), url: `${base}/#/bibliotheque`, hint: t('links.libraryHint') },
  ];
  return (
    <div className="stack">
      {rows.map(({ icon: Icon, label, url, hint }) => (
        <div key={label} className="link-row">
          <Icon size={20} strokeWidth={1.6} />
          <div className="link-info">
            <strong>{label}</strong>
            <code>{url}</code>
            <small className="muted">{hint}</small>
          </div>
          <button className="btn ghost" onClick={() => copy(url)}>
            {copied === url ? <Check size={15} /> : <Copy size={15} />}
            {copied === url ? t('common.copied') : t('common.copy')}
          </button>
        </div>
      ))}
    </div>
  );
}

// --- App -----------------------------------------------------------------------------

function AppTab() {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="stack">
      <Field label={t('app.language')}>
        <Segmented
          value={lang}
          onChange={setLang}
          items={[
            { id: 'fr' as const, label: 'Français' },
            { id: 'en' as const, label: 'English' },
          ]}
        />
      </Field>
      <hr />
      <h3>{t('app.shortcuts')}</h3>
      <ShortcutList />
      <hr />
      <p className="muted small">{t('app.about')}</p>
    </div>
  );
}
