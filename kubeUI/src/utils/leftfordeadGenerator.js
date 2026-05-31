import yaml from 'js-yaml'

// Left 4 Dead (1): Linux server is anonymous SteamCMD, but unlike L4D2
// there's no well-maintained turnkey container image to default to.
// Coming-soon stub until a verified image is chosen.
export const defaultLeftfordeadForm = {
  namespace: 'gamectl-leftfordead',
}

export function buildLeftfordeadYaml(f = defaultLeftfordeadForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Left 4 Dead (1): Linux server is SteamCMD-anonymous but lacks a maintained image. No YAML generated yet (L4D2 is available).'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
