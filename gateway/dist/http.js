import http from 'node:http';
export async function requestSocket(socketPath, method, route, body) {
    return new Promise((resolve, reject) => {
        const req = http.request({ socketPath, path: route, method, headers: { 'content-type': 'application/json' } }, res => {
            let raw = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { raw += chunk; });
            res.on('end', () => {
                let data = {};
                try {
                    data = raw ? JSON.parse(raw) : {};
                }
                catch {
                    reject(new Error('Resposta inválida do daemon.'));
                    return;
                }
                if ((res.statusCode ?? 500) >= 400)
                    reject(new Error(data.error ?? `Daemon retornou ${res.statusCode}.`));
                else
                    resolve(data);
            });
        });
        req.on('error', error => reject(new Error(`Daemon indisponível: ${error.message}. Execute start.`)));
        if (body !== undefined)
            req.write(JSON.stringify(body));
        req.end();
    });
}
