import yaml from 'js-yaml'

// Abiotic Factor's dedicated server is Windows-only (Wine/Proton). No
// native Linux build — coming-soon stub under the Windows/Proton roadmap.
export const defaultAbioticfactorForm = {
  namespace: 'gamectl-abioticfactor',
}

export function buildAbioticfactorYaml(f = defaultAbioticfactorForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Abiotic Factor: Windows-only dedicated server (needs Wine/Proton). No Linux-native YAML generated.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
