import type { PropsWithChildren } from "react";
import { Navigate } from "react-router-dom";
import { usePolicyStore } from "../store/policy";
import type { OrgFeatureKey } from "../../../shared/types";

// O3 — Seite einer abgeschalteten Funktion: still zum Chat umleiten
// (Navigation zeigt sie ohnehin nicht; Deep-Links aus Meldungen/Chat
// landen sonst auf einer Seite, die die Organisation nicht will).
// v0.1.561 — mehrere Features (eines reicht) und kein Aufblitzen der
// Seite, bevor die Vorgaben aus dem Hauptprozess da sind.
export function FeatureGate({ feature, children }: PropsWithChildren<{ feature: OrgFeatureKey | OrgFeatureKey[] }>) {
  const features = usePolicyStore((s) => s.policy.features);
  const ready = usePolicyStore((s) => s.ready);
  const keys = Array.isArray(feature) ? feature : [feature];
  const erlaubt = keys.some((k) => features[k] !== false);
  if (!ready) return null;
  if (!erlaubt) return <Navigate to="/chat" replace />;
  return <>{children}</>;
}
