import axios from 'axios';
import yaml from 'js-yaml';

export async function fetchYamlFiles(folderPath) {
  try {
    const { data } = await axios.get(`${folderPath}/index.json`);
    const yamlFiles = await Promise.all(
      data.files.map(async (file) => {
        const content = await axios.get(`${folderPath}/${file}`);
        return {
          name: file.replace(/\.(ya?ml)$/i, ''), // support .yaml and .yml
          content: content.data
        };
      })
    );
    return yamlFiles;
  } catch (err) {
    throw new Error(`Error fetching YAML files: ${err.message}`);
  }
}

// Parse a multi-doc YAML string into sections (one per K8s resource)
export function parseYamlSections(fileContent) {
  const sections = [];
  yaml.loadAll(fileContent, (doc) => {
    if (!doc) return;
    const kind = doc?.kind || 'Unknown';
    const name = doc?.metadata?.name || 'unnamed';
    const namespace = doc?.metadata?.namespace || '';
    sections.push({
      id: `${kind}:${namespace ? namespace + '/' : ''}${name}`,
      kind,
      name,
      namespace,
      content: yaml.dump(doc, { noRefs: true }),
      object: doc,
    });
  });
  return sections;
}

// Compose a multi-doc YAML from selected sections
export function buildYamlFromSections(sections) {
  return sections.map(s => s.content.trim()).join('\n---\n');
}

// Provide a default export as well (helps avoid named-export resolution issues)
export default {
  fetchYamlFiles,
  parseYamlSections,
  buildYamlFromSections,
};