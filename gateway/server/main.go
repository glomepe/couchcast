// Couchcast — passerelle PS5 Remote Play → WebRTC.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

func main() {
	listen := flag.String("listen", ":8765", "adresse HTTP d'écoute")
	bridgePath := flag.String("bridge", "build/bridge/couchcast-bridge", "chemin du binaire couchcast-bridge")
	dataPath := flag.String("config", "data/config.json", "fichier de configuration (console appairée)")
	webDir := flag.String("web", "web/dist", "dossier de l'interface compilée")
	home, _ := os.UserHomeDir()
	mediaDir := flag.String("media", filepath.Join(home, "Movies", "Couchcast"), "dossier des clips et enregistrements")
	flag.Parse()

	if _, err := os.Stat(*bridgePath); err != nil {
		log.Fatalf("couchcast-bridge introuvable (%s) : lancez d'abord ./build.sh", *bridgePath)
	}
	cfg, err := LoadConfig(*dataPath)
	if err != nil {
		log.Fatalf("configuration illisible : %v", err)
	}
	manager, err := NewManager(Bridge{Path: *bridgePath}, cfg)
	if err != nil {
		log.Fatal(err)
	}
	notify := func() { go manager.Broadcast() }
	library, err := NewLibrary(*mediaDir, notify)
	if err != nil {
		log.Fatalf("dossier média : %v", err)
	}
	manager.Studio = NewStudio(cfg, library, notify)
	log.Printf("clips et enregistrements : %s", *mediaDir)

	viewers, err := NewViewers(manager)
	if err != nil {
		log.Fatal(err)
	}

	api := &API{manager: manager, viewers: viewers, config: cfg, bridge: Bridge{Path: *bridgePath}, studio: manager.Studio, library: library}
	mux := http.NewServeMux()
	api.Register(mux)
	mux.Handle("/", spaHandler(*webDir))

	srv := &http.Server{Addr: *listen, Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		<-ch
		log.Printf("arrêt…")
		manager.Studio.SessionEnded()
		manager.Stop()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}()

	_, port, _ := net.SplitHostPort(*listen)
	for _, ip := range lanIPs() {
		log.Printf("interface : http://%s:%s/", ip, port)
	}
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

type API struct {
	manager *Manager
	viewers *Viewers
	config  *ConfigStore
	bridge  Bridge
	studio  *Studio
	library *Library
}

func (a *API) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/status", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, a.manager.Status())
	})
	mux.HandleFunc("GET /api/events", a.events)
	mux.HandleFunc("POST /api/discover", a.discover)
	mux.HandleFunc("GET /api/psn/login-url", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"url": PSNLoginURL()})
	})
	mux.HandleFunc("POST /api/psn/account-id", a.accountID)
	mux.HandleFunc("POST /api/pair", a.pair)
	mux.HandleFunc("DELETE /api/pair", a.unpair)
	mux.HandleFunc("PUT /api/settings", a.settings)
	mux.HandleFunc("POST /api/stream/start", func(w http.ResponseWriter, r *http.Request) {
		if err := a.manager.Start(); err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, a.manager.Status())
	})
	mux.HandleFunc("POST /api/stream/stop", func(w http.ResponseWriter, r *http.Request) {
		a.manager.Stop()
		writeJSON(w, http.StatusOK, a.manager.Status())
	})
	mux.HandleFunc("POST /api/stream/pin", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Pin string `json:"pin"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if err := a.manager.SendPin(strings.TrimSpace(body.Pin)); err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/webrtc", a.webrtcOffer)
	a.registerStudio(mux)
	mux.HandleFunc("POST /api/stream/keyframe", func(w http.ResponseWriter, r *http.Request) {
		a.manager.RequestKeyframe()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
}

func (a *API) events(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming non supporté", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch, unsubscribe := a.manager.Subscribe()
	defer unsubscribe()
	for {
		select {
		case <-r.Context().Done():
			return
		case st := <-ch:
			data, _ := json.Marshal(st)
			fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}

func (a *API) discover(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	hosts, err := a.bridge.Discover(ctx, "", 3*time.Second)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"hosts": hosts})
}

func (a *API) accountID(w http.ResponseWriter, r *http.Request) {
	var body struct {
		RedirectURL string `json:"redirectUrl"`
		AccountID   string `json:"accountId"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	id := strings.TrimSpace(body.AccountID)
	if id == "" {
		var err error
		if id, err = AccountIDFromRedirect(r.Context(), body.RedirectURL); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
	} else if !ValidAccountID(id) {
		writeError(w, http.StatusBadRequest, errors.New("identifiant invalide (8 octets encodés en base64)"))
		return
	}
	if err := a.config.Update(func(c *Config) { c.AccountID = id }); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"accountId": id})
}

func (a *API) pair(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host string `json:"host"`
		Name string `json:"name"`
		ID   string `json:"id"`
		Pin  string `json:"pin"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	accountID := a.config.Get().AccountID
	if accountID == "" {
		writeError(w, http.StatusBadRequest, errors.New("identifiant PSN manquant"))
		return
	}
	pin := strings.ReplaceAll(strings.TrimSpace(body.Pin), " ", "")
	if len(pin) != 8 || strings.Trim(pin, "0123456789") != "" {
		writeError(w, http.StatusBadRequest, errors.New("le code d'appairage fait 8 chiffres"))
		return
	}
	if net.ParseIP(body.Host) == nil {
		writeError(w, http.StatusBadRequest, errors.New("adresse IP de la console invalide"))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	res, err := a.bridge.Regist(ctx, body.Host, accountID, pin)
	if err != nil {
		writeError(w, http.StatusBadGateway, err)
		return
	}
	name := res.Nickname
	if name == "" {
		name = body.Name
	}
	err = a.config.Update(func(c *Config) {
		c.Console = &Console{Host: body.Host, Name: name, ID: body.ID, MAC: res.MAC,
			AccountID: accountID, RegistKey: res.RegistKey, Morning: res.Morning}
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	a.manager.setState(StateIdle, "")
	writeJSON(w, http.StatusOK, a.manager.Status())
}

func (a *API) unpair(w http.ResponseWriter, r *http.Request) {
	a.manager.Stop()
	if err := a.config.Update(func(c *Config) { c.Console = nil }); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	a.manager.setState(StateUnpaired, "")
	writeJSON(w, http.StatusOK, a.manager.Status())
}

func (a *API) settings(w http.ResponseWriter, r *http.Request) {
	var s StreamSettings
	if !readJSON(w, r, &s) {
		return
	}
	if err := s.Validate(); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := a.config.Update(func(c *Config) { c.Settings = s }); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// Le profil vidéo se négocie à l'ouverture : on relance la session si elle tourne.
	st := a.manager.Status().State
	if st == StateStreaming || st == StateConnecting {
		go func() {
			a.manager.Stop()
			_ = a.manager.Start()
		}()
	}
	writeJSON(w, http.StatusOK, a.manager.Status())
}

func (a *API) webrtcOffer(w http.ResponseWriter, r *http.Request) {
	offer, err := io.ReadAll(io.LimitReader(r.Body, 64<<10))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	answer, err := a.viewers.Answer(string(offer))
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	// Ouvrir un lecteur suffit à démarrer la session Remote Play.
	if a.manager.Status().State != StateUnpaired {
		_ = a.manager.Start()
	}
	w.Header().Set("Content-Type", "application/sdp")
	w.WriteHeader(http.StatusCreated)
	_, _ = io.WriteString(w, answer)
}

// --- utilitaires HTTP ------------------------------------------------------

func readJSON(w http.ResponseWriter, r *http.Request, v any) bool {
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v); err != nil {
		writeError(w, http.StatusBadRequest, fmt.Errorf("JSON invalide : %w", err))
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

// spaHandler sert l'interface compilée, en renvoyant index.html pour les routes inconnues.
func spaHandler(dir string) http.Handler {
	fs := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		if info, err := os.Stat(p); err != nil || info.IsDir() {
			if _, err := os.Stat(filepath.Join(dir, "index.html")); err != nil {
				http.Error(w, "interface non compilée : lancez ./build.sh", http.StatusNotFound)
				return
			}
			if r.URL.Path != "/" {
				r.URL.Path = "/"
			}
		}
		fs.ServeHTTP(w, r)
	})
}

func lanIPs() []string {
	var ips []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
			ips = append(ips, n.IP.String())
		}
	}
	return ips
}
