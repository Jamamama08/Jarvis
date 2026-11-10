-- PlotService (ModuleScript, server only)
--
-- Builds the empty plots when the server starts, gives each player who joins
-- a free plot, sends their character there whenever they spawn, and frees the
-- plot again when they leave.
--
-- Only the server changes who owns a plot. The client just reads the
-- "PlotId" attribute on its own Player to know which plot is theirs.

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Workspace = game:GetService("Workspace")

local Config = require(ReplicatedStorage.Shared.Config)

local PlotService = {}

local plots = {} -- list of plot Models, in order (Plot1, Plot2, ...)
local plotOfPlayer = {} -- [Player] = their plot Model

-- Small helper so building placeholder blocks isn't a wall of code.
local function newPart(name, size, cframe, color, parent)
	local part = Instance.new("Part")
	part.Name = name
	part.Size = size
	part.CFrame = cframe
	part.Color = color
	part.Anchored = true
	part.TopSurface = Enum.SurfaceType.Smooth
	part.BottomSurface = Enum.SurfaceType.Smooth
	part.Parent = parent
	return part
end

local function setSignText(plot, text)
	for _, child in plot.Sign:GetChildren() do
		if child:IsA("SurfaceGui") then
			child.Label.Text = text
		end
	end
end

-- Builds one empty plot out of placeholder blocks.
-- The plot's local +Z side is its "front" (where the sign is).
local function buildPlot(index, plotCFrame, parent)
	local size = Config.PLOT_SIZE

	local plot = Instance.new("Model")
	plot.Name = "Plot" .. index
	plot:SetAttribute("PlotId", index)
	plot:SetAttribute("OwnerUserId", 0) -- 0 means "nobody"

	-- The floor of the izakaya.
	local base = newPart("Base", Vector3.new(size, 1, size), plotCFrame, Config.PLOT_COLOR_EMPTY, plot)
	base.Material = Enum.Material.WoodPlanks
	plot.PrimaryPart = base

	-- A sign on a post at the front edge, showing the owner's name.
	newPart(
		"SignPost",
		Vector3.new(1, 4, 1),
		plotCFrame * CFrame.new(0, 2.5, size / 2 - 1),
		Color3.fromRGB(60, 40, 25),
		plot
	)
	local sign = newPart(
		"Sign",
		Vector3.new(16, 5, 1),
		plotCFrame * CFrame.new(0, 6.5, size / 2 - 1),
		Config.SIGN_COLOR,
		plot
	)
	-- Text on both sides of the sign, so it reads from the aisle and the plot.
	for _, face in { Enum.NormalId.Front, Enum.NormalId.Back } do
		local gui = Instance.new("SurfaceGui")
		gui.Name = "SignGui" .. face.Name
		gui.Face = face
		gui.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
		gui.PixelsPerStud = 40

		local label = Instance.new("TextLabel")
		label.Name = "Label"
		label.Size = UDim2.fromScale(1, 1)
		label.BackgroundTransparency = 1
		label.TextScaled = true
		label.Font = Enum.Font.GothamBold
		label.TextColor3 = Color3.new(1, 1, 1)
		label.Text = "Empty plot"
		label.Parent = gui

		gui.Parent = sign
	end

	-- Where the owner appears. Just a marker, not a real SpawnLocation.
	local pad = newPart(
		"SpawnPoint",
		Vector3.new(6, 0.2, 6),
		plotCFrame * CFrame.new(0, 0.6, size / 2 - 8),
		Color3.fromRGB(240, 230, 210),
		plot
	)
	pad.CanCollide = false
	pad.Material = Enum.Material.SmoothPlastic

	-- Everything the owner unlocks later (kitchen, tables, lanterns...) goes in
	-- here, so it can all be cleared when the plot is freed.
	local contents = Instance.new("Folder")
	contents.Name = "Contents"
	contents.Parent = plot

	plot.Parent = parent
	return plot
end

-- Lays the plots out in rows on both sides of a central aisle.
local function buildAllPlots()
	local folder = Instance.new("Folder")
	folder.Name = "Plots"
	folder.Parent = Workspace

	local perRow = Config.PLOTS_PER_ROW
	local rows = math.ceil(Config.PLOT_COUNT / perRow)
	local stepX = Config.PLOT_SIZE + Config.PLOT_GAP
	local stepZ = Config.PLOT_SIZE + Config.PLOT_GAP * 2

	for i = 1, Config.PLOT_COUNT do
		local col = (i - 1) % perRow
		local row = (i - 1) // perRow
		local x = (col - (perRow - 1) / 2) * stepX
		local z = (row - (rows - 1) / 2) * stepZ
		-- Turn the far row around so every sign faces the middle aisle.
		local yaw = if z > 0 then math.pi else 0
		-- y = 0.5 puts the 1-stud-thick floor on top of the default Baseplate.
		local plotCFrame = CFrame.new(x, 0.5, z) * CFrame.Angles(0, yaw, 0)
		plots[i] = buildPlot(i, plotCFrame, folder)
	end
end

local function claimPlot(player)
	if plotOfPlayer[player] then
		return plotOfPlayer[player]
	end
	for _, plot in plots do
		if plot:GetAttribute("OwnerUserId") == 0 then
			plot:SetAttribute("OwnerUserId", player.UserId)
			plot.Base.Color = Config.PLOT_COLOR_OWNED
			setSignText(plot, player.DisplayName .. "'s Izakaya")
			plotOfPlayer[player] = plot
			-- The client reads this to show "Your izakaya: Plot N".
			player:SetAttribute("PlotId", plot:GetAttribute("PlotId"))
			return plot
		end
	end
	return nil -- every plot is taken
end

local function releasePlot(player)
	local plot = plotOfPlayer[player]
	if not plot then
		return
	end
	plotOfPlayer[player] = nil
	plot.Contents:ClearAllChildren()
	plot:SetAttribute("OwnerUserId", 0)
	plot.Base.Color = Config.PLOT_COLOR_EMPTY
	setSignText(plot, "Empty plot")
end

-- Moves a freshly spawned character onto its owner's plot.
local function sendHome(player, character)
	local root = character:WaitForChild("HumanoidRootPart", 10)
	if not root then
		return
	end
	-- Let Roblox finish placing the character at the normal spawn first,
	-- otherwise it can move the character back after we teleport it.
	task.wait(0.1)
	local plot = plotOfPlayer[player]
	if not plot or character.Parent == nil then
		return
	end
	local standAt = plot.SpawnPoint.Position + Vector3.new(0, 4, 0)
	local center = plot.Base.Position
	local lookAt = Vector3.new(center.X, standAt.Y, center.Z)
	character:PivotTo(CFrame.lookAt(standAt, lookAt))
end

local function onPlayerAdded(player)
	local plot = claimPlot(player)
	if not plot then
		player:Kick("Sorry, every izakaya on this server is taken. Please try another server!")
		return
	end
	player.CharacterAdded:Connect(function(character)
		sendHome(player, character)
	end)
	if player.Character then
		task.spawn(sendHome, player, player.Character)
	end
end

-- Public: returns the plot Model a player owns, or nil.
function PlotService.GetPlot(player)
	return plotOfPlayer[player]
end

-- Public: call once when the server starts.
function PlotService.Init()
	buildAllPlots()
	Players.PlayerAdded:Connect(onPlayerAdded)
	Players.PlayerRemoving:Connect(releasePlot)
	-- Players who joined before this script ran (can happen in Studio tests).
	for _, player in Players:GetPlayers() do
		task.spawn(onPlayerAdded, player)
	end
end

return PlotService
