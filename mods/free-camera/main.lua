-- Free Camera: detach the view from the player and fly it around the level.
--
-- Everything the player can change is declared in mod.json, so it shows up in
-- the Workshop and in the Mod Menu without any code here. This script only
-- reacts to those options and moves the camera.

local options = mh.options

local ZOOM = { Far = 0.5, Normal = 1.0, Close = 2.0 }

local function zoom()
    return ZOOM[options.get("zoom")] or 1.0
end

-- Put the camera on the player, or keep it where the game has it if there is none.
local function center()
    local player = mh.entities.player()
    local state = player ~= 0 and mh.entities.get(player) or mh.camera.get()
    if state then mh.camera.set(state.x, state.y, zoom()) end
end

function on_option_changed(event)
    if event.key == "active" then
        if event.value then center() else mh.camera.release() end
    elseif event.key == "zoom" and options.get("active") then
        local view = mh.camera.get()
        if view then mh.camera.set(view.x, view.y, zoom()) end
    end
end

function on_action(event)
    if event.key == "center" and options.get("active") then center() end
end

-- A new level starts with the game's own camera.
function on_map_loading()
    options.set("active", false)
end

function on_frame()
    -- While a menu has the keyboard, its keys are not ours.
    if mh.input.blocked() then return end

    local toggle = options.get("toggle_key")
    if toggle ~= 0 and mh.input.pressed(toggle) then
        options.set("active", not options.get("active"))
    end
    if not options.get("active") then return end

    -- The arrow keys fly the camera now, so the player must not walk.
    mh.input.block("move")
    local step = tonumber(options.get("speed")) / 256   -- cells per frame
    local right, down = 0, 0
    if mh.input.down(options.get("right")) then right = right + step end
    if mh.input.down(options.get("left")) then right = right - step end
    if mh.input.down(options.get("down")) then down = down + step end
    if mh.input.down(options.get("up")) then down = down - step end
    if right ~= 0 or down ~= 0 then mh.camera.pan(right, down) end
end
