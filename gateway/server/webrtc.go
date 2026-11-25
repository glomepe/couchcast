package main

import (
	"errors"
	"log"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

// Viewers reçoit les offres SDP des navigateurs et les relie aux pistes partagées.
type Viewers struct {
	api     *webrtc.API
	manager *Manager
}

func NewViewers(m *Manager) (*Viewers, error) {
	me := &webrtc.MediaEngine{}
	if err := me.RegisterDefaultCodecs(); err != nil {
		return nil, err
	}
	if err := me.RegisterHeaderExtension(webrtc.RTPHeaderExtensionCapability{URI: playoutDelayURI}, webrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}
	// Intercepteurs standard (NACK, rapports RTCP) + affichage immédiat.
	ir := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(me, ir); err != nil {
		return nil, err
	}
	ir.Add(playoutDelayFactory{})
	// Réseau local uniquement : pas de serveur STUN/TURN, candidats hôte seulement.
	se := webrtc.SettingEngine{}
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4, webrtc.NetworkTypeTCP4})
	api := webrtc.NewAPI(webrtc.WithMediaEngine(me), webrtc.WithSettingEngine(se), webrtc.WithInterceptorRegistry(ir))
	return &Viewers{api: api, manager: m}, nil
}

// Answer crée une connexion pour un spectateur et renvoie la réponse SDP complète
// (candidats ICE inclus : pas de trickle, une seule requête HTTP suffit).
func (v *Viewers) Answer(offerSDP string) (string, error) {
	pc, err := v.api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		return "", err
	}
	fail := func(err error) (string, error) {
		_ = pc.Close()
		return "", err
	}

	video := v.manager.VideoTrack(parseCodec(v.manager.config.Get().Settings.Codec))
	for _, track := range []webrtc.TrackLocal{video, v.manager.Audio} {
		sender, err := pc.AddTrack(track)
		if err != nil {
			return fail(err)
		}
		go v.readRTCP(sender)
	}

	// Manette : le navigateur envoie l'état (14 octets) à chaque changement.
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "gamepad" {
			return
		}
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			if !msg.IsString {
				v.manager.SendController(msg.Data)
			}
		})
	})

	joined := false
	pc.OnConnectionStateChange(func(s webrtc.PeerConnectionState) {
		switch s {
		case webrtc.PeerConnectionStateConnected:
			if !joined {
				joined = true
				v.manager.ViewerJoined()
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
			if joined {
				joined = false
				v.manager.ViewerLeft()
			}
			if s != webrtc.PeerConnectionStateClosed {
				_ = pc.Close()
			}
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return fail(err)
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return fail(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(answer); err != nil {
		return fail(err)
	}
	select {
	case <-gathered:
	case <-time.After(5 * time.Second):
		return fail(errors.New("collecte des candidats ICE trop longue"))
	}
	return pc.LocalDescription().SDP, nil
}

// readRTCP relaie les demandes d'image clé du navigateur (PLI/FIR) vers la console.
func (v *Viewers) readRTCP(sender *webrtc.RTPSender) {
	for {
		pkts, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		for _, p := range pkts {
			switch p.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				v.manager.RequestKeyframe()
			}
		}
	}
}

func init() {
	log.SetFlags(log.Ltime | log.Lmicroseconds)
}
