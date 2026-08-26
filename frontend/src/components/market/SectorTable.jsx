import { Link } from "react-router-dom";
import { TerminalPanel } from "../common/Panels.jsx";

function cell(value) {
  if (value == null) return <span className="mono muted">—</span>;
  const cls = value > 0 ? "pos" : value < 0 ? "neg" : "";
  return (
    <span className={`mono ${cls}`}>
      {value > 0 ? "+" : ""}
      {value.toFixed(2)}
    </span>
  );
}

/** Sector performance matrix (1D / 5D / 1M) from US sector ETFs. */
export default function SectorTable({ data, error }) {
  return (
    <TerminalPanel
      title="SECTOR PERFORMANCE"
      subtitle="US sector ETFs · SPDR select industry proxies"
      flush
    >
      {error ? (
        <p className="fineprint" style={{ padding: "10px 14px" }}>{error}</p>
      ) : !data ? (
        <p className="fineprint" style={{ padding: "10px 14px" }}>LOADING…</p>
      ) : (
        <div className="table-scroll">
          <table className="dna-table sector-table">
            <thead>
              <tr>
                <th>SECTOR</th>
                <th className="num">1D</th>
                <th className="num">5D</th>
                <th className="num">1M</th>
              </tr>
            </thead>
            <tbody>
              {data.sectors.map((s) => (
                <tr key={s.symbol}>
                  <td>
                    <Link className="symbol-link mono" to={`/market/${encodeURIComponent(s.symbol)}`} title={`${s.label} — open overview`}>
                      {s.label}
                    </Link>
                  </td>
                  <td className="num">{cell(s.ret_1d)}</td>
                  <td className="num">{cell(s.ret_5d)}</td>
                  <td className="num">{cell(s.ret_1m)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </TerminalPanel>
  );
}
