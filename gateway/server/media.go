package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Bibliothèque : clips et enregistrements en MP4 dans un dossier (par défaut
// ~/Movies/Couchcast), plus les traitements ffmpeg (conversion, vertical,
// miniatures) exécutés en tâche de fond.

type VerticalLayout struct {
	Mode     string  `json:"mode"`     // "crop" (recadré) | "blur" (image entière sur fond flou)
	Position float64 `json:"position"` // recadrage horizontal : 0 = gauche, 0.5 = centre, 1 = droite
}

func (v VerticalLayout) Valid() bool {
	return (v.Mode == "crop" || v.Mode == "blur") && v.Position >= 0 && v.Position <= 1
}

// verticalFilter produit un graphe ffmpeg 1080×1920 dont la sortie s'appelle [v].
func verticalFilter(v VerticalLayout) string {
	if v.Mode == "blur" {
		return "[0:v]split=2[a][b];" +
			"[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=40[bg];" +
			"[b]scale=1080:-2:flags=lanczos[fg];" +
			"[bg][fg]overlay=0:(H-h)/2,setsar=1[v]"
	}
	return fmt.Sprintf("[0:v]crop=ih*9/16:ih:(iw-ih*9/16)*%.3f:0,scale=1080:1920:flags=lanczos,setsar=1[v]", v.Position)
}

type MediaItem struct {
	Name      string    `json:"name"`
	Kind      string    `json:"kind"` // clip | recording | vertical
	Size      int64     `json:"size"`
	Duration  float64   `json:"duration"`
	CreatedAt time.Time `json:"createdAt"`
	Thumb     bool      `json:"thumb"`
}

type Job struct {
	ID        int       `json:"id"`
	Kind      string    `json:"kind"` // clip | recording | vertical
	Label     string    `json:"label"`
	State     string    `json:"state"` // running | done | error
	Output    string    `json:"output,omitempty"`
	Error     string    `json:"error,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

type Library struct {
	Dir string

	mu     sync.Mutex
	jobs   []*Job
	nextID int
	notify func()
}

func NewLibrary(dir string, notify func()) (*Library, error) {
	if err := os.MkdirAll(filepath.Join(dir, ".thumbs"), 0o755); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Join(dir, ".tmp"), 0o755); err != nil {
		return nil, err
	}
	return &Library{Dir: dir, notify: notify}, nil
}

func (l *Library) tempFile(pattern string) (*os.File, error) {
	return os.CreateTemp(filepath.Join(l.Dir, ".tmp"), pattern)
}

// Path valide un nom de fichier de la bibliothèque (pas de chemin, pas de fichier caché).
func (l *Library) Path(name string) (string, error) {
	if name == "" || name != filepath.Base(name) || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".mp4") {
		return "", errors.New("nom de fichier invalide")
	}
	p := filepath.Join(l.Dir, name)
	if _, err := os.Stat(p); err != nil {
		return "", errors.New("fichier introuvable")
	}
	return p, nil
}

func (l *Library) List() []MediaItem {
	entries, _ := os.ReadDir(l.Dir)
	items := []MediaItem{}
	for _, e := range entries {
		name := e.Name()
		if e.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".mp4") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		kind := "clip"
		switch {
		case strings.Contains(name, "-vertical"):
			kind = "vertical"
		case strings.HasPrefix(name, "enregistrement"):
			kind = "recording"
		}
		_, thumbErr := os.Stat(l.thumbPath(name))
		items = append(items, MediaItem{Name: name, Kind: kind, Size: info.Size(), CreatedAt: info.ModTime(),
			Duration: l.duration(filepath.Join(l.Dir, name)), Thumb: thumbErr == nil})
	}
	sort.Slice(items, func(i, j int) bool { return items[i].CreatedAt.After(items[j].CreatedAt) })
	return items
}

func (l *Library) thumbPath(name string) string {
	return filepath.Join(l.Dir, ".thumbs", strings.TrimSuffix(name, ".mp4")+".jpg")
}

func (l *Library) ThumbPath(name string) (string, error) {
	if _, err := l.Path(name); err != nil {
		return "", err
	}
	return l.thumbPath(name), nil
}

func (l *Library) Delete(name string) error {
	p, err := l.Path(name)
	if err != nil {
		return err
	}
	_ = os.Remove(l.thumbPath(name))
	return os.Remove(p)
}

// durées mises en cache : ffprobe coûte ~30 ms par fichier.
var durationCache sync.Map

func (l *Library) duration(path string) float64 {
	info, err := os.Stat(path)
	if err != nil {
		return 0
	}
	key := fmt.Sprintf("%s|%d|%d", path, info.Size(), info.ModTime().UnixNano())
	if v, ok := durationCache.Load(key); ok {
		return v.(float64)
	}
	out, err := exec.Command(ffprobeBin, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path).Output()
	if err != nil {
		return 0
	}
	d, _ := strconv.ParseFloat(strings.TrimSpace(string(out)), 64)
	durationCache.Store(key, d)
	return d
}

// --- tâches ----------------------------------------------------------------

func (l *Library) Jobs() []Job {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]Job, 0, len(l.jobs))
	for _, j := range l.jobs {
		out = append(out, *j)
	}
	return out
}

func (l *Library) startJob(kind, label string, run func() (string, error)) *Job {
	l.mu.Lock()
	l.nextID++
	j := &Job{ID: l.nextID, Kind: kind, Label: label, State: "running", StartedAt: time.Now()}
	l.jobs = append(l.jobs, j)
	// On ne garde que les 20 dernières tâches.
	if len(l.jobs) > 20 {
		l.jobs = l.jobs[len(l.jobs)-20:]
	}
	l.mu.Unlock()
	l.notify()

	go func() {
		out, err := run()
		l.mu.Lock()
		if err != nil {
			j.State, j.Error = "error", err.Error()
			log.Printf("tâche %s : %v", label, err)
		} else {
			j.State, j.Output = "done", out
		}
		l.mu.Unlock()
		l.notify()
	}()
	return j
}

func ffmpeg(ctx context.Context, args ...string) error {
	cmd := exec.CommandContext(ctx, ffmpegBin, append([]string{"-hide_banner", "-nostdin", "-y", "-v", "error"}, args...)...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("ffmpeg : %s", strings.TrimSpace(lastLine(stderr.String()+"\n"+err.Error())))
	}
	return nil
}

func timestampName(prefix string) string {
	return prefix + "-" + time.Now().Format("2006-01-02_15-04-05")
}

// Finalize convertit un MKV brut en MP4 lisible partout (vidéo copiée, audio en AAC),
// génère la miniature, puis lance l'export vertical si demandé.
func (l *Library) Finalize(mkvPath, baseName string, codec videoCodec, vertical *VerticalLayout) (string, error) {
	defer os.Remove(mkvPath)
	name := baseName + ".mp4"
	out := filepath.Join(l.Dir, name)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	// L'horloge des paquets est celle de leur réception : aresample lisse l'audio.
	args := []string{"-i", mkvPath, "-map", "0:v", "-map", "0:a?", "-c:v", "copy"}
	if codec == codecH265 {
		args = append(args, "-tag:v", "hvc1") // H.265 lisible par QuickTime/Photos ; HDR conservé
	}
	args = append(args, "-af", "aresample=async=1000", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out)
	if err := ffmpeg(ctx, args...); err != nil {
		return "", err
	}
	l.thumbnail(name)
	if vertical != nil {
		l.ExportVertical(name, *vertical)
	}
	return name, nil
}

func (l *Library) thumbnail(name string) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	src := filepath.Join(l.Dir, name)
	at := "1"
	if l.duration(src) < 2 {
		at = "0"
	}
	if err := ffmpeg(ctx, "-ss", at, "-i", src, "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", l.thumbPath(name)); err != nil {
		log.Printf("miniature %s : %v", name, err)
	}
}

// ExportVertical crée une version 1080×1920 (TikTok, Reels, Shorts) avec l'encodeur matériel.
func (l *Library) ExportVertical(name string, layout VerticalLayout) *Job {
	src := filepath.Join(l.Dir, name)
	outName := strings.TrimSuffix(name, ".mp4") + "-vertical.mp4"
	if layout.Mode == "crop" {
		outName = strings.TrimSuffix(name, ".mp4") + "-vertical-recadre.mp4"
	}
	return l.startJob("vertical", "Vertical · "+name, func() (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
		defer cancel()
		args := []string{"-i", src, "-filter_complex", verticalFilter(layout), "-map", "[v]", "-map", "0:a?"}
		args = append(args, encodeArgs(12000, false)...)
		args = append(args, "-c:a", "copy", "-movflags", "+faststart", filepath.Join(l.Dir, outName))
		err := ffmpeg(ctx, args...)
		if err != nil {
			return "", err
		}
		l.thumbnail(outName)
		return outName, nil
	})
}
