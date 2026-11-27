// Generative UI: Baustein „Firmenprofil“ — der Firmenueberblick im Chat im Stil der
// Firmenansicht (Kopf, Kennzahlen, Kontakt mit Website und Netzwerk-Profilen,
// Standort auf der Karte, wichtigste Ansprechpartner mit LinkedIn).
//
// Befund PM-2026-0059 (Joyce, 2026-11-27): Der Ueberblick war eine nackte Tabelle.
// Wie die Firmenkarte laedt der Baustein alles selbst aus der companyId; das Modell
// liefert nur die companyId, optional die personIds der passenden Ansprechpartner und
// als Kinder seine Einordnung. So steht nichts Erfundenes in den Stammdaten, und die
// Abfragen teilen sich den Zwischenspeicher mit der Firmenansicht (gleiche Schluessel).

import { Children, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { gatewayFetch } from "../../../api/gateway";
import { useFirmenZustand } from "../../../api/firmen-zustand";
import { useFeature } from "../../../store/policy";
import { ermittleAdresse } from "../../../routes/CompanyDetail";
import { InsolvenzBadge, LandBadge, RegisterStatusBadge, registerZeile } from "../../RegisterStatusBadge";
import { ExternalLink } from "../../ExternalLink";
import { FirmenLogo, LogoZeile } from "../../FirmenLogo";
import { GlobeIcon, HomeIcon, LinkedInIcon, MailIcon, PhoneIcon, XingIcon } from "../../icons";
import { fmtShareCapital, mailHref, mapsEmbedUrl, mapsHref, telHref } from "../../../lib/format";
import { kartenSuche } from "../../../../../shared/adresse";
import { landAusCompanyId } from "../../../../../shared/register-land";
import { firmenFakt, firmenLinks, firmenMail, personenAusFakten, personenAuswahl, websiteAnzeige } from "./firmenprofil-daten";

/** Logo im Kopf: so hoch wie Name und Registerzeile zusammen. */
const PROFIL_LOGO = 36;

type Quellen = Parameters<typeof ermittleAdresse>[0];
type Structured = NonNullable<Quellen["structured"]>;
type WebsiteDaten = NonNullable<Quellen["website"]>;
type Kontakte = NonNullable<Quellen["contact"]>;

interface Stamm {
  name?: string;
  location?: string | null;
  country?: string | null;
  registerType?: string | null;
  registerNumber?: string | null;
  districtCourt?: string | null;
  legalForm?: string | null;
  registerStatus?: string | null;
  closedAt?: string | null;
  insolvencyStatus?: string | null;
  insolvencyAt?: string | null;
}

interface Abschluss {
  year?: number | null;
  employeeCount?: number | null;
  art?: "einzel" | "konzern" | null;
}

/** Gleiche Schluessel und Pfade wie die Firmenansicht (useTabQuery), damit beide denselben Stand teilen. */
function useTeil<T>(key: string, id: string, pfad: string, an: boolean) {
  return useQuery<T>({ queryKey: ["company", id, key], queryFn: () => gatewayFetch<T>(pfad), enabled: an, retry: false, staleTime: 60_000 });
}

const zahl = new Intl.NumberFormat("de-DE");

function Zeile({ symbol, children }: { symbol: ReactNode; children: ReactNode }) {
  return (
    <li className="gu-profil__zeile">
      <span className="gu-profil__symbol">{symbol}</span>
      <span className="gu-profil__wert">{children}</span>
    </li>
  );
}

export function Firmenprofil({ companyId, personen, children }: { companyId: string; personen?: Array<string | null> | null; children?: ReactNode }) {
  const navigate = useNavigate();
  const id = (companyId ?? "").trim();
  const kontakteErlaubt = useFeature("kontakte");
  // Ruhende Firma (Plan mit aktiven/ruhenden Firmen): nur die Grunddaten, wie in der Firmenansicht.
  const zustand = useFirmenZustand(id || undefined, false);
  const ruhend = zustand.data?.aktivModell === true && zustand.data.zustaende[0]?.zustand === "ruhend";
  const daten = Boolean(id) && (zustand.isError || (zustand.isSuccess && !ruhend));

  const stamm = useQuery<Stamm>({ queryKey: ["company", id], queryFn: () => gatewayFetch<Stamm>(`/v1/companies/${id}`), enabled: Boolean(id), retry: false, staleTime: 60_000 });
  const structured = useTeil<Structured>("structured", id, `/v1/companies/${id}/structured-content`, daten);
  const website = useTeil<WebsiteDaten>("website", id, `/v1/companies/${id}/website`, daten);
  const profil = useTeil<{ keywords?: string[] }>("profile", id, `/v1/companies/${id}/profile?ersatz=radar`, daten);
  const kontakte = useTeil<Kontakte>("contacts", id, `/v1/companies/${id}/contacts`, daten && kontakteErlaubt);
  const abschluesse = useTeil<{ items: Abschluss[] }>("publications", id, `/v1/companies/${id}/publications`, daten);

  const oeffnen = () => navigate(`/companies/${encodeURIComponent(id)}`);
  const s = stamm.data;
  const name = structured.data?.name ?? s?.name ?? (stamm.isLoading ? "Wird geladen…" : id);

  // Nur ohne Daten: Scheitert ein spaeteres Nachladen, bleibt der letzte Stand stehen.
  if (stamm.isError && !stamm.data) {
    return (
      <section className="gu-karte gu-profil">
        <div className="gu-gedaempft">Firma nicht gefunden.</div>
        {Children.count(children) > 0 && <div className="gu-profil__einordnung">{children}</div>}
      </section>
    );
  }

  const land = landAusCompanyId(id);
  const adresse = ermittleAdresse({ land, structured: structured.data, contact: kontakte.data, website: website.data, summary: s });
  const suche = adresse ? kartenSuche(adresse.zeilen, adresse.land) : null;
  const kartenLink = suche ? mapsHref([suche]) : null;
  // Anschrift und Karte nur fuer eine echte Adresse; ein blosser Ortsname aus den
  // Stammdaten steht schon in der Kennzahl „Standort“ und zeigte nur die ganze Stadt.
  const anschrift = adresse && adresse.quelle !== "Stammdaten" ? adresse : null;
  const karte = suche && anschrift ? mapsEmbedUrl([suche]) : null;

  const fakten = kontakteErlaubt ? kontakte.data?.companyFacts : undefined;
  const telefon = website.data?.companySerp?.phone?.trim() || firmenFakt(fakten, "phone");
  const mail = firmenMail(fakten);
  const webUrl = website.data?.website?.url ?? website.data?.companySerp?.url ?? null;
  const netze = firmenLinks(website.data?.website?.socialLinks, fakten);
  const allePersonen = personenAusFakten(fakten, id);
  const gezeigt = personenAuswahl(allePersonen, personen, 4);

  const letzter = [...(abschluesse.data?.items ?? [])].sort((a, b) => (a.year ?? 0) - (b.year ?? 0)).pop();
  const kapital = fmtShareCapital(structured.data?.shareCapital);
  const kennzahlen: Array<{ label: string; wert: string; fuss?: string }> = [];
  const ortszeile = adresse ? (adresse.zeilen[adresse.zeilen.length - 1] ?? "") : "";
  if (ortszeile) kennzahlen.push({ label: "Standort", wert: ortszeile });
  if (structured.data?.foundingYear) kennzahlen.push({ label: "Gegründet", wert: String(structured.data.foundingYear) });
  if (letzter?.employeeCount != null) {
    kennzahlen.push({
      label: "Mitarbeiter",
      wert: zahl.format(letzter.employeeCount),
      ...(letzter.art === "konzern" ? { fuss: `laut Konzernabschluss${letzter.year ? ` ${letzter.year}` : ""}` } : letzter.year ? { fuss: `Stand ${letzter.year}` } : {}),
    });
  }
  if (kapital) kennzahlen.push({ label: "Stammkapital", wert: kapital });

  const stichworte = (profil.data?.keywords ?? []).filter(Boolean).slice(0, 6);
  const register = s ? registerZeile(s) : null;
  const hatKontakt = Boolean(anschrift || telefon || mail || webUrl || netze.length > 0);

  return (
    <section className="gu-karte gu-profil">
      <header className="gu-profil__kopf">
        <LogoZeile
          hoehe={PROFIL_LOGO}
          className="gu-profil__titel"
          logo={<FirmenLogo logos={website.data?.logos} laedt={website.isPending} name={name} groesse={PROFIL_LOGO} breit />}
        >
          <div className={register ? "gu-profil__namenszeile logo-zeile__oben" : "gu-profil__namenszeile logo-zeile__oben logo-zeile__unten"}>
            <button type="button" className="gu-link gu-profil__name" onClick={oeffnen}>
              {name}
            </button>
            <LandBadge country={s?.country} />
            <RegisterStatusBadge status={s?.registerStatus} closedAt={s?.closedAt} />
            <InsolvenzBadge status={s?.insolvencyStatus} seit={s?.insolvencyAt} />
          </div>
          {register && <div className="gu-gedaempft logo-zeile__unten">{register}</div>}
        </LogoZeile>
        <button type="button" className="btn gu-profil__oeffnen" onClick={oeffnen}>
          Firma öffnen
        </button>
      </header>

      {stichworte.length > 0 && (
        <ul className="gu-profil__stichworte">
          {stichworte.map((k) => (
            <li key={k} className="gu-marke gu-marke--neutral">
              {k}
            </li>
          ))}
        </ul>
      )}

      {ruhend && <div className="gu-hinweis gu-hinweis--info">Diese Firma ruht bei dir. AVA zeigt nur die Grunddaten aus dem Register.</div>}

      {kennzahlen.length > 0 && (
        <div className="gu-kennzahlen gu-profil__zahlen">
          {kennzahlen.map((k) => (
            <div key={k.label} className="gu-kennzahl">
              <div className="gu-kennzahl__label">{k.label}</div>
              <div className="gu-kennzahl__wert">{k.wert}</div>
              {k.fuss && <div className="gu-gedaempft">{k.fuss}</div>}
            </div>
          ))}
        </div>
      )}

      {hatKontakt && (
        <div className={karte ? "gu-profil__rumpf gu-profil__rumpf--karte" : "gu-profil__rumpf"}>
          <div className="gu-profil__kontakt">
            <h4 className="gu-abschnitt__titel">Kontakt und Standort</h4>
            <ul className="gu-profil__liste">
              {anschrift && (
                <Zeile symbol={<HomeIcon size={15} />}>
                  {kartenLink ? (
                    <a href={kartenLink} target="_blank" rel="noreferrer" title="In Google Maps öffnen">
                      {anschrift.zeilen.map((z, i) => (
                        <span key={i} className="gu-profil__adresszeile">
                          {z}
                        </span>
                      ))}
                    </a>
                  ) : (
                    anschrift.zeilen.join(", ")
                  )}
                </Zeile>
              )}
              {telefon && (
                <Zeile symbol={<PhoneIcon size={15} />}>
                  <a href={telHref(telefon)}>{telefon}</a>
                </Zeile>
              )}
              {mail && (
                <Zeile symbol={<MailIcon size={15} />}>
                  <a href={mailHref(mail)}>{mail}</a>
                </Zeile>
              )}
              {webUrl && (
                <Zeile symbol={<GlobeIcon size={15} />}>
                  <a href={webUrl} target="_blank" rel="noreferrer">
                    {websiteAnzeige(webUrl)}
                  </a>
                </Zeile>
              )}
            </ul>
            {netze.length > 0 && (
              <div className="gu-profil__netze">
                {netze.map((n) => (
                  <ExternalLink key={n.art} href={n.url} className="gu-profil__netz" title={`${n.label}-Seite der Firma öffnen`}>
                    {n.art === "linkedin" ? <LinkedInIcon size={14} /> : n.art === "xing" ? <XingIcon size={14} /> : <GlobeIcon size={14} />}
                    {n.label}
                  </ExternalLink>
                ))}
              </div>
            )}
          </div>
          {karte && <iframe className="gu-profil__karte" title={`Standort von ${name} auf Google Maps`} src={karte} loading="lazy" referrerPolicy="no-referrer-when-downgrade" />}
        </div>
      )}

      {gezeigt.length > 0 && (
        <div className="gu-profil__abschnitt">
          <div className="gu-profil__abschnittkopf">
            <h4 className="gu-abschnitt__titel">Ansprechpartner</h4>
            {allePersonen.length > gezeigt.length && (
              <button type="button" className="gu-link gu-profil__mehr" onClick={oeffnen}>
                Alle {zahl.format(allePersonen.length)} in der Firmenansicht
              </button>
            )}
          </div>
          <ul className="gu-profil__personen">
            {gezeigt.map((p) => (
              <li key={p.personId} className="gu-profil__person">
                <button type="button" className="gu-link gu-profil__personname" onClick={() => navigate(`/personen/${encodeURIComponent(p.personId)}`)}>
                  {p.name}
                </button>
                {p.titel && <div className="gu-gedaempft gu-profil__persontitel">{p.titel}</div>}
                {(p.linkedin || p.xing) && (
                  <div className="gu-profil__netze">
                    {p.linkedin && (
                      <ExternalLink href={p.linkedin} className="gu-profil__netz" title={`LinkedIn-Profil von ${p.name} öffnen`}>
                        <LinkedInIcon size={14} />
                        LinkedIn
                      </ExternalLink>
                    )}
                    {p.xing && (
                      <ExternalLink href={p.xing} className="gu-profil__netz" title={`XING-Profil von ${p.name} öffnen`}>
                        <XingIcon size={14} />
                        XING
                      </ExternalLink>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {Children.count(children) > 0 && <div className="gu-profil__einordnung">{children}</div>}
    </section>
  );
}
