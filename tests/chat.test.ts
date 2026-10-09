import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost } from '../src/net/host'
import { CHAT_LENGTH, decodeServer, type ChatLine } from '../src/net/protocol'
import { createSim } from '../src/sim'

/** Подключение к хосту, которое копит пришедшие сообщения чата. */
function connect(host: ReturnType<typeof createHost>, name: string) {
  const lines: ChatLine[] = []
  const peer = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'chat') lines.push(...message.lines)
  }, undefined, name)
  return { peer, lines, say: (text: string) => peer.receive(JSON.stringify({ type: 'chat', text })) }
}

test('чат: сообщение уходит всем с ником автора, хост его не хранит', async () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const one = connect(host, 'Первый')
  const two = connect(host, 'Второй')
  one.say('  привет\u0007   всем  ')
  expect(one.lines).toEqual([{ player: one.peer.player, name: 'Первый', text: 'привет всем' }])
  expect(two.lines).toEqual(one.lines)
  // Чаще раза в полсекунды — не проходит; пустое — тоже.
  one.say('ещё')
  two.say('   ')
  expect(two.lines.length).toBe(1)
  await Bun.sleep(550)
  one.say('x'.repeat(CHAT_LENGTH + 50))
  expect(two.lines.at(-1)!.text.length).toBe(CHAT_LENGTH)
  const late = connect(host, 'Поздний')
  expect(late.lines).toEqual([])
})
