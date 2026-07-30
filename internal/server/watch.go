package server

import (
	"cmp"
	"log"
	"slices"
	"time"

	"github.com/tanq16/kairo/internal/notes"
)

const scanInterval = 2 * time.Second

// The hub drops a client whose 16-deep send buffer overflows, so a bulk change must not arrive as a per-path storm
const maxScanEvents = 12

// Matches the upload cap; an external writer is bound by nothing, and hashing means reading the file whole
const maxHashBytes = 10 << 20

type scanChange struct {
	op   string
	path string
	size int64
}

func (s *Server) watch() {
	prev, err := s.service.Scan()
	if err != nil {
		log.Printf("ERROR Failed to take initial scan of data directory: %v", err)
	}
	ticker := time.NewTicker(scanInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.hub.done:
			return
		case <-s.rescan:
		case <-ticker.C:
		}

		// Advancing the snapshot with nobody listening would discard changes no client ever heard about
		if !s.hub.hasClients() {
			continue
		}

		cur, err := s.service.Scan()
		if err != nil {
			log.Printf("ERROR Failed to scan data directory: %v", err)
			continue
		}
		s.emitChanges(diffScan(prev, cur))
		prev = cur
	}
}

func diffScan(prev, cur map[string]notes.FileState) []scanChange {
	var changes []scanChange
	for path, now := range cur {
		before, existed := prev[path]
		switch {
		case now.IsDir:
			if !existed || !before.IsDir {
				changes = append(changes, scanChange{op: "createDir", path: path})
			}
		case !existed || before.IsDir:
			changes = append(changes, scanChange{op: "create", path: path, size: now.Size})
		case before.Size != now.Size || !before.ModTime.Equal(now.ModTime):
			changes = append(changes, scanChange{op: "save", path: path, size: now.Size})
		}
	}
	for path := range prev {
		if _, ok := cur[path]; !ok {
			changes = append(changes, scanChange{op: "delete", path: path})
		}
	}
	slices.SortFunc(changes, func(a, b scanChange) int { return cmp.Compare(a.path, b.path) })
	return changes
}

func (s *Server) emitChanges(changes []scanChange) {
	if len(changes) == 0 {
		return
	}
	if len(changes) > maxScanEvents {
		// The coarse event names no path, so a token left here would silently suppress a later change back to these bytes
		for _, ch := range changes {
			s.tokens.dropTree(ch.path)
		}
		s.hub.emit(Event{Op: "rescan"})
		return
	}
	for _, ch := range changes {
		switch ch.op {
		case "delete":
			s.tokens.dropTree(ch.path)
			s.hub.emit(Event{Op: "delete", Path: ch.path})
		case "createDir":
			s.hub.emit(Event{Op: "createDir", Path: ch.path})
		default:
			s.emitContentChange(ch.op, ch.path, ch.size)
		}
	}
}

// saveMu is held across read+token+emit so an interleaved handleSave can't record this token first and leave its own event unsent
func (s *Server) emitContentChange(op, path string, size int64) {
	if size > maxHashBytes {
		s.hub.emit(Event{Op: op, Path: path})
		return
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	content, err := s.service.GetFile(path)
	if err != nil {
		return
	}
	token := contentToken(content)
	if !s.tokens.changed(path, token) {
		return
	}
	s.hub.emit(Event{Op: op, Path: path, Token: token})
}
