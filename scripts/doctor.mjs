import {spawnSync} from 'node:child_process';
console.log(`Sistema: ${process.platform}; Node: ${process.version}`);
for(const bin of ['sqlite3','psql','claude']) {
 const r=spawnSync(bin,['--version'],{encoding:'utf8',timeout:5000});
 console.log(`${bin}: ${r.status===0?'disponível':'não disponível no PATH'}`);
}
console.log(process.platform==='darwin'?'Ingestão macOS disponível após configurar permissões.':'Ingestão real requer macOS; testes usam fixtures.');
console.log('Este diagnóstico não lê conversas nem verifica login/pareamento.');
