-- Skip Intros: start at the main menu.
--
-- The whole mod is this one call. A script's top level runs while the game is
-- starting, before the first movie, which is the moment to ask for the skip.
-- The two options are declared in mod.json.
mh.game.skip_startup(mh.options.get("movies"), mh.options.get("title"))
