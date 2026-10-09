import os from 'node:os';
import path from 'node:path';
export function appPaths() {
    const data = process.env.WAI_GATEWAY_DATA_DIR ?? path.join(os.homedir(), 'Library', 'Application Support', 'WA Intelligence Gateway');
    const runtime = process.env.WAI_GATEWAY_RUNTIME_DIR ?? path.join(data, 'run');
    return {
        data, runtime, auth: path.join(data, 'auth'), ledger: path.join(data, 'send-ledger.json'),
        socket: path.join(runtime, 'gateway.sock'), pid: path.join(runtime, 'gateway.pid'),
        log: path.join(data, 'gateway.log'),
        launchAgent: process.env.WAI_GATEWAY_LAUNCH_AGENT ?? path.join(os.homedir(), 'Library', 'LaunchAgents', 'local.wai.whatsapp-gateway.plist'),
        trash: path.join(os.homedir(), '.Trash')
    };
}
