package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Console appairée et préférences de flux, persistées dans data/config.json.
// Le fichier contient la clé d'appairage Remote Play : il est créé en 0600.
type Console struct {
	Host      string `json:"host"`
	Name      string `json:"name"`
	ID        string `json:"id"`
	MAC       string `json:"mac"`
	AccountID string `json:"accountId"`
	RegistKey string `json:"registKey"`
	Morning   string `json:"morning"`
}

type StreamSettings struct {
	Resolution int `json:"resolution"` // 360, 540, 720, 1080
	FPS        int `json:"fps"`        // 30, 60
	Bitrate    int `json:"bitrate"`    // kbit/s, 0 = valeur par défaut de la résolution
	// Pilotage : si faux, la passerelle n'annonce aucune manette et la manette de la PS5 reste active.
	Control bool `json:"control"`
}

type StudioSettings struct {
	// Durée gardée en mémoire pour les clips (0 = replay désactivé).
	ReplaySeconds int `json:"replaySeconds"`
	// Garde la session Remote Play ouverte sans spectateur (replay permanent).
	KeepAlive bool `json:"keepAlive"`
	// Crée aussi la version verticale de chaque clip.
	ClipVertical bool           `json:"clipVertical"`
	Vertical     VerticalLayout `json:"vertical"`
}

type LiveDestination struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Platform string `json:"platform"` // twitch | youtube | tiktok | custom
	Server   string `json:"server"`   // rtmp(s)://…
	Key      string `json:"key"`      // clé de stream (secrète)
	Format   string `json:"format"`   // horizontal | vertical
	Reencode bool   `json:"reencode"` // réencoder (débit maîtrisé) ou copier le flux de la PS5
	Bitrate  int    `json:"bitrate"`  // kbit/s si réencodage
}

type Config struct {
	Console  *Console          `json:"console,omitempty"`
	Settings StreamSettings    `json:"settings"`
	Studio   StudioSettings    `json:"studio"`
	Live     []LiveDestination `json:"live,omitempty"`
	// Identifiant PSN mémorisé pour un futur appairage, même sans console.
	AccountID string `json:"accountId,omitempty"`
	// Langue de l'interface (fr | en), partagée avec l'app de bureau.
	Lang string `json:"lang,omitempty"`
}

type ConfigStore struct {
	path string
	mu   sync.Mutex
	cfg  Config
}

func defaultConfig() Config {
	return Config{
		Settings: StreamSettings{Resolution: 1080, FPS: 60},
		Studio:   StudioSettings{ReplaySeconds: 120, Vertical: VerticalLayout{Mode: "blur", Position: 0.5}},
	}
}

func LoadConfig(path string) (*ConfigStore, error) {
	s := &ConfigStore{path: path, cfg: defaultConfig()}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(data, &s.cfg); err != nil {
		return nil, err
	}
	// Fichier antérieur au studio : valeurs par défaut.
	if !s.cfg.Studio.Vertical.Valid() {
		s.cfg.Studio = defaultConfig().Studio
	}
	return s, nil
}

func (s *ConfigStore) Get() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.cfg
	if c.Console != nil {
		console := *c.Console
		c.Console = &console
	}
	c.Live = append([]LiveDestination(nil), c.Live...)
	return c
}

func (s *ConfigStore) Update(fn func(*Config)) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(&s.cfg)
	data, err := json.MarshalIndent(s.cfg, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

func (s StreamSettings) Validate() error {
	switch s.Resolution {
	case 360, 540, 720, 1080:
	default:
		return errors.New("résolution invalide (360, 540, 720 ou 1080)")
	}
	if s.FPS != 30 && s.FPS != 60 {
		return errors.New("fps invalide (30 ou 60)")
	}
	if s.Bitrate != 0 && (s.Bitrate < 1000 || s.Bitrate > 100000) {
		return errors.New("débit invalide (1000 à 100000 kbit/s, ou 0 pour automatique)")
	}
	return nil
}
