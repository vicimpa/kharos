import type { Audio } from '../audio/audio'
import type { LoopName } from '../audio/synth'
import { Assembly, Building, Inventory, Owner, Position, Producer, Site, Unit, amountOf, buildingSpec, unitSpec } from '../sim'
import type { Scene } from './scene'

/** Раз во сколько секунд пересчитывается, что звучит: петли меняются плавно, и чаще не нужно. */
const PERIOD = 0.2
/** Громкость каждой петли при «полном» звучании: фон тише боя и интерфейса. */
const LEVELS: Record<LoopName, number> = {
  hum: 0.22, machinery: 0.25, drill: 0.2, engine: 0.22, tracks: 0.28, steps: 0.16, rotor: 0.22,
}
/**
 * Сколько вблизи звучащих набирают полную громкость: один танк уже слышно, десять — громче, но не вдесятеро.
 * Громкость — 1 − e^(−сумма/SATURATE).
 */
const SATURATE = 3
/** За краем экрана звук стихает на этом расстоянии, в долях полуширины экрана. */
const HEARING = 0.6
/** Издалека слышно тише: при таком масштабе (пикселей на тайл) громкость полная. */
const NEAR_ZOOM = 32

/** Чем звучит юнит каждого класса на ходу. */
const UNIT_LOOPS = { infantry: 'steps', vehicle: 'engine', heavy: 'tracks', air: 'rotor' } as const satisfies Record<string, LoopName>

/**
 * Звук работы: здания и техника на ходу. Ветер, погода и даль — в audio/ambience.ts. Каждый вид звука — одна петля, сколько бы ни звучало источников: громкость —
 * по тому, сколько их и насколько они близки к середине экрана, сторона — по тому, где они. Звучит только своё
 * работающее: электростанция гудит всегда, шахта бурит, цех и переработка стучат, пока работают, завод — пока
 * в очереди есть заказ. Юнит звучит, только когда едет.
 */
export function createMachines(scene: Scene, audio: Audio) {
  let since = PERIOD
  const sum = new Map<LoopName, number>()
  const side = new Map<LoopName, number>()

  const nearness = (x: number, y: number) => {
    const { camera } = scene
    const halfWidth = camera.width / 2 / camera.zoom
    const halfHeight = camera.height / 2 / camera.zoom
    const outside = Math.max(0, Math.abs(x - camera.x) - halfWidth, Math.abs(y - camera.y) - halfHeight)
    return Math.max(0, 1 - outside / (halfWidth * HEARING)) * Math.min(1, camera.zoom / NEAR_ZOOM)
  }
  const add = (name: LoopName, x: number, y: number) => {
    const near = nearness(x, y)
    if (near <= 0) return
    const { camera } = scene
    sum.set(name, (sum.get(name) ?? 0) + near)
    side.set(name, (side.get(name) ?? 0) + near * ((x - camera.x) / (camera.width / 2 / camera.zoom)))
  }

  return {
    update(seconds: number) {
      since += seconds
      if (since < PERIOD) return
      since = 0
      sum.clear()
      side.clear()
      const { world } = scene.sim
      const player = scene.player

      for (const [entity, building, position, owner] of world.query(Building, Position, Owner)) {
        if (owner.player !== player || world.has(entity, Site)) continue
        const spec = buildingSpec(building.type)
        const x = position.x + spec.width / 2
        const y = position.y + spec.height / 2
        if ((spec.power ?? 0) > 0) add('hum', x, y)
        if (spec.extract) add('drill', x, y)
        const assembly = world.get(entity, Assembly)
        const inventory = world.get(entity, Inventory)
        const working =
          (assembly && assembly.progress > 0) ||
          (spec.refines && inventory && amountOf(inventory, spec.refines) > 1e-9) ||
          (world.get(entity, Producer)?.queue.length ?? 0) > 0
        if (working) add('machinery', x, y)
      }

      for (const [, unit, position] of world.query(Unit, Position)) {
        if (Math.abs(position.x - unit.prevX) + Math.abs(position.y - unit.prevY) < 1e-3) continue
        add(UNIT_LOOPS[unitSpec(unit.type).kind], position.x, position.y)
      }

      for (const name of Object.keys(LEVELS) as LoopName[]) {
        const total = sum.get(name) ?? 0
        audio.loop(name, LEVELS[name] * (1 - Math.exp(-total / SATURATE)), total ? (side.get(name) ?? 0) / total : 0)
      }
    },
  }
}
