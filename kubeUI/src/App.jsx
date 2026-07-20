import { useEffect, useState } from 'react'
import { api, setToken as saveToken, getToken } from './api/client'
import { games } from './wizard/gameSchemas'
import GameHub from './pages/GameHub'
import GameManage from './pages/GameManage'
import GameWizard from './pages/GameWizard'
import StorageLocations from './pages/StorageLocations'
import TasksMenu from './components/TasksMenu'
import UpdateBanner from './components/UpdateBanner'
import UpdateCheckButton from './components/UpdateCheckButton'
import DevBadge from './components/DevBadge'

// Encode/decode the current view as a URL hash so refresh keeps you on the same
// page and browser back/forward works. Routes:
//   #/                    → hub
//   #/manage/<gameId>     → manage page for that game
//   #/deploy/<gameId>     → wizard for that game
function parseHash() {
  const h = (window.location.hash || '').replace(/^#\/?/, '')
  if (!h) return { view: 'hub', selectedGame: null }
  const [section, gameId] = h.split('/')
  if (section === 'storage')   return { view: 'storage',   selectedGame: null }
  if (section === 'manage' && gameId) {
    const g = games.find(x => x.id === gameId)
    return g ? { view: 'manage', selectedGame: g } : { view: 'hub', selectedGame: null }
  }
  if (section === 'deploy' && gameId) {
    const g = games.find(x => x.id === gameId)
    return g ? { view: 'deploy', selectedGame: g } : { view: 'hub', selectedGame: null }
  }
  return { view: 'hub', selectedGame: null }
}

function buildHash(view, selectedGame) {
  if (view === 'hub')       return '#/'
  if (view === 'storage')   return '#/storage'
  if ((view === 'manage' || view === 'deploy') && selectedGame?.id) {
    return `#/${view}/${selectedGame.id}`
  }
  return '#/'
}

// view: 'hub' | 'manage' | 'deploy'
export default function App() {
  const [token, setToken] = useState(null)
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [msg, setMsg] = useState('')
  const [loggingIn, setLoggingIn] = useState(false)

  // Post-deploy seamless transition: after Apply, watch the deploy task;
  // on success, count down and forward to the game's manage screen.
  // { taskId, game, status:'running'|'succeeded'|'failed'|'cancelled', detail, secs }
  const [deploy, setDeploy] = useState(null)

  const [needsSetup, setNeedsSetup] = useState(false)
  const [su, setSu] = useState('')
  const [sp, setSp] = useState('')
  const [sp2, setSp2] = useState('')
  // sbt = setup-bootstrap-token. Pre-fill from `?token=…` so the
  // install.sh-printed URL drops the operator straight into the claim
  // form with only a username + password left to enter. The param is
  // stripped from the URL on successful setup so a refresh doesn't try
  // to claim again (see doSetup below).
  const [sbt, setSbt] = useState(() => {
    try { return new URLSearchParams(location.search).get('token') || '' }
    catch { return '' }
  })
  const [setupLoading, setSetupLoading] = useState(false)

  const [setupDone, setSetupDone] = useState(() => localStorage.getItem('kubeSetupDone') === '1')
  const [kubeconfigText, setKubeconfigText] = useState('')
  const [uploadLoading, setUploadLoading] = useState(false)

  // Initialize view/selectedGame from the URL hash so deep-linking and refresh
  // keep you on the same page.
  const initial = parseHash()
  const [view, setView] = useState(initial.view)
  const [selectedGame, setSelectedGame] = useState(initial.selectedGame)
  // First-run nudge: if no Storage Locations exist yet, land the operator on
  // the Storage page (games can't save without one). They can Skip for now.
  const [storageFirstRun, setStorageFirstRun] = useState(false)

  const skipStorageNudge = () => {
    localStorage.setItem('gamectlStorageNudgeSkipped', '1')
    setStorageFirstRun(false)
    setView('hub')
  }

  useEffect(() => {
    if (!token || !setupDone) return
    if (localStorage.getItem('gamectlStorageNudgeSkipped') === '1') return
    let cancelled = false
    let tries = 0
    const check = () => {
      api.get('/storage/locations')
        .then(({ data }) => {
          if (cancelled) return
          if (!(data?.locations || []).length) {
            setStorageFirstRun(true)
            setView('storage')
          }
        })
        .catch(() => {
          // On a brand-new cluster the kube client may still be warming
          // up (/storage/locations 503s). Retry a few times instead of
          // silently giving up for the whole session.
          if (cancelled || tries++ >= 5) return
          setTimeout(check, 2000)
        })
    }
    check()
    return () => { cancelled = true }
  }, [token, setupDone])

  useEffect(() => {
    const t = getToken()
    if (t) {
      setToken(t)
      skipKubeIfConnected()
    } else {
      api.get('/auth/state')
        .then(({ data }) => setNeedsSetup(!!data?.needsSetup))
        .catch(() => {})
    }
  }, [])

  // Global auth-expiry handler. The axios client clears the token and fires
  // this event whenever a protected call 401s, so an expired session drops
  // the user straight back to the login screen with an explanation instead
  // of silently showing empty game lists.
  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null)
      setSelectedGame(null)
      setView('hub')
      setMsg('Your session expired — please log in again.')
    }
    window.addEventListener('gamectl:unauthorized', onUnauthorized)
    return () => window.removeEventListener('gamectl:unauthorized', onUnauthorized)
  }, [])

  // Keep the URL hash in sync with view + selectedGame so reload preserves
  // the page. We replace (not push) so each click in the nav doesn't pile
  // up a history entry per-letter / per-tab-flip.
  useEffect(() => {
    const next = buildHash(view, selectedGame)
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', next)
    }
  }, [view, selectedGame])

  // Listen for browser back/forward so navigating via the address bar /
  // back button updates the React state.
  useEffect(() => {
    const onHash = () => {
      const next = parseHash()
      setView(next.view)
      setSelectedGame(next.selectedGame)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Poll the in-flight deploy task. While running, surface phase progress;
  // on completion (pass OR fail) flip to a 5s countdown that forwards to
  // the game's dashboard — success to use it, failure to see the crash /
  // diagnostics and retry. Either way the user lands where the action is.
  useEffect(() => {
    if (!deploy?.taskId || deploy.status !== 'running') return
    let cancelled = false
    let timer
    const tick = async () => {
      try {
        const { data } = await api.get(`/tasks/${deploy.taskId}`)
        if (cancelled) return
        if (data.status === 'succeeded') {
          setDeploy(d => d && { ...d, status: 'succeeded', secs: 5 })
        } else if (data.status === 'failed' || data.status === 'cancelled') {
          setDeploy(d => d && {
            ...d,
            status: data.status,
            secs: 5,
            detail: data.error || 'see Tasks for details',
          })
        } else {
          const phases = data.phases || []
          const done = phases.filter(p => p.status === 'succeeded').length
          const cur = phases.find(p => p.status === 'running')
          setDeploy(d => d && { ...d, detail: `${done}/${phases.length}${cur ? ` · ${cur.name}` : ''}` })
          timer = setTimeout(tick, 1500)
        }
      } catch {
        if (!cancelled) timer = setTimeout(tick, 3000)
      }
    }
    tick()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [deploy?.taskId, deploy?.status])

  // Countdown → navigate to the game's manage screen, on success OR
  // failure (failure → land on the dashboard to inspect pods/logs and
  // redeploy).
  useEffect(() => {
    const done = deploy?.status === 'succeeded' || deploy?.status === 'failed' || deploy?.status === 'cancelled'
    if (!done) return
    if (deploy.secs <= 0) {
      const g = deploy.game
      setDeploy(null)
      setSelectedGame(g)
      setView('manage')
      return
    }
    const t = setTimeout(() => setDeploy(d => d && { ...d, secs: d.secs - 1 }), 1000)
    return () => clearTimeout(t)
  }, [deploy?.status, deploy?.secs])

  // Skip the kubeconfig screen when the backend already has a working
  // cluster client (in-cluster ServiceAccount — the normal deployment).
  const skipKubeIfConnected = async () => {
    try {
      const { data } = await api.get('/whoami')
      if (data?.kube?.connected) {
        localStorage.setItem('kubeSetupDone', '1')
        setSetupDone(true)
      }
    } catch { /* leave the screen as-is on error */ }
  }

  const login = async (e) => {
    e.preventDefault()
    if (loggingIn) return // ignore Enter-mashing; don't pile up bcrypt requests
    setMsg('')
    setLoggingIn(true)
    const form = new URLSearchParams({ username: u || 'x', password: p || 'x' })
    try {
      const { data } = await api.post('/token', form, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      })
      saveToken(data.access_token)
      setToken(data.access_token)
      await skipKubeIfConnected()
    } catch (err) {
      setMsg(err.message)
    } finally {
      setLoggingIn(false)
    }
  }

  const doSetup = async (e) => {
    e.preventDefault()
    setMsg('')
    if (sp.length < 8) { setMsg('Password must be at least 8 characters'); return }
    if (sp !== sp2) { setMsg('Passwords do not match'); return }
    setSetupLoading(true)
    try {
      const { data } = await api.post('/auth/setup', {
        bootstrapToken: sbt.trim(),
        username: su.trim(),
        password: sp,
      })
      if (data?.access_token) {
        saveToken(data.access_token)
        setToken(data.access_token)
        await skipKubeIfConnected()
      }
      // Admin now exists: leave setup mode regardless (login if no token).
      setNeedsSetup(false)
      setSp(''); setSp2(''); setSbt('')
      // Strip ?token=<bootstrap> from the URL — it's been consumed by
      // the claim handler and a refresh would otherwise re-attempt
      // with the now-dead token.
      try { history.replaceState({}, '', location.pathname + location.hash) } catch {}
    } catch (err) {
      setMsg(err.message || 'Setup failed')
    } finally {
      setSetupLoading(false)
    }
  }

  const logout = () => {
    saveToken(null)
    setToken(null)
    setMsg('')
    localStorage.removeItem('kubeSetupDone')
    localStorage.removeItem('gamectlStorageNudgeSkipped')
    setSetupDone(false)
    setView('hub')
    setSelectedGame(null)
  }

  const markSetupDone = () => {
    localStorage.setItem('kubeSetupDone', '1')
    setSetupDone(true)
  }

  const uploadKubeconfig = async (e) => {
    e.preventDefault()
    if (!kubeconfigText.trim()) { setMsg('Kubeconfig content is required'); return }
    setUploadLoading(true)
    setMsg('')
    try {
      await api.post('/kube/kubeconfig', { kubeconfig: kubeconfigText })
      markSetupDone()
    } catch (err) {
      setMsg(err.message || 'Failed to store kubeconfig')
    } finally {
      setUploadLoading(false)
    }
  }

  const handleKubeconfigFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setKubeconfigText(await file.text())
  }

  const selectGame = (game) => {
    setSelectedGame(game)
    setView('manage')
  }

  const startDeploy = (game) => {
    setSelectedGame(game)
    setView('deploy')
  }

  // --- First-run admin setup screen ---
  if (!token && needsSetup) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="flex flex-col items-center gap-3 mb-5">
            <img src="/brand/gamectl-logo.png" alt="GameCTL" className="h-28" />
            <h1 className="text-2xl font-semibold">First-run setup</h1>
            <p className="text-sm text-slate-300 text-center">
              No admin exists yet. Create one to finish securing this instance.
              Paste the one-time <span className="font-medium">bootstrap token</span> from
              the server log:
              <code className="block mt-1 text-xs text-slate-400">
                kubectl -n gamectl logs deploy/gamectl | grep -i "BOOTSTRAP TOKEN"
              </code>
            </p>
          </div>
          <form onSubmit={doSetup} className="space-y-4">
            <input
              className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="Bootstrap token"
              value={sbt}
              onChange={e => setSbt(e.target.value)}
              autoComplete="off"
            />
            <input
              className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="New admin username"
              value={su}
              onChange={e => setSu(e.target.value)}
              autoComplete="username"
            />
            <input
              type="password"
              className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="New password (min 8 chars)"
              value={sp}
              onChange={e => setSp(e.target.value)}
              autoComplete="new-password"
            />
            <input
              type="password"
              className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="Confirm password"
              value={sp2}
              onChange={e => setSp2(e.target.value)}
              autoComplete="new-password"
            />
            <button
              disabled={setupLoading}
              className="w-full px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium disabled:opacity-50"
            >
              {setupLoading ? 'Creating…' : 'Create admin & sign in'}
            </button>
          </form>
          {msg && <p className="mt-4 text-sm text-center text-rose-300">{msg}</p>}
        </div>
      </div>
    )
  }

  // --- Login screen ---
  if (!token) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-slate-900 p-6">
          <div className="flex flex-col items-center gap-3 mb-6">
            <img src="/brand/gamectl-logo.png" alt="GameCTL" className="h-32" />
            <h1 className="text-2xl font-semibold">GameCTL</h1>
          </div>
          <form onSubmit={login} className="space-y-4">
            <input
              className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="Username"
              value={u}
              onChange={e => setU(e.target.value)}
            />
            <input
              type="password"
              className="w-full form-input rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="Password"
              value={p}
              onChange={e => setP(e.target.value)}
            />
            <button
              disabled={loggingIn}
              className="w-full px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-medium disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {loggingIn ? 'Signing in…' : 'Login'}
            </button>
          </form>
          {msg && <p className="mt-4 text-sm text-center text-rose-300">{msg}</p>}
        </div>
      </div>
    )
  }

  // --- Kubeconfig setup screen ---
  if (!setupDone) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center px-4">
        <div className="w-full max-w-3xl rounded-2xl border border-slate-800 bg-slate-900 p-6 space-y-6">
          <div>
            <h2 className="text-2xl font-semibold mb-2">Connect to Kubernetes</h2>
            <p className="text-sm text-slate-300">
              Paste or upload a kubeconfig with access to your cluster.
            </p>
          </div>
          <form onSubmit={uploadKubeconfig} className="flex flex-col gap-3">
            <textarea
              className="min-h-[160px] form-textarea rounded-lg border-slate-700 bg-slate-800 text-slate-100"
              placeholder="Paste kubeconfig YAML here"
              value={kubeconfigText}
              onChange={e => setKubeconfigText(e.target.value)}
              disabled={uploadLoading}
            />
            <input
              type="file"
              accept=".yaml,.yml,.conf"
              onChange={handleKubeconfigFile}
              className="text-sm text-slate-300"
              disabled={uploadLoading}
            />
            <button
              type="submit"
              disabled={uploadLoading}
              className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-50"
            >
              {uploadLoading ? 'Saving…' : 'Save kubeconfig'}
            </button>
          </form>
          <div className="flex gap-3">
            <button onClick={markSetupDone} className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700">
              Skip / Already configured
            </button>
            <button onClick={logout} className="px-4 py-2 rounded-lg bg-slate-900 border border-slate-800 hover:bg-slate-800">
              Logout
            </button>
          </div>
          {msg && <p className="text-sm text-rose-300">{msg}</p>}
        </div>
      </div>
    )
  }

  // --- Main app ---
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-4">
          <button onClick={() => { setView('hub'); setSelectedGame(null) }}>
            <img src="/brand/gamectl-logo.png" alt="GameCTL" className="h-16 w-auto" />
          </button>

          {/* Breadcrumb */}
          <nav className="flex items-center gap-1 text-sm text-slate-400">
            <button onClick={() => { setView('hub'); setSelectedGame(null) }} className="hover:text-slate-100">
              Games
            </button>
            {selectedGame && (
              <>
                <span>/</span>
                <span className="text-slate-100">{selectedGame.name}</span>
              </>
            )}
            {view === 'deploy' && <><span>/</span><span className="text-slate-100">Deploy</span></>}
          </nav>

          {/* Secondary nav */}
          <div className="ml-auto flex items-center gap-2">
            <DevBadge />
            <UpdateCheckButton />
            <TasksMenu />
            <button
              onClick={() => { setView('storage'); setSelectedGame(null) }}
              className={`px-3 py-1.5 rounded-lg text-sm border ${view === 'storage' ? 'bg-slate-800 border-slate-600' : 'border-transparent hover:bg-slate-800'}`}
            >
              Storage
            </button>
            <button
              onClick={logout}
              className="px-3 py-1.5 rounded-lg text-sm bg-slate-800 hover:bg-slate-700 border border-slate-700"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <UpdateBanner />

      {deploy && (
        <div className="max-w-6xl mx-auto px-4 pt-4">
          {deploy.status === 'running' && (
            <div className="rounded-lg border border-sky-800 bg-sky-950 px-4 py-3 text-sm text-sky-200 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
              <span className="flex-1">
                Deploying <strong>{deploy.game?.name}</strong>… <span className="text-sky-400/80">{deploy.detail}</span>
              </span>
              <button onClick={() => setDeploy(null)} className="text-sky-400 hover:text-sky-200 text-xs">dismiss</button>
            </div>
          )}
          {deploy.status === 'succeeded' && (
            <div className="rounded-lg border border-emerald-800 bg-emerald-950 px-4 py-3 text-sm text-emerald-200 flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              <span className="flex-1">
                <strong>{deploy.game?.name}</strong> deployed — opening its dashboard in {deploy.secs}s…
              </span>
              <button
                onClick={() => { const g = deploy.game; setDeploy(null); setSelectedGame(g); setView('manage') }}
                className="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs font-medium"
              >
                Go now
              </button>
              <button onClick={() => setDeploy(null)} className="text-emerald-400 hover:text-emerald-200 text-xs">stay</button>
            </div>
          )}
          {(deploy.status === 'failed' || deploy.status === 'cancelled') && (
            <div className="rounded-lg border border-rose-800 bg-rose-950 px-4 py-3 text-sm text-rose-200 flex items-center gap-3">
              <span className="h-2 w-2 rounded-full bg-rose-400" />
              <span className="flex-1">
                <strong>{deploy.game?.name}</strong> deploy {deploy.status} — {deploy.detail}.
                {' '}Opening the dashboard to inspect &amp; retry in {deploy.secs}s…
              </span>
              <button
                onClick={() => { const g = deploy.game; setDeploy(null); setSelectedGame(g); setView('manage') }}
                className="px-2.5 py-1 rounded-lg bg-rose-800 hover:bg-rose-700 text-xs font-medium"
              >
                Go now
              </button>
              <button onClick={() => setDeploy(null)} className="text-rose-400 hover:text-rose-200 text-xs">stay</button>
            </div>
          )}
        </div>
      )}

      <main>
        {view === 'hub' && (
          <GameHub onSelectGame={selectGame} onDeploy={startDeploy} />
        )}

        {view === 'manage' && selectedGame && (
          <GameManage
            game={selectedGame}
            onBack={() => { setView('hub'); setSelectedGame(null) }}
            onDeploy={startDeploy}
          />
        )}

        {view === 'deploy' && selectedGame && (
          <div className="max-w-6xl mx-auto px-4 py-6">
            <div className="flex items-center gap-3 mb-6">
              <button
                onClick={() => setView('manage')}
                className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-sm"
              >
                ← Back
              </button>
              <h2 className="text-xl font-semibold">Deploy {selectedGame.name}</h2>
            </div>
            <GameWizard
              initialGame={selectedGame.id}
              onApply={async (yaml) => {
                const { data } = await api.post('/kube/apply', { yaml })
                if (data?.taskId) {
                  setDeploy({ taskId: data.taskId, game: selectedGame, status: 'running', detail: 'starting…' })
                }
                return data
              }}
            />
            {/* The Review step inside the wizard already shows the generated
                YAML — no need to render it twice. */}
          </div>
        )}


        {view === 'storage' && <StorageLocations firstRun={storageFirstRun} onSkip={skipStorageNudge} onContinue={skipStorageNudge} />}

      </main>
    </div>
  )
}
