import { createClient } from "@/lib/supabase/server";
import { BarrasHorizontais, BarrasPorDia } from "@/components/operacao/whatsapp/Graficos";
import { EstadoErro, Painel, TituloPagina } from "@/components/operacao/whatsapp/Blocos";
import { carregarDashboard, DIAS_JANELA } from "@/lib/whatsapp/dashboard";
import { exigirAdminDaRequisicao } from "@/lib/whatsapp/guarda";

export const dynamic = "force-dynamic";

function Numero({ rotulo, valor, apoio }: { rotulo: string; valor: number; apoio?: string }) {
  return (
    <div className="min-w-0">
      <p className="font-sans text-xs uppercase tracking-wider text-ink-muted">{rotulo}</p>
      <p className="font-serif text-3xl text-ink">{valor}</p>
      {apoio && <p className="font-sans text-xs text-ink-muted">{apoio}</p>}
    </div>
  );
}

export default async function DashboardWhatsappPage() {
  await exigirAdminDaRequisicao();
  const supabase = await createClient();
  const r = await carregarDashboard(supabase);

  if (!r.ok) {
    return (
      <div className="space-y-6">
        <TituloPagina titulo="Dashboard do WhatsApp" />
        <EstadoErro mensagem={r.erro} />
      </div>
    );
  }

  const d = r.dados;
  const totalMensagens = d.mensagensGrupos.reduce((s, p) => s + p.total, 0);
  const totalLinks = d.linksGrupos.reduce((s, p) => s + p.total, 0);

  return (
    <div className="space-y-6">
      <TituloPagina
        titulo="Dashboard do WhatsApp"
        descricao={`Últimos ${DIAS_JANELA} dias. Somente leitura. Mensagens diretas aparecem só como contagem.`}
      />

      {d.truncado && (
        <p role="status" className="font-sans text-sm text-ink-muted">
          O volume passou do limite de leitura. Os números mais antigos da janela podem estar incompletos.
        </p>
      )}

      <div className="grid w-full min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        <Painel titulo="Mensagens por dia" descricao="Grupos e comunidades liberados.">
          <BarrasPorDia serie={d.mensagensGrupos} rotulo="Mensagens em grupos por dia" />
          <p className="mt-2 font-sans text-xs text-ink-muted">
            {totalMensagens} em grupos. Mensagens diretas: {d.diretos.mensagens} em {d.diretos.conversas} conversas.
          </p>
        </Painel>

        <Painel titulo="Links por dia" descricao="Compartilhados nos grupos.">
          <BarrasPorDia serie={d.linksGrupos} rotulo="Links em grupos por dia" />
          <p className="mt-2 font-sans text-xs text-ink-muted">{totalLinks} links no período.</p>
        </Painel>

        <Painel titulo="Grupos mais ativos" descricao="Por número de mensagens no período.">
          <BarrasHorizontais
            itens={d.chatsAtivos.map((c) => ({ rotulo: c.nome, valor: c.mensagens }))}
            vazio="Nenhuma mensagem de grupo no período."
          />
        </Painel>

        <Painel titulo="Pendências abertas" descricao="Mensagens diretas aguardando resposta, apenas em número.">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Numero rotulo="Total" valor={d.pendencias.total} />
            <Numero rotulo="Alta" valor={d.pendencias.porUrgencia.alta} />
            <Numero rotulo="Média" valor={d.pendencias.porUrgencia.media} />
            <Numero rotulo="Baixa" valor={d.pendencias.porUrgencia.baixa} />
          </div>
          <h3 className="mt-5 font-sans text-xs font-semibold uppercase tracking-wider text-ink-muted">Por idade</h3>
          <div className="mt-2">
            <BarrasHorizontais
              itens={[
                { rotulo: "Hoje", valor: d.pendencias.porIdade.hoje },
                { rotulo: "1 a 3 dias", valor: d.pendencias.porIdade["um-a-tres"], tom: "alerta" },
                { rotulo: "Mais de 3 dias", valor: d.pendencias.porIdade["mais-de-tres"], tom: "perigo" },
              ]}
              vazio=""
            />
          </div>
        </Painel>

        <Painel titulo="Resumos enviados" descricao={`Gerados nos últimos ${DIAS_JANELA} dias.`} className="xl:col-span-2">
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Numero rotulo="Grupos enviados" valor={d.envios.gruposEnviados} />
            <Numero rotulo="Grupos não enviados" valor={d.envios.gruposNaoEnviados} />
            <Numero rotulo="Resumos de DMs enviados" valor={d.envios.digestsEnviados} />
            <Numero rotulo="Resumos de DMs não enviados" valor={d.envios.digestsNaoEnviados} />
          </div>
        </Painel>
      </div>
    </div>
  );
}
