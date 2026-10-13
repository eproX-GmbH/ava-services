// Z10 (2026-10-13): Wer darf einzelne Schritte neu erzwingen? Owner/Admin
// einer Organisation oder Inhaber eines persoenlichen Kontos. Solange die
// Rolle nicht bekannt ist, gilt "nein" — lieber den Knopf kurz verbergen als
// einen 403 zeigen.
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "./gateway";
import type { OrgState } from "../../../shared/types";

export function useIstAdmin(): boolean {
  const org = useQuery({ queryKey: ["org"], queryFn: () => gatewayFetch<OrgState>("/v1/tenants/me"), retry: false, staleTime: 60_000 });
  const st = org.data;
  if (!st) return false;
  return st.kind === "personal" || st.myRole === "owner" || st.myRole === "admin";
}
