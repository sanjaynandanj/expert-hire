import { Compass } from "lucide-react";

export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand">
      <span className="brand-mark"><Compass size={19} strokeWidth={2.4} aria-hidden="true" /></span>
      {!compact && <span>Northstar</span>}
    </span>
  );
}
