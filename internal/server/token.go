package server

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
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

// dropTree removes a path and its descendants so a deleted/moved directory can't leave stale child tokens that later suppress a legitimate save; the "/" boundary stops a sibling like "notesX" being caught by prefix "notes"
func (t *tokenTable) dropTree(prefix string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	sub := prefix + "/"
	for key := range t.last {
		if key == prefix || strings.HasPrefix(key, sub) {
			delete(t.last, key)
		}
	}
}
