import { expect, test } from 'bun:test'
import { DEFAULT_CONFIG, Terrain, biomeAt, createLand, sampleTerrain, terrainAt } from '../src/map/terrain'

test('предпросмотр местности совпадает с миром везде, кроме гор', () => {
  const config = { ...DEFAULT_CONFIG, seed: 4242, rockLevel: 0.5 }
  const land = createLand(config)
  for (let y = -300; y < 300; y += 7) {
    for (let x = -300; x < 300; x += 7) {
      const terrain = terrainAt(land, x, y)
      const sample = sampleTerrain(config, x, y)
      expect(sample.biome).toBe(biomeAt(land, x, y))
      expect(sample.terrain).toBe(terrain === Terrain.Mountain ? Terrain.Rock : terrain)
    }
  }
})
