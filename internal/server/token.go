package server

import (
	"crypto/sha256"
	"encoding/hex"
	"sync"
)

func contentToken(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// tokenTable remembers the last token per path so a byte-identical save emits nothing — stops viewers churning on every autosave
type tokenTable struct {
	mu   sync.Mutex
	last map[string]string
}

func newTokenTable() *tokenTable {
	return &tokenTable{last: make(map[string]string)}
}

func (t *tokenTable) changed(path, token string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.last[path] == token {
		return false
	}
	t.last[path] = token
	return true
}

func (t *tokenTable) set(path, token string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.last[path] = token
}

func (t *tokenTable) drop(path string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.last, path)
}
