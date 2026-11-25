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
	"sync"
	"syscall"
	"time"
)

func main() {
	listen := flag.String("listen", ":8765", "adresse HTTP d'écoute")
	bridgePath := flag.String("bridge", "build/bridge/"+exe("couchcast-bridge"), "chemin du binaire couchcast-bridge")
	dataPath := flag.String("config", "data/config.json", "fichier de configuration (console appairée)")
	webDir := flag.String("web", "web/dist", "dossier de l'interface compilée")
	mediaDir := flag.String("media", defaultMediaDir(), "dossier des clips et enregistrements")
	ffmpegDir := flag.String("ffmpeg-dir", "", "dossier contenant ffmpeg et ffprobe (par défaut : à côté du serveur, sinon le PATH)")
	flag.Parse()

	locateFFmpeg(*ffmpegDir)
	go pickEncoder() // test des encodeurs matériels en arrière-plan
	if _, err := os.Stat(*bridgePath); err != nil {
		log.Fatalf("couchcast-bridge introuvable (%s) : lancez d'abord ./build.sh", *bridgePath)
	}
	cfg, err := LoadConfig(*dataPath)
	if err != nil {
		log.Fatalf("configuration illisible : %v", err)
	}
	SetSmoothing(cfg.Get().Settings.Smoothing)
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
	var shutdownOnce sync.Once
	shutdown := func() {
		shutdownOnce.Do(func() {
			log.Printf("arrêt…")
			manager.Studio.SessionEnded()
			manager.Stop() // ferme proprement la session Remote Play
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		})
	}
	api.shutdown = shutdown
	go func() {
		ch := make(chan os.Signal, 1)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		<-ch
		shutdown()
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
	manager  *Manager
	viewers  *Viewers
	config   *ConfigStore
	bridge   Bridge
	studio   *Studio
	library  *Library
	shutdown func()
}

func (a *API) Register(mux *http.ServeMux) {
	// Adresses à donner aux autres appareils (téléphone, autre PC) : celle tournée vers
	// la console d'abord, c'est forcément le réseau de la maison.
	mux.HandleFunc("GET /api/lan", func(w http.ResponseWriter, r *http.Request) {
		_, port, _ := net.SplitHostPort(r.Host)
		if port == "" {
			port = "80"
		}
		target := ""
		if c := a.manager.config.Get().Console; c != nil {
			target = c.Host
		}
		var urls []string
		for _, ip := range homeIPs(target) {
			urls = append(urls, "http://"+net.JoinHostPort(ip, port))
		}
		writeJSON(w, http.StatusOK, map[string][]string{"urls": urls})
	})
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
	mux.HandleFunc("POST /api/stream/standby", func(w http.ResponseWriter, r *http.Request) {
		if err := a.manager.Standby(); err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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
	// Arrêt propre demandé par l'app de bureau (Windows n'a pas de SIGTERM),
	// accepté seulement depuis la machine elle-même.
	mux.HandleFunc("POST /api/shutdown", func(w http.ResponseWriter, r *http.Request) {
		host, _, _ := net.SplitHostPort(r.RemoteAddr)
		if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
			writeError(w, http.StatusForbidden, errors.New("réservé à la machine locale"))
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		go a.shutdown()
	})
	a.registerStudio(mux)
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
	previous := a.config.Get().Settings
	if err := a.config.Update(func(c *Config) { c.Settings = s }); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	SetSmoothing(s.Smoothing) // appliqué en direct, sans reconnexion
	onlySmoothing := previous
	onlySmoothing.Smoothing = s.Smoothing
	// Le profil vidéo se négocie à l'ouverture : on relance la session si elle tourne.
	st := a.manager.Status().State
	if onlySmoothing != s && (st == StateStreaming || st == StateConnecting) {
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

// homeIPs : l'adresse locale utilisée pour joindre target (ou Internet), puis les autres
// adresses privées. Écarte les interfaces virtuelles (Docker, VM, VPN) quand c'est possible.
func homeIPs(target string) []string {
	var ips []string
	seen := map[string]bool{}
	add := func(ip string) {
		if ip != "" && !seen[ip] {
			seen[ip] = true
			ips = append(ips, ip)
		}
	}
	for _, dest := range []string{target, "192.168.1.1", "1.1.1.1"} {
		if dest == "" {
			continue
		}
		// UDP : aucun paquet n'est envoyé, le système choisit juste l'interface de sortie.
		if conn, err := net.Dial("udp4", net.JoinHostPort(dest, "9")); err == nil {
			add(conn.LocalAddr().(*net.UDPAddr).IP.String())
			conn.Close()
			break
		}
	}
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || ifc.Flags&net.FlagPointToPoint != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && n.IP.To4() != nil && n.IP.IsPrivate() && n.IP.To4()[3] != 0 {
				add(n.IP.String())
			}
		}
	}
	return ips
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
