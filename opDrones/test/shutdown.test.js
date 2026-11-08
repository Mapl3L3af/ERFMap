const test = require('node:test');
const assert = require('node:assert/strict');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    test(`server exits and releases its port on ${signal}`, {timeout: 8000}, async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'erfmap-shutdown-'));
        const child = spawn(process.execPath, ['server.js'], {
            cwd: path.join(__dirname, '..'),
            env: {...process.env, ERFMAP_DATA: directory, PORT: '0', HOST: '127.0.0.1'},
        });
        t.after(() => { child.kill('SIGKILL'); fs.rmSync(directory, {recursive: true, force: true}); });
        const exit = once(child, 'exit');
        const port = await new Promise((resolve, reject) => {
            let output = '';
            child.stdout.on('data', chunk => {
                output += chunk;
                const match = output.match(/localhost:(\d+)/);
                if (match) resolve(Number(match[1]));
            });
            child.stderr.on('data', chunk => reject(Error(String(chunk))));
            child.on('error', reject);
        });
        // Hold a connection open while requesting shutdown.
        const socket = net.connect(port, '127.0.0.1');
        socket.on('error', () => {});
        t.after(() => socket.destroy());
        await once(socket, 'connect');
        child.kill(signal);
        const [code] = await exit;
        assert.equal(code, 0);
        const probe = net.createServer();
        await new Promise((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', resolve);
        });
        await new Promise(resolve => probe.close(resolve));
    });
}
