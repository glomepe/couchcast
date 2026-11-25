package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Studio : clips (replay), enregistrement et lives, au-dessus de Capture et Library.

type RecordingStatus struct {
	Active    bool      `json:"active"`
	StartedAt time.Time `json:"startedAt,omitempty"`
	Bytes     int64     `json:"bytes"`
}

type LiveStatus struct {
	ID        string    `json:"id"`
	State     string    `json:"state"` // off | connecting | live | error
	Error     string    `json:"error,omitempty"`
	Kbps      float64   `json:"kbps"`
	StartedAt time.Time `json:"startedAt,omitempty"`
}

type StudioStatus struct {
	Settings      StudioSettings  `json:"settings"`
	Recording     RecordingStatus `json:"recording"`
	ReplaySeconds float64         `json:"replaySeconds"` // durée réellement disponible
	ReplayMB      float64         `json:"replayMB"`
	Live          []LiveStatus    `json:"live"`
	Jobs          []Job           `json:"jobs"`
	MediaDir      string          `json:"mediaDir"`
	FFmpeg        bool            `json:"ffmpeg"` // ffmpeg trouvé (sinon clips et lives impossibles)
	OS            string          `json:"os"`
}

type recording struct {
	sink      *sink
	file      *os.File
	counter   *countingWriter
	startedAt time.Time
}

type liveRun struct {
	dest      LiveDestination
	cmd       *exec.Cmd
	stdin     io.WriteCloser
	sink      *sink
	state     string
	err       string
	kbps      float64
	startedAt time.Time
	stopping  bool
	cleanup   sync.Once
}

type Studio struct {
	capture *Capture
	library *Library
	config  *ConfigStore
	notify  func()

	ffmpegOK bool

	mu    sync.Mutex
	rec   *recording
	lives map[string]*liveRun
	// Arrêts d'erreur conservés pour l'affichage (destination → message).
	liveErrors map[string]string
}

func NewStudio(cfg *ConfigStore, lib *Library, notify func()) *Studio {
	st := cfg.Get().Studio
	return &Studio{
		capture:    NewCapture(time.Duration(st.ReplaySeconds) * time.Second),
		library:    lib,
		config:     cfg,
		notify:     notify,
		lives:      map[string]*liveRun{},
		liveErrors: map[string]string{},
		ffmpegOK:   ffmpegAvailable(),
	}
}

// KeyframeInterval : fréquence des images clés à demander à la PS5 (0 = aucune).
// Une image clé est 3 à 5 fois plus lourde qu'une image normale : sur Wi-Fi elle met
// plus longtemps à arriver, d'où un petit pic de latence. On n'en demande donc que
// si c'est utile : 2 s pendant un live (Twitch exige ≤ 4 s), 6 s pour le replay
// (un clip démarre au plus 6 s avant le moment demandé), aucune sinon.
func (s *Studio) KeyframeInterval() time.Duration {
	s.mu.Lock()
	lives := len(s.lives)
	s.mu.Unlock()
	switch {
	case lives > 0:
		return 2 * time.Second
	case s.config.Get().Studio.ReplaySeconds > 0:
		return 6 * time.Second
	default:
		return 0
	}
}

// Busy : une sortie est active, la session ne doit pas être fermée faute de spectateur.
func (s *Studio) Busy() bool {
	return s.capture.SinkCount() > 0 || s.config.Get().Studio.KeepAlive
}

func (s *Studio) Status() StudioStatus {
	cfg := s.config.Get()
	secs, bytes := s.capture.ReplayInfo()
	st := StudioStatus{Settings: cfg.Studio, ReplaySeconds: secs, ReplayMB: float64(bytes) / 1e6,
		Jobs: s.library.Jobs(), MediaDir: s.library.Dir, Live: []LiveStatus{}, FFmpeg: s.ffmpegOK, OS: runtime.GOOS}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rec != nil {
		st.Recording = RecordingStatus{Active: true, StartedAt: s.rec.startedAt, Bytes: s.rec.counter.n.Load()}
	}
	for _, d := range cfg.Live {
		ls := LiveStatus{ID: d.ID, State: "off", Error: s.liveErrors[d.ID]}
		if ls.Error != "" {
			ls.State = "error"
		}
		if r := s.lives[d.ID]; r != nil {
			ls.State, ls.Error, ls.Kbps, ls.StartedAt = r.state, r.err, r.kbps, r.startedAt
		}
		st.Live = append(st.Live, ls)
	}
	return st
}

func (s *Studio) UpdateSettings(ns StudioSettings) error {
	if ns.ReplaySeconds < 0 || ns.ReplaySeconds > 600 {
		return errors.New("durée de replay invalide (0 à 600 s)")
	}
	if !ns.Vertical.Valid() {
		return errors.New("disposition verticale invalide")
	}
	if err := s.config.Update(func(c *Config) { c.Studio = ns }); err != nil {
		return err
	}
	s.capture.SetMaxAge(time.Duration(ns.ReplaySeconds) * time.Second)
	s.notify()
	return nil
}

// --- clips -------------------------------------------------------------------

func (s *Studio) Clip(seconds float64) (*Job, error) {
	if avail, _ := s.capture.ReplayInfo(); avail <= 0 {
		return nil, errors.New("rien en mémoire : le replay démarre avec le flux (et doit être activé dans le Studio)")
	}
	tmp, err := s.library.tempFile("clip-*.mkv")
	if err != nil {
		return nil, err
	}
	// La copie depuis la mémoire est immédiate : le clip couvre bien l'instant du clic.
	got, err := s.capture.WriteReplay(tmp, seconds)
	tmp.Close()
	if err != nil {
		os.Remove(tmp.Name())
		return nil, err
	}
	var vertical *VerticalLayout
	if st := s.config.Get().Studio; st.ClipVertical {
		vertical = &st.Vertical
	}
	label := fmt.Sprintf("Clip %s", formatDuration(got))
	return s.library.startJob("clip", label, func() (string, error) {
		return s.library.Finalize(tmp.Name(), timestampName("clip"), vertical)
	}), nil
}

func formatDuration(sec float64) string {
	d := time.Duration(sec * float64(time.Second)).Round(time.Second)
	if d < time.Minute {
		return fmt.Sprintf("%d s", int(d.Seconds()))
	}
	return fmt.Sprintf("%d min %02d s", int(d.Minutes()), int(d.Seconds())%60)
}

// --- enregistrement ----------------------------------------------------------

type countingWriter struct {
	w io.Writer
	n atomic.Int64
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	c.n.Add(int64(n))
	return n, err
}

func (s *Studio) StartRecording() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.rec != nil {
		return nil
	}
	f, err := s.library.tempFile("enregistrement-*.mkv")
	if err != nil {
		return err
	}
	cw := &countingWriter{w: f}
	sk, err := s.capture.AddSink(cw)
	if err != nil {
		f.Close()
		os.Remove(f.Name())
		return err
	}
	s.rec = &recording{sink: sk, file: f, counter: cw, startedAt: time.Now()}
	log.Printf("enregistrement démarré : %s", f.Name())
	go s.notify()
	return nil
}

func (s *Studio) StopRecording() (*Job, error) {
	s.mu.Lock()
	rec := s.rec
	s.rec = nil
	s.mu.Unlock()
	if rec == nil {
		return nil, errors.New("aucun enregistrement en cours")
	}
	werr := s.capture.RemoveSink(rec.sink)
	rec.file.Close()
	if werr != nil {
		log.Printf("enregistrement : %v", werr)
	}
	label := "Enregistrement " + formatDuration(time.Since(rec.startedAt).Seconds())
	return s.library.startJob("recording", label, func() (string, error) {
		return s.library.Finalize(rec.file.Name(), timestampName("enregistrement"), nil)
	}), nil
}

// SessionEnded : la PS5 a coupé, on clôt proprement l'enregistrement et les lives
// (une nouvelle session repart avec des horodatages remis à zéro).
func (s *Studio) SessionEnded() {
	if _, err := s.StopRecording(); err == nil {
		log.Printf("enregistrement clôturé (fin de session)")
	}
	s.mu.Lock()
	ids := make([]string, 0, len(s.lives))
	for id := range s.lives {
		ids = append(ids, id)
	}
	s.mu.Unlock()
	for _, id := range ids {
		s.StopLive(id)
	}
	s.capture.Reset()
}

// --- live ----------------------------------------------------------------------

var livePresets = map[string]string{
	"twitch":  "rtmp://live.twitch.tv/app",
	"youtube": "rtmp://a.rtmp.youtube.com/live2",
}

func (d LiveDestination) Validate() error {
	if strings.TrimSpace(d.Name) == "" {
		return errors.New("nom requis")
	}
	if !strings.HasPrefix(d.Server, "rtmp://") && !strings.HasPrefix(d.Server, "rtmps://") {
		return errors.New("l'adresse du serveur doit commencer par rtmp:// ou rtmps://")
	}
	if strings.TrimSpace(d.Key) == "" {
		return errors.New("clé de stream requise")
	}
	if d.Format != "horizontal" && d.Format != "vertical" {
		return errors.New("format invalide")
	}
	if d.Reencode && (d.Bitrate < 1000 || d.Bitrate > 50000) {
		return errors.New("débit invalide (1000 à 50000 kbit/s)")
	}
	return nil
}

func newID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Studio) liveArgs(d LiveDestination) []string {
	args := []string{"-hide_banner", "-nostdin", "-v", "error", "-stats_period", "2", "-progress", "pipe:1",
		"-fflags", "+genpts", "-f", "matroska", "-i", "pipe:0"}
	audio := []string{"-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-af", "aresample=async=1000"}
	encode := func(kbps int) []string { return encodeArgs(kbps, true) }
	bitrate := d.Bitrate
	if bitrate == 0 {
		bitrate = 6000
	}
	if d.Format == "vertical" {
		args = append(args, "-filter_complex", verticalFilter(s.config.Get().Studio.Vertical), "-map", "[v]", "-map", "0:a?")
		args = append(args, encode(bitrate)...)
	} else {
		args = append(args, "-map", "0:v", "-map", "0:a?")
		if d.Reencode {
			args = append(args, encode(bitrate)...)
		} else {
			args = append(args, "-c:v", "copy")
		}
	}
	args = append(args, audio...)
	return append(args, "-f", "flv", "-flvflags", "no_duration_filesize", strings.TrimRight(d.Server, "/")+"/"+d.Key)
}

func (s *Studio) StartLive(id string) error {
	var dest *LiveDestination
	for _, d := range s.config.Get().Live {
		if d.ID == id {
			d := d
			dest = &d
		}
	}
	if dest == nil {
		return errors.New("destination inconnue")
	}
	s.mu.Lock()
	if s.lives[id] != nil {
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()

	cmd := exec.Command(ffmpegBin, s.liveArgs(*dest)...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("ffmpeg : %w", err)
	}
	sk, err := s.capture.AddSink(stdin)
	if err != nil {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return err
	}
	run := &liveRun{dest: *dest, cmd: cmd, stdin: stdin, sink: sk, state: "connecting", startedAt: time.Now()}
	s.mu.Lock()
	s.lives[id] = run
	delete(s.liveErrors, id)
	s.mu.Unlock()
	s.notify()
	log.Printf("live %q démarré (%s)", dest.Name, dest.Format)

	var lastErr lastErrorLine
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := sc.Text()
			lastErr.mu.Lock()
			lastErr.line = line
			lastErr.mu.Unlock()
			log.Printf("live %q : %s", dest.Name, line)
		}
	}()
	go func() {
		// -progress : blocs clé=valeur, dont « bitrate=6012.3kbits/s ».
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			k, v, _ := strings.Cut(sc.Text(), "=")
			if k == "bitrate" {
				kbps, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(v), "kbits/s"), 64)
				s.mu.Lock()
				run.state, run.kbps = "live", kbps
				s.mu.Unlock()
				s.notify()
			}
		}
	}()
	go func() {
		err := cmd.Wait()
		s.releaseLive(run)
		s.mu.Lock()
		delete(s.lives, id)
		if !run.stopping {
			msg := lastErr.get()
			if msg == "le pont s'est arrêté" {
				msg = fmt.Sprint(err)
			}
			s.liveErrors[id] = "le live s'est arrêté : " + msg
		}
		s.mu.Unlock()
		log.Printf("live %q arrêté (%v)", dest.Name, err)
		s.notify()
	}()
	return nil
}

// releaseLive détache la sortie de la capture puis ferme l'entrée de ffmpeg.
func (s *Studio) releaseLive(run *liveRun) {
	run.cleanup.Do(func() {
		done := make(chan struct{})
		go func() {
			_ = s.capture.RemoveSink(run.sink)
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			_ = run.cmd.Process.Kill() // débloque une écriture coincée
			<-done
		}
		_ = run.stdin.Close()
	})
}

func (s *Studio) StopLive(id string) {
	s.mu.Lock()
	run := s.lives[id]
	if run != nil {
		run.stopping = true
	}
	delete(s.liveErrors, id)
	s.mu.Unlock()
	if run == nil {
		s.notify()
		return
	}
	s.releaseLive(run)
	go func() {
		time.Sleep(5 * time.Second)
		if run.cmd.ProcessState == nil {
			_ = run.cmd.Process.Kill()
		}
	}()
}

func (s *Studio) SaveDestination(d LiveDestination) (LiveDestination, error) {
	if d.Server == "" {
		d.Server = livePresets[d.Platform]
	}
	cfg := s.config.Get()
	if d.ID != "" && (strings.TrimSpace(d.Key) == "" || strings.HasPrefix(d.Key, "••••")) {
		// Clé non renvoyée par l'interface : on garde l'ancienne.
		for _, old := range cfg.Live {
			if old.ID == d.ID {
				d.Key = old.Key
			}
		}
	}
	if err := d.Validate(); err != nil {
		return d, err
	}
	err := s.config.Update(func(c *Config) {
		if d.ID == "" {
			d.ID = newID()
			c.Live = append(c.Live, d)
			return
		}
		for i := range c.Live {
			if c.Live[i].ID == d.ID {
				c.Live[i] = d
			}
		}
	})
	s.notify()
	return d, err
}

func (s *Studio) DeleteDestination(id string) error {
	s.StopLive(id)
	err := s.config.Update(func(c *Config) {
		out := c.Live[:0]
		for _, d := range c.Live {
			if d.ID != id {
				out = append(out, d)
			}
		}
		c.Live = out
	})
	s.notify()
	return err
}

// PublicDestinations : destinations sans la clé de stream (seule la fin est montrée).
func (s *Studio) PublicDestinations() []LiveDestination {
	list := s.config.Get().Live
	if list == nil {
		list = []LiveDestination{}
	}
	for i := range list {
		k := list[i].Key
		if len(k) > 4 {
			list[i].Key = "••••" + k[len(k)-4:]
		} else {
			list[i].Key = "••••"
		}
	}
	return list
}
