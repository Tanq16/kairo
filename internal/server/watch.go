package server

import (
	"cmp"
	"log"
	"slices"
	"time"

	"github.com/tanq16/kairo/internal/notes"
)

const scanInterval = 2 * time.Second

// Past this many changed paths one coarse event stands in for all of them: the hub drops a client whose 16-deep send buffer overflows, so a bulk change like a git checkout must not arrive as a per-path storm
const maxScanEvents = 12

// Matches the upload cap, since nothing written through the app can exceed it; a file dropped into the data directory by other means is bounded by nothing, and hashing it means reading it whole
const maxHashBytes = 10 << 20

type scanChange struct {
	op   string
	path string
	size int64
}

// Changes made outside the app — an agent, an editor, a git pull — reach clients only through this loop; it shares the hub's lifecycle because feeding the hub is all it does
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
			// With nobody listening the snapshot stays put, so the first scan after a client connects still reports whatever accumulated while it was idle
			if !s.hub.hasClients() {
				continue
			}
		}

		cur, err := s.service.Scan()
		if err != nil {
			// A half-finished walk would read as a pile of deletes, so keep the old snapshot and let the next tick retry
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

// saveMu covers read+token+emit so an interleaved handleSave cannot record this token first and then suppress its own event — the saving client would see its own write come back as a remote change
func (s *Server) emitContentChange(op, path string, size int64) {
	if size > maxHashBytes {
		// Still worth announcing so the tree refreshes; without a token no client tries to patch it into an editor, which is right for something this size
		s.hub.emit(Event{Op: op, Path: path})
		return
	}
	s.saveMu.Lock()
	defer s.saveMu.Unlock()
	content, err := s.service.GetFile(path)
	if err != nil {
		return // vanished or unreadable since the walk; the next scan reports it as a delete
	}
	token := contentToken(content)
	// The token table is what makes this safe to run alongside the write handlers: bytes clients were already told about emit nothing, so a save made through the API never echoes back
	if !s.tokens.changed(path, token) {
		return
	}
	s.hub.emit(Event{Op: op, Path: path, Token: token})
}
