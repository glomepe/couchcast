import { useEffect, useState } from 'react';

export type State = 'unpaired' | 'idle' | 'waking' | 'connecting' | 'pin' | 'streaming' | 'error';

export interface StreamSettings {
  resolution: 360 | 540 | 720 | 1080;
  fps: 30 | 60;
  bitrate: number; // kbit/s, 0 = auto
  control: boolean; // la passerelle annonce une manette à la PS5 (déloge la manette locale)
}

export interface Status {
  state: State;
  error?: string;
  console?: { host: string; name: string; mac?: string };
  settings: StreamSettings;
  profile?: { width: number; height: number; fps: number; bitrate: number };
  stats: {
    fps: number;
    videoKbps: number;
    audioKbps: number;
    framesLost: number;
    viewers: number;
    uptimeS: number;
    ping: PingStats;
  };
  hasAccountId: boolean;
  studio?: StudioStatus;
  lang?: string;
}

export interface PingStats {
  lastMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  jitterMs: number;
  lossPct: number;
  samples: number;
}

export interface VerticalLayout {
  mode: 'blur' | 'crop';
  position: number; // 0 = gauche, 1 = droite (mode recadré)
}

export interface StudioSettings {
  replaySeconds: number;
  keepAlive: boolean;
  clipVertical: boolean;
  vertical: VerticalLayout;
}

export interface Job {
  id: number;
  kind: 'clip' | 'recording' | 'vertical';
  label: string;
  state: 'running' | 'done' | 'error';
  output?: string;
  error?: string;
  startedAt: string;
}

export interface LiveStatus {
  id: string;
  state: 'off' | 'connecting' | 'live' | 'error';
  error?: string;
  kbps: number;
  startedAt?: string;
}

export interface StudioStatus {
  settings: StudioSettings;
  recording: { active: boolean; startedAt?: string; bytes: number };
  replaySeconds: number;
  replayMB: number;
  live: LiveStatus[];
  jobs: Job[];
  mediaDir: string;
  ffmpeg: boolean;
  os: string;
}

export interface LiveDestination {
  id?: string;
  name: string;
  platform: 'twitch' | 'youtube' | 'tiktok' | 'custom';
  server: string;
  key: string;
  format: 'horizontal' | 'vertical';
  reencode: boolean;
  bitrate: number;
}

export interface MediaItem {
  name: string;
  kind: 'clip' | 'recording' | 'vertical';
  size: number;
  duration: number;
  createdAt: string;
  thumb: boolean;
}

export interface DiscoveredHost {
  host: string;
  name: string;
  type: string;
  id: string;
  ps5: boolean;
  state: 'ready' | 'standby' | 'unknown';
  running_app: string;
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export const api = {
  discover: () => call<{ hosts: DiscoveredHost[] }>('POST', '/api/discover'),
  loginUrl: () => call<{ url: string }>('GET', '/api/psn/login-url'),
  accountId: (input: { redirectUrl?: string; accountId?: string }) =>
    call<{ accountId: string }>('POST', '/api/psn/account-id', input),
  pair: (host: DiscoveredHost, pin: string) =>
    call<Status>('POST', '/api/pair', { host: host.host, name: host.name, id: host.id, pin }),
  unpair: () => call<Status>('DELETE', '/api/pair'),
  settings: (s: StreamSettings) => call<Status>('PUT', '/api/settings', s),
  start: () => call<Status>('POST', '/api/stream/start'),
  stop: () => call<Status>('POST', '/api/stream/stop'),
  pin: (pin: string) => call<{ ok: boolean }>('POST', '/api/stream/pin', { pin }),

  studioSettings: (s: StudioSettings) => call<Status>('PUT', '/api/studio/settings', s),
  clip: (seconds: number) => call<Job>('POST', '/api/clip', { seconds }),
  recordStart: () => call<{ ok: boolean }>('POST', '/api/record/start'),
  recordStop: () => call<Job>('POST', '/api/record/stop'),

  library: () => call<{ items: MediaItem[]; dir: string }>('GET', '/api/library'),
  deleteMedia: (name: string) => call<{ ok: boolean }>('DELETE', `/api/library/${encodeURIComponent(name)}`),
  vertical: (name: string, layout: VerticalLayout) =>
    call<Job>('POST', `/api/library/${encodeURIComponent(name)}/vertical`, layout),
  reveal: (name: string) => call<{ ok: boolean }>('POST', `/api/library/${encodeURIComponent(name)}/reveal`),

  liveList: () => call<{ destinations: LiveDestination[] }>('GET', '/api/live'),
  liveSave: (d: LiveDestination) => call<{ destinations: LiveDestination[] }>('POST', '/api/live', d),
  liveDelete: (id: string) => call<{ destinations: LiveDestination[] }>('DELETE', `/api/live/${id}`),
  liveStart: (id: string) => call<{ ok: boolean }>('POST', `/api/live/${id}/start`),
  liveStop: (id: string) => call<{ ok: boolean }>('POST', `/api/live/${id}/stop`),
};

export const mediaUrl = (name: string) => `/media/${encodeURIComponent(name)}`;
export const thumbUrl = (name: string) => `/media/${encodeURIComponent(name)}/thumb`;

export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function formatSize(bytes: number): string {
  const fr = document.documentElement.lang === 'fr';
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(1)} ${fr ? 'Go' : 'GB'}`;
  return `${(bytes / 1e6).toFixed(0)} ${fr ? 'Mo' : 'MB'}`;
}

/** État de la passerelle, poussé en continu par le serveur (Server-Sent Events). */
export function useStatus(): Status | null {
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => {
    const es = new EventSource('/api/events');
    es.onmessage = (e) => setStatus(JSON.parse(e.data));
    return () => es.close();
  }, []);
  return status;
}
