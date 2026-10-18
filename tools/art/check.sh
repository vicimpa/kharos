#!/bin/zsh
# Сверка переноса графики: кадры чертежей из TS (tools/art/dump.ts) и из модов (apps/client/examples/looks.rs) должны
# совпасть до пикселя. Запуск из корня: tools/art/check.sh [раздел/вид…] — без видов сверяет все перенесённые.
# Код выхода — 0, только если совпали все.
cd "${0:A:h}/../.."
OUT=.cache/art
mkdir -p $OUT
KINDS=("$@")
if (( ${#KINDS} == 0 )); then
  KINDS=(${(f)"$(cd mods/base && ls units/*.luau turrets/*.luau | sed 's/\.luau$//'; ls -d buildings/*/ | sed 's|/$||')"})
fi
bun tools/art/dump.ts $OUT/ts.bin $KINDS || exit 1
cargo run -q -p kharos-client --release --example looks $OUT/mods.bin $KINDS || exit 1
python3 - $OUT/ts.bin $OUT/mods.bin <<'PY'
import json, sys
a, b = open(sys.argv[1], 'rb').read(), open(sys.argv[2], 'rb').read()
parts = json.load(open(sys.argv[1] + '.json'))
off, failed = 0, 0
for part in parts:
    name, frames, size = part['kind'], part['frames'], part['bytes']
    bad = [i for i in range(frames) if a[off + i * size:off + (i + 1) * size] != b[off + i * size:off + (i + 1) * size]]
    off += frames * size
    print(('OK  ' if not bad else 'FAIL') + f' {name}: {frames - len(bad)} из {frames} кадров совпали' + (f' (первый несовпавший — {bad[0]})' if bad else ''))
    failed += bool(bad)
if len(b) != off:
    print(f'FAIL размер: TS {off} байт, моды {len(b)}')
    failed += 1
sys.exit(1 if failed else 0)
PY
