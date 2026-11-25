package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
)

type State string

const (
	StateUnpaired   State = "unpaired"   // aucune console appairée
	StateIdle       State = "idle"       // prêt, pas de session Remote Play
	StateWaking     State = "waking"     // console en veille, réveil en cours
	StateConnecting State = "connecting" // session Remote Play en cours d'ouverture
	StatePin        State = "pin"        // la console demande le code de connexion du profil
	StateStreaming  State = "streaming"
	StateError      State = "error"
)

// Délai sans spectateur avant de fermer la session Remote Play (libère la console).
const idleTimeout = 60 * time.Second

type Stats struct {
	FPS        float64   `json:"fps"`
	VideoKbps  float64   `json:"videoKbps"`
	AudioKbps  float64   `json:"audioKbps"`
	FramesLost int64     `json:"framesLost"`
	FrameKB    float64   `json:"frameKB"`    // taille moyenne d'une image
	MaxFrameKB float64   `json:"maxFrameKB"` // plus grosse image (souvent une image clé)
	Viewers    int       `json:"viewers"`
	UptimeS    int64     `json:"uptimeS"`
	Ping       PingStats `json:"ping"`
}

type VideoProfile struct {
	Width   int `json:"width"`
	Height  int `json:"height"`
	FPS     int `json:"fps"`
	Bitrate int `json:"bitrate"`
}

type Status struct {
	State    State          `json:"state"`
	Error    string         `json:"error,omitempty"`
	Console  *ConsoleInfo   `json:"console,omitempty"`
	Settings StreamSettings `json:"settings"`
	Profile  *VideoProfile  `json:"profile,omitempty"`
	Stats    Stats          `json:"stats"`
	// Indique si un identifiant PSN est déjà mémorisé (utile pour l'appairage).
	HasAccountID bool          `json:"hasAccountId"`
	Studio       *StudioStatus `json:"studio,omitempty"`
	Lang         string        `json:"lang,omitempty"`
}

type ConsoleInfo struct {
	Host string `json:"host"`
	Name string `json:"name"`
	MAC  string `json:"mac,omitempty"`
}

type Manager struct {
	bridge Bridge
	config *ConfigStore

	Studio *Studio
	Pinger Pinger

	Video *webrtc.TrackLocalStaticSample
	Audio *webrtc.TrackLocalStaticSample

	mu              sync.Mutex
	state           State
	lastErr         string
	proc            *StreamProcess
	profile         *VideoProfile
	viewers         int
	noViewerAt      time.Time // début de la période sans spectateur
	startedAt       time.Time
	lastIDR         time.Time
	lastPeriodicIDR time.Time
	inUseRetries    int // tentatives après « Remote Play déjà utilisé »
	subs            map[chan Status]struct{}
	cancelWake      context.CancelFunc

	// Compteurs de la fenêtre courante (une seconde).
	statsMu      sync.Mutex
	winFrames    int
	winVideoB    int
	winAudioB    int
	winMaxFrame  int
	framesLost   int64
	lastStats    Stats
	lastVideoTs  time.Duration
	paramSets    []byte // dernier SPS/PPS reçu (Annex-B)
	audioFrameMs time.Duration
}

func NewManager(b Bridge, cfg *ConfigStore) (*Manager, error) {
	video, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000},
		"video", "ps5-video")
	if err != nil {
		return nil, err
	}
	audio, err := webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
		"audio", "ps5-audio")
	if err != nil {
		return nil, err
	}
	m := &Manager{bridge: b, config: cfg, Video: video, Audio: audio,
		subs: map[chan Status]struct{}{}, audioFrameMs: 10 * time.Millisecond}
	m.state = StateIdle
	if cfg.Get().Console == nil {
		m.state = StateUnpaired
	}
	go m.statsLoop()
	return m, nil
}

// --- État et abonnements ---------------------------------------------------

func (m *Manager) Status() Status {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.statusLocked()
}

func (m *Manager) statusLocked() Status {
	cfg := m.config.Get()
	s := Status{State: m.state, Error: m.lastErr, Settings: cfg.Settings, Profile: m.profile,
		HasAccountID: cfg.AccountID != "", Lang: cfg.Lang}
	if cfg.Console != nil {
		s.Console = &ConsoleInfo{Host: cfg.Console.Host, Name: cfg.Console.Name, MAC: cfg.Console.MAC}
	}
	m.statsMu.Lock()
	s.Stats = m.lastStats
	m.statsMu.Unlock()
	s.Stats.Viewers = m.viewers
	s.Stats.Ping = m.Pinger.Stats()
	if m.Studio != nil {
		st := m.Studio.Status()
		s.Studio = &st
	}
	return s
}

func (m *Manager) Subscribe() (chan Status, func()) {
	ch := make(chan Status, 4)
	m.mu.Lock()
	m.subs[ch] = struct{}{}
	st := m.statusLocked()
	m.mu.Unlock()
	ch <- st
	return ch, func() {
		m.mu.Lock()
		delete(m.subs, ch)
		m.mu.Unlock()
	}
}

func (m *Manager) broadcastLocked() {
	st := m.statusLocked()
	for ch := range m.subs {
		select {
		case ch <- st:
		default: // abonné lent : il recevra le prochain état
		}
	}
}

// Broadcast pousse l'état courant aux abonnés (appelé par le studio).
func (m *Manager) Broadcast() {
	m.mu.Lock()
	m.broadcastLocked()
	m.mu.Unlock()
}

func (m *Manager) setState(s State, errMsg string) {
	m.mu.Lock()
	m.state = s
	m.lastErr = errMsg
	m.broadcastLocked()
	m.mu.Unlock()
}

func (m *Manager) statsLoop() {
	t := time.NewTicker(time.Second)
	last := time.Now()
	for now := range t.C {
		if c := m.config.Get().Console; c != nil {
			m.Pinger.SetHost(c.Host)
		}
		secs := now.Sub(last).Seconds()
		last = now
		m.statsMu.Lock()
		st := Stats{
			FPS:        float64(m.winFrames) / secs,
			VideoKbps:  float64(m.winVideoB*8) / secs / 1000,
			AudioKbps:  float64(m.winAudioB*8) / secs / 1000,
			FramesLost: m.framesLost,
		}
		st.MaxFrameKB = float64(m.winMaxFrame) / 1024
		if m.winFrames > 0 {
			st.FrameKB = float64(m.winVideoB) / float64(m.winFrames) / 1024
		}
		m.winFrames, m.winVideoB, m.winAudioB, m.winMaxFrame = 0, 0, 0, 0
		m.statsMu.Unlock()

		m.mu.Lock()
		if !m.startedAt.IsZero() {
			st.UptimeS = int64(now.Sub(m.startedAt).Seconds())
		}
		proc, streaming := m.proc, m.state == StateStreaming
		idle := m.viewers == 0 && !m.noViewerAt.IsZero() && now.Sub(m.noViewerAt) > idleTimeout
		m.statsMu.Lock()
		m.lastStats = st
		m.statsMu.Unlock()
		m.broadcastLocked()
		m.mu.Unlock()

		if proc != nil && streaming && m.Studio != nil {
			// Images clés régulières : clips découpables et live compatible.
			if iv := m.Studio.KeyframeInterval(); iv > 0 && now.Sub(m.lastPeriodicIDR) >= iv {
				m.lastPeriodicIDR = now
				m.RequestKeyframe()
			}
			if idle && !m.Studio.Busy() {
				log.Printf("aucun spectateur depuis %s : fermeture de la session Remote Play", idleTimeout)
				m.mu.Lock()
				m.noViewerAt = time.Time{}
				m.mu.Unlock()
				go m.Stop()
			}
		}
	}
}

// --- Cycle de vie de la session Remote Play --------------------------------

// Start ouvre une session si aucune n'est active (réveille la console au besoin).
func (m *Manager) Start() error {
	m.mu.Lock()
	cfg := m.config.Get()
	if cfg.Console == nil {
		m.mu.Unlock()
		return errors.New("aucune console appairée")
	}
	switch m.state {
	case StateWaking, StateConnecting, StatePin, StateStreaming:
		m.mu.Unlock()
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	m.cancelWake = cancel
	m.state = StateConnecting
	m.lastErr = ""
	if m.viewers == 0 {
		m.noViewerAt = time.Now()
	}
	m.broadcastLocked()
	m.mu.Unlock()

	go m.connect(ctx, *cfg.Console, cfg.Settings)
	return nil
}

func (m *Manager) connect(ctx context.Context, c Console, s StreamSettings) {
	if err := m.ensureAwake(ctx, c); err != nil {
		if ctx.Err() == nil {
			m.setState(StateError, err.Error())
		}
		return
	}
	if ctx.Err() != nil {
		return
	}

	m.mu.Lock()
	m.state = StateConnecting
	m.broadcastLocked()
	m.mu.Unlock()

	proc, err := m.bridge.Stream(c, s, m)
	if err != nil {
		m.setState(StateError, "lancement du pont impossible : "+err.Error())
		return
	}
	m.mu.Lock()
	m.proc = proc
	m.startedAt = time.Now()
	m.mu.Unlock()
	m.statsMu.Lock()
	m.framesLost = 0
	m.lastVideoTs = 0
	m.paramSets = nil
	m.statsMu.Unlock()
}

// ensureAwake réveille la console si elle est en veille et attend qu'elle soit prête.
func (m *Manager) ensureAwake(ctx context.Context, c Console) error {
	hosts, err := m.bridge.Discover(ctx, c.Host, 2*time.Second)
	if err != nil {
		return fmt.Errorf("recherche de la console : %w", err)
	}
	if len(hosts) == 0 {
		return fmt.Errorf("la console ne répond pas sur %s (éteinte complètement, ou adresse IP changée ?)", c.Host)
	}
	if hosts[0].State == "ready" {
		return nil
	}

	m.setState(StateWaking, "")
	if err := m.bridge.Wakeup(ctx, c.Host, c.RegistKey); err != nil {
		return fmt.Errorf("réveil impossible : %w", err)
	}
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
		hosts, _ := m.bridge.Discover(ctx, c.Host, 1500*time.Millisecond)
		if len(hosts) > 0 && hosts[0].State == "ready" {
			// La console répond avant que le service Remote Play soit vraiment prêt.
			time.Sleep(3 * time.Second)
			return nil
		}
	}
	return errors.New("la console ne s'est pas réveillée à temps")
}

func (m *Manager) Stop() {
	m.mu.Lock()
	proc := m.proc
	if m.cancelWake != nil {
		m.cancelWake()
		m.cancelWake = nil
	}
	if proc == nil && m.state != StateUnpaired {
		m.state = StateIdle
		m.broadcastLocked()
	}
	m.mu.Unlock()
	if proc != nil {
		proc.Stop()
	}
}

func (m *Manager) SendPin(pin string) error {
	m.mu.Lock()
	proc := m.proc
	m.mu.Unlock()
	if proc == nil {
		return errors.New("aucune session en cours")
	}
	m.setState(StateConnecting, "")
	return proc.SendPin(pin)
}

func (m *Manager) SendController(state []byte) {
	m.mu.Lock()
	proc := m.proc
	m.mu.Unlock()
	if proc != nil && len(state) == 14 && m.config.Get().Settings.Control {
		_ = proc.SendController(state)
	}
}

// RequestKeyframe demande une image clé (nouveau spectateur, perte de paquets),
// au plus une fois toutes les 500 ms.
func (m *Manager) RequestKeyframe() {
	m.mu.Lock()
	proc := m.proc
	if proc == nil || time.Since(m.lastIDR) < 500*time.Millisecond {
		m.mu.Unlock()
		return
	}
	m.lastIDR = time.Now()
	m.mu.Unlock()
	_ = proc.RequestIDR()
}

// --- Spectateurs -----------------------------------------------------------

func (m *Manager) ViewerJoined() {
	m.mu.Lock()
	m.viewers++
	m.noViewerAt = time.Time{}
	m.broadcastLocked()
	m.mu.Unlock()
	m.RequestKeyframe()
}

func (m *Manager) ViewerLeft() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.viewers > 0 {
		m.viewers--
	}
	if m.viewers == 0 {
		m.noViewerAt = time.Now()
	}
	m.broadcastLocked()
}

// --- StreamHandler (appelé depuis le goroutine de lecture du pont) ---------

func (m *Manager) OnVideo(au []byte, ts time.Duration) {
	m.statsMu.Lock()
	dur := ts - m.lastVideoTs
	if m.lastVideoTs == 0 || dur <= 0 || dur > 200*time.Millisecond {
		dur = time.Second / 60
	}
	m.lastVideoTs = ts
	m.winFrames++
	m.winVideoB += len(au)
	m.winMaxFrame = max(m.winMaxFrame, len(au))
	m.statsMu.Unlock()

	m.mu.Lock()
	if m.state != StateStreaming {
		m.state = StateStreaming
		m.inUseRetries = 0
		m.lastErr = ""
		m.broadcastLocked()
	}
	m.mu.Unlock()

	// La PS5 n'envoie SPS/PPS qu'une fois, seuls, en début de session. Après une perte,
	// le décodeur matériel du navigateur est réinitialisé et ne peut repartir que sur
	// une IDR précédée de SPS/PPS : on les garde et on les recolle devant chaque IDR.
	info := inspectAU(au)
	if (info.sps || info.pps) && !info.idr && !info.iSlice && len(info.types) <= 3 {
		m.statsMu.Lock()
		m.paramSets = append([]byte(nil), au...)
		m.statsMu.Unlock()
		if m.Studio != nil {
			m.Studio.capture.SetParamSets(au, 0, 0)
		}
		return
	}
	if info.idr && !info.sps {
		m.statsMu.Lock()
		if m.paramSets != nil {
			au = append(append(make([]byte, 0, len(m.paramSets)+len(au)), m.paramSets...), au...)
		}
		m.statsMu.Unlock()
	}

	if err := m.Video.WriteSample(media.Sample{Data: au, Duration: dur}); err != nil {
		log.Printf("écriture vidéo : %v", err)
	}
	if m.Studio != nil {
		m.Studio.capture.OnVideo(au, ts.Milliseconds(), info.idr)
	}
}

func (m *Manager) OnAudio(pkt []byte, ts time.Duration) {
	if m.Studio != nil {
		m.Studio.capture.OnAudio(pkt, ts.Milliseconds())
	}
	m.statsMu.Lock()
	m.winAudioB += len(pkt)
	dur := m.audioFrameMs
	m.statsMu.Unlock()
	if err := m.Audio.WriteSample(media.Sample{Data: pkt, Duration: dur}); err != nil {
		log.Printf("écriture audio : %v", err)
	}
}

func (m *Manager) OnEvent(ev map[string]any) {
	num := func(k string) int {
		v, _ := ev[k].(float64)
		return int(v)
	}
	switch ev["type"] {
	case "video_profile":
		m.mu.Lock()
		m.profile = &VideoProfile{Width: num("width"), Height: num("height"), FPS: num("fps"), Bitrate: num("bitrate")}
		if m.Studio != nil {
			m.Studio.capture.SetSize(num("width"), num("height"))
		}
		m.broadcastLocked()
		m.mu.Unlock()
	case "audio_header":
		if rate, size := num("rate"), num("frame_size"); rate > 0 && size > 0 {
			m.statsMu.Lock()
			m.audioFrameMs = time.Duration(size) * time.Second / time.Duration(rate)
			m.statsMu.Unlock()
		}
	case "frames_lost":
		m.statsMu.Lock()
		m.framesLost += int64(num("count"))
		m.statsMu.Unlock()
	case "login_pin_request":
		msg := ""
		if ev["incorrect"] == true {
			msg = "code incorrect"
		}
		m.setState(StatePin, msg)
	case "connected":
		log.Printf("session Remote Play établie")
	case "quit":
		log.Printf("session terminée : %v %v", ev["reason"], ev["detail"])
		m.mu.Lock()
		m.lastErr = fmt.Sprint(ev["reason"])
		m.mu.Unlock()
	}
}

func (m *Manager) OnExit(err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.proc = nil
	m.startedAt = time.Time{}
	m.profile = nil
	stoppedByUs := m.cancelWake == nil
	if m.cancelWake != nil {
		m.cancelWake()
		m.cancelWake = nil
	}
	cfg := m.config.Get()
	switch {
	case err != nil:
		m.state = StateError
		m.lastErr = err.Error()
	case !stoppedByUs && strings.Contains(m.lastErr, "already in use") && m.inUseRetries < 4 && cfg.Console != nil:
		// Juste après un redémarrage, la PS5 met quelques secondes à libérer l'ancienne
		// session : on réessaie au lieu d'afficher une erreur.
		m.inUseRetries++
		log.Printf("Remote Play encore occupé, nouvel essai dans 3 s (%d/4)", m.inUseRetries)
		m.state = StateConnecting
		ctx, cancel := context.WithCancel(context.Background())
		m.cancelWake = cancel
		console, settings := *cfg.Console, cfg.Settings
		go func() {
			select {
			case <-ctx.Done():
			case <-time.After(3 * time.Second):
				m.connect(ctx, console, settings)
			}
		}()
	case !stoppedByUs && m.lastErr != "" && m.lastErr != "Stopped":
		// La console a mis fin à la session (ex. Remote Play déjà utilisé ailleurs).
		m.state = StateError
	default:
		m.state = StateIdle
		m.lastErr = ""
	}
	log.Printf("pont arrêté (état %s %s)", m.state, m.lastErr)
	if m.Studio != nil {
		go m.Studio.SessionEnded()
	}
	m.broadcastLocked()
}
