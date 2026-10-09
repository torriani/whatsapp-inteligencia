import os from "node:os";
import path from "node:path";
// gateway_entry invokes the bundled ESM CLI with Node, no global installation needed.
export function gatewayCommand(config) {
  const expand = value => value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
  const entry = config.notificacao.gateway_entry;
  if (entry) return { bin: process.execPath, prefix: [expand(entry)] };
  return { bin: expand(config.notificacao.gateway_bin), prefix: [] };
}
