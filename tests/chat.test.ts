import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG } from '../src/map/terrain'
import { createHost } from '../src/net/host'
import { CHAT_LENGTH, decodeServer, type ChatLine } from '../src/net/protocol'
import { complete } from '../src/net/chatCommands'
import { Owner, Player, Unit, createSim } from '../src/sim'

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

test('команды: ответ только автору, админские скрыты без /admin, пароль в чат не уходит', async () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  const host = createHost(sim, undefined, undefined, { admin: 'секрет' })
  const lists: { commands: string[]; admin: boolean }[] = []
  const one = connect(host, 'Первый')
  const two = connect(host, 'Второй')
  const spy = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'commands') lists.push({ commands: message.commands.map((command) => command.name), admin: message.admin })
  }, undefined, 'Третий')
  expect(lists[0].commands).not.toContain('kick')
  const tell = (text: string) => spy.receive(JSON.stringify({ type: 'chat', text }))
  tell('/kick Первый')
  await Bun.sleep(550)
  tell('/admin неверно')
  expect(one.notices.some((line) => line.text.includes('неверно'))).toBe(false)
  await Bun.sleep(550)
  // После неверного пароля несколько секунд не пускает и с верным.
  tell('/admin секрет')
  expect(lists.at(-1)!.admin).toBe(false)
  await Bun.sleep(3000)
  tell('/admin секрет')
  expect(lists.at(-1)).toMatchObject({ admin: true })
  expect(lists.at(-1)!.commands).toContain('kick')
  await Bun.sleep(550)
  tell('/credits Второй +500')
  await Bun.sleep(550)
  tell('/say всем привет')
  expect(two.notices.at(-1)).toMatchObject({ name: '[Сервер]', text: 'всем привет' })
}, 10_000)

test('консоль: /msg уходит только адресату, /kick отключает игрока', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }))
  const one = connect(host, 'Первый')
  const two = connect(host, 'Игрок 2')
  const three = connect(host, 'Третий')
  one.say('/msg "Игрок 2" тайна, "в кавычках"')
  expect(two.lines.at(-1)).toMatchObject({ name: 'Первый', text: 'тайна, "в кавычках"', whisper: 'Игрок 2' })
  expect(three.lines).toEqual([])
  const out: string[] = []
  let closed = 0
  const four = host.join(() => {}, undefined, 'Четвёртый', () => closed++)
  host.command('kick Четвёртый', { admin: true, reply: (text) => out.push(text) })
  expect(closed).toBe(1)
  host.command('nope', { admin: true, reply: (text) => out.push(text) })
  expect(out.at(-1)).toContain('Нет команды')
  void four
})

test('дополнение: команды по началу, ники в кавычках, если в них пробел', () => {
  const commands = [
    { name: 'msg', args: ['<игрок>', '<текст>'], help: '' },
    { name: 'me', args: ['<действие>'], help: '' },
  ]
  expect(complete('/m', commands, []).map((item) => item.text)).toEqual(['/msg ', '/me '])
  expect(complete('/msg иг', commands, ['Игрок 2', 'Вася']).map((item) => item.text)).toEqual(['/msg "Игрок 2" '])
  expect(complete('/msg ', commands, ['Вася']).map((item) => item.text)).toEqual(['/msg Вася '])
  expect(complete('привет', commands, ['Вася'])).toEqual([])
})

test('админ: spawn у базы, killunits, heal, reset и reveal', () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  const host = createHost(sim)
  const one = connect(host, 'Первый')
  const out: string[] = []
  const admin = { admin: true, reply: (text: string) => out.push(text) }
  const units = () => {
    let count = 0
    for (const [entity, owner] of sim.world.query(Owner)) if (owner.player === one.peer.player && sim.world.has(entity, Unit)) count++
    return count
  }
  const before = units()
  host.command('spawn tank 3 Первый', admin)
  expect(units()).toBe(before + 3)
  host.command('spawn nonsense', admin)
  expect(out.at(-1)).toContain('Юниты:')
  host.command('killunits all', admin)
  expect(units()).toBe(0)
  host.command('reset Первый', admin)
  expect(units()).toBeGreaterThan(0)
  host.command('reveal Первый', admin)
  expect(sim.vision.explored(one.peer.player, sim.bounds.right - 2, sim.bounds.bottom - 2)).toBe(true)
  host.command('players', admin)
  expect(out.at(-1)).toContain('Первый')
})

test('дополнение аргумента из списка: виды юнитов', () => {
  const commands = [{ name: 'spawn', args: ['<юнит>'], choices: [['tank', 'trike']], help: '' }]
  expect(complete('/spawn t', commands, []).map((item) => item.text)).toEqual(['/spawn tank ', '/spawn trike '])
})

test('редактор живого мира: только после /editor, мир без тумана, правки применяются к миру хоста', () => {
  const sim = createSim({ generator: DEFAULT_CONFIG, size: 256 })
  const host = createHost(sim, undefined, undefined, { admin: 'секрет' })
  const welcomes: { editor?: true; fog?: boolean }[] = []
  const replies: string[] = []
  const peer = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'welcome') welcomes.push({ editor: message.editor, fog: message.options.fog })
    if (message.type === 'chat') for (const line of message.lines) if (!line.name) replies.push(line.text)
  }, undefined, 'Админ')
  const other = connect(host, 'Другой')
  const tell = (message: object) => peer.receive(JSON.stringify(message))
  const units = () => {
    let count = 0
    for (const [, owner] of sim.world.query(Owner, Unit)) if (owner.player === other.peer.player) count++
    return count
  }
  const before = units()
  // Без редактора правка молча отбрасывается.
  tell({ type: 'edit', edit: { op: 'addPlayer' } })
  const spawn = { type: 'edit', edit: { op: 'unit', type: 'tank', x: 0, y: 0, player: other.peer.player } }
  tell(spawn)
  expect(units()).toBe(before)
  tell({ type: 'chat', text: '/admin секрет' })
  // /editor — не для того, кто просто знает про чат: нужен режим администратора, а за ним пауза между сообщениями.
  const now = Date.now
  Date.now = () => now() + 1000
  tell({ type: 'chat', text: '/editor' })
  Date.now = now
  expect(welcomes.at(-1)).toEqual({ editor: true, fog: false })
  // Где встанет танк — найдём свободный тайл перебором.
  const { left, top, right, bottom } = sim.bounds
  for (let y = top + 20; y < bottom - 20 && units() === before; y += 3) {
    for (let x = left + 20; x < right - 20 && units() === before; x += 3) tell({ type: 'edit', edit: { ...spawn.edit, x, y } })
  }
  expect(units()).toBe(before + 1)
  expect(replies.some((text) => text.startsWith('Редактор'))).toBe(true)
})

test('/hide: скрытого администратора нет в списке игроков у других, вход не объявляется', () => {
  const host = createHost(createSim({ generator: DEFAULT_CONFIG, size: 256 }), undefined, undefined, { admin: 'секрет' })
  const rosters: string[][] = []
  let id: string | undefined
  const admin = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'welcome') id ??= message.id
  }, undefined, 'Админ')
  const other = connect(host, 'Другой')
  const watcher = host.join((data) => {
    const message = decodeServer(data)
    if (message.type === 'players') rosters.push(message.players.map((info) => info.name))
  }, undefined, 'Смотрящий')
  admin.receive(JSON.stringify({ type: 'chat', text: '/admin секрет' }))
  const now = Date.now
  Date.now = () => now() + 1000
  admin.receive(JSON.stringify({ type: 'chat', text: '/hide' }))
  Date.now = now
  expect(rosters.at(-1)).not.toContain('Админ')
  expect(other.notices.at(-1)).toMatchObject({ name: 'Админ', text: 'выходит из игры' })
  const count = other.notices.length
  admin.leave()
  host.join(() => {}, id, 'Админ')
  expect(other.notices.length).toBe(count)
  void watcher
})
