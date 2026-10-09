import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost } from '../src/net/host'
import { CHAT_LENGTH, decodeServer, type ChatLine } from '../src/net/protocol'
import { Owner, Player, createSim } from '../src/sim'

/** Подключение к хосту, которое копит пришедшие сообщения чата: игроков — в lines, сервера — в notices. */
function connect(host: ReturnType<typeof createHost>, name: string) {
  const lines: ChatLine[] = []
  const notices: ChatLine[] = []
  const peer = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'chat') for (const line of message.lines) (line.system ? notices : lines).push(line)
  }, undefined, name)
  return { peer, lines, notices, say: (text: string) => peer.receive(JSON.stringify({ type: 'chat', text })) }
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

test('сервер пишет в чат, кто зашёл и вышел; вторая вкладка того же игрока — не в счёт', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const one = connect(host, 'Первый')
  const two = connect(host, 'Второй')
  expect(one.notices).toEqual([{ player: two.peer.player, name: 'Второй', text: 'заходит в игру', system: true }])
  two.peer.leave()
  expect(one.notices.at(-1)).toMatchObject({ name: 'Второй', text: 'выходит из игры', system: true })
})

test('сервер пишет в чат о поражении игрока один раз', () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  const host = createHost(sim)
  const one = connect(host, 'Первый')
  const two = connect(host, 'Второй')
  const doomed: number[] = []
  for (const [entity, owner] of sim.world.query(Owner)) if (owner.player === two.peer.player && !sim.world.has(entity, Player)) doomed.push(entity)
  for (const entity of doomed) sim.world.destroy(entity)
  // Поражения хост проверяет раз в несколько тиков; advance за раз делает их немного.
  for (let i = 0; i < 20; i++) host.advance(sim.time.step)
  expect(one.notices.filter((line) => line.text === 'терпит поражение')).toEqual([{ player: two.peer.player, name: 'Второй', text: 'терпит поражение', system: true }])
})
