//go:build !windows

package main

import (
	"net"
	"os"
	"time"

	"golang.org/x/net/icmp"
	"golang.org/x/net/ipv4"
)

// Ping ICMP « datagram » : pas besoin de droits administrateur sur macOS et Linux.
type prober struct {
	conn *icmp.PacketConn
	id   int
	seq  int
	buf  []byte
}

func newProber() (*prober, error) {
	conn, err := icmp.ListenPacket("udp4", "0.0.0.0")
	if err != nil {
		return nil, err
	}
	return &prober{conn: conn, id: os.Getpid() & 0xffff, buf: make([]byte, 1500)}, nil
}

func (p *prober) Close() { p.conn.Close() }

// Ping renvoie le temps aller-retour en ms, ou -1 en cas de perte.
func (p *prober) Ping(ip net.IP, timeout time.Duration) float64 {
	p.seq = (p.seq + 1) & 0xffff
	msg := icmp.Message{Type: ipv4.ICMPTypeEcho, Body: &icmp.Echo{ID: p.id, Seq: p.seq, Data: []byte("couchcast")}}
	wb, _ := msg.Marshal(nil)
	start := time.Now()
	if _, err := p.conn.WriteTo(wb, &net.UDPAddr{IP: ip}); err != nil {
		return -1
	}
	_ = p.conn.SetReadDeadline(start.Add(timeout))
	for {
		n, _, err := p.conn.ReadFrom(p.buf)
		if err != nil {
			return -1
		}
		rm, err := icmp.ParseMessage(1, p.buf[:n])
		if err != nil || rm.Type != ipv4.ICMPTypeEchoReply {
			continue
		}
		if echo, ok := rm.Body.(*icmp.Echo); ok && echo.Seq == p.seq {
			return float64(time.Since(start).Microseconds()) / 1000
		}
	}
}
