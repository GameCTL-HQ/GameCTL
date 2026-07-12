import yaml from 'js-yaml'

// Left 4 Dead 2 IS anonymous-SteamCMD and Linux-capable, but no verified
// TURNKEY image found yet: sourceservers/left4dead2 has an empty Cmd
// (entrypoint /bin/bash -c with nothing) so it exits 0 instantly, and a
// PVC at its /server WorkingDir hides the 5GB install. Needs a real
// auto-starting srcds image (or an explicit run command + non-overlaying
// mount). Coming-soon stub until then — no broken default.
export const defaultLeft4dead2Form = {
  namespace: 'gamectl-left4dead2',
}

export function buildLeft4dead2Yaml(f = defaultLeft4dead2Form) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Left 4 Dead 2: anonymous SteamCMD + Linux-capable, but no verified turnkey image yet (sourceservers/left4dead2 has no auto-start Cmd). No server YAML generated until a working image is wired.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
