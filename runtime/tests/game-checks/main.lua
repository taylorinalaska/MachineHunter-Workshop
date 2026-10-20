-- Automated in-game checks.
--
-- scripts/game-test.ps1 installs this mod together with maps built by
-- scripts/game-checks.ts, starts the game, and removes both afterwards. The
-- script walks the player through the map and reports on the log:
--
--   [CHECK] PASS <name> | <detail>      a check passed
--   [CHECK] FAIL <name> | <detail>      a check failed
--   [CHECK] INFO <text>                 something worth knowing
--   [CHECK] KEYS <vk>[+<vk>] <ms>       the harness should hold these keys
--   [CHECK] SHOT <name>                 the harness should save a screenshot
--   [CHECK] DONE ...                    finished
--
-- A script cannot press keys, so it asks the harness to, and watches the key
-- go down and come back up to know when that has happened. The checks run
-- in a coroutine resumed every frame, so they read as straight-line code.

local root = mh.mod.root
local layout = dofile(root .. "\\layout.lua")

local function log(text) mh.runtime.log("[CHECK] " .. text) end
local passed, failed = 0, 0
local function check(name, ok, detail)
    if ok then passed = passed + 1 else failed = failed + 1 end
    log((ok and "PASS " or "FAIL ") .. name .. (detail and (" | " .. detail) or ""))
end
local function info(text) log("INFO " .. text) end
local function done() log("DONE " .. passed .. " passed, " .. failed .. " failed") end

-- Which run this is: the harness writes phase.txt.
local phase = "main"
do
    local file = io.open(root .. "\\phase.txt", "r")
    if file then phase = file:read("l") or "main"; file:close() end
end

------------------------------------------------------------------ waiting

local function now() return mh.runtime.time() / 1000 end

local function wait(seconds)
    local until_ = now() + seconds
    while now() < until_ do coroutine.yield() end
end

local function wait_until(test, seconds)
    local until_ = now() + seconds
    while now() < until_ do
        if test() then return true end
        coroutine.yield()
    end
    return test()
end

-- Have the harness hold `keys` for `ms`; `each` runs every frame meanwhile.
local function hold(keys, ms, each)
    log("KEYS " .. table.concat(keys, "+") .. " " .. math.floor(ms))
    if not wait_until(function() return mh.input.down(keys[1]) end, 8) then
        info("the harness did not press " .. keys[1])
        return false
    end
    while mh.input.down(keys[1]) do
        if each then each() end
        coroutine.yield()
    end
    wait(0.15)
    return true
end

local function tap(key) return hold({ key }, 150) end

local function shot(name)
    log("SHOT " .. name)
    wait(1.5)
end

------------------------------------------------------------------- player

local function player()
    local p = mh.entities.player()
    if p == 0 then return nil end
    return p
end

local function state()
    local p = player()
    return p and mh.entities.get(p)
end

local function cell()
    local p = player()
    return p and mh.map.entity_cell(p)
end

local function where()
    local s = state()
    if not s then return "no player" end
    local c = cell()
    return string.format("(%.2f, %.2f) z %.3f storey %s area %d", s.x, s.y, s.z, c and tostring(c.layer + 1) or "?", mh.map.group())
end

local ground_z = 0

-- Put the player in the middle of a cell on the ground storey.
local function place(at)
    local p = player()
    if not p then return false end
    local ok = mh.entities.set_position(p, at.x + 0.5, at.y + 0.5, ground_z)
    wait(0.6)
    return ok
end

-- Arrow keys move the player in screen directions; calibrate() checks which.
local KEY = { east = 39, west = 37, north = 38, south = 40 }

local function keys_for(directions)
    local out = {}
    for i, d in ipairs(directions) do out[i] = KEY[d] end
    return out
end

-- Walk in short steps until `done_` says so or `seconds` run out.
local function walk(directions, done_, seconds, each)
    local until_ = now() + seconds
    while now() < until_ do
        if done_() then return true end
        hold(keys_for(directions), 400, function()
            if each then each() end
        end)
    end
    return done_()
end

local function distance(a, b) return math.abs(a.x - b.x) + math.abs(a.y - b.y) end

local function has_mod(id) return mh.runtime.mods()[id] ~= nil end

------------------------------------------------------------------- checks

local function start_level()
    if not wait_until(function() return player() ~= nil and mh.map.loaded() end, 90) then
        check("the level starts with a player", false, "no player after 90 s")
        return false
    end
    wait(3)
    ground_z = state().z
    info("start " .. where())
    if has_mod("dev-tools") then
        local passive = mh.options.set("dev-tools", "passive", true)
        check("one mod switches on another mod's option (passive enemies)", passive and mh.options.get("dev-tools", "passive") == true)
    end
    return true
end

local function calibrate()
    place(layout.start)
    local before = state()
    local ok = place({ x = layout.start.x + 1, y = layout.start.y })
    local moved = state()
    check("a script can move the player (set_position)", ok and math.abs(moved.x - before.x - 1) < 0.1, string.format("from %.2f to %.2f", before.x, moved.x))

    place(layout.start)
    local a = state()
    hold({ 39 }, 900)
    local b = state()
    local dx, dy = b.x - a.x, b.y - a.y
    info(string.format("Right moved the player by (%.2f, %.2f)", dx, dy))
    if math.abs(dy) > math.abs(dx) then
        -- The view is turned: Right walks along y.
        if dy > 0 then KEY.south, KEY.north, KEY.east, KEY.west = 39, 37, 38, 40 else KEY.north, KEY.south, KEY.east, KEY.west = 39, 37, 40, 38 end
    elseif dx < 0 then
        KEY.west, KEY.east, KEY.north, KEY.south = 39, 37, 40, 38
    end
    check("the arrow keys walk the player", math.abs(dx) + math.abs(dy) > 0.2, string.format("east %d north %d", KEY.east, KEY.north))
end

local function ramps()
    for _, r in ipairs(layout.ramps) do
        -- First a look at the ramp from the side, for its side wall.
        place(r.beside)
        shot("ramp-" .. r.direction)
        place(r.start)
        local before = state()
        local highest, top_z = 0, before.z
        walk({ r.direction }, function()
            local c = cell()
            return c ~= nil and c.layer >= 1 and math.abs(state().x - (r.high.x + 0.5)) + math.abs(state().y - (r.high.y + 0.5)) >= 1.2
        end, 9, function()
            local c, s = cell(), state()
            if c and c.layer > highest then highest = c.layer end
            if s and math.abs(s.z - before.z) > math.abs(top_z - before.z) then top_z = s.z end
        end)
        local c = cell()
        check("ramp rising " .. r.direction .. " leads to the storey above", highest >= 1 and c ~= nil and c.layer >= 1,
            string.format("z %.3f -> %.3f, ends at %s", before.z, top_z, where()))
        if phase == "ramps" then
            wait(0.6)
            c = cell()
            check("ramp " .. r.direction .. " stays on upper floor", c and c.layer == 1 and math.abs(state().z - before.z - 1) < 0.1, where())
            local opposite = { east = "west", west = "east", north = "south", south = "north" }
            -- A 180-degree turn moves this character in an arc. Finish the turn
            -- on the platform, then center the approach so the narrow test rail
            -- does not turn a slope test into a shoulder/railing collision test.
            hold(keys_for({ opposite[r.direction] }), 800)
            local step = { east = {1, 0}, west = {-1, 0}, north = {0, -1}, south = {0, 1} }
            local d = step[r.direction]
            mh.entities.set_position(player(), r.high.x + d[1] + 0.5, r.high.y + d[2] + 0.5, before.z + 1)
            wait(0.2)
            walk({ opposite[r.direction] }, function()
                local s = state()
                return math.abs(s.x - (r.start.x + 0.5)) + math.abs(s.y - (r.start.y + 0.5)) < 0.7
            end, 9)
            c = cell()
            check("ramp " .. r.direction .. " descends to ground", c and c.layer == 0 and math.abs(state().z - before.z) < 0.1, where())
        end
    end
end

local function hazard()
    local h = layout.hazard
    place(h.start)
    local p = player()
    local before = state().health
    walk({ "east" }, function() return state().x >= h.x0 + 1 end, 8)
    wait(1.5)
    local after = state().health
    check("hazard floor hurts", after < before, string.format("health %d -> %d", before, after))
    place(h.start)         -- off the hazard, or it keeps hurting
    mh.entities.set_health(p, before)
    wait(0.2)
    check("a script can set health", state().health == before, tostring(state().health))
end

local function diagonals()
    for _, d in ipairs(layout.diagonals) do
        place(d.start)
        local function side() local s = state(); return d.a * s.x + d.b * s.y - d.c end
        local start = side()
        local crossed = false
        hold(keys_for(d.keys), 3500, function()
            if (side() > 0) ~= (start > 0) then crossed = true end
        end)
        local finish = side()
        check(d.name .. " blocks the player", not crossed and math.abs(finish) < math.abs(start),
            string.format("distance from the wall %.2f -> %.2f, %s", math.abs(start), math.abs(finish), where()))
        if d.shot then shot(d.shot) end
    end
end

local function prop_with_wall()
    local p = layout.prop
    place(p.start)
    local entered, crossed = false, false
    hold({ KEY.east }, 3000, function()
        local s = state()
        if s.x >= p.cell.x then entered = true end
        if s.x >= p.wall then crossed = true end
    end)
    check("a retail prop with an added wall: walkable, and the wall blocks", entered and not crossed,
        string.format("retail cell %d, ends at %s", p.retail, where()))
    shot("prop-with-wall")
end

local function teleporter()
    local t = layout.teleporter
    place(t.start)
    local last, landed = state(), nil
    walk({ "east" }, function() return landed ~= nil end, 10, function()
        local s = state()
        if s and not landed and math.abs(s.x - last.x) + math.abs(s.y - last.y) > 2 then landed = { x = s.x, y = s.y } end
        last = s or last
    end)
    local near = landed and math.abs(landed.x - (t.to.x + 0.5)) < 1.5 and math.abs(landed.y - (t.to.y + 0.5)) < 1.5
    check("teleporter sends the player to its destination", near,
        landed and string.format("landed at (%.2f, %.2f), destination (%d, %d)", landed.x, landed.y, t.to.x, t.to.y) or ("no jump; " .. where()))
end

local function mod_menu()
    if not has_mod("mod-menu") then info("Mod Menu not installed; skipped"); return end
    place(layout.start)
    tap(114)
    wait(0.6)
    check("Mod Menu opens and takes the keyboard", mh.input.blocked())
    shot("mod-menu")
    tap(114)
    wait(0.6)
    check("Mod Menu closes", not mh.input.blocked())

    -- Rebind the menu's own key from inside the menu. Each mod with options has one page, in
    -- alphabetical order of the mods' names: the Mod Menu's comes after the loaded ones among
    -- Controls, Developer Tools, Free Camera and HD Rendering.
    local before = 0
    for _, id in ipairs({ "controls", "dev-tools", "free-camera", "hd-rendering" }) do if has_mod(id) then before = before + 1 end end
    local saved = mh.options.get("mod-menu", "open_key")
    tap(114)
    wait(0.5)
    for _ = 1, before do tap(39); wait(0.15) end
    tap(13)                -- "Open and close" now waits for a key
    wait(0.4)
    tap(115)               -- F4
    wait(0.4)
    local rebound = mh.options.get("mod-menu", "open_key")
    check("Mod Menu: a key can be rebound from the menu", rebound == 115, "open key is now " .. mh.input.key_name(rebound))
    tap(115)
    wait(0.6)
    check("Mod Menu: the new key closes it", not mh.input.blocked())
    tap(115)
    wait(0.6)
    check("Mod Menu: the new key opens it", mh.input.blocked())
    tap(115)
    wait(0.6)
    mh.options.set("mod-menu", "open_key", saved)
end

local function free_camera()
    if not has_mod("free-camera") then info("Free Camera not installed; skipped"); return end
    place(layout.start)
    mh.options.set("free-camera", "active", true)
    wait(0.5)
    local view = mh.camera.get()
    check("free camera takes the view", view ~= nil and view.overridden)
    local s0, c0 = state(), mh.camera.get()
    hold({ KEY.east }, 1500)
    wait(0.3)
    local s1, c1 = state(), mh.camera.get()
    check("free camera flies with the arrow keys", c1.x - c0.x > 0.3, string.format("camera x %.2f -> %.2f", c0.x, c1.x))
    check("the player stays put while the camera flies", math.abs(s1.x - s0.x) < 0.15 and math.abs(s1.y - s0.y) < 0.15,
        string.format("player (%.2f, %.2f) -> (%.2f, %.2f)", s0.x, s0.y, s1.x, s1.y))
    shot("free-camera")
    mh.options.set("free-camera", "active", false)
    wait(0.5)
    check("free camera gives the view back", not mh.camera.get().overridden)
end

local function dev_tools()
    if not has_mod("dev-tools") then info("Developer Tools not installed; skipped"); return end
    place(layout.diagonals[1].start)
    local keys = { "hud", "types", "headings", "collision" }
    local saved = {}
    for _, k in ipairs(keys) do saved[k] = mh.options.get("dev-tools", k); mh.options.set("dev-tools", k, true) end
    wait(0.5)
    shot("dev-tools")
    -- These options are saved, so put back what the player had.
    for _, k in ipairs(keys) do mh.options.set("dev-tools", k, saved[k]) end
end

---------------------------------------------------------------- followers

-- Map objects of `group` whose type matches a follower and whose position is in
-- the area its path covers: one that has been moving no longer stands where it
-- was placed.
local function find_followers(specs, group)
    local found, taken = {}, {}
    for i = 0, mh.map.object_count(group, 0) - 1 do
        local id = mh.map.object_at(group, 0, i)
        local o = mh.map.object_get(id)
        for n, f in ipairs(specs) do
            if o and o.type == f.type and not taken[n] then
                local x0, y0, x1, y1 = math.huge, math.huge, -math.huge, -math.huge
                for _, p in ipairs(f.points) do
                    x0, y0 = math.min(x0, p.x), math.min(y0, p.y)
                    x1, y1 = math.max(x1, p.x + 1), math.max(y1, p.y + 1)
                end
                if o.x >= x0 - 1.5 and o.x <= x1 + 1.5 and o.y >= y0 - 1.5 and o.y <= y1 + 1.5 then
                    taken[n] = true
                    found[#found + 1] = { spec = f, object = id }
                    break
                end
            end
        end
    end
    return found
end

-- Actors only exist while the player is near them and come back under a new
-- handle, so stand by the follower and ask its map object for the actor.
local function acquire(follower)
    place(follower.spec.watch)
    local entity = 0
    wait_until(function()
        local o = mh.map.object_get(follower.object)
        entity = o and o.entity or 0
        return entity ~= 0
    end, 4)
    if entity == 0 then
        info(follower.spec.name .. " had not appeared; spawning it")
        entity = mh.map.object_spawn(follower.object)
        wait(1)
    end
    return entity
end

local MODE_ONCE, MODE_BACK_AND_FORTH, MODE_LOOP, MODE_ZONE = 0, 1, 2, 4

local function check_followers(specs, group)
    local list = find_followers(specs, group)
    check("the followers are on the map (area " .. group .. ")", #list == #specs, #list .. " of " .. #specs)
    for _, f in ipairs(list) do
        local spec, pts = f.spec, f.spec.points
        local entity = acquire(f)
        local smp, start = {}, now()
        local seconds = spec.mode == MODE_BACK_AND_FORTH and 26 or 16
        while now() - start < seconds do
            local s = entity ~= 0 and mh.entities.get(entity)
            if s then smp[#smp + 1] = { t = now() - start, x = s.x, y = s.y } end
            -- Some followers shoot; keep the player alive while watching.
            local me = state()
            if me and me.health < 50 then mh.entities.set_health(player(), 95) end
            wait(0.25)
        end
        local name = spec.name
        if #smp < 10 then
            check(name .. ": follows its path", false, "no live actor to watch (" .. #smp .. " samples)")
        else
            local travelled = 0
            for i = 2, #smp do travelled = travelled + distance(smp[i], smp[i - 1]) end
            local a = { x = pts[1].x + 0.5, y = pts[1].y + 0.5 }
            local b = { x = pts[2].x + 0.5, y = pts[2].y + 0.5 }
            local last = smp[#smp]
            local detail = string.format("behaviour %d, travelled %.1f cells in %.0f s, ended (%.1f, %.1f)", spec.behavior, travelled, last.t, last.x, last.y)
            if spec.mode == MODE_LOOP then
                check(name .. ": goes round", travelled > 4, detail)
            elseif spec.mode == MODE_BACK_AND_FORTH then
                local at_b, back = nil, false
                for _, s in ipairs(smp) do
                    if not at_b and distance(s, b) < 1.2 then at_b = s.t end
                    if at_b and s.t > at_b and distance(s, a) < 1.5 then back = true end
                end
                check(name .. ": turns round at the end", at_b ~= nil and back, detail)
            elseif spec.mode == MODE_ONCE then
                -- Retail mode 0 reads like "walk once and stop", but nothing walks it: followers
                -- stay at the first point. Checked so a change in that shows up.
                local stayed = true
                for _, s in ipairs(smp) do if distance(s, a) > 0.6 then stayed = false end end
                check(name .. ": stays at its first point", stayed, detail)
            elseif spec.mode == MODE_ZONE then
                local x0, y0 = math.min(pts[1].x, pts[2].x) - 1, math.min(pts[1].y, pts[2].y) - 1
                local x1, y1 = math.max(pts[1].x, pts[2].x) + 2, math.max(pts[1].y, pts[2].y) + 2
                local inside = true
                for _, s in ipairs(smp) do if s.x < x0 or s.x > x1 or s.y < y0 or s.y > y1 then inside = false end end
                check(name .. ": wanders inside its zone", inside and travelled > 2, detail)
            end
        end
    end
    return list
end

local function followers()
    local list = check_followers(layout.followers, 0)

    -- Game speed: pause the world with Developer Tools while watching the looping robot.
    local looping = nil
    for _, f in ipairs(list) do if f.spec.mode == MODE_LOOP then looping = f end end
    local e = looping and acquire(looping) or 0
    if has_mod("dev-tools") and e ~= 0 then
        mh.options.set("dev-tools", "speed", "Pause")
        wait(0.3)
        local p0 = mh.entities.get(e)
        wait(1.5)
        local p1 = mh.entities.get(e)
        mh.options.set("dev-tools", "speed", "1x")
        wait(1.5)
        local p2 = mh.entities.get(e)
        check("game speed: Pause stops the world", p0 and p1 and distance(p0, p1) < 0.02, p0 and p1 and string.format("moved %.3f", distance(p0, p1)) or "no robot")
        check("game speed: 1x starts it again", p1 and p2 and distance(p1, p2) > 0.1, p1 and p2 and string.format("moved %.3f", distance(p1, p2)) or "no robot")
    end
end

-- Passive enemies, and the runtime trace recording the shots and damage of the same fight.
local function guard()
    if not has_mod("dev-tools") then info("Developer Tools not installed; skipped"); return end
    local g = layout.guard
    local robot = find_followers({ { type = 3, points = { g.robot }, name = "guard" } }, 0)[1]
    if not robot then check("the guard robot is on the map", false); return end
    local entity = acquire({ spec = { watch = g.player, name = "guard robot" }, object = robot.object })
    if entity == 0 then check("the guard robot is active", false); return end
    local p = player()
    local before = state().health

    wait(6)
    local calm = state().health
    check("passive enemies: the robot holds fire", calm >= before, string.format("health %d -> %d over 6 s", before, calm))

    local trace_was = mh.options.get("dev-tools", "trace")
    mh.options.set("dev-tools", "trace", true)
    mh.options.set("dev-tools", "passive", false)
    local hurt = wait_until(function() return state().health < calm end, 12)
    check("passive enemies off: the robot attacks", hurt, string.format("health %d", state().health))
    mh.options.set("dev-tools", "passive", true)
    mh.entities.set_health(p, before)
    hold({ 17 }, 700)      -- Ctrl fires the player's weapon
    wait(0.5)
    mh.options.set("dev-tools", "trace", trace_was)
    wait(0.5)

    local text = ""
    local file = io.open("logs\\runtime-trace.log", "r")
    if file then text = file:read("a") or ""; file:close() end
    local fires = select(2, text:gsub("TRACE FIRE", ""))
    local damage = select(2, text:gsub("TRACE DAMAGE", ""))
    check("runtime trace records shots and damage", fires > 0 and damage > 0, string.format("%d FIRE and %d DAMAGE records, %d bytes", fires, damage, #text))
end

------------------------------------------------------------------- ending

local level_complete = false
function on_level_complete() level_complete = true end

local function second_area_and_exit()
    place(layout.area.start)
    local arrived = walk({ "east" }, function() return mh.map.group() == 1 end, 10)
    wait(1.5)
    local s = state()
    check("teleporter into another area", arrived and s ~= nil and math.abs(s.x - (layout.area.to.x + 0.5)) < 1.5 and math.abs(s.y - (layout.area.to.y + 0.5)) < 1.5,
        "area " .. mh.map.group() .. ", " .. where())
    if not arrived then return end

    local on_exit = false
    walk({ "east" }, function()
        local c = cell()
        if c and c.class == 0x0400 then on_exit = true end
        return on_exit or level_complete
    end, 10)
    wait_until(function() return level_complete end, 6)
    shot("after-exit")
    check("stepping on the exit ends the level", on_exit and level_complete, "on_level_complete " .. (level_complete and "fired" or "did not fire"))
end

local function run(name, fn)
    local ok, err = pcall(fn)
    if not ok then check(name, false, "script error: " .. tostring(err)) end
end

local function main()
    if not start_level() then done(); return end
    run("calibration", calibrate)
    run("ramps", ramps)
    run("hazard", hazard)
    run("diagonal walls", diagonals)
    run("prop with a wall", prop_with_wall)
    run("teleporter", teleporter)
    run("Mod Menu", mod_menu)
    run("free camera", free_camera)
    run("Developer Tools", dev_tools)
    run("guard", guard)
    run("followers", followers)
    run("second area and exit", second_area_and_exit)
    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    done()
end

-- The MILIT3 map: it starts in its second area, where tanks follow routes.
local function second()
    if not start_level() then done(); return end
    check("a map can start in its second area", mh.map.group() == 1, "area " .. mh.map.group() .. ", " .. where())
    run("tanks", function() check_followers(layout.second.followers, 1) end)
    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    done()
end

-- A custom enemy: a Four Foot made over with its own health, damage and look.
local function custom()
    if not start_level() then done(); return end
    local c = layout.custom
    local robot = find_followers({ { type = 3, points = { c.robot }, name = "custom robot" } }, 0)[1]
    if not robot then check("the custom robot is on the map", false); done(); return end
    local entity = acquire({ spec = { watch = c.player, name = "custom robot" }, object = robot.object })
    local e = entity ~= 0 and mh.entities.get(entity)
    check("a custom enemy has its own health", e and e.health == c.health,
        e and string.format("health %d, expected %d (a Four Foot has %d)", e.health, c.health, c.retail_health) or "no robot")
    shot("custom-robot")
    -- A Four Foot's first weapon does 3 a hit before difficulty scaling, which is at most x1.21.
    if has_mod("dev-tools") then
        local p = player()
        local full = state().health
        local last, hits, start = full, {}, now()
        mh.options.set("dev-tools", "passive", false)
        while now() - start < 12 and #hits < 6 do
            local h = state() and state().health or last
            if h < last then hits[#hits + 1] = last - h end
            last = h
            if h < full / 2 then mh.entities.set_health(p, full); last = full end
            coroutine.yield()
        end
        mh.entities.set_health(p, full)
        shot("custom-robot-attacking")
        mh.options.set("dev-tools", "passive", true)
        mh.entities.set_health(p, full)
        local sum = 0
        for _, d in ipairs(hits) do sum = sum + d end
        local mean = #hits > 0 and sum / #hits or 0
        check("a custom enemy's shots do more damage", #hits > 0 and mean >= c.min_hit,
            string.format("%d hits: %s (a Four Foot's do at most 4)", #hits, table.concat(hits, ", ")))
        mh.options.set("dev-tools", "passive", false)
    end
    done()
end

-- Two friends that follow the player round a course (see friendMap in scripts/game-checks.ts).
local function friends()
    if not start_level() then done(); return end
    local F = layout.friends
    -- The friend of each type, wherever it is now: friends change storey and area.
    local function find(type)
        for g = 0, mh.map.group_count() - 1 do
            for l = 0, mh.map.layer_count(g) - 1 do
                for i = 0, mh.map.object_count(g, l) - 1 do
                    local o = mh.map.object_get(mh.map.object_at(g, l, i))
                    if o and o.type == type and o.entity ~= 0 then
                        local s = mh.entities.get(o.entity)
                        if s then s.handle = o.entity; return s end
                    end
                end
            end
        end
        return nil
    end
    local function gap(type)
        local s, p = find(type), state()
        if not s or not p or s.group ~= p.group then return 99 end
        return math.sqrt((s.x - p.x) ^ 2 + (s.y - p.y) ^ 2)
    end
    local function gaps()
        local out = {}
        for _, f in ipairs(F.friends) do out[#out + 1] = string.format("%d: %.1f", f.type, gap(f.type)) end
        return table.concat(out, ", ")
    end
    local function worst()
        local w = 0
        for _, f in ipairs(F.friends) do w = math.max(w, gap(f.type)) end
        return w
    end

    -- They must not shoot, with enemies free to.
    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    local full = state().health
    wait(6)
    check("friends do not attack the player", state().health >= full, string.format("health %d -> %d; %s", full, state().health, gaps()))

    -- Standing still: they wander a little, stay close, and keep apart.
    local walked, far = {}, 0
    local last = {}
    local start = now()
    while now() - start < 8 do
        for _, f in ipairs(F.friends) do
            local s = find(f.type)
            if s and last[f.type] then walked[f.type] = (walked[f.type] or 0) + math.sqrt((s.x - last[f.type].x) ^ 2 + (s.y - last[f.type].y) ^ 2) end
            last[f.type] = s or last[f.type]
        end
        far = math.max(far, worst())
        coroutine.yield()
    end
    do
        local r, p = find(F.friends[1].type), state()
        if r and p then info(string.format("robot at (%.2f, %.2f) z %.3f, player z %.3f", r.x, r.y, r.z, p.z)) end
    end
    local a, b = find(F.friends[1].type), find(F.friends[2].type)
    local apart = a and b and math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) or 0
    local calm = true
    for _, f in ipairs(F.friends) do calm = calm and (walked[f.type] or 0) < 6 end
    check("friends wander only a little when the player stands still", calm and far <= 3.5,
        string.format("walked %.1f and %.1f cells in 8 s, at most %.1f away", walked[F.friends[1].type] or 0, walked[F.friends[2].type] or 0, far))
    check("friends keep apart", apart >= 0.5, string.format("%.1f cells apart", apart))

    -- The player is moved by the script at walking pace (2.2 cells a second), so the check does
    -- not depend on the game window having the keyboard. `height(t)` gives z along a leg.
    local most = 0
    local function glide(from, to, height)
        local length = math.sqrt((to.x - from.x) ^ 2 + (to.y - from.y) ^ 2)
        local t0 = now()
        while true do
            local t = math.min(1, (now() - t0) * 2.2 / length)
            local x, y = from.x + 0.5 + (to.x - from.x) * t, from.y + 0.5 + (to.y - from.y) * t
            mh.entities.set_position(player(), x, y, height and height(x, y) or ground_z)
            most = math.max(most, worst())
            if t >= 1 then break end
            coroutine.yield()
        end
    end

    -- Walking: through the door into the next room.
    for k = 2, #F.course do glide(F.course[k - 1], F.course[k]) end
    wait(4)
    local through = true
    for _, f in ipairs(F.friends) do local s = find(f.type); through = through and s ~= nil and s.x > 10.2 end
    check("friends follow the player through a door into the next room", through and worst() <= 3, gaps() .. string.format("; at most %.1f away on the way", most))
    shot("friends-room-b")

    -- Up the ramp onto the upper storey: z climbs a storey (1.0) over the ramp's two cells.
    local low, high = F.ramp.low, F.ramp.high
    local function ramp_z(x)
        local t = math.max(0, math.min(1, (x - low.x) / (high.x + 1 - low.x)))
        return ground_z + t
    end
    glide(F.ramp.from, { x = high.x + 2, y = high.y }, function(x) return ramp_z(x) end)
    wait(4)
    info("on the landing " .. where())
    for _, f in ipairs(F.friends) do local s = find(f.type); if s then info(string.format("friend %d at (%.2f, %.2f) z %.2f", f.type, s.x, s.y, s.z)) end end
    local p = state()
    local up = true
    -- Within half a storey is the same storey (the top of the ramp counts).
    for _, f in ipairs(F.friends) do local s = find(f.type); up = up and s ~= nil and math.abs(s.z - p.z) < 0.5 end
    check("friends follow the player up a ramp", p and math.abs(p.z - ground_z) > 0.5 and up and worst() <= 3, string.format("player z %.2f; %s", p and p.z or 0, gaps()))
    shot("friends-upstairs")

    -- Through the teleporter into the second area.
    glide({ x = high.x + 2, y = high.y }, F.teleporter, function() return ground_z + 1 end)
    wait_until(function() return mh.map.group() == 1 end, 4)
    wait(1)
    -- Walk on a little in the new area; the friends come in behind.
    local here = state()
    if here then glide({ x = math.floor(here.x), y = math.floor(here.y) }, { x = math.floor(here.x) + 3, y = math.floor(here.y) }, function() return here.z end) end
    wait(4)
    local moved, nearest = true, 99
    for _, f in ipairs(F.friends) do
        local s = find(f.type)
        moved = moved and s ~= nil and s.group == 1
        nearest = math.min(nearest, gap(f.type))
    end
    check("friends follow the player through a teleporter into another area", mh.map.group() == 1 and moved and worst() <= 3, string.format("player in area %d; %s", mh.map.group(), gaps()))
    check("friends do not stand on the player", nearest >= 0.6, string.format("nearest %.1f cells", nearest))
    shot("friends-second-area")

    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    done()
end

-- A fight (see fightMap in scripts/game-checks.ts): a friend and a tough enemy.
local function fight()
    if not start_level() then done(); return end
    local F = layout.fight
    local function find(type)
        for i = 0, mh.map.object_count(0, 0) - 1 do
            local o = mh.map.object_get(mh.map.object_at(0, 0, i))
            if o and o.type == type and o.entity ~= 0 then
                local s = mh.entities.get(o.entity)
                if s then s.handle = o.entity; return s end
            end
        end
        return nil
    end
    local p = player()
    local full = state().health
    local friend0, enemy0 = find(F.friend), find(F.enemy)
    info(string.format("friend %s, enemy %s", friend0 and friend0.health or "none", enemy0 and enemy0.health or "none"))
    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    -- The player never fires; they are kept alive so the fight can be watched.
    local friend_low, enemy_low = friend0 and friend0.health or 0, enemy0 and enemy0.health or 0
    local died = false
    local start = now()
    -- Developer Tools' trace records every shot and hit; the counts go in the report.
    if has_mod("dev-tools") then mh.options.set("dev-tools", "trace", true) end
    while now() - start < 30 and not died do
        mh.entities.set_health(p, full)
        local f, e = find(F.friend), find(F.enemy)
        if f then friend_low = math.min(friend_low, f.health); if f.health <= 0 then died = true end
        else died = friend0 ~= nil end
        if e then enemy_low = math.min(enemy_low, e.health) end
        coroutine.yield()
    end
    shot("fight")
    if has_mod("dev-tools") then
        mh.options.set("dev-tools", "trace", false)
        wait(0.5)
        local file = io.open("logs\\runtime-trace.log", "r")
        local text = file and file:read("a") or ""
        if file then file:close() end
        local fires, hits = {}, {}
        for slot in text:gmatch("TRACE FIRE[^\n]- slot=(%-?%d+)") do fires[slot] = (fires[slot] or 0) + 1 end
        for kind, slot, hp in text:gmatch("TRACE (DAMAGE%w*)[^\n]- slot=(%-?%d+)[^\n]- hp=(%-?%d+%->%-?%d+)") do hits[#hits + 1] = kind .. "@" .. slot .. ":" .. hp end
        local f = {}
        for k, v in pairs(fires) do f[#f + 1] = k .. "=" .. v end
        info("trace fires by slot: " .. table.concat(f, ", "))
        info("trace damage: " .. table.concat(hits, " ", 1, math.min(#hits, 30)))
    end
    check("a friend fights an enemy", enemy0 and enemy_low < enemy0.health, string.format("enemy health %s -> %d", enemy0 and enemy0.health or "?", enemy_low))
    check("an enemy fights a friend", friend0 and friend_low < friend0.health, string.format("friend health %s -> %d", friend0 and friend0.health or "?", friend_low))
    if not died then
        -- It held out: bring it to its last hit point and let the enemy finish it.
        local f = find(F.friend)
        if f then mh.entities.set_health(f.handle, 1) end
        died = wait_until(function() mh.entities.set_health(p, full); local g = find(F.friend); return g == nil or g.health <= 0 end, 20)
    end
    check("a friend dies when its health runs out", died)
    wait(6)
    local back = find(F.friend)
    check("a dead friend stays dead", back == nil or back.health <= 0, back and string.format("health %d", back.health) or "gone")
    shot("fight-after")
    done()
end

-- Two friends against two enemies (see battleMap in scripts/game-checks.ts).
local function battle()
    if not start_level() then done(); return end
    local B = layout.battle
    -- Every actor of a type in play, by map record.
    local function all(type)
        local out = {}
        for i = 0, mh.map.object_count(0, 0) - 1 do
            local o = mh.map.object_get(mh.map.object_at(0, 0, i))
            if o and o.type == type then out[#out + 1] = o end
        end
        return out
    end
    local low = {}       -- lowest health seen, by map record
    local first = {}
    local kind = {}      -- type of each record seen: a killed one's record goes away
    local function watch()
        for _, type in ipairs({ B.friends[1], B.friends[2], B.enemy }) do
            for _, o in ipairs(all(type)) do
                local s = o.entity ~= 0 and mh.entities.get(o.entity)
                if s then
                    first[o.id] = first[o.id] or s.health
                    kind[o.id] = type
                    low[o.id] = math.min(low[o.id] or s.health, s.health)
                elseif first[o.id] then
                    low[o.id] = math.min(low[o.id], 0)   -- gone: killed
                end
            end
        end
    end
    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    local p = player()
    local full = state().health
    local start = now()
    while now() - start < 30 do
        mh.entities.set_health(p, full)
        watch()
        coroutine.yield()
    end
    shot("battle")
    local function summary(type)
        local hurt, parts = 0, {}
        for id, t in pairs(kind) do
            if t == type then
                local alive = false
                for _, o in ipairs(all(type)) do if o.id == id and o.entity ~= 0 then alive = true end end
                local lowest = alive and low[id] or 0
                parts[#parts + 1] = string.format("%d->%d", first[id], lowest)
                if lowest < first[id] then hurt = hurt + 1 end
            end
        end
        return hurt, #parts, table.concat(parts, ", ")
    end
    local eh, en, es = summary(B.enemy)
    local f1, n1, s1 = summary(B.friends[1])
    local f2, n2, s2 = summary(B.friends[2])
    check("two friends wear down both enemies", en == 2 and eh == 2, "enemies " .. es)
    check("both friends join in and the enemies fight them", n1 == 1 and n2 == 1 and f1 + f2 >= 1, "Four Foot " .. s1 .. "; Laughing Cavalier " .. s2)
    check("the game carries on through the battle", state() ~= nil, where())
    done()
end

-- Doors (see doorsMap in scripts/game-checks.ts). A door cell's definition changes as it opens.
local function doors()
    if not start_level() then done(); return end
    local D = layout.doors
    local function def(c) local s = mh.map.cell_get(0, 0, c.x, c.y); return s and s.definition or -1 end
    -- A door's panel runs across the middle of its cell; the north quarter is open floor, and
    -- standing there is being in the door's cell, which is what opens it (the game's contact test
    -- is the cell an actor is in).
    local function touch(c)
        place({ x = c.x, y = c.y - 1 })
        mh.entities.set_position(player(), c.x + 0.5, c.y + 0.12, ground_z)
        wait(0.5)
        place({ x = c.x, y = c.y - 1 })
    end
    local function closes_again(c, closed)
        return wait_until(function() return def(c) == closed end, 8)
    end

    -- Use real movement through a one-cell corridor, without teleporting into
    -- the door's trigger cell. Test both approach directions.
    for _, approach in ipairs({ { side = -1, direction = "south" }, { side = 1, direction = "north" } }) do
        local c = D.walking
        local closed = def(c)
        place({ x = c.x, y = c.y + approach.side })
        walk({ approach.direction }, function()
            return approach.side < 0 and state().y > c.y + 1 or approach.side > 0 and state().y < c.y
        end, 5)
        local crossed = approach.side < 0 and state().y > c.y + 1 or approach.side > 0 and state().y < c.y
        check("walk through sliding door from " .. (approach.side < 0 and "north" or "south"), crossed, where())
        place({ x = c.x + 2, y = c.y + 2 })
        closes_again(c, closed)
    end

    local closed = def(D.touch)
    touch(D.touch)
    local opened = wait_until(function() return def(D.touch) ~= closed end, 2)
    local after = def(D.touch)
    check("a door opens when touched", opened, string.format("cell %d -> %d", closed, after))
    shot("door-open")
    check("an open door closes again", opened and closes_again(D.touch, closed), "cell " .. def(D.touch))

    local a0, b0 = def(D.pair[1]), def(D.pair[2])
    touch(D.pair[1])
    local both = wait_until(function() return def(D.pair[1]) ~= a0 and def(D.pair[2]) ~= b0 end, 2)
    check("a double door opens together", both, string.format("%d -> %d, %d -> %d", a0, def(D.pair[1]), b0, def(D.pair[2])))
    -- They slide: once open, the moment they start to close is caught partway (the open cell shows no panel).
    if both then
        local open = def(D.pair[1])
        if wait_until(function() return def(D.pair[1]) ~= open end, 8) then log("SHOT door-closing") end
        closes_again(D.pair[1], a0)
    end

    local g0 = def(D.bare)
    touch(D.bare)
    local bare = wait_until(function() return def(D.bare) ~= g0 end, 2)
    check("a door with no floor of its own opens", bare, string.format("cell %d -> %d", g0, def(D.bare)))
    if bare then closes_again(D.bare, g0) end

    local k0 = def(D.key)
    touch(D.key)
    wait(1)
    check("a door that needs a key stays shut without it", def(D.key) == k0, "cell " .. def(D.key))
    place(D.keyAt)
    wait(1)
    touch(D.key)
    local keyed = wait_until(function() return def(D.key) ~= k0 end, 2)
    check("with the key it opens", keyed, "cell " .. def(D.key))

    local s0 = def(D.switched)
    touch(D.switched)
    wait(1)
    check("a switch door stays shut when touched", def(D.switched) == s0, "cell " .. def(D.switched))
    place(D.switchAt)
    local switched = wait_until(function() return def(D.switched) ~= s0 end, 2)
    check("stepping on its switch opens it", switched, "cell " .. def(D.switched))
    shot("switch-door")
    if switched then closes_again(D.switched, s0) end
    touch(D.switched)
    local again = wait_until(function() return def(D.switched) ~= s0 end, 2)
    check("after the switch, touch opens it too", again, "cell " .. def(D.switched))
    done()
end

-- Reproduce a door in an existing project without modifying the original file.
local function userdoor()
    if not start_level() then done(); return end
    local d = layout.userDoor
    local function definition() return mh.map.cell_get(d.group, d.layer, d.x, d.y).definition end
    local function approach()
        place({ x = d.x, y = d.y + 1 })
        walk({ "north" }, function() return state().y < d.y end, 4)
        info("door approach " .. where() .. " cell " .. definition())
    end
    local closed = definition()
    if d.lock > 0 then
        mh.game.revoke_access(2 ^ (d.lock - 1))
        approach()
        check("project door stays locked without its key", definition() == closed, where())
        if d.keyAt then
            place(d.keyAt)
            wait(1)
        else
            mh.game.grant_access(2 ^ (d.lock - 1))
        end
    end
    local keyBit = d.lock > 0 and 2 ^ (d.lock - 1) or 0
    local function hasKey() return keyBit == 0 or math.floor(mh.game.state().access_mask / keyBit) % 2 == 1 end
    if keyBit > 0 then check("project key is in inventory after pickup", hasKey(), "access " .. mh.game.state().access_mask) end
    approach()
    check("project door opens and can be walked through", state().y < d.y, where())
    if keyBit > 0 then
        check("project key stays in inventory after first use", hasKey(), "access " .. mh.game.state().access_mask)
        local firstFacing = state().facing
        place({ x = d.x, y = d.y - 2 })
        wait(8)
        check("project key stays in inventory while door closes", hasKey(), "access " .. mh.game.state().access_mask)
        if d.robot then
            local found = find_followers({ { type = d.robot.type, points = { d.robot }, name = "possession robot" } }, d.group)[1]
            if found then
                local human = state().active_type
                local robot = acquire({ object = found.object, spec = { watch = { x = d.robot.x - 1, y = d.robot.y }, name = "possession robot" } })
                if robot ~= 0 then
                    mh.entities.set_health(robot, 0)
                    wait(0.3)
                    local possessed = wait_until(function()
                        if state().active_type ~= human then return true end
                        local r = mh.entities.get(robot)
                        if r then mh.entities.set_position(player(), r.x, r.y, r.z) end
                        return false
                    end, 6)
                    check("possess the robot from the project", possessed, "body " .. human .. " -> " .. state().active_type)
                    check("key remains available after possession", hasKey(), "access " .. mh.game.state().access_mask)
                    mh.entities.set_facing(player(), (firstFacing + 1024) % 2048)
                    place({ x = d.x, y = d.y - 1 })
                else check("project robot is active for possession", false) end
            else check("project robot is available for possession", false) end
        end
        walk({ "south" }, function() return state().y > d.y + 1 end, 5)
        check("project door opens again from the other side", state().y > d.y + 1, where())
        check("project key stays in inventory after second use", hasKey(), "access " .. mh.game.state().access_mask)
        if d.robot then
            place({ x = d.x, y = d.y + 2 })
            wait(8)
            mh.game.revoke_access(keyBit)
            approach()
            check("possessed robot cannot open door without key", state().y > d.y + 0.5, where())
            mh.game.grant_access(keyBit)
            approach()
            check("possessed robot opens door from the south with key", state().y < d.y, where())
        end
        mh.game.revoke_access(keyBit)
        wait(0.3)
        check("scripts can still deliberately revoke the key", not hasKey(), "access " .. mh.game.state().access_mask)
        mh.game.grant_access(keyBit)
    end
    shot("project-door")
    done()
end

-- Screenshot regressions for a supplied project, including camera-dependent terrain.
local function usergeometry()
    if not start_level() then done(); return end
    for _, p in ipairs({ {x=6,y=64}, {x=7,y=64}, {x=8,y=64}, {x=9,y=65}, {x=3,y=35}, {x=7,y=46} }) do
        place(p)
        shot("terrain-" .. p.x .. "-" .. p.y)
    end
    done()
end

-- Exercise every door in a supplied project with its actual placed creature.
local function usercorridor()
    if not start_level() then done(); return end
    local r = layout.corridorRobot
    if not r then check("project has corridor robot", false); done(); return end
    local found = find_followers({ {type=r.type, points={r}, name="corridor robot"} }, 0)[1]
    if not found then check("corridor robot is placed", false); done(); return end
    local e = acquire({object=found.object, spec={watch={x=r.x+1,y=r.y},name="corridor robot"}})
    mh.entities.set_health(e, 0)
    wait(0.3)
    local possessed = wait_until(function()
        if state().active_type == 3 then return true end
        local s = mh.entities.get(e)
        if s then mh.entities.set_position(player(),s.x,s.y,s.z) end
        return false
    end,6)
    check("possess the corridor robot", possessed, "body " .. state().active_type)
    for _, d in ipairs(layout.userDoors) do
        if d.facing == "ns" then
            mh.game.grant_access(31)
            mh.entities.set_facing(player(),0)
            place({x=d.x,y=d.y+1})
            walk({"north"},function() return state().y < d.y end,5)
            check("robot crosses north through project door " .. d.x .. "," .. d.y,state().y < d.y,where())
            place({x=d.x,y=d.y-2})
            wait(5)
            mh.entities.set_facing(player(),1024)
            place({x=d.x,y=d.y-1})
            walk({"south"},function() return state().y > d.y+1 end,5)
            check("robot crosses south through project door " .. d.x .. "," .. d.y,state().y > d.y+1,where())
        end
    end
    done()
end

-- The in-game interface with HD Rendering: screenshots of the status bar, a picked-up key and
-- the "CONTINUE?" screen after the player dies, for looking at. The game must carry on throughout.
local function hud()
    if not start_level() then done(); return end
    local D = layout.doors
    wait(1)
    shot("hud-start")
    place(D.keyAt)
    wait(1.5)
    shot("hud-key")
    mh.entities.set_health(player(), 0)
    wait(2)
    shot("hud-dead")
    wait(3)
    shot("hud-continue")
    check("the game carries on with the interface scaled up", state() ~= nil or mh.game.level() ~= nil, where())
    done()
end

-- A trigger pad and everything it does (see triggersMap in scripts/game-checks.ts).
local function triggers()
    if not start_level() then done(); return end
    local T = layout.triggers
    local function def(c) local s = mh.map.cell_get(0, 0, c.x, c.y); return s and s.definition or -1 end
    local function robot()
        for i = 0, mh.map.object_count(0, 0) - 1 do
            local o = mh.map.object_get(mh.map.object_at(0, 0, i))
            if o and o.type == T.robot.type and math.abs(o.x - (T.robot.x + 0.5)) < 0.6 and math.abs(o.y - (T.robot.y + 0.5)) < 0.6 then return o end
        end
        return nil
    end
    local r0, b0, t0 = def(T.rubble), def(T.broken), def(T.retiled)
    local hidden = robot()
    check("the robot starts hidden", hidden ~= nil and (hidden.entity or 0) == 0, hidden and ("entity " .. tostring(hidden.entity)) or "no object")
    place({ x = T.pad.x - 2, y = T.pad.y })
    shot("trigger-before")
    place(T.pad)
    wait(1.5)
    check("a trigger breaks a block to rubble", def(T.rubble) ~= r0, string.format("cell %d -> %d", r0, def(T.rubble)))
    check("a trigger breaks a block into its broken version", def(T.broken) ~= b0, string.format("cell %d -> %d", b0, def(T.broken)))
    check("a trigger changes a floor's texture", def(T.retiled) ~= t0, string.format("cell %d -> %d", t0, def(T.retiled)))
    local shown = robot()
    check("a trigger reveals a hidden robot", shown ~= nil and (shown.entity or 0) ~= 0, shown and ("entity " .. tostring(shown.entity)) or "no object")
    shot("trigger-after")
    -- Once only: stepping on again does nothing more, and nothing goes wrong.
    place({ x = T.pad.x - 1, y = T.pad.y })
    place(T.pad)
    wait(1)
    check("the game carries on after a second step", state() ~= nil, where())
    done()
end

-- Built props, seen from three places (see propsMap in scripts/game-checks.ts).
local function props()
    if not start_level() then done(); return end
    for i, spot in ipairs(layout.props.spots) do
        place(spot)
        wait(1)
        shot("props-" .. i)
    end
    check("the game carries on with built props on screen", state() ~= nil, where())
    done()
end

-- The pause menu's QUIT with Enter, as its hint says: Enter pauses, down to QUIT, Enter asks
-- "QUIT?" (NO first) instead of resuming; down to YES and Enter goes back to the menus.
local function pause_quit()
    if not start_level() then done(); return end
    wait(1)
    tap(13)
    wait(2.5)
    check("Enter pauses the game", mh.game.flow() == 12, "flow " .. tostring(mh.game.flow()))
    shot("pause-menu")
    -- CONTINUE is highlighted first: Enter resumes, and the same press does not pause again.
    hold({ 13 }, 600)
    wait(1.5)
    check("Enter on CONTINUE resumes and stays resumed", mh.game.flow() == 10, "flow " .. tostring(mh.game.flow()))
    tap(13)
    wait(2.5)
    tap(40)
    wait(0.8)
    tap(13)
    wait(1.5)
    check("Enter on QUIT asks first and stays paused", mh.game.flow() == 12, "flow " .. tostring(mh.game.flow()))
    shot("pause-quit-asks")
    tap(40)
    wait(0.8)
    tap(13)
    local left = wait_until(function() return mh.game.flow() ~= 10 and mh.game.flow() ~= 12 end, 8)
    shot("pause-after-quit")
    check("YES leaves the level", left, "flow " .. tostring(mh.game.flow()))
    done()
end

-- The Controls mod: move Forward to I and Pause to P; the old keys stop doing those things.
local function controls()
    if not start_level() then done(); return end
    wait(1)
    -- The harness wrote "pause = CTRL" into settings.cfg: Fire, declared first, keeps CTRL.
    check("Controls: a key given twice in settings.cfg stays with the first control", mh.options.get("controls", "fire") == 0x11 and mh.options.get("controls", "pause") == 0,
        string.format("fire %s pause %s", tostring(mh.options.get("controls", "fire")), tostring(mh.options.get("controls", "pause"))))
    mh.options.set("controls", "pause", 13)
    mh.options.set("controls", "forward", 0x49)
    mh.options.set("controls", "pause", 0x50)
    wait(0.5)
    local a = state()
    hold({ 38 }, 800)
    local b = state()
    check("Controls: the old Forward key no longer moves", math.abs(b.x - a.x) + math.abs(b.y - a.y) < 0.05, string.format("moved %.2f", math.abs(b.x - a.x) + math.abs(b.y - a.y)))
    hold({ 0x49 }, 800)
    wait(0.3)
    local c = state()
    check("Controls: the new Forward key moves", math.abs(c.x - b.x) + math.abs(c.y - b.y) > 0.3, string.format("moved %.2f", math.abs(c.x - b.x) + math.abs(c.y - b.y)))
    tap(13)
    wait(1.5)
    check("Controls: the old Pause key no longer pauses", mh.game.flow() == 10, "flow " .. tostring(mh.game.flow()))
    tap(0x50)
    wait(1.5)
    check("Controls: the new Pause key pauses", mh.game.flow() == 12, "flow " .. tostring(mh.game.flow()))
    tap(0x50)
    wait(1.5)
    mh.options.set("controls", "weapon_toggle", 0x49)
    check("Controls: giving a key to another control takes it away", mh.options.get("controls", "forward") == 0, "forward " .. tostring(mh.options.get("controls", "forward")))
    -- The action "Original keys" is run from the Mod Menu; here the keys go back one by one.
    mh.options.set("controls", "forward", 38)
    mh.options.set("controls", "pause", 13)
    mh.options.set("controls", "weapon_toggle", 0x57)
    done()
end

-- Custom effects: a grid of emitters, one per particle of the engine's effect table. The game must carry on.
local function effects()
    if not start_level() then done(); return end
    wait(2)
    shot("effects-start")
    local alive = wait_until(function() return state() == nil end, 12) == false
    shot("effects-after")
    check("custom effects play and the game carries on", alive and state() ~= nil, where())
    done()
end

-- A run with free-camera switched off in settings.cfg: everything else must still load.
local function disabled_checks()
    local mods = mh.runtime.mods()
    check("a switched-off mod is not loaded", mods["free-camera"] == nil)
    check("its options are not offered", mh.options.get("free-camera", "active") == nil)
    check("the other mods still load", mods["mod-menu"] ~= nil and mods["hd-rendering"] ~= nil and mods["dev-tools"] ~= nil)
    done()
end

-- One plain map per retail theme: each must load and play.
local function theme()
    if not start_level() then done(); return end
    local name = mh.game.level_name(mh.game.level()) or "?"
    local s = state()
    wait(2)
    check(name .. " theme: a custom map loads and plays", s ~= nil and state() ~= nil, where())
    done()
end

-- The picture and the window, from a normal start with the intro movies playing (Skip Intros is
-- switched off for this run): screenshots of the movies, then fullscreen and back.
local function display()
    wait(3)
    shot("display-movie-1")
    wait(3)
    shot("display-movie-2")
    wait(4)
    shot("display-later")
    if has_mod("hd-rendering") then
        mh.options.set("hd-rendering", "display", "Fullscreen")
        wait(2)
        shot("display-fullscreen")
        mh.options.set("hd-rendering", "display", "Window")
        wait(2)
        shot("display-window")
        check("HD Rendering: fullscreen and back to a window", mh.options.get("hd-rendering", "display") == "Window")
    end
    done()
end

local runner = nil
if phase == "display" then runner = coroutine.create(display) end
if phase == "main" then runner = coroutine.create(main) end
if phase == "ramps" then runner = coroutine.create(function()
    if not start_level() then done(); return end
    run("calibration", calibrate)
    run("ramps", ramps)
    if has_mod("dev-tools") then mh.options.set("dev-tools", "passive", false) end
    done()
end) end
if phase == "second" then runner = coroutine.create(second) end
if phase == "theme" then runner = coroutine.create(theme) end
if phase == "custom" then runner = coroutine.create(custom) end
if phase == "effects" then runner = coroutine.create(effects) end
if phase == "friends" then runner = coroutine.create(friends) end
if phase == "fight" then runner = coroutine.create(fight) end
if phase == "battle" then runner = coroutine.create(battle) end
if phase == "doors" then runner = coroutine.create(doors) end
if phase == "userdoor" then runner = coroutine.create(userdoor) end
if phase == "usergeometry" then runner = coroutine.create(usergeometry) end
if phase == "usercorridor" then runner = coroutine.create(usercorridor) end
if phase == "hud" then runner = coroutine.create(hud) end
if phase == "props" then runner = coroutine.create(props) end
if phase == "triggers" then runner = coroutine.create(triggers) end
if phase == "pause" then runner = coroutine.create(pause_quit) end
if phase == "controls" then runner = coroutine.create(controls) end


function on_runtime_ready()
    info("phase " .. phase)
    if phase == "disabled" then disabled_checks() end
end

function on_frame()
    if not runner or coroutine.status(runner) == "dead" then return end
    local ok, err = coroutine.resume(runner)
    if not ok then
        check("checking script", false, tostring(err))
        done()
        runner = nil
    end
end
