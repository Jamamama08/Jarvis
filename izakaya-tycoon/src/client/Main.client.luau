-- Main (LocalScript, client only)
-- For now it shows which plot is yours. It only *reads* what the server set;
-- the client never decides ownership, money or purchases.

local Players = game:GetService("Players")

local player = Players.LocalPlayer

local gui = Instance.new("ScreenGui")
gui.Name = "PlotHud"
gui.ResetOnSpawn = false -- keep the HUD when the character respawns

local label = Instance.new("TextLabel")
label.Name = "PlotLabel"
label.AnchorPoint = Vector2.new(0.5, 0)
label.Position = UDim2.new(0.5, 0, 0, 10)
label.Size = UDim2.fromOffset(260, 36)
label.BackgroundColor3 = Color3.fromRGB(40, 25, 20)
label.BackgroundTransparency = 0.2
label.TextColor3 = Color3.fromRGB(255, 235, 200)
label.Font = Enum.Font.GothamBold
label.TextSize = 18
label.Parent = gui

local corner = Instance.new("UICorner")
corner.CornerRadius = UDim.new(0, 8)
corner.Parent = label

local function refresh()
	local plotId = player:GetAttribute("PlotId")
	if plotId then
		label.Text = "Your izakaya: Plot " .. plotId
	else
		label.Text = "Finding you a plot..."
	end
end

player:GetAttributeChangedSignal("PlotId"):Connect(refresh)
refresh()

gui.Parent = player:WaitForChild("PlayerGui")
