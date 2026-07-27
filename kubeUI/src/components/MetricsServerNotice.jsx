import { useEffect, useState } from 'react'
import { api } from '../api/client'
import { copyText } from '../utils/clipboard'

// Fallback only — the server owns the canonical command
// (kube.MetricsServerInstallCommand) and ships it in the status payload.
const FALLBACK_CMD = 'kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml'

// MetricsServerNotice — the single place GameCTL tells an operator that
// CPU/RAM graphs need metrics-server, and hands them the command to install
// it. GameCTL does not install it itself: that needs cluster-scoped RBAC +
// an APIService, which its namespace-confined ServiceAccount deliberately
// cannot do (the README).
//
// Self-gating: it fetches the status and renders NOTHING unless the cluster
// positively cannot serve metrics. `unknown` (the check was blocked, e.g.
// by RBAC) also renders nothing — telling an operator to install something
// they may already have is worse than staying quiet.
export default function MetricsServerNotice({ variant = 'panel' }) {
  const [st, setSt] = useState(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    let stop = false
    api.get('/cluster/metrics-server')
      .then(r => { if (!stop) setSt(r.data) })
      .catch(() => {})
    return () => { stop = true }
  }, [])

  if (!st || st.available || st.unknown) return null

  const cmd = st.installCommand || FALLBACK_CMD
  const copy = async () => {
    const ok = await copyText(cmd)
    setMsg(ok ? 'Install command copied.' : 'Copy failed — select the command manually.')
  }

  // Installed but not serving is a different problem than not installed at
  // all — say which one it is, and pass the API server's own detail through
  // rather than making the operator go dig it out of kubectl.
  const lead = st.installed
    ? `metrics-server is installed but is not serving metrics yet${st.detail ? `: ${st.detail}` : '.'}`
    : 'This cluster does not have metrics-server, so GameCTL cannot show CPU and RAM usage for game servers.'
  const action = st.installed
    ? 'Give it a moment to become ready, or re-apply it:'
    : 'Install it on the cluster with your own kubectl credentials, then refresh:'

  const compact = variant === 'compact'

  return (
    <section className={compact
      ? 'mt-2 rounded border border-sky-900 bg-sky-950/30 p-2'
      : 'rounded-xl border border-sky-900 bg-sky-950/30 p-4'}>
      <p className={compact
        ? 'text-[11px] font-semibold text-sky-300'
        : 'text-sm font-semibold text-sky-300 mb-1'}>
        CPU and RAM graphs need metrics-server
      </p>
      <p className={compact ? 'mt-1 text-[11px] text-slate-300' : 'text-xs text-slate-300'}>
        {lead} {action}
      </p>
      <code className={compact
        ? 'mt-2 block overflow-x-auto rounded bg-slate-950 px-2 py-1.5 text-[10px] text-slate-200'
        : 'mt-2 block overflow-x-auto rounded bg-slate-950 px-3 py-2 text-[11px] text-slate-200'}>
        {cmd}
      </code>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <button
          onClick={copy}
          className={compact
            ? 'rounded bg-sky-600 px-2 py-1 text-[11px] font-medium text-white'
            : 'rounded bg-sky-600 px-3 py-1.5 text-xs font-medium text-white'}
        >
          Copy command
        </button>
        <span className={compact ? 'text-[10px] text-slate-500' : 'text-[11px] text-slate-500'}>
          The first CPU/RAM samples appear about 30 seconds after it becomes ready.
        </span>
        {msg && <span className={compact ? 'text-[10px] text-slate-400' : 'text-[11px] text-slate-400'}>{msg}</span>}
      </div>
    </section>
  )
}
