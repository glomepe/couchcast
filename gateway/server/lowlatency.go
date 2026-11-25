package main

import (
	"strings"
	"sync/atomic"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// Extension RTP « playout-delay » (utilisée par le cloud gaming). Elle borne le tampon
// de lecture du navigateur (unités de 10 ms) : min = max = 0 affiche chaque image dès
// qu'elle est décodée (latence minimale, mais la gigue du Wi-Fi se voit) ; une borne
// haute de quelques dizaines de ms permet à Chrome de lisser la cadence.
const playoutDelayURI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"

// playoutDelay : bornes courantes en ms (min << 16 | max), modifiables en direct.
var playoutDelay atomic.Uint32

// SetSmoothing applique le niveau de lissage à tous les spectateurs, immédiatement.
func SetSmoothing(level string) {
	minMs, maxMs := 10, 40 // équilibré (par défaut) : une petite marge pour une cadence régulière
	switch level {
	case "latency":
		minMs, maxMs = 0, 0
	case "smooth":
		minMs, maxMs = 20, 60
	}
	playoutDelay.Store(uint32(minMs)<<16 | uint32(maxMs))
}

func init() { SetSmoothing("balanced") }

type playoutDelayFactory struct{}

func (playoutDelayFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &playoutDelayInterceptor{}, nil
}

type playoutDelayInterceptor struct {
	interceptor.NoOp
}

func (*playoutDelayInterceptor) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	var id uint8
	for _, e := range info.RTPHeaderExtensions {
		if e.URI == playoutDelayURI {
			id = uint8(e.ID)
		}
	}
	if id == 0 || !strings.HasPrefix(strings.ToLower(info.MimeType), "video/") {
		return writer // le navigateur n'a pas négocié l'extension
	}
	return interceptor.RTPWriterFunc(func(h *rtp.Header, b []byte, a interceptor.Attributes) (int, error) {
		v := playoutDelay.Load()
		ext := rtp.PlayoutDelayExtension{MinDelay: uint16(v>>16) / 10, MaxDelay: uint16(v&0xffff) / 10}
		if payload, err := ext.Marshal(); err == nil {
			_ = h.SetExtension(id, payload)
		}
		return writer.Write(h, b, a)
	})
}
