# GameCtlRtv — two-stage Rock-The-Vote plugin

A CounterStrikeSharp plugin for the kus `cs2-modded-server` image. `!rtv` runs
a **two-stage vote**: stage 1 picks a game mode, stage 2 picks a map of that
mode. Most votes wins; ties (and the no-votes case) break at random.

It exists because GameModeManager's built-in RTV couldn't reliably resolve the
maps in its pool. GameCTL disables GameModeManager's RTV (see
`kubeUI/src/utils/cs2GameModeManager.js`) and ships this instead.

## Layout

- `GameCtlRtv.cs` — the plugin (single file).
- `GameCtlRtv.csproj` — builds against `CounterStrikeSharp.API` 1.0.367, the
  version the kus image runs.
- The mode/map catalog and vote tuning live in
  `kubeUI/src/utils/cs2RtvCatalog.js` — **that** is the source of truth for
  what modes/maps appear. The plugin just reads the JSON GameCTL generates
  from it (`addons/counterstrikesharp/configs/plugins/GameCtlRtv/GameCtlRtv.json`).

## How it ships

GameCTL's CS2 generator (`cs2Generator.js`) writes the plugin into the
`custom_files` overlay:

- the compiled DLL — base64-embedded in `cs2RtvPluginDll.js`, decoded into
  `addons/counterstrikesharp/plugins/GameCtlRtv/GameCtlRtv.dll`;
- the config — generated from `cs2RtvCatalog.js`;
- `subscribed_file_ids.txt` — the catalog's workshop IDs, so the kus image
  pre-downloads every RTV map at boot.

## Rebuild (only when GameCtlRtv.cs changes)

```sh
cd cs2-plugin
~/.dotnet/dotnet build -c Release          # -> bin/Release/GameCtlRtv.dll
# regenerate the base64 the generator ships:
node --input-type=module -e "import('node:fs').then(fs=>{ \
  const b64=fs.readFileSync('bin/Release/GameCtlRtv.dll').toString('base64'); \
  const f='../kubeUI/src/utils/cs2RtvPluginDll.js'; \
  const hdr=fs.readFileSync(f,'utf8').split('export const')[0]; \
  fs.writeFileSync(f, hdr+'export const GAMECTL_RTV_DLL_BASE64 =\n  '+JSON.stringify(b64)+'\n'); })"
```

Changing only the catalog (`cs2RtvCatalog.js`) needs **no rebuild** — the
generator re-emits the config and the pre-download list on the next deploy.
