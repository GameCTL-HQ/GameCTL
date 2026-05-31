import yaml from 'js-yaml'

// Sons of the Forest has NO native Linux dedicated server — Windows only
// (Wine/Proton). Coming-soon stub; falls under the Windows/Proton roadmap
// item. Emits only the namespace so nothing broken is applied.
export const defaultSonsoftheforestForm = {
  namespace: 'gamectl-sonsoftheforest',
}

export function buildSonsoftheforestYaml(f = defaultSonsoftheforestForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Sons of the Forest: Windows-only dedicated server (needs Wine/Proton). No Linux-native YAML generated.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
