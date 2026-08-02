#!/usr/bin/env bash
# build-plugins.sh — rebuild the CounterStrikeSharp plugins and re-embed their
# DLLs into the kubeUI generator (kubeUI/src/utils/cs2*PluginDll.js).
#
# WHY THIS EXISTS: GameCTL ships each plugin DLL as base64 embedded in a .js
# the cs2 generator writes into the server overlay. The DLL and the .cs source
# can silently drift — build a plugin but forget to re-embed and every deploy
# ships a STALE plugin. That's exactly what hid recent surf !replay/!ghostcam
# and RTV work behind old builds (live servers ran 30–36 KB DLLs while the
# source built to 60 KB). This script rebuilds + re-embeds in one step, and
# --check gates deploys so a stale embed can't ship.
#
# Usage:
#   scripts/build-plugins.sh            # rebuild all plugins and re-embed
#   scripts/build-plugins.sh --check    # fail (exit 1) if any embed's size
#                                        # != a fresh build (deploy/CI gate)
#
# NOTE: the .NET build is not byte-reproducible across separate compiles (the
# MVID/debug hash varies), so --check compares the *decoded DLL size*, which is
# stable and reliably catches a forgotten re-embed.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$ROOT"
DOTNET="${DOTNET:-$HOME/.dotnet/dotnet}"
[ -x "$DOTNET" ] || DOTNET="$(command -v dotnet || true)"
[ -n "$DOTNET" ] && [ -x "$DOTNET" ] || { echo "build-plugins: dotnet not found (set \$DOTNET)" >&2; exit 2; }

CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1

# name | csproj | built-dll | embed-js
PLUGINS=(
  "GameCtlRtv|cs2-plugin/GameCtlRtv.csproj|cs2-plugin/bin/Release/GameCtlRtv.dll|kubeUI/src/utils/cs2RtvPluginDll.js"
  "GameCtlSurfHUD|cs2-plugin/GameCtlSurfHUD/GameCtlSurfHUD.csproj|cs2-plugin/GameCtlSurfHUD/bin/Release/GameCtlSurfHUD.dll|kubeUI/src/utils/cs2SurfHudPluginDll.js"
  "GameCtlDmRounds|cs2-plugin/GameCtlDmRounds/GameCtlDmRounds.csproj|cs2-plugin/GameCtlDmRounds/bin/Release/GameCtlDmRounds.dll|kubeUI/src/utils/cs2DmRoundsPluginDll.js"
)

# decoded byte length of the base64 embedded in a *PluginDll.js (tolerates the
# `\n<b64>\n` and `<b64>` template-literal variants).
embed_size() {
  node -e '
    const fs=require("fs");
    const s=fs.readFileSync(process.argv[1],"utf8");
    const m=s.match(/=\s*`\n?([\s\S]*?)\n?`/);
    if(!m){console.error("no embed template in "+process.argv[1]);process.exit(3);}
    process.stdout.write(String(Buffer.from(m[1].replace(/\s/g,""),"base64").length));
  ' "$1"
}

stale=0
for spec in "${PLUGINS[@]}"; do
  IFS='|' read -r name csproj dll js <<<"$spec"
  echo ">> $name: building"
  "$DOTNET" build -c Release "$csproj" -v q --nologo >/dev/null
  [ -f "$dll" ] || { echo "   ERROR: built DLL not found at $dll" >&2; exit 2; }
  bsz=$(stat -c %s "$dll")

  if [ "$CHECK" -eq 1 ]; then
    esz=$(embed_size "$js")
    if [ "$esz" = "$bsz" ]; then
      echo "   ok — embed $esz B matches fresh build"
    else
      echo "   STALE — $js embeds ${esz} B but a fresh build is ${bsz} B"
      stale=1
    fi
  else
    node -e '
      const fs=require("fs");
      // node -e argv is [node, ...args] — there is NO script-path slot, so the
      // passed args start at argv[1]. (Skipping two here left js=undefined and
      // crashed the re-embed.)
      const [,dll,js]=process.argv;
      const b64=fs.readFileSync(dll).toString("base64").match(/.{1,76}/g).join("\n");
      let s=fs.readFileSync(js,"utf8");
      if(!/=\s*`\n?[\s\S]*?\n?`/.test(s)){console.error("no embed template in "+js);process.exit(3);}
      s=s.replace(/(=\s*`)\n?[\s\S]*?\n?(`)/, "$1\n"+b64+"\n$2");
      fs.writeFileSync(js,s);
    ' "$dll" "$js"
    echo "   re-embedded -> $js (${bsz} B)"
  fi
done

if [ "$CHECK" -eq 1 ] && [ "$stale" -ne 0 ]; then
  echo >&2
  echo "!! plugin embed(s) STALE. Run:  scripts/build-plugins.sh   then commit the" >&2
  echo "   updated kubeUI/src/utils/cs2*PluginDll.js" >&2
  exit 1
fi
echo "build-plugins: done"
