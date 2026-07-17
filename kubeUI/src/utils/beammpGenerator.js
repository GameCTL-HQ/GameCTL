import yaml from 'js-yaml'

// BeamMP IS Linux-native and has a free AuthKey model, BUT the readily
// available image (ponbus/beammp) is a Pterodactyl-panel "egg": it's
// config-file driven (USER=container, /home/container, ServerConfig.toml),
// not env-driven, so plain k8s env injection won't configure it. Shipped
// as coming-soon to avoid a broken default until a clean, env/volume-
// configurable image (or a generated ServerConfig.toml ConfigMap) is wired.
export const defaultBeammpForm = {
  namespace: 'gamectl-beammp',
}

export function buildBeammpYaml(f = defaultBeammpForm) {
  const ns = 'gamectl' /* single-namespace: see the README */
  const note = '# BeamMP: Linux-native but the available image is a Pterodactyl egg (config-file driven). Needs a clean image or a generated ServerConfig.toml before enabling. No server YAML generated yet.'
  return `${note}\n---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${ns}\n`
}
