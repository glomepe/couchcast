package main

import (
	"errors"
	"net/http"
	"os/exec"
	"strconv"
)

func (a *API) registerStudio(mux *http.ServeMux) {
	mux.HandleFunc("PUT /api/studio/settings", func(w http.ResponseWriter, r *http.Request) {
		var s StudioSettings
		if !readJSON(w, r, &s) {
			return
		}
		if err := a.studio.UpdateSettings(s); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, a.manager.Status())
	})

	mux.HandleFunc("PUT /api/prefs", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Lang string `json:"lang"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Lang != "fr" && body.Lang != "en" {
			writeError(w, http.StatusBadRequest, errors.New("langue invalide (fr ou en)"))
			return
		}
		if err := a.config.Update(func(c *Config) { c.Lang = body.Lang }); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		a.manager.Broadcast()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})

	mux.HandleFunc("POST /api/clip", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Seconds float64 `json:"seconds"`
		}
		if !readJSON(w, r, &body) {
			return
		}
		if body.Seconds < 5 || body.Seconds > 600 {
			writeError(w, http.StatusBadRequest, errors.New("durée de clip invalide (5 à 600 s)"))
			return
		}
		job, err := a.studio.Clip(body.Seconds)
		if err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job)
	})

	mux.HandleFunc("POST /api/record/start", func(w http.ResponseWriter, r *http.Request) {
		if err := a.studio.StartRecording(); err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/record/stop", func(w http.ResponseWriter, r *http.Request) {
		job, err := a.studio.StopRecording()
		if err != nil {
			writeError(w, http.StatusConflict, err)
			return
		}
		writeJSON(w, http.StatusAccepted, job)
	})

	// --- bibliothèque ---
	mux.HandleFunc("GET /api/library", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"items": a.library.List(), "dir": a.library.Dir})
	})
	mux.HandleFunc("DELETE /api/library/{name}", func(w http.ResponseWriter, r *http.Request) {
		if err := a.library.Delete(r.PathValue("name")); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/library/{name}/vertical", func(w http.ResponseWriter, r *http.Request) {
		var layout VerticalLayout
		if !readJSON(w, r, &layout) {
			return
		}
		if !layout.Valid() {
			writeError(w, http.StatusBadRequest, errors.New("disposition invalide"))
			return
		}
		name := r.PathValue("name")
		if _, err := a.library.Path(name); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusAccepted, a.library.ExportVertical(name, layout))
	})
	// Affiche le fichier dans le Finder (utile quand l'interface est ouverte sur le Mac).
	mux.HandleFunc("POST /api/library/{name}/reveal", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.library.Path(r.PathValue("name"))
		if err == nil {
			err = exec.Command("open", "-R", p).Run()
		}
		if err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("GET /media/{name}", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.library.Path(r.PathValue("name"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		if r.URL.Query().Has("download") {
			w.Header().Set("Content-Disposition", "attachment; filename="+strconv.Quote(r.PathValue("name")))
		}
		http.ServeFile(w, r, p) // gère les requêtes partielles (lecture dans le navigateur)
	})
	mux.HandleFunc("GET /media/{name}/thumb", func(w http.ResponseWriter, r *http.Request) {
		p, err := a.library.ThumbPath(r.PathValue("name"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Cache-Control", "max-age=3600")
		http.ServeFile(w, r, p)
	})

	// --- live ---
	mux.HandleFunc("GET /api/live", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"destinations": a.studio.PublicDestinations()})
	})
	mux.HandleFunc("POST /api/live", func(w http.ResponseWriter, r *http.Request) {
		var d LiveDestination
		if !readJSON(w, r, &d) {
			return
		}
		if _, err := a.studio.SaveDestination(d); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"destinations": a.studio.PublicDestinations()})
	})
	mux.HandleFunc("DELETE /api/live/{id}", func(w http.ResponseWriter, r *http.Request) {
		if err := a.studio.DeleteDestination(r.PathValue("id")); err != nil {
			writeError(w, http.StatusInternalServerError, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"destinations": a.studio.PublicDestinations()})
	})
	mux.HandleFunc("POST /api/live/{id}/start", func(w http.ResponseWriter, r *http.Request) {
		if a.manager.Status().State != StateStreaming {
			writeError(w, http.StatusConflict, errors.New("lancez d'abord le flux de la PS5"))
			return
		}
		if err := a.studio.StartLive(r.PathValue("id")); err != nil {
			writeError(w, http.StatusBadRequest, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /api/live/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		a.studio.StopLive(r.PathValue("id"))
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
}
