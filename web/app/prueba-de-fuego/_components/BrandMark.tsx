import Link from "next/link";

export default function BrandMark({ subtitle }: { subtitle: string }) {
  return (
    <div className="hb-brand">
      <Link href="/" className="hb-brand-link">
        <div className="hb-logo">
          <img src="/logo.png" alt="Visionary Trades" />
        </div>
        <div className="hb-name">Visionary Trades</div>
      </Link>
      <div className="hb-chip">{subtitle}</div>
    </div>
  );
}
