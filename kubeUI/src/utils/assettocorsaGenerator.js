import yaml from 'js-yaml'

// Assetto Corsa's dedicated server is Windows-native (commonly run via
// Wine/Proton). No clean Linux-native build — coming-soon stub under the
// Windows/Proton roadmap.
export const defaultAssettocorsaForm = {
  namespace: 'gamectl-assettocorsa',
}

export function buildAssettocorsaYaml(f = defaultAssettocorsaForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Assetto Corsa: Windows-native dedicated server (needs Wine/Proton). No Linux-native YAML generated.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
