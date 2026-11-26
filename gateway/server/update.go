package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Vérification des mises à jour : dernière release publiée sur GitHub, mise en cache 6 h.
// Rien n'est installé automatiquement (l'app n'est pas signée) : on propose le téléchargement.

const releasesRepo = "glomepe/couchcast"

type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Available bool   `json:"available"`
	URL       string `json:"url,omitempty"`      // page de la release
	Download  string `json:"download,omitempty"` // fichier pour ce système
	CheckedAt int64  `json:"checkedAt,omitempty"`
	Error     string `json:"error,omitempty"`
}

type Updater struct {
	current string
	mu      sync.Mutex
	info    UpdateInfo
	at      time.Time
}

func (u *Updater) Check(force bool) UpdateInfo {
	u.mu.Lock()
	defer u.mu.Unlock()
	if !force && !u.at.IsZero() && time.Since(u.at) < 6*time.Hour {
		return u.info
	}
	info := UpdateInfo{Current: u.current}
	client := http.Client{Timeout: 8 * time.Second}
	req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+releasesRepo+"/releases/latest", nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "Couchcast/"+u.current)
	resp, err := client.Do(req)
	if err != nil {
		info.Error = err.Error()
	} else {
		defer resp.Body.Close()
		var rel struct {
			Tag string `json:"tag_name"`
			URL string `json:"html_url"`
		}
		if resp.StatusCode != http.StatusOK {
			info.Error = resp.Status
		} else if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
			info.Error = err.Error()
		} else {
			info.Latest = strings.TrimPrefix(rel.Tag, "v")
			info.URL = rel.URL
			info.Available = u.current != "dev" && newerVersion(info.Latest, u.current)
			info.Download = "https://github.com/" + releasesRepo + "/releases/download/" + rel.Tag + "/Couchcast-mac-arm64.dmg"
		}
	}
	info.CheckedAt = time.Now().Unix()
	u.info, u.at = info, time.Now()
	if info.Error != "" {
		u.at = time.Now().Add(-5*time.Hour - 50*time.Minute) // nouvel essai dans 10 min
	}
	return info
}

// newerVersion : a > b, en comparant les nombres de « 1.2.3 » (suffixes « -beta » ignorés).
func newerVersion(a, b string) bool {
	parse := func(v string) []int {
		v, _, _ = strings.Cut(v, "-")
		var out []int
		for _, p := range strings.Split(v, ".") {
			n, _ := strconv.Atoi(p)
			out = append(out, n)
		}
		return out
	}
	pa, pb := parse(a), parse(b)
	for i := 0; i < max(len(pa), len(pb)); i++ {
		var x, y int
		if i < len(pa) {
			x = pa[i]
		}
		if i < len(pb) {
			y = pb[i]
		}
		if x != y {
			return x > y
		}
	}
	return false
}
