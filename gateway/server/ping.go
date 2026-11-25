package main

import (
	"math"
	"net"
	"os"
	"sync"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// Pinger mesure en continu la latence réseau Mac → PS5 (ICMP « datagram », sans
// droits administrateur sur macOS). C'est la seule partie de la latence totale
// qui dépend de l'installation : câble, Wi-Fi, placement de la box.

type PingStats struct {
	LastMs   float64 `json:"lastMs"`
	AvgMs    float64 `json:"avgMs"`
	MinMs    float64 `json:"minMs"`
	MaxMs    float64 `json:"maxMs"`
	JitterMs float64 `json:"jitterMs"` // écart moyen entre deux mesures successives
	LossPct  float64 `json:"lossPct"`
	Samples  int     `json:"samples"`
}

type Pinger struct {
	mu      sync.Mutex
	host    string
	window  []float64 // -1 = perdu
	stats   PingStats
	started bool
}

const pingWindow = 30 // ~15 s d'historique à 2 mesures par seconde

func (p *Pinger) SetHost(host string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if host != p.host {
		p.host, p.window, p.stats = host, nil, PingStats{}
	}
	if !p.started && host != "" {
		p.started = true
		go p.loop()
	}
}

func (p *Pinger) Stats() PingStats {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.stats
}

func (p *Pinger) loop() {
	conn, err := icmp.ListenPacket("udp4", "0.0.0.0")
	if err != nil {
		return // ping indisponible : les stats restent à zéro
	}
	defer conn.Close()
	id := os.Getpid() & 0xffff
	buf := make([]byte, 1500)
	for seq := 0; ; seq++ {
		p.mu.Lock()
		host := p.host
		p.mu.Unlock()
		dst, err := net.ResolveIPAddr("ip4", host)
		if err != nil {
			time.Sleep(time.Second)
			continue
		}
		msg := icmp.Message{Type: ipv4.ICMPTypeEcho, Body: &icmp.Echo{ID: id, Seq: seq & 0xffff, Data: []byte("couchcast")}}
		wb, _ := msg.Marshal(nil)
		start := time.Now()
		rtt := -1.0
		if _, err := conn.WriteTo(wb, &net.UDPAddr{IP: dst.IP}); err == nil {
			deadline := start.Add(400 * time.Millisecond)
			_ = conn.SetReadDeadline(deadline)
			for {
				n, _, err := conn.ReadFrom(buf)
				if err != nil {
					break
				}
				rm, err := icmp.ParseMessage(1, buf[:n])
				if err != nil || rm.Type != ipv4.ICMPTypeEchoReply {
					continue
				}
				if echo, ok := rm.Body.(*icmp.Echo); ok && echo.Seq == seq&0xffff {
					rtt = float64(time.Since(start).Microseconds()) / 1000
					break
				}
			}
		}
		p.record(rtt)
		time.Sleep(time.Until(start.Add(500 * time.Millisecond)))
	}
}

func (p *Pinger) record(rtt float64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.window = append(p.window, rtt)
	if len(p.window) > pingWindow {
		p.window = p.window[1:]
	}
	s := PingStats{MinMs: math.Inf(1), LastMs: rtt}
	var sum, jitter float64
	var ok, lost, pairs int
	prev := -1.0
	for _, v := range p.window {
		if v < 0 {
			lost++
			prev = -1
			continue
		}
		ok++
		sum += v
		s.MinMs = math.Min(s.MinMs, v)
		s.MaxMs = math.Max(s.MaxMs, v)
		if prev >= 0 {
			jitter += math.Abs(v - prev)
			pairs++
		}
		prev = v
	}
	if ok > 0 {
		s.AvgMs = sum / float64(ok)
	} else {
		s.MinMs = 0
	}
	if pairs > 0 {
		s.JitterMs = jitter / float64(pairs)
	}
	s.LossPct = 100 * float64(lost) / float64(len(p.window))
	s.Samples = len(p.window)
	p.stats = s
}
