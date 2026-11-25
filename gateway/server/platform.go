package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// exe ajoute l'extension des exécutables du système (.exe sous Windows).
func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

// defaultMediaDir : ~/Movies/Couchcast sur macOS, ~/Videos/Couchcast ailleurs.
func defaultMediaDir() string {
	home, _ := os.UserHomeDir()
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Movies", "Couchcast")
	}
	return filepath.Join(home, "Videos", "Couchcast")
}

// revealFile montre le fichier dans le gestionnaire de fichiers du système.
func revealFile(path string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", "-R", path).Run()
	case "windows":
		// explorer renvoie un code non nul même quand tout va bien.
		_ = exec.Command("explorer", "/select,", path).Run()
		return nil
	default:
		return exec.Command("xdg-open", filepath.Dir(path)).Run()
	}
}

// Outils ffmpeg : fournis par l'option -ffmpeg, placés à côté du serveur
// (version téléchargeable) ou trouvés dans le PATH.
var ffmpegBin, ffprobeBin = "ffmpeg", "ffprobe"

func locateFFmpeg(dir string) {
	if dir == "" {
		if self, err := os.Executable(); err == nil {
			dir = filepath.Dir(self)
		}
	}
	for _, t := range []struct {
		name string
		dst  *string
	}{{"ffmpeg", &ffmpegBin}, {"ffprobe", &ffprobeBin}} {
		if p := filepath.Join(dir, exe(t.name)); dir != "" && fileExists(p) {
			*t.dst = p
		} else if p, err := exec.LookPath(t.name); err == nil {
			*t.dst = p
		}
	}
}

// ffmpegAvailable : clips, enregistrements et lives ont besoin de ffmpeg.
func ffmpegAvailable() bool {
	_, err := exec.LookPath(ffmpegBin)
	return err == nil
}

func fileExists(p string) bool {
	info, err := os.Stat(p)
	return err == nil && !info.IsDir()
}
