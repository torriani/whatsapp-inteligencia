// Schema guard: aborta se o ChatStorage.sqlite mudar o que o worker espera.
export const ESPERADO = {
  ZWAMESSAGE: [
    "Z_PK", "ZCHATSESSION", "ZGROUPMEMBER", "ZISFROMME", "ZMESSAGEDATE", "ZSTANZAID",
    "ZTEXT", "ZMESSAGETYPE", "ZGROUPEVENTTYPE", "ZMEDIAITEM", "ZPARENTMESSAGE", "ZPUSHNAME", "ZFROMJID",
  ],
  ZWACHATSESSION: ["Z_PK", "ZCONTACTJID", "ZPARTNERNAME", "ZSESSIONTYPE", "ZREMOVED", "ZLASTMESSAGEDATE", "ZMESSAGECOUNTER"],
  ZWAGROUPMEMBER: ["Z_PK", "ZCHATSESSION", "ZMEMBERJID", "ZCONTACTNAME"],
  ZWAMEDIAITEM: ["Z_PK", "ZMESSAGE", "ZTITLE"],
};

export class SchemaGuardError extends Error {
  constructor(faltando) {
    super(`Schema do ChatStorage mudou. Faltando: ${faltando.join(", ")}. Ingestao abortada.`);
    this.name = "SchemaGuardError";
    this.faltando = faltando;
  }
}

// atual: { TABELA: ["COL", ...] }. Lanca SchemaGuardError se algo esperado nao existir.
export function avaliarSchema(atual, esperado = ESPERADO) {
  const faltando = [];
  for (const [tabela, colunas] of Object.entries(esperado)) {
    const cols = new Set(atual[tabela] || []);
    if (!cols.size) { faltando.push(`${tabela} (tabela)`); continue; }
    for (const c of colunas) if (!cols.has(c)) faltando.push(`${tabela}.${c}`);
  }
  if (faltando.length) throw new SchemaGuardError(faltando);
  return true;
}
