import yaml from 'js-yaml'

// Unturned HAS a Linux dedicated server (anonymous SteamCMD, app 1110390),
// but there's no single canonical maintained container image to default to
// without guessing. Shipped as coming-soon to avoid a broken default;
// flip to a real generator once a verified image is chosen.
export const defaultUnturnedForm = {
  namespace: 'gamectl-unturned',
}

export function buildUnturnedYaml(f = defaultUnturnedForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Unturned: Linux server exists (SteamCMD app 1110390, anonymous) but needs a verified container image before enabling. No YAML generated yet.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
