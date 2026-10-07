/**
 * Двоичные изменения мира. Каждый тик меняются в основном места и повороты едущих — их сотни и тысячи, и в JSON
 * каждое стоило бы под сотню байт. Здесь движение идёт записями по 11–13 байт, а всё остальное, редкое, — JSON
 * следом. Кадр: тип (1 байт), тик (4), число записей движения (варинт), записи, остаток — JSON.
 * Запись: номер сущности (варинт), флаги (1 байт: есть ли поворот), x и y (int32, в 1/POSITION тайла),
 * поворот (int16, в 1/FACING радиана).
 */

/** Сколько долей тайла в единице координаты: 1/256 тайла глазу не видна. */
export const POSITION = 256
/** Сколько долей радиана в единице поворота: ±π укладывается в int16. */
export const FACING = 10000

const DELTA = 1
const HAS_FACING = 1

/** Движение сущности в целых единицах сети: x, y и поворот; null — поворота у сущности нет. */
export type Motion = [x: number, y: number, facing: number | null]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Место и поворот в единицах сети: их и сравнивает хост, и шлёт. */
export const quantize = (x: number, y: number, facing?: number): Motion => [
  Math.round(x * POSITION),
  Math.round(y * POSITION),
  facing === undefined ? null : Math.round(facing * FACING),
]

/** Собирает кадр изменений: motions — номер сущности и её движение; json — остальное. */
export function encodeDelta(tick: number, motions: [number, Motion][], json: string): Uint8Array {
  const text = encoder.encode(json)
  const bytes = new Uint8Array(1 + 4 + 5 + motions.length * 16 + text.length)
  const view = new DataView(bytes.buffer)
  let at = 0
  const varint = (value: number) => {
    while (value >= 0x80) {
      bytes[at++] = (value & 0x7f) | 0x80
      value >>>= 7
    }
    bytes[at++] = value
  }
  bytes[at++] = DELTA
  view.setUint32(at, tick)
  at += 4
  varint(motions.length)
  for (const [id, [x, y, facing]] of motions) {
    varint(id)
    bytes[at++] = facing === null ? 0 : HAS_FACING
    view.setInt32(at, x)
    view.setInt32(at + 4, y)
    at += 8
    if (facing !== null) {
      view.setInt16(at, facing)
      at += 2
    }
  }
  bytes.set(text, at)
  return bytes.subarray(0, at + text.length)
}

/** Разбирает кадр изменений. motion — номер, x, y и поворот подряд, уже в тайлах и радианах; поворота нет — NaN. */
export function decodeDelta(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let at = 0
  const varint = () => {
    let value = 0
    let shift = 0
    for (;;) {
      const byte = bytes[at++]
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
      shift += 7
    }
  }
  if (bytes[at++] !== DELTA) throw new Error('Неизвестный двоичный кадр')
  const tick = view.getUint32(at)
  at += 4
  const count = varint()
  const motion: number[] = new Array(count * 4)
  for (let i = 0; i < count; i++) {
    motion[i * 4] = varint()
    const flags = bytes[at++]
    motion[i * 4 + 1] = view.getInt32(at) / POSITION
    motion[i * 4 + 2] = view.getInt32(at + 4) / POSITION
    at += 8
    if (flags & HAS_FACING) {
      motion[i * 4 + 3] = view.getInt16(at) / FACING
      at += 2
    } else motion[i * 4 + 3] = NaN
  }
  const rest = JSON.parse(decoder.decode(bytes.subarray(at)))
  return { tick, motion, ...rest }
}
