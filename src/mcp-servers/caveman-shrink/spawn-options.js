// Spawn options for the upstream MCP child process.
//
// Windows: spawn('npx', ...) (and any .cmd shim such as 'gemini') hits ENOENT
// because PATHEXT resolution only happens when child_process spawns through
// a shell. POSIX systems resolve fine without a shell. Keep shell:false on
// POSIX to avoid argv quoting surprises.
//
// SECURITY: Using shell:true on Windows is dangerous as it allows command
// injection via arguments. We now use shell:false always and handle
// command resolution for Windows batch files manually.
//
// Exported standalone so the behavior is unit-testable without re-running
// the CLI entry point (index.js exits immediately when args are empty).

'use strict';

function getSpawnOptions(platform = process.platform) {
  return {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    windowsHide: true,
  };
}

module.exports = { getSpawnOptions };
