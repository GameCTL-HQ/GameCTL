import { useMemo, useState } from 'react'

function stripExt(path) {
  const i = path.lastIndexOf('.')
  const j = path.lastIndexOf('/')
  if (i > j) return path.slice(0, i)
  return path
}

function hasExt(path) {
  const i = path.lastIndexOf('.')
  const j = path.lastIndexOf('/')
  return i > j
}

export default function ImageWithFallback({ src, alt = '', className = '', exts = ['png','jpg','jpeg','svg','webp'], style, fallbackSrc }) {
  const candidates = useMemo(() => {
    if (!src) return fallbackSrc ? [fallbackSrc] : []
    const list = [src]
    // Remote URLs (e.g. a publisher's CDN) are exact — don't ext-swap them;
    // just fall back to the local placeholder if the fetch fails.
    const isRemote = /^https?:\/\//i.test(src)
    if (!isRemote) {
      const base = hasExt(src) ? stripExt(src) : src
      for (const e of exts) {
        const cand = `${base}.${e}`
        if (!list.includes(cand)) list.push(cand)
      }
    }
    if (fallbackSrc && !list.includes(fallbackSrc)) list.push(fallbackSrc)
    return list
  }, [src, exts, fallbackSrc])

  const [idx, setIdx] = useState(0)
  const [failed, setFailed] = useState(false)

  if (!candidates.length || failed) return null

  return (
    <img
      src={candidates[idx]}
      alt={alt}
      className={className}
      style={style}
      onError={() => {
        if (idx + 1 < candidates.length) setIdx(idx + 1)
        else setFailed(true)
      }}
    />
  )
}
