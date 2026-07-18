// Spawn options for the upstream MCP child process.
//
// Windows: spawn('npx', ...) (and any .cmd shim such as 'gemini') hits ENOENT
// if shell:false is used and the command is not an absolute path or doesn't
// have the correct extension.
//
// However, shell:true on Windows is vulnerable to OS Command Injection
// if arguments are not properly sanitized. To stay secure, we use shell:false
// and recommend Windows users to use the full command name (e.g., 'npx.cmd').

'use strict';

function getSpawnOptions(platform = process.platform) {
  return {
    stdio: ['pipe', 'pipe', 'inherit'],
    shell: false,
    windowsHide: true,
  };
}

module.exports = { getSpawnOptions };
