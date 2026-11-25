package main

import (
	"strings"

	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// Extension RTP « playout-delay » (utilisée par le cloud gaming) : avec min = max = 0,
// Chrome affiche chaque image dès qu'elle est décodée, sans tampon de lissage.
const playoutDelayURI = "http://www.webrtc.org/experiments/rtp-hdrext/playout-delay"

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
	payload, err := rtp.PlayoutDelayExtension{MinDelay: 0, MaxDelay: 0}.Marshal()
	if err != nil {
		return writer
	}
	return interceptor.RTPWriterFunc(func(h *rtp.Header, b []byte, a interceptor.Attributes) (int, error) {
		_ = h.SetExtension(id, payload)
		return writer.Write(h, b, a)
	})
}
