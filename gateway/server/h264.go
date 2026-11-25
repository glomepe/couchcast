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

type auInfo struct {
	idr, iSlice, sps, pps bool
	types                 []byte
}

func inspectAU(au []byte) auInfo {
	var info auInfo
	for _, nal := range splitNALs(au) {
		if len(nal) == 0 {
			continue
		}
		t := nal[0] & 0x1f
		info.types = append(info.types, t)
		switch t {
		case 5:
			info.idr = true
		case 1:
			if st, ok := sliceType(nal); ok && st == 2 {
				info.iSlice = true
			}
		case 7:
			info.sps = true
		case 8:
			info.pps = true
		}
	}
	return info
}
