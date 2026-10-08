import { SAVE_VERSION, type SimSave } from '../sim'

/**
 * Двоичный файл сохранения: один формат для браузера, воркера и сервера.
 *
 * Файл: "KHRS" (4 байта), версия формата (uint16), затем тело, сжатое deflate. Тело — разделы подряд:
 * тег (4 байта ASCII), длина (uint32), данные. Незнакомые разделы загрузка пропускает, так что новая версия
 * может добавить раздел, не ломая чтение. Числа — little-endian.
 *
 * Разделы сейчас: META — параметры мира и тик (JSON), WRLD — сущности (JSON-снимок), EXPL — разведанное (JSON),
 * LAND — карта мира (см. saveLand в terrain.ts).
 * Вызывающий может добавить свои (extras) — например, сервер кладёт игроков, а файл экспорта — название слота.
 *
 * Старые файлы поднимаются до текущей версии цепочкой MIGRATIONS: каждая миграция переводит разделы из версии v
 * в v + 1. Самая старая читаемая версия — FIRST_BINARY_VERSION: раньше сохранения были JSON, их не переносим.
 */

const MAGIC = 'KHRS'
/** Первая двоичная версия сохранения. Всё, что старше, — прежний JSON, его загрузка отвергает. */
export const FIRST_BINARY_VERSION = 20

/** Разделы файла по тегам. */
export type Sections = Map<string, Uint8Array>

/** Перевод разделов из версии v в v + 1, по ключу v. Меняет разделы на месте. */
const MIGRATIONS: Record<number, (sections: Sections) => void> = {}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const jsonSection = (value: unknown) => encoder.encode(JSON.stringify(value))
export const readJson = <T>(bytes: Uint8Array | undefined): T | undefined => (bytes ? (JSON.parse(decoder.decode(bytes)) as T) : undefined)

/** Сжатие deflate: тем же, что тело файла, хост сжимает карту для клиентов. */
export const deflate = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('deflate-raw'))
export const inflate = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('deflate-raw'))

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  return new Uint8Array(await new Response(new Response(bytes as Uint8Array<ArrayBuffer>).body!.pipeThrough(stream)).arrayBuffer())
}

/** Собирает файл из разделов. */
export async function packSections(sections: Sections, version = SAVE_VERSION): Promise<Uint8Array> {
  let size = 0
  for (const [, data] of sections) size += 8 + data.length
  const body = new Uint8Array(size)
  const view = new DataView(body.buffer)
  let at = 0
  for (const [tag, data] of sections) {
    if (tag.length !== 4) throw new Error(`Тег раздела должен быть из 4 букв: ${tag}`)
    body.set(encoder.encode(tag), at)
    view.setUint32(at + 4, data.length, true)
    body.set(data, at + 8)
    at += 8 + data.length
  }
  const packed = await pipe(body, new CompressionStream('deflate-raw'))
  const file = new Uint8Array(6 + packed.length)
  file.set(encoder.encode(MAGIC))
  new DataView(file.buffer).setUint16(4, version, true)
  file.set(packed, 6)
  return file
}

/** Разбирает файл на разделы и поднимает их до текущей версии. Бросает ошибку, если это не сохранение или оно не читается. */
export async function unpackSections(file: Uint8Array): Promise<Sections> {
  if (file.length < 6 || decoder.decode(file.subarray(0, 4)) !== MAGIC) throw new Error('Это не файл сохранения')
  let version = new DataView(file.buffer, file.byteOffset, file.byteLength).getUint16(4, true)
  if (version < FIRST_BINARY_VERSION) throw new Error('Сохранение слишком старой версии игры')
  if (version > SAVE_VERSION) throw new Error('Сохранение из более новой версии игры')
  const body = await pipe(file.subarray(6), new DecompressionStream('deflate-raw'))
  const view = new DataView(body.buffer)
  const sections: Sections = new Map()
  for (let at = 0; at < body.length; ) {
    if (at + 8 > body.length) throw new Error('Файл сохранения повреждён')
    const tag = decoder.decode(body.subarray(at, at + 4))
    const length = view.getUint32(at + 4, true)
    if (at + 8 + length > body.length) throw new Error('Файл сохранения повреждён')
    sections.set(tag, body.subarray(at + 8, at + 8 + length))
    at += 8 + length
  }
  for (; version < SAVE_VERSION; version++) {
    const migrate = MIGRATIONS[version]
    if (!migrate) throw new Error(`Нет перехода сохранения с версии ${version}`)
    migrate(sections)
  }
  return sections
}

type Meta = Omit<SimSave, 'version' | 'world' | 'explored' | 'land'>

/** Сохранение мира в файл; extras — дополнительные JSON-разделы вызывающего, тег из 4 букв. */
export function encodeSave(save: SimSave, extras: Record<string, unknown> = {}): Promise<Uint8Array> {
  const { version: _, world, explored, land, ...meta } = save
  const sections: Sections = new Map([
    ['META', jsonSection(meta satisfies Meta)],
    ['WRLD', jsonSection(world)],
    ['LAND', land],
  ])
  if (explored) sections.set('EXPL', jsonSection(explored))
  for (const [tag, value] of Object.entries(extras)) sections.set(tag, jsonSection(value))
  return packSections(sections)
}

/** Мир из файла и разделы, чтобы вызывающий прочёл свои. Бросает ошибку, если файл не читается. */
export async function decodeSave(file: Uint8Array): Promise<{ save: SimSave; sections: Sections }> {
  const sections = await unpackSections(file)
  const meta = readJson<Meta>(sections.get('META'))
  const world = readJson<SimSave['world']>(sections.get('WRLD'))
  const land = sections.get('LAND')
  if (!meta || !world || !land) throw new Error('Файл сохранения повреждён')
  const explored = readJson<SimSave['explored']>(sections.get('EXPL'))
  // Копия: раздел — вид на тело файла, а карта живёт дольше него.
  return { save: { version: SAVE_VERSION, ...meta, world, ...(explored && { explored }), land: land.slice() }, sections }
}
