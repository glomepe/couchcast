package main

import (
	"errors"
	"io"
	"log"
	"sync"
	"time"
)

// Capture reçoit le flux de la PS5 (H.264 + Opus, déjà compressés) et le distribue :
//   - à la mémoire de replay (les N dernières secondes, découpées en GOP) ;
//   - aux sorties actives (enregistrement, lives), chacune avec son propre MKVWriter.
// Rien n'est réencodé ici : un clip ou un enregistrement est une copie exacte du flux.

// Une image clé toutes les 2 s : clips découpables à la seconde près et live compatible
// avec les plateformes (Twitch exige un intervalle ≤ 4 s).
const keyframeInterval = 2 * time.Second

type mediaPacket struct {
	video bool
	key   bool
	ms    int64
	data  []byte
}

type gop struct {
	startMs int64
	packets []mediaPacket
	bytes   int
}

type Capture struct {
	mu        sync.Mutex
	sps, pps  []byte
	width     int
	height    int
	ring      []*gop
	ringBytes int
	maxAge    time.Duration
	lastMs    int64
	sinks     map[*sink]struct{}
}

func NewCapture(maxAge time.Duration) *Capture {
	return &Capture{maxAge: maxAge, sinks: map[*sink]struct{}{}}
}

func (c *Capture) SetMaxAge(d time.Duration) {
	c.mu.Lock()
	c.maxAge = d
	c.pruneLocked()
	c.mu.Unlock()
}

// Reset vide la mémoire de replay (nouvelle session : horodatages repartant de zéro).
func (c *Capture) Reset() {
	c.mu.Lock()
	c.ring, c.ringBytes, c.lastMs = nil, 0, 0
	c.mu.Unlock()
}

func (c *Capture) SetParamSets(au []byte, width, height int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, nal := range splitNALs(au) {
		switch nal[0] & 0x1f {
		case 7:
			c.sps = append([]byte(nil), nal...)
		case 8:
			c.pps = append([]byte(nil), nal...)
		}
	}
	if width > 0 {
		c.width, c.height = width, height
	}
}

func (c *Capture) SetSize(width, height int) {
	c.mu.Lock()
	c.width, c.height = width, height
	c.mu.Unlock()
}

func (c *Capture) OnVideo(au []byte, ms int64, key bool) {
	p := mediaPacket{video: true, key: key, ms: ms, data: au}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastMs = ms
	if key {
		c.ring = append(c.ring, &gop{startMs: ms})
		c.pruneLocked()
	}
	c.appendLocked(p)
	c.fanOutLocked(p)
}

func (c *Capture) OnAudio(pkt []byte, ms int64) {
	p := mediaPacket{ms: ms, data: pkt}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.appendLocked(p)
	c.fanOutLocked(p)
}

func (c *Capture) appendLocked(p mediaPacket) {
	if len(c.ring) == 0 || c.maxAge <= 0 {
		return // le replay commence à la première image clé
	}
	g := c.ring[len(c.ring)-1]
	g.packets = append(g.packets, p)
	g.bytes += len(p.data)
	c.ringBytes += len(p.data)
}

func (c *Capture) pruneLocked() {
	if c.maxAge <= 0 {
		c.ring, c.ringBytes = nil, 0
		return
	}
	limit := c.lastMs - c.maxAge.Milliseconds()
	// On garde le GOP qui chevauche la limite pour pouvoir couvrir toute la durée.
	for len(c.ring) > 1 && c.ring[1].startMs <= limit {
		c.ringBytes -= c.ring[0].bytes
		c.ring = c.ring[1:]
	}
}

// ReplayInfo : durée réellement disponible et mémoire occupée.
func (c *Capture) ReplayInfo() (seconds float64, bytes int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.ring) == 0 {
		return 0, 0
	}
	return float64(c.lastMs-c.ring[0].startMs) / 1000, c.ringBytes
}

var errNoVideo = errors.New("aucune image reçue de la PS5 pour l'instant")

// WriteReplay écrit dans w les `seconds` dernières secondes (à partir d'une image clé).
func (c *Capture) WriteReplay(w io.Writer, seconds float64) (float64, error) {
	c.mu.Lock()
	if len(c.ring) == 0 || c.sps == nil {
		c.mu.Unlock()
		return 0, errNoVideo
	}
	from := c.lastMs - int64(seconds*1000)
	start := 0
	for i, g := range c.ring {
		if g.startMs <= from {
			start = i
		}
	}
	var packets []mediaPacket
	for _, g := range c.ring[start:] {
		packets = append(packets, g.packets...)
	}
	origin := c.ring[start].startMs
	got := float64(c.lastMs-origin) / 1000
	sps, pps, width, height := c.sps, c.pps, c.width, c.height
	c.mu.Unlock()

	mw, err := NewMKVWriter(w, width, height, sps, pps)
	if err != nil {
		return 0, err
	}
	for _, p := range packets {
		if p.video {
			err = mw.WriteVideo(p.data, p.ms-origin, p.key)
		} else if p.ms >= origin {
			err = mw.WriteAudio(p.data, p.ms-origin)
		}
		if err != nil {
			return 0, err
		}
	}
	return got, mw.Close()
}

// --- Sorties en continu (enregistrement, live) -----------------------------

type sink struct {
	ch      chan mediaPacket
	started bool  // a reçu sa première image clé
	origin  int64 // horodatage de cette image clé
	lagging bool  // tampon plein : on saute jusqu'à la prochaine image clé
	done    chan error
}

// AddSink ouvre une sortie : les paquets sont écrits en MKV dans w, à partir de la
// prochaine image clé, par un goroutine dédié (une sortie lente ne bloque pas le flux).
// Le canal renvoyé reçoit l'erreur finale quand la sortie s'arrête.
func (c *Capture) AddSink(w io.Writer) (*sink, error) {
	c.mu.Lock()
	if c.sps == nil {
		c.mu.Unlock()
		return nil, errNoVideo
	}
	s := &sink{ch: make(chan mediaPacket, 4096), done: make(chan error, 1)}
	sps, pps, width, height := c.sps, c.pps, c.width, c.height
	c.sinks[s] = struct{}{}
	c.mu.Unlock()

	go func() {
		mw, err := NewMKVWriter(w, width, height, sps, pps)
		for p := range s.ch {
			if err != nil {
				continue // on vide le canal jusqu'à la fermeture
			}
			if p.video {
				err = mw.WriteVideo(p.data, p.ms, p.key)
			} else {
				err = mw.WriteAudio(p.data, p.ms)
			}
		}
		if err == nil {
			err = mw.Close()
		}
		s.done <- err
	}()
	return s, nil
}

// RemoveSink ferme la sortie et attend la fin de l'écriture.
func (c *Capture) RemoveSink(s *sink) error {
	c.mu.Lock()
	if _, ok := c.sinks[s]; ok {
		delete(c.sinks, s)
		close(s.ch)
	}
	c.mu.Unlock()
	return <-s.done
}

func (c *Capture) fanOutLocked(p mediaPacket) {
	for s := range c.sinks {
		if !s.started {
			if !p.key {
				continue
			}
			s.started, s.origin = true, p.ms
		}
		if s.lagging {
			if !p.key {
				continue
			}
			s.lagging = false
		}
		if p.ms < s.origin {
			continue
		}
		q := p
		q.ms -= s.origin
		select {
		case s.ch <- q:
		default:
			s.lagging = true
			log.Printf("sortie en retard : images sautées jusqu'à la prochaine image clé")
		}
	}
}

func (c *Capture) SinkCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.sinks)
}
