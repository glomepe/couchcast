package main

// Analyse minimale d'unités d'accès H.264 Annex-B (diagnostic et réparation du flux).

// splitNALs renvoie les NAL d'une unité d'accès, sans les codes de début.
func splitNALs(au []byte) [][]byte {
	var nals [][]byte
	start := -1
	for i := 0; i+2 < len(au); i++ {
		if au[i] == 0 && au[i+1] == 0 && au[i+2] == 1 {
			if start >= 0 {
				end := i
				if end > start && au[end-1] == 0 {
					end-- // code de début sur 4 octets
				}
				nals = append(nals, au[start:end])
			}
			start = i + 3
			i += 2
		}
	}
	if start >= 0 && start < len(au) {
		nals = append(nals, au[start:])
	}
	return nals
}

// bitReader lit des champs Exp-Golomb (en ignorant les octets d'émulation 0x000003).
type bitReader struct {
	data  []byte
	pos   int // en bits
	zeros int
}

func newBitReader(rbsp []byte) *bitReader {
	// Retire les octets d'émulation de prévention.
	out := make([]byte, 0, len(rbsp))
	zeros := 0
	for _, b := range rbsp {
		if zeros >= 2 && b == 3 {
			zeros = 0
			continue
		}
		if b == 0 {
			zeros++
		} else {
			zeros = 0
		}
		out = append(out, b)
	}
	return &bitReader{data: out}
}

func (r *bitReader) bit() (uint, bool) {
	if r.pos >= len(r.data)*8 {
		return 0, false
	}
	b := (r.data[r.pos/8] >> (7 - uint(r.pos%8))) & 1
	r.pos++
	return uint(b), true
}

func (r *bitReader) ue() (uint, bool) {
	zeros := 0
	for {
		b, ok := r.bit()
		if !ok || zeros > 31 {
			return 0, false
		}
		if b == 1 {
			break
		}
		zeros++
	}
	v := uint(1)
	for i := 0; i < zeros; i++ {
		b, ok := r.bit()
		if !ok {
			return 0, false
		}
		v = v<<1 | b
	}
	return v - 1, true
}

// sliceType renvoie le type de slice (0=P, 1=B, 2=I, 3=SP, 4=SI) d'un NAL de slice.
func sliceType(nal []byte) (uint, bool) {
	if len(nal) < 2 {
		return 0, false
	}
	r := newBitReader(nal[1:])
	if _, ok := r.ue(); !ok { // first_mb_in_slice
		return 0, false
	}
	t, ok := r.ue()
	return t % 5, ok
}

// videoCodec : codec du flux envoyé par la PS5.
type videoCodec int

const (
	codecH264 videoCodec = iota
	codecH265
)

func parseCodec(s string) videoCodec {
	if s == "h265" || s == "h265-hdr" {
		return codecH265
	}
	return codecH264
}

// nalType renvoie le type d'une NAL (5 bits en H.264, 6 bits en H.265).
func (c videoCodec) nalType(nal []byte) byte {
	if c == codecH265 {
		return (nal[0] >> 1) & 0x3f
	}
	return nal[0] & 0x1f
}

// isParamSet : VPS/SPS/PPS (H.265 : 32-34, H.264 : 7-8).
func (c videoCodec) isParamSet(t byte) bool {
	if c == codecH265 {
		return t >= 32 && t <= 34
	}
	return t == 7 || t == 8
}

// isDelimiter : délimiteur d'unité d'accès (inutile une fois en conteneur).
func (c videoCodec) isDelimiter(t byte) bool {
	if c == codecH265 {
		return t == 35
	}
	return t == 9
}

// isKeyframe : IDR (H.264 : 5 ; H.265 : IDR_W_RADL, IDR_N_LP, CRA).
func (c videoCodec) isKeyframe(t byte) bool {
	if c == codecH265 {
		return t >= 19 && t <= 21
	}
	return t == 5
}

type auInfo struct {
	idr, iSlice, params bool
	slices              bool
	types               []byte
}

func inspectAU(au []byte, codec videoCodec) auInfo {
	var info auInfo
	for _, nal := range splitNALs(au) {
		if len(nal) == 0 {
			continue
		}
		t := codec.nalType(nal)
		info.types = append(info.types, t)
		switch {
		case codec.isKeyframe(t):
			info.idr, info.slices = true, true
		case codec.isParamSet(t):
			info.params = true
		case codec == codecH264 && t == 1:
			info.slices = true
			if st, ok := sliceType(nal); ok && st == 2 {
				info.iSlice = true
			}
		case codec == codecH265 && t < 32:
			info.slices = true
		}
	}
	return info
}

// hvcC : configuration du décodeur H.265 (ISO 14496-15) à partir de VPS/SPS/PPS.
func hvcC(vps, sps, pps []byte) []byte {
	if len(sps) < 3 {
		return nil
	}
	rbsp := newBitReader(sps[2:]).data // sans octets d'émulation
	if len(rbsp) < 13 {
		return nil
	}
	maxSubLayers := (rbsp[0]>>1)&0x07 + 1
	nested := rbsp[0] & 0x01
	ptl := rbsp[1:13] // profile_tier_level général : 12 octets
	bitDepth := byte(8)
	if ptl[0]&0x1f == 2 { // profil Main 10 (HDR)
		bitDepth = 10
	}
	b := []byte{1}
	b = append(b, ptl[0])
	b = append(b, ptl[1:5]...)  // compatibilité de profil
	b = append(b, ptl[5:11]...) // contraintes
	b = append(b, ptl[11])      // niveau
	b = append(b, 0xF0, 0x00, 0xFC, 0xFD, 0xF8|(bitDepth-8), 0xF8|(bitDepth-8), 0, 0)
	b = append(b, maxSubLayers<<3|nested<<2|3) // longueur des NAL sur 4 octets
	b = append(b, 3)
	for _, n := range []struct {
		t   byte
		nal []byte
	}{{32, vps}, {33, sps}, {34, pps}} {
		b = append(b, 0x80|n.t, 0, 1, byte(len(n.nal)>>8), byte(len(n.nal)))
		b = append(b, n.nal...)
	}
	return b
}
