#!/bin/sh
# build_editor.sh — regenera web/vendor/codemirror.bundle.js: o CodeMirror 6
# (versões fixas em tools/editor/package.json) empacotado com o esbuild num
# IIFE que define o global CM. O resultado é commitado: "make" não depende
# de npm nem de rede. Rodar só ao atualizar o editor; depois conferir
# web/vendor/LICENSES.md (versões) e "make test".
#
#   sh tools/build_editor.sh          (npm/npx do PATH; no WSL serve o do Windows)
#
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK="$ROOT/build/editor-src"
NPM=${NPM:-npm}
NPX=${NPX:-npx}

rm -rf "$WORK"
mkdir -p "$WORK"
cp "$ROOT/tools/editor/package.json" "$ROOT/tools/editor/entry.js" "$WORK/"
cd "$WORK"
$NPM install --no-audit --no-fund --loglevel=error
# Caminhos relativos: o npx do Windows chamado pelo WSL não entende /mnt/c.
$NPX --no-install esbuild entry.js --bundle --minify --format=iife --global-name=CM \
    --legal-comments=none --target=es2019 --charset=utf8 --outfile=codemirror.bundle.js
{
    printf '/* CodeMirror 6 (MIT, https://codemirror.net) empacotado por tools/build_editor.sh;\n'
    printf ' * versões e licença em web/vendor/LICENSES.md. Não editar. */\n'
    cat codemirror.bundle.js
} >"$ROOT/web/vendor/codemirror.bundle.js"
# Versões efetivamente instaladas (para o LICENSES.md).
for p in state view language commands search autocomplete lint; do
    node -e "console.log('@codemirror/$p', require('./node_modules/@codemirror/$p/package.json').version)"
done
node -e "console.log('@lezer/highlight', require('./node_modules/@lezer/highlight/package.json').version)"
node -e "console.log('@lezer/common', require('./node_modules/@lezer/common/package.json').version)"
node -e "console.log('style-mod', require('./node_modules/style-mod/package.json').version)"
node -e "console.log('w3c-keyname', require('./node_modules/w3c-keyname/package.json').version)"
node -e "console.log('crelt', require('./node_modules/crelt/package.json').version)"
node -e "console.log('esbuild', require('./node_modules/esbuild/package.json').version)"
wc -c "$ROOT/web/vendor/codemirror.bundle.js"
