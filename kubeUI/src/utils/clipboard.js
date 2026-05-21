// Robust copy-to-clipboard helper. The browser's Clipboard API
// (navigator.clipboard.writeText) only works in secure contexts —
// HTTPS or localhost. GameCTL is commonly accessed over plain HTTP
// at a LAN IP (e.g. http://10.0.0.73:8080), where the API is
// undefined and a silent no-op was the previous behavior. This
// helper tries the modern API first and falls back to a
// document.execCommand('copy') textarea trick for non-secure
// contexts so copy still works on http:// URLs.
//
// Returns a Promise<boolean> resolving to true on success, false
// otherwise. Never throws.
export async function copyText(text) {
  if (text == null) return false
  const str = String(text)
  if (!str) return false

  // 1. Modern Clipboard API — works on HTTPS/localhost and is the
  //    only option when the user requires permissions prompting.
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(str)
      return true
    } catch {
      // Fall through to the legacy fallback (some browsers reject
      // writeText in non-secure contexts even though it exists).
    }
  }

  // 2. Legacy fallback — works on http://lan-ip in every browser
  //    that still ships document.execCommand. The textarea is
  //    positioned off-screen so the user never sees a flash.
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = str
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.left = '0'
    ta.style.opacity = '0'
    ta.style.pointerEvents = 'none'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    ta.setSelectionRange(0, str.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok === true
  } catch {
    return false
  }
}
