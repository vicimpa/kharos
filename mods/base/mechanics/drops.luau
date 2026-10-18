--!strict
-- Груз на земле: погибшее в бою оставляет на земле то, что лежало на его складе или в кузове. Топливо реактора сгорает
-- в аварии и на землю не падает (meltdown). Как дропы вывозят — mechanics/hauling.

local drops = require("lib/drops")
local kinds = require("lib/kinds")

local mechanic = {}

mechanic.components = {
	-- Дроп: склад без здания на одном тайле и без хозяина.
	Drop = {},
}

mechanic.on = {
	-- Гибель в бою движка: груз погибшего — на землю.
	killed = function(ctx, event)
		local remains = event.remains
		local stock = remains and remains.Inventory
		if not stock then
			return
		end
		local proto = remains.Proto
		local kind = kinds.byId(ctx, proto and proto.id)
		local burns = kind and kind.data.meltdown and kind.data.burns
		if burns then
			local items = table.clone(stock.items)
			items[burns.good] = nil
			remains = table.clone(remains)
			remains.Inventory = { items = items }
		end
		drops.cargo(ctx, event.entity, remains)
	end,
}

return mechanic
