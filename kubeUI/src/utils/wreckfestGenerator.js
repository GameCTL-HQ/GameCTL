export const defaultWreckfestForm = {
  namespace: 'gamectl-wreckfest',
}

export function buildWreckfestYaml(f = defaultWreckfestForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# Wreckfest usually needs Windows Server or Proton/Wine. No Linux native dedicated server YAML generated.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
