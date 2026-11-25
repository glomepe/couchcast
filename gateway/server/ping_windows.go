//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"net"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Sous Windows, l'ICMP sans droits administrateur passe par l'API IcmpSendEcho.
var (
	iphlpapi          = windows.NewLazySystemDLL("iphlpapi.dll")
	procIcmpCreate    = iphlpapi.NewProc("IcmpCreateFile")
	procIcmpClose     = iphlpapi.NewProc("IcmpCloseHandle")
	procIcmpSendEcho  = iphlpapi.NewProc("IcmpSendEcho")
	errIcmpUnavailble = errors.New("IcmpCreateFile indisponible")
)

type prober struct {
	handle uintptr
	reply  []byte
}

func newProber() (*prober, error) {
	h, _, _ := procIcmpCreate.Call()
	if h == 0 || h == uintptr(windows.InvalidHandle) {
		return nil, errIcmpUnavailble
	}
	return &prober{handle: h, reply: make([]byte, 256)}, nil
}

func (p *prober) Close() { procIcmpClose.Call(p.handle) }

func (p *prober) Ping(ip net.IP, timeout time.Duration) float64 {
	ip4 := ip.To4()
	if ip4 == nil {
		return -1
	}
	data := []byte("couchcast")
	addr := binary.LittleEndian.Uint32(ip4) // ordre réseau, tel quel en mémoire
	start := time.Now()
	n, _, _ := procIcmpSendEcho.Call(p.handle, uintptr(addr),
		uintptr(unsafe.Pointer(&data[0])), uintptr(len(data)), 0,
		uintptr(unsafe.Pointer(&p.reply[0])), uintptr(len(p.reply)), uintptr(timeout.Milliseconds()))
	elapsed := time.Since(start)
	// ICMP_ECHO_REPLY : Address (4 octets) puis Status (0 = succès).
	if n == 0 || binary.LittleEndian.Uint32(p.reply[4:8]) != 0 {
		return -1
	}
	return float64(elapsed.Microseconds()) / 1000
}
