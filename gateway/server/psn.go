package main

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Récupération de l'identifiant de compte PSN nécessaire à l'appairage PS5.
// Même procédure que chiaki-ng (scripts/psn-account-id.go) : l'utilisateur se
// connecte lui-même sur la page Sony, puis colle l'URL de redirection obtenue.
// Seul le code d'autorisation à usage unique transite par ce serveur.
const (
	psnClientID     = "ba495a24-818c-472b-b12d-ff231c1b5745"
	psnClientSecret = "mvaiZkRsAsI1IBkY"
	psnRedirectURI  = "https://remoteplay.dl.playstation.net/remoteplay/redirect"
	psnAuthBase     = "https://auth.api.sonyentertainmentnetwork.com/2.0/oauth"
)

func PSNLoginURL() string {
	q := url.Values{
		"service_entity":     {"urn:service-entity:psn"},
		"response_type":      {"code"},
		"client_id":          {psnClientID},
		"redirect_uri":       {psnRedirectURI},
		"scope":              {"psn:clientapp"},
		"request_locale":     {"fr_FR"},
		"ui":                 {"pr"},
		"service_logo":       {"ps"},
		"layout_type":        {"popup"},
		"smcid":              {"remoteplay"},
		"prompt":             {"always"},
		"PlatformPrivacyWs1": {"minimal"},
	}
	return psnAuthBase + "/authorize?" + q.Encode()
}

// AccountIDFromRedirect échange le code contenu dans l'URL de redirection contre
// l'identifiant de compte, encodé comme l'attend la PS5 (8 octets LE en base64).
func AccountIDFromRedirect(ctx context.Context, redirect string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(redirect))
	if err != nil {
		return "", errors.New("URL invalide")
	}
	code := u.Query().Get("code")
	if code == "" {
		return "", errors.New("l'URL ne contient pas de paramètre « code » : copiez l'adresse complète de la page « redirect »")
	}

	client := &http.Client{Timeout: 15 * time.Second}
	form := url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {psnRedirectURI}}
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, psnAuthBase+"/token", strings.NewReader(form.Encode()))
	req.SetBasicAuth(psnClientID, psnClientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	var token struct {
		AccessToken string `json:"access_token"`
	}
	if err := doJSON(client, req, &token); err != nil {
		return "", fmt.Errorf("échange du code : %w (le code n'est valable que quelques minutes et une seule fois)", err)
	}
	if token.AccessToken == "" {
		return "", errors.New("Sony n'a pas renvoyé de jeton")
	}

	req, _ = http.NewRequestWithContext(ctx, http.MethodGet, psnAuthBase+"/token/"+url.PathEscape(token.AccessToken), nil)
	req.SetBasicAuth(psnClientID, psnClientSecret)
	var info struct {
		UserID string `json:"user_id"`
	}
	if err := doJSON(client, req, &info); err != nil {
		return "", fmt.Errorf("lecture du compte : %w", err)
	}
	uid, err := strconv.ParseUint(info.UserID, 10, 64)
	if err != nil {
		return "", errors.New("identifiant utilisateur PSN inattendu")
	}
	var buf [8]byte
	binary.LittleEndian.PutUint64(buf[:], uid)
	return base64.StdEncoding.EncodeToString(buf[:]), nil
}

func doJSON(client *http.Client, req *http.Request, out any) error {
	res, err := client.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", res.StatusCode)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

// ValidAccountID vérifie le format (8 octets en base64), pour une saisie manuelle.
func ValidAccountID(s string) bool {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	return err == nil && len(b) == 8
}
