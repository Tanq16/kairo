package server

import (
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// embed.FS reports a zero ModTime, so http.FileServer sends no validator at all and a browser can hold a stale app.js across an upgrade with nothing to revalidate against; embedded bytes are fixed at build time, so hashing once at startup stays correct
func buildAssetETags(fsys fs.FS) (map[string]string, error) {
	etags := make(map[string]string)
	err := fs.WalkDir(fsys, ".", func(name string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		etags[name] = `"` + contentToken(data) + `"`
		return nil
	})
	if err != nil {
		return nil, err
	}
	return etags, nil
}

// http.ServeContent answers If-None-Match from whatever ETag the header already carries, so setting it before delegating is what turns a repeat load into a 304
func (s *Server) staticHandler(fsys fs.FS) http.Handler {
	files := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.setAssetValidators(w, strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/"))
		files.ServeHTTP(w, r)
	})
}

// no-cache still allows caching — it only forbids reusing the copy without asking, which is what keeps a 3.5MB vendored bundle from being re-sent on every load
func (s *Server) setAssetValidators(w http.ResponseWriter, name string) {
	etag, ok := s.assetETags[name]
	if !ok {
		return
	}
	w.Header().Set("ETag", etag)
	w.Header().Set("Cache-Control", "no-cache")
}
