/** Tipos das linhas do schema wa lidas pelo portal (contrato do banco v1). */

export type ChatResumo = {
  id: string;
  jid: string;
  tipo: "grupo" | "comunidade" | "direto";
  nome: string;
  categoria: string | null;
  modo: "off" | "registrar" | "inteligencia" | "dm_sugerir";
  ultima_msg_em: string | null;
  liberado_em: string | null;
  retencao_dias: number | null;
  n_mensagens: number;
  n_mensagens_24h: number;
  n_links: number;
  n_perguntas_abertas: number;
  n_aprendizados: number;
  resumo_id: number | null;
  resumo_data_ref: string | null;
  resumo_discutido: unknown;
  resumo_decidido: unknown;
  resumo_olhar: unknown;
  resumo_n_mensagens: number | null;
  resumo_gerado_em: string | null;
};

export type IngestaoExecucao = {
  id: number;
  iniciou_em: string | null;
  terminou_em: string | null;
  lidas: number | null;
  gravadas: number | null;
  descartadas_sensivel: number | null;
  erro: string | null;
};

export type Mensagem = {
  id: number;
  chat_id: string;
  enviada_em: string;
  autor_id: string | null;
  autor_nome: string | null;
  do_dono: boolean;
  tipo: number;
  texto: string | null;
  redigida: boolean;
  apagada: boolean;
  tem_midia: boolean;
  midia_meta: unknown;
  transcrito: boolean;
  responde_a: number | null;
};

export type LinkCompartilhado = {
  id: number;
  chat_id: string;
  chat_nome: string;
  mensagem_id: number;
  url: string;
  url_norm: string;
  dominio: string;
  titulo: string | null;
  compartilhado_em: string;
  vezes: number;
  tags: string[] | null;
  autor_id: string | null;
  autor_nome: string | null;
  favorito: boolean;
  favoritado_em: string | null;
};

export type Aprendizado = {
  id: number;
  chat_id: string | null;
  chat_nome: string | null;
  titulo: string;
  corpo: string;
  tags: string[] | null;
  fontes: number[];
  confianca: number | null;
  status: "candidato" | "aprovado" | "descartado";
  criado_em: string;
  atualizado_em: string;
  tema: string | null;
  motivo_descarte: "suporte" | "fora_do_tema" | null;
};

/** Item da lista editável wa.config[aprendizado_temas]. */
export type TemaAprendizado = { nome: string; descricao: string };

export type Resumo = {
  id: number;
  chat_id: string;
  periodo: "dia" | "semana";
  data_ref: string;
  discutido: unknown;
  decidido: unknown;
  olhar: unknown;
  n_mensagens: number;
  gerado_em: string;
};

export type Decisao = {
  id: number;
  chat_id: string;
  resumo_id: number | null;
  texto: string;
  decidida_em: string | null;
  responsavel: string | null;
};

export type Pergunta = {
  id: number;
  chat_id: string;
  texto_norm: string;
  topico: string | null;
  status: "aberta" | "respondida" | "ignorada";
  dirigida_ao_dono: boolean;
  detectada_em: string;
};

export type AuditoriaEnvioResumo = {
  id: number;
  quando: string;
  ator: string;
  acao: string;
  alvo: string | null;
  detalhe: unknown;
};

export type DestinoNotificacao = {
  jid: string | null;
  nome: string | null;
  ativo: boolean;
  atualizado_em: string;
};

export type UrgenciaPendencia = "alta" | "media" | "baixa";
export type StatusPendencia = "aberta" | "respondida" | "descartada";

/** Linha de wa.v_pendencias: DM aguardando resposta. Nunca traz texto redigido para envio. */
export type Pendencia = {
  id: number;
  chat_id: string;
  contato_nome: string | null;
  chat_nome: string;
  espera_desde: string;
  pedido: string | null;
  urgencia: UrgenciaPendencia;
  tipo_resposta: string | null;
  audio_sem_transcricao: boolean;
  status: StatusPendencia;
  gerado_em: string;
  /** true = contato salvo na agenda do dono; só esses recebem resposta pelo portal. */
  contato?: boolean | null;
  /** Envio mais recente da pendência (wa.fila_envio). Nunca traz o texto. */
  fila_id?: number | null;
  fila_status?: StatusFilaEnvio | null;
  fila_erro?: string | null;
  fila_expira_em?: string | null;
};

export type StatusFilaEnvio =
  | "aprovado" | "enviando" | "enviado" | "falhou" | "cancelado" | "expirado"
  | "pendente" | "copiado" | "aberto_no_whatsapp" | "confirmado_pelo_dono";

/** Resultado de leitura: nunca lança, a tela decide o estado de erro. */
export type Resultado<T> = { ok: true; dados: T } | { ok: false; erro: string };
