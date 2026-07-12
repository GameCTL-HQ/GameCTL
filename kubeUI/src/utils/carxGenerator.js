export const defaultCarxForm = {
  namespace: 'gamectl-carx',
}

export function buildCarxYaml(f = defaultCarxForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# CarX dedicated servers may require Windows/Proton; Linux container recipes vary. Stub only.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
