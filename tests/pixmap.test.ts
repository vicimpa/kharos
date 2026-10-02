import { expect, test } from 'bun:test'
import { Pixmap } from '../src/render/pixmap'

/** Рисунок символами: # — закрашенный пиксель. */
const picture = (image: Pixmap) => {
  const rows: string[] = []
  for (let y = 0; y < image.height; y++) {
    let row = ''
    for (let x = 0; x < image.width; x++) row += image.data[(y * image.width + x) * 4 + 3] ? '#' : '.'
    rows.push(row)
  }
  return rows
}

test('rect закрашивает ровно свои пиксели и пишет цвет', () => {
  const image = new Pixmap(4, 3).rect(1, 1, 2, 1, 0x102030)
  expect(picture(image)).toEqual(['....', '.##.', '....'])
  expect([...image.data.subarray(20, 24)]).toEqual([0x10, 0x20, 0x30, 255])
})

test('фигуры обрезаются по краям холста и сдвигаются началом координат', () => {
  const image = new Pixmap(3, 3)
  image.originX = image.originY = 1
  image.rect(-5, 0, 6, 1, 0xffffff)
  expect(picture(image)).toEqual(['...', '##.', '...'])
})

test('circle закрашивает пиксели, центр которых внутри круга', () => {
  const image = new Pixmap(6, 6).circle(3, 3, 2, 0xffffff)
  expect(picture(image)).toEqual(['......', '..##..', '.####.', '.####.', '..##..', '......'])
})

test('ring оставляет середину пустой', () => {
  const image = new Pixmap(8, 8).ring(4, 4, 3, 1, 0xffffff)
  expect(picture(image)[4]).toBe('.#....#.')
})

test('line: горизонтальный отрезок заданной толщины', () => {
  const image = new Pixmap(6, 4).line(1, 2, 5, 2, 2, 0xffffff)
  expect(picture(image)).toEqual(['......', '.####.', '.####.', '......'])
})
