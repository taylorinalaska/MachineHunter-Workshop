# Building from source

The Windows release is ready to run; these instructions are for developers.

## Requirements

Windows 10/11 x64, Node.js 22+, npm, Visual Studio 2022 / Build Tools with Desktop development with C++ (x86 tools and Windows SDK). Python 3 is needed to create release ZIPs. Retail files are needed to play and run the optional corpus tests.

```powershell
npm ci
npm run typecheck
npm test
npm run test:setup
npm run build
New-Item -ItemType Directory -Force game
npm run runtime:build
```

The runtime build installs its DLL and bundled mods under game/. Lua scripts also need the verified Lua 5.4.8 x86 lua54.dll; the release builder fetches it into build/release-deps/. Copy it into game/, or use that DLL from the official Workshop release.

Run Setup.bat to import your own retail files, then Workshop.bat or npm run dev for hot reload. Play.bat starts the game alone. Shared data tables are included; private research files are not build dependencies. Corpus tests skip when retail files are absent.

## Release

```powershell
npm run release
# Or choose a fresh output folder:
node scripts/build-release.mjs release/v0.1-rebuild
```

The builder compiles the UI, runtime and mods, validates pinned Node/Lua dependencies, and produces Windows/source ZIPs and SHA-256 checksums. Existing output folders are refused. The Windows ZIP includes corresponding source.

Packaging uses explicit allowlists. User maps, settings, logs, personal files, research, build intermediates, node_modules and Git history are excluded. Only built Workshop DLLs and verified Node/Lua runtimes are bundled. Each user supplies retail files after extraction.

Publish the Windows ZIP, source ZIP and SHA256SUMS.txt together. For a new GitHub repository, use the clean source export. An older working repository's Git history may still contain excluded historical material.

## Tests

npm test covers formats, the compiler, editor operations and packaging. npm run typecheck checks TypeScript. With retail files installed, npm run game:test runs the native game harness and takes game-window focus. scripts/test-door-state.ps1 checks door state without launching the game.

Private-map diagnostics accept -Only userdoor, usercorridor or usergeometry with -DoorProject <path>. They use temporary packages and do not modify the original project. Test maps are not included in the Windows release.
