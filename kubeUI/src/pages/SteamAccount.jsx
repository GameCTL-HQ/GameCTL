import { useEffect, useState } from 'react'
import { api } from '../api/client'

// Shared Steam account for Steam-gated game servers that can't use
// anonymous SteamCMD (e.g. DayZ; Workshop content later). Write-only:
// the password is sent once and never read
// back — the page only ever shows whether it's configured + the username.
export default function SteamAccount() {
  const [status, setStatus] = useState(null) // { configured, username }
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  const load = () =>
    api.get('/steam/credentials')
      .then(({ data }) => { setStatus(data); setUsername(data?.username || '') })
      .catch(e => setErr(e.response?.data?.detail || e.message))

  useEffect(() => { load() }, [])

  const save = async () => {
    setBusy(true); setMsg(''); setErr('')
    try {
      await api.put('/steam/credentials', { username: username.trim(), password })
      setPassword('')
      setMsg('Saved. Stored as a write-only Secret in your cluster.')
      await load()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Save failed')
    } finally { setBusy(false) }
  }

  const clear = async () => {
    setBusy(true); setMsg(''); setErr('')
    try {
      await api.delete('/steam/credentials')
      setUsername(''); setPassword('')
      setMsg('Removed.')
      await load()
    } catch (e) {
      setErr(e.response?.data?.detail || e.message || 'Remove failed')
    } finally { setBusy(false) }
  }

  const inp = 'form-input w-full rounded-lg border-slate-700 bg-slate-800 text-slate-100 text-sm'

  return (
    <div className="max-w-2xl mx-auto px-4 py-6">
      <h2 className="text-xl font-semibold mb-1">Steam Account</h2>
      <p className="text-sm text-slate-400 mb-4">
        One shared Steam login for game servers that can't use anonymous
        SteamCMD (e.g. DayZ; more, and Workshop content, later). It's saved
        as a write-only Kubernetes Secret in the <code className="text-slate-300">gamectl</code>
        {' '}namespace, referenced by deployments via <code className="text-slate-300">secretKeyRef</code> —
        never shown again here and never written into any manifest/YAML.
      </p>

      <div className="rounded-lg border border-amber-700 bg-amber-950/40 px-4 py-3 mb-5 text-xs text-amber-200/90 space-y-1">
        <div className="font-medium text-amber-100">Read this before saving</div>
        <ul className="list-disc ml-4 space-y-0.5">
          <li>The account must <strong>own the game</strong> (e.g. DayZ) — a blank Steam account can log in but won't be entitled to download the server.</li>
          <li>Use a <strong>dedicated secondary account</strong>, never your main one.</li>
          <li><strong>Disable Steam Guard 2FA</strong> on it — headless SteamCMD can't complete a 2FA prompt.</li>
          <li>Storage is base64 + namespaced RBAC, write-only here, never in YAML. For true at-rest encryption, enable etcd encryption-at-rest on your cluster.</li>
        </ul>
      </div>

      {status && (
        <p className="text-sm mb-3">
          Status:{' '}
          {status.configured
            ? <span className="text-emerald-400">configured ✓ (user <code className="text-slate-300">{status.username}</code>)</span>
            : <span className="text-slate-400">not configured</span>}
        </p>
      )}

      <div className="space-y-3">
        <label className="block text-sm">
          <span className="text-slate-300">Steam username</span>
          <input className={inp} value={username} autoComplete="off"
            onChange={e => setUsername(e.target.value)} placeholder="dedicated-account-name" />
        </label>
        <label className="block text-sm">
          <span className="text-slate-300">Steam password {status?.configured && <span className="text-slate-500">(leave blank to keep current)</span>}</span>
          <input className={inp} type="password" value={password} autoComplete="new-password"
            onChange={e => setPassword(e.target.value)} placeholder="••••••••" />
        </label>

        <div className="flex items-center gap-2 pt-1">
          <button
            onClick={save}
            disabled={busy || !username.trim() || !password}
            className="px-4 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-sm font-medium disabled:opacity-50"
          >{busy ? 'Saving…' : 'Save'}</button>
          {status?.configured && (
            <button
              onClick={clear} disabled={busy}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/60 border border-slate-700 text-rose-300 text-sm disabled:opacity-50"
            >Remove</button>
          )}
          {msg && <span className="text-sm text-emerald-300">{msg}</span>}
          {err && <span className="text-sm text-rose-300">{err}</span>}
        </div>
      </div>
    </div>
  )
}
