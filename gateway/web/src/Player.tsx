import { Activity, Clapperboard, Gamepad2, Keyboard, Maximize, Minimize, Power, Settings2, Volume2, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, formatClock, type Status } from './api';
import { Drawer, type DrawerTab } from './Drawer';
import { startGamepadLoop } from './gamepad';
import { useI18n } from './i18n';
import { useRefreshRate } from './display';
import { cssFilter, sharpenKernel, useImageSettings } from './image';
import { ShortcutHelp, useShortcuts, type ShortcutAction } from './shortcuts';
import { ClipButton, PingMeter, RecButton, clip, toggleRecording } from './studio/Controls';
import { IconButton, Kbd } from './ui';
import { connectViewer, type Viewer, type ViewerStats } from './webrtc';

export function Player({ status, obs = false }: { status: Status; obs?: boolean }) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;

  const [rtcState, setRtcState] = useState<RTCPeerConnectionState | 'off'>('off');
  const [rtcError, setRtcError] = useState('');
  const [muted, setMuted] = useState(!obs);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [idle, setIdle] = useState(false);
  const [fullscreen, setFullscreen] = useState(!!document.fullscreenElement);
  const [gamepadOn, setGamepadOn] = useState(false);
  const [gamepadName, setGamepadName] = useState<string | null>(null);
  const [viewerStats, setViewerStats] = useState<ViewerStats | null>(null);

  const image = useImageSettings();
  const sessionActive = ['streaming', 'connecting', 'waking', 'pin'].includes(status.state);

  const disconnect = useCallback(() => {
    viewerRef.current?.close();
    viewerRef.current = null;
    setRtcState('off');
  }, []);

  const connect = useCallback(async () => {
    if (viewerRef.current || !videoRef.current) return;
    setRtcError('');
    try {
      viewerRef.current = await connectViewer(videoRef.current, setRtcState);
    } catch (e) {
      setRtcError((e as Error).message);
      disconnect();
    }
  }, [disconnect]);

  // Lancement par l'utilisateur : le geste autorise aussi le son.
  const launch = useCallback(async () => {
    setMuted(false);
    await connect();
  }, [connect]);

  useEffect(() => {
    if (status.state === 'streaming' && !viewerRef.current) connect();
    if ((status.state === 'idle' || status.state === 'error') && viewerRef.current) disconnect();
  }, [status.state, connect, disconnect]);

  useEffect(() => {
    if (rtcState === 'failed') disconnect();
  }, [rtcState, disconnect]);

  useEffect(() => disconnect, [disconnect]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted;
  }, [muted]);

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  // Statistiques du navigateur.
  useEffect(() => {
    if (!showStats) return;
    const id = setInterval(async () => {
      if (viewerRef.current) setViewerStats(await viewerRef.current.stats());
    }, 1000);
    return () => clearInterval(id);
  }, [showStats]);

  // Manette → PS5.
  useEffect(() => {
    if (!gamepadOn || !status.settings.control) return;
    return startGamepadLoop((state) => {
      const dc = viewerRef.current?.gamepad;
      if (dc?.readyState === 'open') dc.send(state);
    }, setGamepadName);
  }, [gamepadOn, status.settings.control]);

  // Interface masquée après 2,5 s d'inactivité.
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2500);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('touchstart', wake);
    window.addEventListener('keydown', wake);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('touchstart', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
  }, []);

  const onShortcut = useCallback(
    (action: ShortcutAction) => {
      const st = statusRef.current;
      switch (action) {
        case 'launch':
          if (st.state === 'idle' || st.state === 'error' || (st.state === 'streaming' && !viewerRef.current)) launch();
          break;
        case 'fullscreen':
          toggleFullscreen();
          break;
        case 'mute':
          setMuted((m) => !m);
          break;
        case 'clip30':
          clip(30);
          break;
        case 'clip120':
          clip(120);
          break;
        case 'record':
          toggleRecording(st);
          break;
        case 'stats':
          setShowStats((s) => !s);
          break;
        case 'settings':
          setDrawer((d) => (d ? null : 'stream'));
          break;
        case 'library':
          location.hash = '#/bibliotheque';
          break;
        case 'image':
          setDrawer((d) => (d === 'image' ? null : 'image'));
          break;
        case 'gamepad':
          if (st.settings.control) setGamepadOn((g) => !g);
          break;
        case 'stop':
          api.stop();
          break;
        case 'help':
          setShowHelp((h) => !h);
          break;
        case 'close':
          setShowHelp(false);
          setDrawer(null);
          break;
      }
    },
    [launch, toggleFullscreen],
  );
  useShortcuts(obs ? noop : onShortcut);

  const showVideo = rtcState === 'connected' && status.state === 'streaming';
  const chromeHidden = idle && showVideo && !drawer && !showHelp;

  if (obs) {
    return (
      <div className="player obs">
        <video ref={videoRef} autoPlay playsInline className={showVideo ? '' : 'hidden'} />
      </div>
    );
  }

  return (
    <div className={`player ${chromeHidden ? 'chrome-hidden' : ''}`}>
      <svg width="0" height="0" aria-hidden style={{ position: 'absolute' }}>
        <filter id="cc-sharpen" colorInterpolationFilters="sRGB">
          <feConvolveMatrix order="3" kernelMatrix={sharpenKernel(image.sharpness)} preserveAlpha="true" />
        </filter>
      </svg>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={showVideo ? '' : 'hidden'}
        style={{ filter: cssFilter(image) }}
        onDoubleClick={toggleFullscreen}
      />

      {!showVideo && <Splash status={status} rtcState={rtcState} rtcError={rtcError} onLaunch={launch} />}
      {status.state === 'pin' && <PinPrompt error={status.error} />}

      <header className="toolbar">
        <div className="tb-group">
          <span className="brand" title="Couchcast">
            <span className="brand-mark" />
            <span className="brand-name">couchcast</span>
          </span>
          <StatePill status={status} />
          <span className="console-name">{status.console?.name}</span>
          <PingMeter status={status} />
        </div>

        <div className="tb-group center">
          <RecButton status={status} />
          <ClipButton status={status} />
        </div>

        <div className="tb-group right">
          {showVideo && (
            <IconButton
              icon={muted ? VolumeX : Volume2}
              label={muted ? t('bar.sound.on') : t('bar.sound.off')}
              shortcut="M"
              active={!muted}
              onClick={() => setMuted((m) => !m)}
            />
          )}
          {status.settings.control && (
            <IconButton
              icon={Gamepad2}
              label={gamepadOn ? gamepadName ?? t('bar.gamepad.none') : t('bar.gamepad')}
              shortcut="G"
              active={gamepadOn}
              onClick={() => setGamepadOn((g) => !g)}
            />
          )}
          <IconButton icon={Activity} label={t('bar.stats')} shortcut="T" active={showStats} onClick={() => setShowStats((s) => !s)} />
          <IconButton icon={Clapperboard} label={t('bar.library')} shortcut="L" onClick={() => (location.hash = '#/bibliotheque')} />
          <IconButton icon={Settings2} label={t('bar.settings')} shortcut="," active={!!drawer} onClick={() => setDrawer((d) => (d ? null : 'stream'))} />
          <IconButton icon={Keyboard} label={t('bar.shortcuts')} shortcut="?" onClick={() => setShowHelp(true)} />
          <IconButton icon={fullscreen ? Minimize : Maximize} label={t('bar.fullscreen')} shortcut="F" onClick={toggleFullscreen} />
          {sessionActive && <IconButton icon={Power} label={t('bar.stop')} shortcut="⇧ X" tone="danger" onClick={() => api.stop()} />}
        </div>
      </header>

      {showStats && <StatsHud status={status} viewer={viewerStats} />}
      {drawer && <Drawer status={status} tab={drawer} onTab={setDrawer} onClose={() => setDrawer(null)} />}
      {showHelp && <ShortcutHelp onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function noop() {}

function StatePill({ status }: { status: Status }) {
  const { t } = useI18n();
  return (
    <span className={`state-pill s-${status.state}`}>
      <span className="led" />
      {t(`state.${status.state}` as never)}
    </span>
  );
}

function Splash({ status, rtcState, rtcError, onLaunch }: { status: Status; rtcState: string; rtcError: string; onLaunch: () => void }) {
  const { t, lang } = useI18n();
  const ready = status.state === 'idle' || status.state === 'error';
  const text =
    status.state === 'waking'
      ? t('splash.waking')
      : status.state === 'connecting'
        ? t('splash.connecting')
        : rtcState === 'connecting' || rtcState === 'new'
          ? t('splash.player')
          : t('splash.waiting');

  return (
    <div className="splash">
      <div className="splash-grid" aria-hidden />
      {ready ? (
        <div className="splash-content">
          <p className="eyebrow">{status.console?.name ?? 'PS5'}</p>
          <button className="launch" onClick={onLaunch} aria-label={t('splash.launch')}>
            <span className="ring r1" />
            <span className="ring r2" />
            <span className="launch-core">
              <Power size={34} strokeWidth={1.6} />
            </span>
          </button>
          <h1>{t('splash.launch')}</h1>
          <p className="muted">
            {t('splash.hint')} <Kbd>{lang === 'en' ? 'Space' : 'Espace'}</Kbd>
          </p>
          {status.state === 'error' && status.error && <p className="error">{status.error}</p>}
          {rtcError && <p className="error">{rtcError}</p>}
        </div>
      ) : (
        <div className="splash-content">
          <div className="signal" aria-hidden>
            <i />
            <i />
            <i />
            <i />
            <i />
          </div>
          <p className="splash-status">{text}</p>
          {status.state === 'streaming' && rtcState === 'off' && (
            <button className="btn primary" onClick={onLaunch}>
              {t('splash.show')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PinPrompt({ error }: { error?: string }) {
  const { t } = useI18n();
  const [pin, setPin] = useState('');
  return (
    <div className="modal">
      <form
        className="sheet"
        onSubmit={(e) => {
          e.preventDefault();
          if (pin) api.pin(pin);
        }}
      >
        <h2>{t('pin.title')}</h2>
        <p className="muted">{t('pin.text')}</p>
        {error && <p className="error">{t('pin.wrong')}</p>}
        <div className="row">
          <input autoFocus inputMode="numeric" type="password" className="mono" value={pin} onChange={(e) => setPin(e.target.value)} />
          <button className="btn primary" disabled={!pin}>
            {t('common.validate')}
          </button>
        </div>
      </form>
    </div>
  );
}

function StatsHud({ status, viewer }: { status: Status; viewer: ViewerStats | null }) {
  const { t } = useI18n();
  const hz = useRefreshRate();
  const s = status.stats;
  const p = s.ping;
  const rows: Array<[string, string, string?]> = [
    [t('stats.profile'), status.profile ? `${status.profile.width}×${status.profile.height} · ${status.profile.fps} · ${status.profile.bitrate / 1000} Mb` : '—'],
    [t('stats.received'), `${s.fps.toFixed(0)} fps · ${(s.videoKbps / 1000).toFixed(1)} Mb/s`],
    [t('stats.ping'), p.samples ? `${p.avgMs.toFixed(1)} ms ±${p.jitterMs.toFixed(1)} · ${p.lossPct.toFixed(0)} %` : '—', p.avgMs > 8 ? 'warn' : undefined],
    [t('stats.lost'), String(s.framesLost), s.framesLost > 0 ? 'warn' : undefined],
    [t('stats.frame'), `${s.frameKB.toFixed(0)} / ${s.maxFrameKB.toFixed(0)} KB`],
  ];
  if (viewer) {
    rows.push(
      [t('stats.displayed'), `${viewer.width}×${viewer.height} · ${viewer.fps.toFixed(0)} fps · ${viewer.codec}`],
      [t('stats.buffer'), `${viewer.jitterBufferMs.toFixed(0)} ms`, viewer.jitterBufferMs > 30 ? 'warn' : undefined],
      [t('stats.decode'), `${viewer.decodeMs.toFixed(1)} ms`],
      [t('stats.pipeline'), `${viewer.pipelineMs.toFixed(0)} ms`],
      [t('stats.dropped'), `${viewer.packetsLost} / ${viewer.framesDropped}`],
      [t('stats.audioBuffer'), `${viewer.audioBufferMs.toFixed(0)} ms`],
    );
  }
  // Estimation de la latence mesurable : aller réseau + Couchcast + attente moyenne de l'écran.
  const net = p.samples ? p.avgMs / 2 : 0;
  const app = viewer ? viewer.pipelineMs : 0;
  const display = 1000 / hz / 2;
  const total = net + app + display;
  rows.push([t('stats.audio'), `${s.audioKbps.toFixed(0)} kb/s`], [t('stats.viewers'), String(s.viewers)], [t('stats.uptime'), formatClock(s.uptimeS)]);
  return (
    <aside className="stats-hud mono">
      {rows.map(([k, v, tone]) => (
        <div key={k} className="hud-row">
          <span>{k}</span>
          <span className={tone}>{v}</span>
        </div>
      ))}
      {viewer && (
        <div className="hud-latency">
          <div className="hud-title">{t('lat.title')}</div>
          <div className="lat-bar" aria-hidden>
            <i className="net" style={{ flex: net }} />
            <i className="app" style={{ flex: app }} />
            <i className="disp" style={{ flex: display }} />
          </div>
          <div className="hud-row"><span><b className="dot net" />{t('lat.network')}</span><span>{net.toFixed(1)} ms</span></div>
          <div className="hud-row"><span><b className="dot app" />{t('lat.app')}</span><span>{app.toFixed(1)} ms</span></div>
          <div className="hud-row"><span><b className="dot disp" />{t('lat.display', { hz })}</span><span>{display.toFixed(1)} ms</span></div>
          <div className="hud-row total"><span>{t('lat.total')}</span><span>≈ {total.toFixed(0)} ms</span></div>
          <div className="hud-note">{t('lat.ps5')}</div>
        </div>
      )}
    </aside>
  );
}
