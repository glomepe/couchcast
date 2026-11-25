package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"math"
)

// Écrivain Matroska minimal : une piste H.264 (copiée telle quelle depuis la PS5)
// et une piste Opus. Sert aux enregistrements, aux clips et à l'envoi vers ffmpeg
// (live), sans aucun réencodage. Les horodatages sont en millisecondes.

const (
	mkvTrackVideo = 1
	mkvTrackAudio = 2
	// Un cluster ne peut couvrir que ±32 s (horodatage relatif sur 16 bits).
	mkvMaxClusterMs = 5000
)

type MKVWriter struct {
	w            io.Writer
	cluster      bytes.Buffer
	clusterStart int64
	hasCluster   bool
	err          error
	codec        videoCodec
}

// paramSets : NAL de paramètres du flux vidéo (bruts, sans code de début).
type paramSets struct {
	vps, sps, pps []byte
}

// NewMKVWriter écrit l'en-tête (EBML, Segment de taille inconnue, Info, Tracks).
// params contient les NAL de paramètres bruts (H.264 : SPS, PPS ; H.265 : VPS, SPS, PPS).
func NewMKVWriter(w io.Writer, width, height int, codec videoCodec, params paramSets) (*MKVWriter, error) {
	m := &MKVWriter{w: w, codec: codec}
	codecID, private := "V_MPEG4/ISO/AVC", avcC(params.sps, params.pps)
	if codec == codecH265 {
		codecID, private = "V_MPEGH/ISO/HEVC", hvcC(params.vps, params.sps, params.pps)
	}
	var head bytes.Buffer
	head.Write(ebml(0x1A45DFA3,
		ebmlUint(0x4286, 1), ebmlUint(0x42F7, 1), ebmlUint(0x42F2, 4), ebmlUint(0x42F3, 8),
		ebmlString(0x4282, "matroska"), ebmlUint(0x4287, 4), ebmlUint(0x4285, 2)))
	head.Write(ebmlID(0x18538067))
	head.Write([]byte{0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF}) // taille inconnue
	head.Write(ebml(0x1549A966,
		ebmlUint(0x2AD7B1, 1000000), // TimestampScale : 1 ms
		ebmlString(0x4D80, "Couchcast"), ebmlString(0x5741, "Couchcast")))
	head.Write(ebml(0x1654AE6B,
		ebml(0xAE,
			ebmlUint(0xD7, mkvTrackVideo), ebmlUint(0x73C5, mkvTrackVideo), ebmlUint(0x83, 1),
			ebmlString(0x86, codecID), ebmlBytes(0x63A2, private),
			ebml(0xE0, ebmlUint(0xB0, uint64(width)), ebmlUint(0xBA, uint64(height)))),
		ebml(0xAE,
			ebmlUint(0xD7, mkvTrackAudio), ebmlUint(0x73C5, mkvTrackAudio), ebmlUint(0x83, 2),
			ebmlString(0x86, "A_OPUS"), ebmlBytes(0x63A2, opusHead()),
			ebmlUint(0x56BB, 80000000), // SeekPreRoll : 80 ms
			ebml(0xE1, ebmlFloat(0xB5, 48000), ebmlUint(0x9F, 2)))))
	if _, err := w.Write(head.Bytes()); err != nil {
		return nil, err
	}
	return m, nil
}

// WriteVideo ajoute une unité d'accès Annex-B (convertie en NAL préfixés par leur taille).
func (m *MKVWriter) WriteVideo(au []byte, ms int64, keyframe bool) error {
	if keyframe || !m.hasCluster || ms-m.clusterStart > mkvMaxClusterMs {
		m.flushCluster(ms)
	}
	var data bytes.Buffer
	for _, nal := range splitNALs(au) {
		t := m.codec.nalType(nal)
		if m.codec.isParamSet(t) || m.codec.isDelimiter(t) {
			continue // paramètres dans CodecPrivate, délimiteurs inutiles
		}
		var l [4]byte
		binary.BigEndian.PutUint32(l[:], uint32(len(nal)))
		data.Write(l[:])
		data.Write(nal)
	}
	return m.block(mkvTrackVideo, data.Bytes(), ms, keyframe)
}

func (m *MKVWriter) WriteAudio(pkt []byte, ms int64) error {
	if !m.hasCluster {
		m.flushCluster(ms)
	}
	if ms-m.clusterStart > mkvMaxClusterMs {
		m.flushCluster(ms)
	}
	return m.block(mkvTrackAudio, pkt, ms, true)
}

func (m *MKVWriter) block(track byte, data []byte, ms int64, key bool) error {
	rel := ms - m.clusterStart
	if rel < math.MinInt16 {
		rel = math.MinInt16 // horodatage en retard sur le cluster : on le colle au début
	}
	flags := byte(0)
	if key {
		flags = 0x80
	}
	payload := make([]byte, 0, 4+len(data))
	payload = append(payload, 0x80|track)
	payload = binary.BigEndian.AppendUint16(payload, uint16(int16(rel)))
	payload = append(payload, flags)
	payload = append(payload, data...)
	m.cluster.Write(ebmlBytes(0xA3, payload))
	return m.err
}

// flushCluster écrit le cluster en cours (taille connue) et en ouvre un nouveau.
func (m *MKVWriter) flushCluster(nextStart int64) {
	if m.hasCluster && m.err == nil {
		body := append(ebmlUint(0xE7, uint64(max(m.clusterStart, 0))), m.cluster.Bytes()...)
		_, m.err = m.w.Write(ebmlRaw(0x1F43B675, body))
	}
	m.cluster.Reset()
	m.clusterStart = nextStart
	m.hasCluster = true
}

// Close termine le dernier cluster (le Segment reste de taille inconnue, ce qui est valide).
func (m *MKVWriter) Close() error {
	m.flushCluster(m.clusterStart)
	return m.err
}

// --- encodage EBML ---------------------------------------------------------

func ebmlID(id uint32) []byte {
	switch {
	case id >= 0x1000000:
		return []byte{byte(id >> 24), byte(id >> 16), byte(id >> 8), byte(id)}
	case id >= 0x10000:
		return []byte{byte(id >> 16), byte(id >> 8), byte(id)}
	case id >= 0x100:
		return []byte{byte(id >> 8), byte(id)}
	default:
		return []byte{byte(id)}
	}
}

func ebmlSize(n uint64) []byte {
	for length := 1; length <= 8; length++ {
		if n < (uint64(1)<<(7*length))-1 {
			b := make([]byte, length)
			v := n | uint64(1)<<(7*length)
			for i := length - 1; i >= 0; i-- {
				b[i] = byte(v)
				v >>= 8
			}
			return b
		}
	}
	panic("élément EBML trop grand")
}

func ebmlRaw(id uint32, body []byte) []byte {
	out := append(ebmlID(id), ebmlSize(uint64(len(body)))...)
	return append(out, body...)
}

func ebml(id uint32, children ...[]byte) []byte {
	return ebmlRaw(id, bytes.Join(children, nil))
}

func ebmlBytes(id uint32, b []byte) []byte { return ebmlRaw(id, b) }

func ebmlString(id uint32, s string) []byte { return ebmlRaw(id, []byte(s)) }

func ebmlUint(id uint32, v uint64) []byte {
	b := binary.BigEndian.AppendUint64(nil, v)
	i := 0
	for i < 7 && b[i] == 0 {
		i++
	}
	return ebmlRaw(id, b[i:])
}

func ebmlFloat(id uint32, f float64) []byte {
	return ebmlRaw(id, binary.BigEndian.AppendUint64(nil, math.Float64bits(f)))
}

// avcC : configuration du décodeur H.264 (ISO 14496-15) à partir de SPS/PPS.
func avcC(sps, pps []byte) []byte {
	if len(sps) < 4 {
		return nil
	}
	b := []byte{1, sps[1], sps[2], sps[3], 0xFF, 0xE1}
	b = binary.BigEndian.AppendUint16(b, uint16(len(sps)))
	b = append(b, sps...)
	b = append(b, 1)
	b = binary.BigEndian.AppendUint16(b, uint16(len(pps)))
	return append(b, pps...)
}

// opusHead : en-tête d'identification Opus (RFC 7845), stéréo 48 kHz.
func opusHead() []byte {
	b := []byte("OpusHead")
	b = append(b, 1, 2)                            // version, canaux
	b = binary.LittleEndian.AppendUint16(b, 312)   // pre-skip
	b = binary.LittleEndian.AppendUint32(b, 48000) // fréquence d'origine
	b = binary.LittleEndian.AppendUint16(b, 0)     // gain
	return append(b, 0)                            // mapping family
}
