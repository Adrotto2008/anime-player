-- Bindings belong to this mpv instance only. No OS hooks or personal configuration writes.
local utils = require 'mp.utils'
local actions = {next='ap-next',previous='ap-prev',skipIntro='ap-skip-intro',skipEnding='ap-skip-ending'}
local owned = {}
local presets_ready = false
local function canonical(key)
    key = key:gsub('CTRL%+', 'Ctrl+'):gsub('ALT%+', 'Alt+'):gsub('SHIFT%+', 'Shift+'):gsub('META%+', 'Meta+')
    return key
end
mp.register_script_message('configure', function(id, json)
    local data = utils.parse_json(json) or {}
    local keys = data.keys or {}
    if not presets_ready then
        for index, preset in ipairs(data.presets or {}) do
            local command = preset.command
            -- Weak bindings preserve input.conf commands the user already assigned.
            mp.add_key_binding(preset.key, 'preset-' .. index, function() mp.command(command) end)
        end
        presets_ready = true
    end
    local conflicts = {}
    local bindings = mp.get_property_native('input-bindings', {})
    for action, key in pairs(keys or {}) do
        if key ~= '' then
            for _, binding in ipairs(bindings) do
                local own = binding.owner == mp.get_script_name() and (binding.cmd or ''):find('/ap-', 1, true)
                -- Historical episode navigation intentionally uses the two chapter keys.
                local navigation = binding.is_weak and not binding.owner and ((action=='next' and key=='PGDWN') or (action=='previous' and key=='PGUP'))
                if canonical(binding.key)==key and not own and not navigation and (binding.priority or -1)>=0 then
                    conflicts[#conflicts+1] = key .. ': ' .. (binding.cmd or 'mpv')
                end
            end
        end
    end
    if #conflicts == 0 then
        for action, _ in pairs(owned) do mp.remove_key_binding('ap-' .. action) end
        owned = {}
        for action, key in pairs(keys or {}) do
            if actions[action] and key ~= '' then
                local message = actions[action]
                mp.add_key_binding(key, 'ap-' .. action, function() mp.commandv('script-message', message) end, {repeatable=false})
                owned[action] = key
            end
        end
    end
    mp.commandv('script-message', 'ap-bindings-result', id, utils.format_json({ok=#conflicts==0,conflicts=conflicts}))
end)
