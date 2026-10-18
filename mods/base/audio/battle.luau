--!strict
-- Звуки боя: раз в кадр смотрит, какие выстрелы и взрывы появились в мире, и даёт им голос — громкость по тому,
-- насколько они далеко от середины экрана, сторона — по тому, левее они или правее. Лучевое оружие бьёт сразу и без
-- взрыва: попадание звучит само. Погибшее под взрывом скрежещет (машина) или рушится (здание). Взрывы и выстрелы пушек
-- трясут камеру (c.shared.trauma, cameras/rts): сильнее, чем взрыв больше и ближе.

-- Звук выстрела каждого оружия и его громкость; звук попадания лучевого.
local SHOTS = {
	rifle = { "rifle", 0.35 },
	machinegun = { "machinegun", 0.25 },
	cannon = { "cannon", 0.8 },
	artillery = { "artillery", 1 },
	bomb = { "bombFall", 0.5 },
	launcher = { "launcher", 0.45 },
	laser = { "laser", 0.35 },
	arc = { "arc", 0.5 },
	flame = { "flame", 0.4 },
	flak = { "flak", 0.45 },
	coreGun = { "laser", 0.6 },
}
local HITS = { laser = "sizzle", coreGun = "sizzle", flame = "burn", arc = "zap" }
local BEAM_HIT_VOLUME = 0.3
-- Взрывы: меньше SMALL_BLAST — попадание пули, оно щёлкает тихо; от BIG_BLAST — гибель техники или здания.
local SMALL_BLAST, HIT_VOLUME, BIG_BLAST = 0.3, 0.12, 1.3
-- Погибший — то, что пропало в кадр взрыва не дальше DEATH_REACH или размера взрыва; громкость скрежета и обвала.
local DEATH_REACH, WRECK_VOLUME, COLLAPSE_VOLUME = 1, 0.6, 0.8
-- Громкость взрыва: основа и прибавка на тайл размера.
local BLAST_VOLUME, BLAST_VOLUME_PER_SIZE = 1, 0.6
-- Тряска на тайл размера, самая сильная от одного взрыва; выстрел пушки — как взрыв такого размера; докуда достаёт.
local BLAST_SHAKE, MAX_BLAST_SHAKE, CANNON_SHAKE_SIZE = 0.3, 0.8, 0.3
local SHAKE_REACH, SHAKE_REACH_PER_SIZE = 6, 8
-- Чаще этого один и тот же звук не повторяется: сотня винтовок звучит как одна очередь.
local MIN_GAP = {
	rifle = 0.04, machinegun = 0.035, cannon = 0.08, launcher = 0.06, laser = 0.06, arc = 0.08, blast = 0.05, bigBlast = 0.1,
	flame = 0.12, flak = 0.06, artillery = 0.1, bombFall = 0.15, ricochet = 0.05, wreck = 0.1, collapse = 0.2, sizzle = 0.06, burn = 0.15, zap = 0.05,
}
-- За краем экрана звук стихает на этом расстоянии, в долях полуширины экрана.
local HEARING = 0.8

local shots: { [number]: number } = {}
local blasts: { [number]: number } = {}
local bodies: { [number]: { x: number, y: number, kind: string } } = {}
local last: { [string]: number } = {}
local tick = -1

return {
	update = function(c)
		if not c.audio then
			return
		end
		-- Скачок часов — новый мир: прежние выстрелы и взрывы из другого мира.
		if tick < 0 or math.abs(c.tick - tick) > 100 then
			shots, blasts, bodies = {}, {}, {}
		end
		tick = c.tick
		local function play(name: string, volume: number, x: number, y: number)
			if c.clock - (last[name] or -math.huge) < (MIN_GAP[name] or 0) then
				return
			end
			if c:nearness(x, y, HEARING) * volume <= 0.01 then
				return
			end
			last[name] = c.clock
			c:sound(name, { x = x, y = y, volume = volume, reach = HEARING })
		end
		-- Толчок от взрыва размера size в (x, y): чем больше и ближе к середине экрана, тем сильнее.
		local function jolt(size: number, x: number, y: number)
			local distance = math.sqrt((x - c.camera.x) ^ 2 + (y - c.camera.y) ^ 2)
			local near = math.max(0, 1 - distance / (SHAKE_REACH + size * SHAKE_REACH_PER_SIZE))
			c.shared.trauma = math.min(1, (c.shared.trauma or 0) + math.min(MAX_BLAST_SHAKE, size * BLAST_SHAKE) * near * near)
		end
		-- Новое — то, чего не было в прошлом кадре, или что моложе прежнего с тем же номером.
		local nextShots = {}
		for _, e in c:each({ "Shot" }) do
			local shot = c:get(e, "Shot")
			local age = shots[e]
			nextShots[e] = shot.age
			if age ~= nil and shot.age >= age then
				continue
			end
			local voice = SHOTS[shot.weapon]
			if voice and c:sees(shot.fromX, shot.fromY) then
				play(voice[1], voice[2], shot.fromX, shot.fromY)
			end
			local hit = HITS[shot.weapon]
			if hit and not shot.blocked and c:sees(shot.toX, shot.toY) then
				play(hit, BEAM_HIT_VOLUME, shot.toX, shot.toY)
			end
			if shot.weapon == "cannon" then
				jolt(CANNON_SHAKE_SIZE, shot.fromX, shot.fromY)
			end
		end
		shots = nextShots
		-- Погибшее пропадает в тот же кадр, что появляется взрыв на его месте.
		local nextBodies = {}
		for _, e in c:each({ "Mover", "Position" }) do
			local at = c:get(e, "Position")
			nextBodies[e] = { x = at.x, y = at.y, kind = if c:get(e, "Mover").class == "infantry" then "soldier" else "machine" }
		end
		for _, e in c:each({ "Building", "Position" }) do
			local at = c:get(e, "Position")
			nextBodies[e] = { x = at.x, y = at.y, kind = "building" }
		end
		local fallen = {}
		for e, body in bodies do
			if not nextBodies[e] then
				table.insert(fallen, body)
			end
		end
		bodies = nextBodies
		local nextBlasts = {}
		for _, e in c:each({ "Blast", "Position" }) do
			local blast, at = c:get(e, "Blast"), c:get(e, "Position")
			local age = blasts[e]
			nextBlasts[e] = blast.age
			if (age ~= nil and blast.age >= age) or not c:sees(at.x, at.y) then
				continue
			end
			if blast.size < SMALL_BLAST then
				play("ricochet", HIT_VOLUME, at.x, at.y)
				continue
			end
			play(if blast.size >= BIG_BLAST then "bigBlast" else "blast", BLAST_VOLUME + blast.size * BLAST_VOLUME_PER_SIZE, at.x, at.y)
			jolt(blast.size, at.x, at.y)
			local reach = math.max(DEATH_REACH, blast.size)
			for _, body in fallen do
				if math.sqrt((body.x - at.x) ^ 2 + (body.y - at.y) ^ 2) <= reach then
					if body.kind == "building" then
						play("collapse", COLLAPSE_VOLUME + blast.size * 0.2, at.x, at.y)
					elseif body.kind == "machine" then
						play("wreck", WRECK_VOLUME, at.x, at.y)
					end
					break
				end
			end
		end
		blasts = nextBlasts
	end,
}
