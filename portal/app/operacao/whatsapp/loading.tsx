export default function CarregandoWhatsapp() {
  return (
    <div className="w-full min-w-0 space-y-3" role="status" aria-label="Carregando">
      <div className="h-8 w-1/3 animate-pulse rounded-md bg-divider" />
      <div className="h-24 w-full animate-pulse rounded-card bg-divider" />
      <div className="h-24 w-full animate-pulse rounded-card bg-divider" />
    </div>
  );
}
