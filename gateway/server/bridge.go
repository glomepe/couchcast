package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Types de paquets émis par couchcast-bridge sur stdout (voir bridge/src/main.c).
const (
	pktVideo = 1
	pktAudio = 2
	pktEvent = 3

	cmdController = 1
	cmdIDR        = 2
	cmdStop       = 3
	cmdPin        = 4
	cmdStandby    = 5
)

type Bridge struct {
	Path string
}

type DiscoveredHost struct {
	Host       string `json:"host"`
	Name       string `json:"name"`
	Type       string `json:"type"`
	ID         string `json:"id"`
	PS5        bool   `json:"ps5"`
	State      string `json:"state"` // ready | standby | unknown
	RunningApp string `json:"running_app"`
}

type RegistResult struct {
	RegistKey string `json:"regist_key"`
	Morning   string `json:"morning"`
	Nickname  string `json:"nickname"`
	MAC       string `json:"mac"`
}

// run exécute une sous-commande courte et renvoie stdout ; stderr sert de message d'erreur.
func (b Bridge) run(ctx context.Context, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, b.Path, args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if err != nil {
		return stdout.Bytes(), fmt.Errorf("%s: %w", lastLine(stderr.String()), err)
	}
	return stdout.Bytes(), nil
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if l := strings.TrimSpace(lines[i]); l != "" {
			return strings.TrimPrefix(l, "couchcast-bridge: ")
		}
	}
	return "couchcast-bridge"
}

func (b Bridge) Discover(ctx context.Context, host string, timeout time.Duration) ([]DiscoveredHost, error) {
	args := []string{"discover", "--timeout", strconv.FormatFloat(timeout.Seconds(), 'f', 1, 64)}
	if host != "" {
		args = append(args, "--host", host)
	}
	out, err := b.run(ctx, args...)
	hosts := []DiscoveredHost{}
	sc := bufio.NewScanner(bytes.NewReader(out))
	for sc.Scan() {
		var h DiscoveredHost
		if json.Unmarshal(sc.Bytes(), &h) == nil {
			hosts = append(hosts, h)
		}
	}
	// Code de sortie 1 = aucune console trouvée : ce n'est pas une erreur.
	var exitErr *exec.ExitError
	if err != nil && !(errors.As(err, &exitErr) && exitErr.ExitCode() == 1) {
		return hosts, err
	}
	return hosts, nil
}

func (b Bridge) Wakeup(ctx context.Context, host, registKey string) error {
	_, err := b.run(ctx, "wakeup", "--host", host, "--regist-key", registKey)
	return err
}

func (b Bridge) Regist(ctx context.Context, host, accountID, pin string) (*RegistResult, error) {
	out, err := b.run(ctx, "regist", "--host", host, "--account-id", accountID, "--pin", pin)
	if err != nil {
		return nil, err
	}
	var r RegistResult
	if err := json.Unmarshal(bytes.TrimSpace(out), &r); err != nil {
		return nil, fmt.Errorf("réponse d'appairage illisible: %w", err)
	}
	return &r, nil
}

// --- Session de streaming ---------------------------------------------------

type StreamHandler interface {
	OnVideo(au []byte, ts time.Duration)
	OnAudio(pkt []byte, ts time.Duration)
	OnEvent(ev map[string]any)
	OnExit(err error)
}

type StreamProcess struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	writeMu sync.Mutex
	done    chan struct{}
}

func (b Bridge) Stream(c Console, s StreamSettings, h StreamHandler) (*StreamProcess, error) {
	args := []string{"stream",
		"--host", c.Host, "--regist-key", c.RegistKey, "--morning", c.Morning, "--account-id", c.AccountID,
		"--resolution", strconv.Itoa(s.Resolution), "--fps", strconv.Itoa(s.FPS)}
	if s.Bitrate > 0 {
		args = append(args, "--bitrate", strconv.Itoa(s.Bitrate))
	}
	if !s.Control {
		args = append(args, "--spectator")
	}
	if s.Codec != "" {
		args = append(args, "--codec", s.Codec)
	}
	cmd := exec.Command(b.Path, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	p := &StreamProcess{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	var lastErr lastErrorLine
	go func() {
		sc := bufio.NewScanner(stderr)
		for sc.Scan() {
			line := sc.Text()
			lastErr.set(line)
			log.Printf("bridge: %s", line)
		}
	}()
	go func() {
		readErr := readPackets(bufio.NewReaderSize(stdout, 1<<20), h)
		waitErr := cmd.Wait()
		close(p.done)
		switch {
		case waitErr != nil:
			h.OnExit(fmt.Errorf("%s (%v)", lastErr.get(), waitErr))
		case readErr != nil && !errors.Is(readErr, io.EOF):
			h.OnExit(readErr)
		default:
			h.OnExit(nil)
		}
	}()
	return p, nil
}

func readPackets(r *bufio.Reader, h StreamHandler) error {
	var header [13]byte
	var origin uint64
	for {
		if _, err := io.ReadFull(r, header[:]); err != nil {
			return err
		}
		typ := header[0]
		size := binary.LittleEndian.Uint32(header[1:5])
		tsUs := binary.LittleEndian.Uint64(header[5:13])
		if size > 32<<20 {
			return fmt.Errorf("paquet démesuré (%d octets)", size)
		}
		buf := make([]byte, size)
		if _, err := io.ReadFull(r, buf); err != nil {
			return err
		}
		if origin == 0 {
			origin = tsUs
		}
		ts := time.Duration(tsUs-origin) * time.Microsecond
		switch typ {
		case pktVideo:
			h.OnVideo(buf, ts)
		case pktAudio:
			h.OnAudio(buf, ts)
		case pktEvent:
			var ev map[string]any
			if json.Unmarshal(buf, &ev) == nil {
				h.OnEvent(ev)
			}
		}
	}
}

func (p *StreamProcess) send(typ byte, payload []byte) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	msg := make([]byte, 5+len(payload))
	msg[0] = typ
	binary.LittleEndian.PutUint32(msg[1:5], uint32(len(payload)))
	copy(msg[5:], payload)
	_, err := p.stdin.Write(msg)
	return err
}

func (p *StreamProcess) RequestIDR() error { return p.send(cmdIDR, nil) }

func (p *StreamProcess) SendController(state []byte) error { return p.send(cmdController, state) }

func (p *StreamProcess) SendPin(pin string) error { return p.send(cmdPin, []byte(pin)) }

func (p *StreamProcess) Standby() error { return p.send(cmdStandby, nil) }

// Stop demande un arrêt propre (la console libère la session Remote Play),
// puis tue le processus s'il ne s'est pas terminé à temps.
func (p *StreamProcess) Stop() {
	_ = p.send(cmdStop, nil)
	select {
	case <-p.done:
	case <-time.After(5 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

type lastErrorLine struct {
	mu   sync.Mutex
	line string
}

func (l *lastErrorLine) set(s string) {
	if strings.Contains(s, "[chiaki E]") || strings.HasPrefix(s, "couchcast-bridge:") {
		l.mu.Lock()
		l.line = strings.TrimPrefix(s, "couchcast-bridge: ")
		l.mu.Unlock()
	}
}

func (l *lastErrorLine) get() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.line == "" {
		return "le pont s'est arrêté"
	}
	return l.line
}
