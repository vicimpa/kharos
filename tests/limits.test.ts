import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost } from '../src/net/host'
import { clientAddress, createBucket, createGate } from '../src/net/limits'
import { createSim } from '../src/sim'

test('ведро жетонов: разом не больше запаса, потом — по скорости', () => {
  let time = 0
  const bucket = createBucket(2, 3, () => time)
  expect([1, 2, 3, 4].map(() => bucket.take())).toEqual([true, true, true, false])
  time += 500
  expect([bucket.take(), bucket.take()]).toEqual([true, false])
  // Сверх запаса жетоны не копятся, сколько ни жди.
  time += 60_000
  expect([1, 2, 3, 4].map(() => bucket.take())).toEqual([true, true, true, false])
})

test('привратник: с одного адреса — не больше подключений разом, попыток в минуту и новых игроков в час', () => {
  let time = 0
  const gate = createGate({ connections: 2, connectsPerMinute: 4, newPlayersPerHour: 1 }, () => time)
  for (let i = 0; i < 2; i++) {
    expect(gate.admit('a')).toBe(true)
    gate.opened('a')
  }
  // Мест с адреса больше нет, а другому адресу это не мешает.
  expect(gate.admit('a')).toBe(false)
  expect(gate.admit('b')).toBe(true)
  gate.closed('a')
  expect(gate.admit('a')).toBe(true)
  // Попытки кончились, хотя место есть; через четверть минуты одна возвращается.
  expect(gate.admit('a')).toBe(false)
  time += 15_000
  expect(gate.admit('a')).toBe(true)
  expect([gate.newcomer('a'), gate.newcomer('a'), gate.newcomer('b')]).toEqual([true, false, true])
  time += 3_600_000
  expect(gate.newcomer('a')).toBe(true)
  // Ноль снимает ограничение.
  const open = createGate({ connections: 0, connectsPerMinute: 0, newPlayersPerHour: 0 }, () => time)
  for (let i = 0; i < 100; i++) {
    expect(open.admit('a') && open.newcomer('a')).toBe(true)
    open.opened('a')
  }
})

test('адрес клиента: заголовку прокси верят только от своего прокси и берут то, что дописал он', () => {
  expect(clientAddress('127.0.0.1', '6.6.6.6, 1.2.3.4')).toBe('1.2.3.4')
  expect(clientAddress('::ffff:127.0.0.1', '1.2.3.4')).toBe('1.2.3.4')
  expect(clientAddress('5.5.5.5', '1.2.3.4')).toBe('5.5.5.5')
  expect(clientAddress('127.0.0.1', null)).toBe('127.0.0.1')
})

test('поток сообщений: лишнее отбрасывается, а кто не унимается — отключается; другим игрокам это не мешает', () => {
  const logged: string[] = []
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }), undefined, undefined, { log: (text) => logged.push(text) })
  let closed = 0
  const sent: string[] = []
  const flooder = host.join((data) => typeof data === 'string' && sent.push(data), undefined, 'Спамер', () => closed++)
  const quiet = host.join(() => {}, undefined, 'Тихий', () => closed++)
  const view = JSON.stringify({ type: 'view', left: 0, top: 0, right: 1, bottom: 1 })
  for (let i = 0; i < 200; i++) flooder.receive(view)
  expect(closed).toBe(0)
  for (let i = 0; i < 1000; i++) flooder.receive(view)
  expect(closed).toBe(1)
  expect(sent.at(-1)).toContain('Слишком много сообщений')
  expect(logged.some((line) => line.includes('слишком много сообщений'))).toBe(true)
  // Слишком длинное сообщение не читается вовсе.
  quiet.receive(JSON.stringify({ type: 'chat', text: 'x'.repeat(100_000) }))
  quiet.receive(view)
  expect(closed).toBe(1)
})
