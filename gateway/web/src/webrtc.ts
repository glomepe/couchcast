// Connexion WebRTC de lecture : une offre SDP envoyée en HTTP, une réponse complète
// en retour (pas de trickle ICE : tout se passe sur le réseau local).

export interface ViewerStats {
  fps: number;
  kbps: number;
  width: number;
  height: number;
  packetsLost: number;
  framesDropped: number;
  jitterBufferMs: number; // tampon de gigue (valeur sur la dernière seconde)
  audioBufferMs: number; // tampon audio du navigateur
  decodeMs: number; // temps de décodage moyen d'une image
  pipelineMs: number; // de la réception du premier paquet à l'image décodée
  rttMs: number;
  codec: string;
}

export interface Viewer {
  pc: RTCPeerConnection;
  gamepad: RTCDataChannel;
  audio: RTCDataChannel | null; // son basse latence (sinon : piste audio WebRTC classique)
  close(): void;
  stats(): Promise<ViewerStats>;
}

export async function connectViewer(
  video: HTMLVideoElement,
  onState: (s: RTCPeerConnectionState) => void,
  opts: { lowLatencyAudio?: boolean } = {},
): Promise<Viewer> {
  const pc = new RTCPeerConnection();
  const stream = new MediaStream();
  video.srcObject = stream;

  for (const kind of ['video', 'audio'] as const) {
    const t = pc.addTransceiver(kind, { direction: 'recvonly' });
    lowLatency(t.receiver);
  }
  pc.ontrack = (e) => {
    // Son basse latence : la piste audio WebRTC n'est pas jouée (sinon on l'entend deux fois).
    if (e.track.kind === 'audio' && opts.lowLatencyAudio) return;
    stream.addTrack(e.track);
    lowLatency(e.receiver);
  };
  pc.onconnectionstatechange = () => onState(pc.connectionState);

  // Canal non fiable et non ordonné : seul le dernier état de la manette compte.
  const gamepad = pc.createDataChannel('gamepad', { ordered: false, maxRetransmits: 0 });
  // Son : un paquet perdu vaut mieux qu'un paquet en retard.
  const audio = opts.lowLatencyAudio ? pc.createDataChannel('audio', { ordered: false, maxRetransmits: 0 }) : null;
  if (audio) audio.binaryType = 'arraybuffer';

  const offer = await pc.createOffer();
  await pc.setLocalDescription({ type: 'offer', sdp: opusStereo(offer.sdp!) });
  await iceGatheringComplete(pc);
  const res = await fetch('/api/webrtc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/sdp' },
    body: pc.localDescription!.sdp,
  });
  if (!res.ok) {
    pc.close();
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  await pc.setRemoteDescription({ type: 'answer', sdp: opusStereo(await res.text()) });

  let last = { at: 0, bytes: 0, jb: 0, jbCount: 0, decode: 0, processing: 0, decoded: 0 };
  return {
    pc,
    gamepad,
    audio,
    close: () => pc.close(),
    async stats() {
      const report = await pc.getStats();
      const s: ViewerStats = { fps: 0, kbps: 0, width: 0, height: 0, packetsLost: 0, framesDropped: 0, jitterBufferMs: 0, audioBufferMs: 0, decodeMs: 0, pipelineMs: 0, rttMs: 0, codec: '' };
      const codecs = new Map<string, string>();
      report.forEach((r) => {
        if (r.type === 'codec') codecs.set(r.id, r.mimeType);
      });
      report.forEach((r) => {
        if (r.type === 'inbound-rtp' && r.kind === 'video') {
          s.fps = r.framesPerSecond ?? 0;
          s.width = r.frameWidth ?? 0;
          s.height = r.frameHeight ?? 0;
          s.packetsLost = r.packetsLost ?? 0;
          s.framesDropped = r.framesDropped ?? 0;
          s.codec = (codecs.get(r.codecId) ?? '').replace('video/', '');
          // Valeurs cumulées depuis le début : on calcule la différence sur la dernière période.
          const now = r.timestamp as number;
          const emitted = r.jitterBufferEmittedCount ?? 0;
          const decoded = r.framesDecoded ?? 0;
          if (last.at) {
            s.kbps = ((r.bytesReceived - last.bytes) * 8) / (now - last.at);
            if (emitted > last.jbCount) s.jitterBufferMs = ((r.jitterBufferDelay - last.jb) / (emitted - last.jbCount)) * 1000;
            if (decoded > last.decoded) {
              s.decodeMs = (((r.totalDecodeTime ?? 0) - last.decode) / (decoded - last.decoded)) * 1000;
              s.pipelineMs = (((r.totalProcessingDelay ?? 0) - last.processing) / (decoded - last.decoded)) * 1000;
            }
          }
          last = {
            at: now,
            bytes: r.bytesReceived,
            jb: r.jitterBufferDelay ?? 0,
            jbCount: emitted,
            decode: r.totalDecodeTime ?? 0,
            processing: r.totalProcessingDelay ?? 0,
            decoded,
          };
        }
        if (r.type === 'inbound-rtp' && r.kind === 'audio' && r.jitterBufferEmittedCount) {
          s.audioBufferMs = (r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000;
        }
        if (r.type === 'candidate-pair' && r.nominated && r.currentRoundTripTime !== undefined) {
          s.rttMs = r.currentRoundTripTime * 1000;
        }
      });
      return s;
    },
  };
}

/** Fonction de transfert des images reçues (« pq » ou « hlg » = HDR), lue sur une image décodée. */
export async function detectTransfer(stream: MediaStream): Promise<string | null> {
  const track = stream.getVideoTracks()[0];
  if (!track || !('MediaStreamTrackProcessor' in window)) return null;
  const clone = track.clone();
  try {
    const Processor = (window as unknown as { MediaStreamTrackProcessor: new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> } }).MediaStreamTrackProcessor;
    const reader = new Processor({ track: clone }).readable.getReader();
    const { value: frame } = await reader.read();
    const transfer = frame?.colorSpace.transfer ?? null;
    frame?.close();
    await reader.cancel();
    return transfer;
  } catch {
    return null;
  } finally {
    clone.stop();
  }
}

/** Cible du tampon du navigateur selon le lissage (ms ; null = adaptatif, borné par le serveur). */
export function applySmoothing(pc: RTCPeerConnection, level: string) {
  const target = level === 'latency' ? 0 : level === 'smooth' ? 40 : null;
  for (const r of pc.getReceivers()) {
    const rr = r as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number };
    try {
      if ('jitterBufferTarget' in r) rr.jitterBufferTarget = target;
      else rr.playoutDelayHint = (target ?? 0) / 1000;
    } catch {
      /* non supporté */
    }
  }
}

// Réduit au minimum le tampon de lecture (Chrome : jitterBufferTarget, ancien nom playoutDelayHint).
function lowLatency(receiver: RTCRtpReceiver) {
  const r = receiver as unknown as { jitterBufferTarget?: number | null; playoutDelayHint?: number };
  try {
    if ('jitterBufferTarget' in receiver) r.jitterBufferTarget = 0;
    else r.playoutDelayHint = 0;
  } catch {
    /* non supporté par ce navigateur */
  }
}

function iceGatheringComplete(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      if (pc.iceGatheringState === 'complete') {
        pc.removeEventListener('icegatheringstatechange', done);
        resolve();
      }
    };
    pc.addEventListener('icegatheringstatechange', done);
    setTimeout(resolve, 2000); // les candidats hôte suffisent en local
  });
}

// Sans « stereo=1 » dans les paramètres Opus, Chrome décode le son en mono : la stéréo très
// spatialisée des jeux, repliée en mono, sonne creuse, comme une réverbération.
function opusStereo(sdp: string): string {
  const pt = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp)?.[1];
  if (!pt) return sdp;
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params: string) =>
    /stereo=1/.test(params) ? line : `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1`,
  );
}
