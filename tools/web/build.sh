#!/bin/zsh
# Клиент на Rust для браузера (Emscripten): tools/web/build.sh [профиль] — по умолчанию release. Кладёт в dist/rust-web
# страницу, клиент (kharos.js, kharos.wasm) и пакет модов (mods.data, mods.js). Посмотреть: tools/web/serve.sh.
#
# Luau под wasm собирается только Emscripten'ом и с исключениями wasm, а их Rust умеет пока на nightly:
# -Zemscripten-wasm-eh и пересборка std (rustup component add rust-src --toolchain nightly).
set -e
cd "${0:A:h}/../.."
PROFILE=${1:-release}
TARGET=wasm32-unknown-emscripten
OUT=dist/rust-web
RUSTFLAGS="-Zemscripten-wasm-eh" cargo +nightly build -p kharos-client --bin kharos --profile $PROFILE --target $TARGET -Zbuild-std=std,panic_unwind
mkdir -p $OUT
cp target/$TARGET/$PROFILE/kharos.js target/$TARGET/$PROFILE/kharos.wasm apps/client/web/index.html $OUT/
# Моды — отдельным пакетом: правка мода не пересобирает клиент.
python3 /opt/homebrew/opt/emscripten/libexec/tools/file_packager.py $OUT/mods.data --preload mods@/mods --js-output=$OUT/mods.js --quiet
ls -la $OUT
