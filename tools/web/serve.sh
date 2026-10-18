#!/bin/zsh
# Раздаёт браузерную сборку клиента на Rust (tools/web/build.sh): tools/web/serve.sh [порт] — по умолчанию 8090.
cd "${0:A:h}/../../dist/rust-web"
exec python3 -m http.server ${1:-8090} --bind 127.0.0.1
