import axios from 'axios'

// In dev we proxy /api → http://127.0.0.1:8000 (see vite.config.js)
const baseURL = '/api'
// Global timeout so a cold-start / unreachable backend fails fast with a
// clear error instead of hanging indefinitely (which felt like a freeze,
// e.g. on a mistyped-password login against a just-booted local server).
//
// 30s, not 15s: several endpoints talk to the Kubernetes API (and through
// it to a node) before answering, and a busy cluster pushed past 15s often
// enough to surface as a bare "Network Error" on a request that had in fact
// succeeded server-side. Long enough to ride out a slow apiserver, still
// short enough that a genuinely dead backend reports quickly.
export const api = axios.create({ baseURL, timeout: 30000 })

export const setToken = (t) => {
  if (t) localStorage.setItem('token', t)
  else localStorage.removeItem('token')
}
export const getToken = () => localStorage.getItem('token')

api.interceptors.request.use((cfg) => {
  const t = getToken()
  if (t) {
    cfg.headers = cfg.headers ?? {}
    cfg.headers.Authorization = `Bearer ${t}`
  }
  return cfg
})

// unify error messages + global auth-expiry handling
api.interceptors.response.use(
  (r) => r,
  (err) => {
    const status = err?.response?.status
    const url = err?.config?.url || ''

    // Session expired / token invalid: the JWT is no longer accepted, so
    // every protected call (game lists, status, …) 401s and the UI would
    // otherwise just show empty screens with no explanation. Clear the
    // stored token and signal App to drop back to the login screen.
    //
    // Skip the /token endpoint itself — a 401 there is a bad username/
    // password on the login form, handled inline by the login UI, not an
    // expired session. Also require an existing token so a logged-out
    // user hitting a protected route doesn't loop.
    if (status === 401 && !url.includes('/token') && getToken()) {
      setToken(null)
      window.dispatchEvent(new CustomEvent('gamectl:unauthorized'))
    }

    const detail = err?.response?.data?.detail ?? err?.response?.data?.error
    const msg = detail
      ? (typeof detail === 'string' ? detail : JSON.stringify(detail))
      : err?.message || 'Request failed'
    return Promise.reject(new Error(msg))
  }
)
