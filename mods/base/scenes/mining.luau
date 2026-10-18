--!strict
-- Сценка витрины: добыча — работающая база, шахта, трубы, переработки и грузовики, которые развозят готовое по
-- хранилищам (mining в sim-ts/showcase.ts, тестовая карта — lib/sandbox).

local sandbox = require("lib/sandbox")

return {
	create = function(ctx, player: number): boolean
		return sandbox.spawn(ctx, player) ~= nil
	end,
}
