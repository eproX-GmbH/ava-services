import type { PropsWithChildren } from "react";
import { Navigate } from "react-router-dom";
import { useFeature } from "../store/policy";
import type { OrgFeatureKey } from "../../../shared/types";

// O3 — Seite einer abgeschalteten Funktion: still zum Chat umleiten
// (Navigation zeigt sie ohnehin nicht; Deep-Links aus Meldungen/Chat
// landen sonst auf einer Seite, die die Organisation nicht will).
export function FeatureGate({ feature, children }: PropsWithChildren<{ feature: OrgFeatureKey }>) {
  const erlaubt = useFeature(feature);
  if (!erlaubt) return <Navigate to="/chat" replace />;
  return <>{children}</>;
}
