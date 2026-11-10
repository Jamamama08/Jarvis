-- Config (ModuleScript, shared)
-- Numbers that both the server and the client may read.
-- Change values here instead of hunting through the code.
-- Nothing in here is secret: clients can read everything in ReplicatedStorage.

local Config = {}

-- Plots ----------------------------------------------------------------------
-- One plot per player, so set Game Settings > Places > Max Players to PLOT_COUNT.
Config.PLOT_COUNT = 6
Config.PLOTS_PER_ROW = 3
Config.PLOT_SIZE = 80 -- studs, plots are square
Config.PLOT_GAP = 20 -- studs between plots (the aisle in the middle is twice this)

Config.PLOT_COLOR_EMPTY = Color3.fromRGB(120, 90, 60) -- dark wood
Config.PLOT_COLOR_OWNED = Color3.fromRGB(181, 138, 88) -- light wood
Config.SIGN_COLOR = Color3.fromRGB(150, 30, 30) -- red, like a lantern

return Config
