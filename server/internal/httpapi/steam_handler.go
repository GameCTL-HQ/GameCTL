package httpapi

import (
	"errors"
	"net/http"
	"time"

	"github.com/GameCTL-HQ/GameCTL/server/internal/steam"
)

func steamStatus() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		addr := r.URL.Query().Get("addr")
		if addr == "" {
			writeError(w, http.StatusBadRequest, "addr query parameter required")
			return
		}

		out, err := steam.Query(addr, 3*time.Second)
		if err != nil {
			if errors.Is(err, steam.ErrBadAddr) {
				writeError(w, http.StatusBadRequest, err.Error())
				return
			}
			// Match Python: 502 for query failures with the underlying error message.
			writeError(w, http.StatusBadGateway, "Failed to query server: "+err.Error())
			return
		}
		writeJSON(w, http.StatusOK, out)
	}
}
