package main

import (
	"context"
	"log"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
	"time"
)

// Encodeur H.264 utilisé pour les exports verticaux et les lives réencodés.
// On essaie d'abord les encodeurs matériels, puis libx264 en dernier recours.

type videoEncoder struct {
	Name string
	// Options propres à l'encodeur, hors débit.
	args func(live bool) []string
}

var encoderCandidates = map[string][]videoEncoder{
	"darwin": {
		{"h264_videotoolbox", func(live bool) []string {
			a := []string{"-profile:v", "high", "-pix_fmt", "yuv420p"}
			if live {
				a = append(a, "-realtime", "1")
			}
			return a
		}},
	},
	"linux": {
		{"h264_nvenc", func(bool) []string { return []string{"-preset", "p4", "-pix_fmt", "yuv420p"} }},
	},
}

var softwareEncoder = videoEncoder{"libx264", func(live bool) []string {
	if live {
		return []string{"-preset", "veryfast", "-tune", "zerolatency", "-pix_fmt", "yuv420p"}
	}
	return []string{"-preset", "fast", "-pix_fmt", "yuv420p"}
}}

var (
	encoderOnce   sync.Once
	chosenEncoder videoEncoder
)

// pickEncoder teste réellement chaque candidat (encoder une image) : un encodeur
// présent dans ffmpeg peut être inutilisable faute de carte graphique compatible.
func pickEncoder() videoEncoder {
	encoderOnce.Do(func() {
		chosenEncoder = softwareEncoder
		for _, enc := range encoderCandidates[runtime.GOOS] {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := exec.CommandContext(ctx, ffmpegBin, "-hide_banner", "-v", "error", "-f", "lavfi",
				"-i", "color=c=black:s=256x256:d=0.1", "-frames:v", "1", "-c:v", enc.Name, "-f", "null", "-").Run()
			cancel()
			if err == nil {
				chosenEncoder = enc
				break
			}
		}
		log.Printf("encodeur vidéo : %s", chosenEncoder.Name)
	})
	return chosenEncoder
}

// encodeArgs : options ffmpeg pour encoder en H.264 à débit maîtrisé.
func encodeArgs(kbps int, live bool) []string {
	enc := pickEncoder()
	k := strconv.Itoa(kbps) + "k"
	args := []string{"-c:v", enc.Name}
	args = append(args, enc.args(live)...)
	args = append(args, "-b:v", k, "-maxrate", k, "-bufsize", strconv.Itoa(kbps*2)+"k")
	if live {
		args = append(args, "-g", "120")
	}
	return args
}
