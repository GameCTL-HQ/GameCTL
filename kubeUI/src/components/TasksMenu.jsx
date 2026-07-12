import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client'

// Color stack mirrors the StatusPill in GameManage so the UI feels consistent.
const STATUS_STYLES = {
  pending:   { pill: 'bg-slate-800 text-slate-300 border-slate-700',         dot: 'bg-slate-500' },
  running:   { pill: 'bg-sky-950 text-sky-300 border-sky-900',               dot: 'bg-sky-400 animate-pulse' },
  succeeded: { pill: 'bg-emerald-950 text-emerald-300 border-emerald-900',   dot: 'bg-emerald-400' },
  failed:    { pill: 'bg-rose-950 text-rose-300 border-rose-900',            dot: 'bg-rose-400' },
  cancelled: { pill: 'bg-amber-950 text-amber-300 border-amber-900',         dot: 'bg-amber-400' },
}

function elapsed(start, end) {
  const a = new Date(start).getTime()
  const b = end ? new Date(end).getTime() : Date.now()
  const secs = Math.max(0, Math.round((b - a) / 1000))
  if (secs < 60) return `${secs}s`
  const m = Math.floor(secs / 60)
  return `${m}m ${secs - m * 60}s`
}

function StatusPill({ status }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium border ${s.pill}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {status}
    </span>
  )
}

function PhaseRow({ phase }) {
  const s = STATUS_STYLES[phase.status] || STATUS_STYLES.pending
  // A "rich" failure phase carries multi-line detail (helper pod log +
  // classified hint paragraph). Show the headline error inline and an
  // expander that opens the full block — operators can read mount.nfs's
  // actual stderr without leaving the task panel.
  const [open, setOpen] = useState(false)
  const failed = phase.status === 'failed'
  const hasRichDetail = failed && phase.detail && phase.detail.trim().length > 0
  return (
    <li className="py-1.5 border-t border-slate-800 first:border-t-0">
      <div className="grid grid-cols-[auto_1fr_auto] items-start gap-2">
        <span className={`h-2 w-2 rounded-full mt-1.5 ${s.dot}`} />
        <div className="min-w-0">
          <p className="text-xs text-slate-200" title={phase.name}>{phase.name}</p>
          {phase.detail && phase.status === 'running' && (
            <p className="text-[10px] text-slate-500">{phase.detail}</p>
          )}
          {phase.error && (
            <p className="text-[11px] text-rose-300 font-mono whitespace-pre-wrap break-words">{phase.error}</p>
          )}
          {hasRichDetail && (
            <button
              onClick={() => setOpen(v => !v)}
              className="mt-1 text-[10px] text-sky-300 hover:text-sky-200 underline underline-offset-2"
            >
              {open ? 'Hide details' : 'View details + helper-pod log'}
            </button>
          )}
        </div>
        <span className="text-[10px] text-slate-500 font-mono">
          {elapsed(phase.startedAt, phase.finishedAt)}
        </span>
      </div>
      {hasRichDetail && open && (
        <pre className="mt-1.5 ml-4 max-h-80 overflow-auto rounded-md border border-slate-800 bg-slate-950/70 p-2 text-[10px] leading-snug text-slate-300 whitespace-pre-wrap break-words font-mono">
{phase.detail}
        </pre>
      )}
    </li>
  )
}

// TaskDetailModal — a full-page overlay with the phase checklist. Polls
// /api/tasks/<id> every 1s while the task is still running, then stops.
// cancelTask POSTs the stop request; callers refresh from their own poll.
async function cancelTask(id) {
  try {
    await api.post(`/tasks/${id}/cancel`)
  } catch {
    /* 409 = already finished; the poll will reflect final state anyway */
  }
}

function TaskDetailModal({ taskId, onClose }) {
  const [task, setTask] = useState(null)
  const [err, setErr] = useState(null)
  const [stopping, setStopping] = useState(false)
  const [rerunning, setRerunning] = useState(false)
  const [activeId, setActiveId] = useState(taskId)

  useEffect(() => {
    let cancelled = false
    let timer = null
    const tick = async () => {
      try {
        const { data } = await api.get(`/tasks/${activeId}`)
        if (cancelled) return
        setTask(data)
        if (data.status === 'pending' || data.status === 'running') {
          timer = setTimeout(tick, 1000)
        }
      } catch (e) {
        if (!cancelled) setErr(e.response?.data?.detail || e.message)
      }
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [activeId])

  const rerun = async () => {
    setRerunning(true)
    setErr(null)
    try {
      const { data } = await api.post(`/tasks/${activeId}/rerun`)
      // Swap the modal over to the new task so the operator can watch
      // the retry stream without re-opening anything.
      if (data?.taskId) {
        setActiveId(data.taskId)
        setTask(null)
      }
    } catch (e) {
      setErr(e.response?.data?.detail || e.message)
    } finally {
      setRerunning(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-start justify-center pt-20 px-4" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-slate-900 p-6 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold text-slate-100">
              {task?.title || 'Task'}
            </h2>
            {task?.subject && (
              <p className="text-xs text-slate-400 font-mono truncate">{task.subject}</p>
            )}
          </div>
          {task && <StatusPill status={task.status} />}
          {task && (task.status === 'running' || task.status === 'pending') && (
            <button
              onClick={async () => { setStopping(true); await cancelTask(activeId) }}
              disabled={stopping}
              className="px-2.5 py-1 rounded-lg text-xs font-medium border border-rose-800 bg-rose-950 text-rose-300 hover:bg-rose-900 disabled:opacity-50"
            >
              {stopping ? 'Stopping…' : 'Stop'}
            </button>
          )}
          {task && task.rerunnable && (task.status === 'failed' || task.status === 'cancelled') && (
            <button
              onClick={rerun}
              disabled={rerunning}
              title="Re-run this task with the same input (e.g. retry an apply after fixing NFS perms)"
              className="px-2.5 py-1 rounded-lg text-xs font-medium border border-sky-800 bg-sky-950 text-sky-300 hover:bg-sky-900 disabled:opacity-50"
            >
              {rerunning ? 'Starting…' : 'Re-run'}
            </button>
          )}
          <button onClick={onClose} className="text-slate-400 hover:text-slate-100 text-xl leading-none">×</button>
        </div>

        {err && (
          <div className="mb-3 rounded-lg border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-300">{err}</div>
        )}
        {task?.error && (
          <div className="mb-3 rounded-lg border border-rose-800 bg-rose-950/40 px-3 py-2 text-xs text-rose-300 font-mono whitespace-pre-wrap">
            {task.error}
          </div>
        )}

        {!task ? (
          <p className="text-sm text-slate-400">Loading…</p>
        ) : task.phases.length === 0 ? (
          <p className="text-sm text-slate-400">No phases yet — task is pending.</p>
        ) : (
          <ul className="rounded-lg border border-slate-800 bg-slate-950 px-3 py-2">
            {task.phases.map((p, i) => <PhaseRow key={i} phase={p} />)}
          </ul>
        )}

        {task && (
          <div className="mt-4 flex items-center justify-between text-xs text-slate-500">
            <span>
              {task.finishedAt
                ? `Ran for ${elapsed(task.startedAt, task.finishedAt)} · done`
                : `Running for ${elapsed(task.startedAt)}`}
            </span>
            {task.startedBy && <span>by {task.startedBy}</span>}
          </div>
        )}
      </div>
    </div>
  )
}

// TasksMenu — the header dropdown. Always visible; shows running count
// when there are any, otherwise just the bell-style label.
export default function TasksMenu() {
  const [tasks, setTasks] = useState([])
  const [open, setOpen] = useState(false)
  const [detailId, setDetailId] = useState(null)
  const wrapperRef = useRef(null)

  // Poll /api/tasks. Fast cadence (2s) when any task is running, slower
  // (5s) when idle so we're not hammering for nothing.
  useEffect(() => {
    let cancelled = false
    let timer = null
    const tick = async () => {
      try {
        const { data } = await api.get('/tasks?limit=25')
        if (cancelled) return
        setTasks(data.tasks || [])
        const anyActive = (data.tasks || []).some(t => t.status === 'pending' || t.status === 'running')
        timer = setTimeout(tick, anyActive ? 2000 : 5000)
      } catch {
        timer = setTimeout(tick, 10000)
      }
    }
    tick()
    return () => { cancelled = true; if (timer) clearTimeout(timer) }
  }, [])

  // Click-away to close.
  useEffect(() => {
    if (!open) return
    const onDoc = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const runningCount = tasks.filter(t => t.status === 'pending' || t.status === 'running').length

  return (
    <>
      <div ref={wrapperRef} className="relative">
        <button
          onClick={() => setOpen(v => !v)}
          className={`px-3 py-1.5 rounded-lg text-sm border ${runningCount > 0 ? 'bg-sky-950 border-sky-900 text-sky-300' : 'bg-slate-800 hover:bg-slate-700 border-slate-700 text-slate-200'}`}
          title="Background tasks"
        >
          {runningCount > 0 ? (
            <span className="inline-flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-sky-400 animate-pulse" />
              {runningCount} running
            </span>
          ) : (
            'Tasks'
          )}
        </button>

        {open && (
          <div className="absolute right-0 mt-2 w-96 max-h-[60vh] overflow-y-auto rounded-xl border border-slate-700 bg-slate-900 shadow-2xl z-40">
            <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-300">Recent tasks</span>
              <span className="text-[10px] text-slate-500">
                {runningCount > 0 ? `${runningCount} running · auto-refreshing` : 'auto-refreshing'}
              </span>
            </div>
            {tasks.length === 0 ? (
              <p className="px-3 py-6 text-xs text-slate-500 text-center">No tasks yet.</p>
            ) : (
              <ul>
                {tasks.map(t => {
                  const phasesDone = t.phases.filter(p => p.status === 'succeeded').length
                  const phasesTotal = t.phases.length
                  const current = t.phases.find(p => p.status === 'running')
                  const active = t.status === 'running' || t.status === 'pending'
                  return (
                    <li key={t.id} className="border-b border-slate-800 last:border-b-0 flex items-stretch hover:bg-slate-800/50">
                      <button
                        onClick={() => { setDetailId(t.id); setOpen(false) }}
                        className="flex-1 min-w-0 text-left px-3 py-2"
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <StatusPill status={t.status} />
                          <span className="text-sm text-slate-200 truncate flex-1">{t.title}</span>
                          <span className="text-[10px] text-slate-500 font-mono">{elapsed(t.startedAt, t.finishedAt)}</span>
                        </div>
                        {t.subject && (
                          <p className="text-[11px] text-slate-500 font-mono truncate">{t.subject}</p>
                        )}
                        {phasesTotal > 0 && (
                          <p className="text-[11px] text-slate-400 mt-1 truncate">
                            {phasesDone}/{phasesTotal} {current ? `· ${current.name}` : 'phases'}
                          </p>
                        )}
                        {t.error && (
                          <p className="text-[11px] text-rose-300 mt-1 truncate" title={t.error}>{t.error}</p>
                        )}
                      </button>
                      {active && (
                        <button
                          onClick={() => cancelTask(t.id)}
                          title="Stop this task"
                          className="px-3 shrink-0 text-[11px] font-medium text-rose-300 hover:bg-rose-900/40 border-l border-slate-800"
                        >
                          Stop
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}
    </>
  )
}
