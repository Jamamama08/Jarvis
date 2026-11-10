-- Main (Script, server only)
-- The one server entry point. It starts each service in order.
-- Services are ModuleScripts in the Services folder next to this script.

local Services = script.Parent.Services

local PlotService = require(Services.PlotService)

PlotService.Init()

print("[Izakaya Tycoon] Server started")
