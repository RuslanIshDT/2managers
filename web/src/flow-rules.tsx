export interface FlowRuleRow {
  who: string;
  subject: string;
  amount: string;
  cause: string;
  change: string;
  area: string;
  limit: string;
  basis: string;
}

export interface FlowRuleView {
  summary: string;
  lettersAway: number;
  meetingsAway: number;
  chains: FlowRuleRow[];
  series: FlowRuleRow[];
  rights: FlowRuleRow[];
}

export function FlowRules({ view, acceptedOn }: { view: FlowRuleView | undefined; acceptedOn: string }) {
  if (!view) return null;
  if (!view.summary && !view.chains.length && !view.series.length && !view.rights.length && !acceptedOn) return null;
  return (
    <div id="flow-rules" className="mt-3 grid gap-4 text-sm">
      {view.summary ? <p className="font-semibold">{view.summary}</p> : null}
      {acceptedOn ? <p>{acceptedOn}</p> : null}
      {view.chains.length ? (
        <section>
          <h3 className="font-semibold">Цепочки писем</h3>
          <ul className="mt-2 grid gap-3">
            {view.chains.map((row, index) => (
              <li key={`${row.subject}:${index}`}>
                <p className="font-medium">
                  {row.who}
                  {row.who && row.subject ? ' — ' : ''}
                  {row.subject}
                </p>
                <p>{row.amount}</p>
                {row.cause ? <p>Причина: {row.cause}</p> : null}
                {row.change ? <p>{row.change}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {view.series.length ? (
        <section>
          <h3 className="font-semibold">Серии встреч</h3>
          <ul className="mt-2 grid gap-3">
            {view.series.map((row, index) => (
              <li key={`${row.subject}:${index}`}>
                <p className="font-medium">{row.subject}</p>
                <p>{row.amount}</p>
                {row.cause ? <p>Причина: {row.cause}</p> : null}
                {row.change ? <p>{row.change}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {view.rights.length ? (
        <section>
          <h3 className="font-semibold">Права подчинённым</h3>
          <ul className="mt-2 grid gap-3">
            {view.rights.map((row, index) => (
              <li key={`${row.who}:${row.area}:${index}`}>
                <p className="font-medium">
                  {row.who}
                  {row.area ? ` — ${row.area}` : ''}
                  {row.limit ? ` ${row.limit}` : ''}
                </p>
                {row.basis ? <p>Основание: {row.basis}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
