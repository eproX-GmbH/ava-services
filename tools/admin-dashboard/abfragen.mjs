// Kennzahlen des Betreiber-Dashboards.
//
// Jede Kennzahl ist eine benannte Abfrage gegen genau eine Datenbank. Neue
// Kennzahlen kommen einfach hier dazu; die Oberfläche fragt sie über ihren
// Namen ab. Regeln:
//
//   - Ausschließlich lesend. Der Server erzwingt das zusätzlich über eine
//     Nur-Lese-Transaktion, aber schon hier gilt: nichts außer SELECT.
//   - Jede Abfrage bekommt einen Zeitraum in Tagen ($1), auch wenn sie ihn
//     nicht braucht. Das hält die Aufrufe gleichförmig.
//   - Spaltennamen sind das, was in der Oberfläche steht. Deutsch, knapp.

/** Die Datenbanken, die das Dashboard liest. */
export const DATENBANKEN = {
  gateway: "ava_db_gateway",
  stammdaten: "ava_master_data",
  register: "ava_structured_content",
  website: "ava_website",
  kontakte: "ava_company_contact",
  profile: "ava_company_profile",
  publikationen: "ava_company_publication",
  bewertung: "ava_company_evaluation",
};

export const ABFRAGEN = {
  // ---- Überblick ---------------------------------------------------------
  ueberblick_verarbeitung: {
    titel: "Verarbeitungen im Zeitraum",
    db: "gateway",
    art: "kennzahlen",
    sql: `
      SELECT
        count(*) FILTER (WHERE state = 'completed')                    AS "abgeschlossen",
        count(*) FILTER (WHERE state = 'failed')                       AS "fehlgeschlagen",
        count(*) FILTER (WHERE state = 'skipped')                      AS "uebersprungen",
        count(DISTINCT "companyId")                                    AS "firmen",
        count(DISTINCT "transactionId")                                AS "vorgaenge"
      FROM "EntityProgress"
      WHERE "updatedAt" > now() - ($1 || ' days')::interval`,
  },

  ueberblick_kosten: {
    titel: "Modellnutzung im Zeitraum",
    db: "gateway",
    art: "kennzahlen",
    sql: `
      SELECT
        count(*)                                                        AS "aufrufe",
        coalesce(sum("inputTokens" + "outputTokens"), 0)                AS "token",
        round(coalesce(sum("costMicroUsd"), 0) / 1000000.0, 2)          AS "kosten_usd",
        count(*) FILTER (WHERE status >= 400)                           AS "fehler",
        coalesce(round(avg("latencyMs")), 0)                            AS "dauer_ms_schnitt"
      FROM "LlmUsage"
      WHERE "createdAt" > now() - ($1 || ' days')::interval`,
  },

  // ---- Strukturierter Registerinhalt -------------------------------------
  si_quellen: {
    titel: "Strukturierter Registerinhalt nach Quelle",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT
        CASE WHEN "runId" LIKE 'register-delta%' THEN 'Register-Delta (automatisch)'
             ELSE 'Nutzerlauf' END                                      AS "quelle",
        count(*)                                                        AS "firmen",
        max("updatedAt")                                                AS "zuletzt"
      FROM "ContentFreshness"
      WHERE stage = 'structured-content'
        AND "updatedAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 2 DESC`,
  },

  si_verlauf: {
    titel: "Neue Registerinhalte je Tag",
    db: "register",
    art: "verlauf",
    sql: `
      SELECT to_char("updatedAt"::date, 'YYYY-MM-DD')                   AS "tag",
             count(*)                                                    AS "firmen"
      FROM "StructuredContent"
      WHERE "updatedAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
  },

  si_bestand: {
    titel: "Bestand an Registerinhalten",
    db: "register",
    art: "kennzahlen",
    sql: `
      SELECT
        count(*)                                                        AS "firmen_gesamt",
        count("foundingYear")                                           AS "mit_gruendungsjahr",
        count(*) FILTER (WHERE "updatedAt" > now() - ($1 || ' days')::interval) AS "im_zeitraum",
        (SELECT count(*) FROM "ManagingDirector")                       AS "geschaeftsfuehrer"
      FROM "StructuredContent"`,
  },

  register_jobs: {
    titel: "Register-Jobs nach Art",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT art                                                        AS "art",
             count(*) FILTER (WHERE status = 'erledigt')                AS "erledigt",
             count(*) FILTER (WHERE status = 'offen')                   AS "offen",
             count(*) FILTER (WHERE status = 'fehler')                  AS "fehler",
             count(*)                                                    AS "gesamt"
      FROM "RegisterJob"
      WHERE "updatedAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 5 DESC`,
  },

  // ---- Producer ----------------------------------------------------------
  producer_stand: {
    titel: "Producer im Zeitraum",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT producer                                                   AS "producer",
             count(*) FILTER (WHERE state = 'completed')                AS "abgeschlossen",
             count(*) FILTER (WHERE state = 'failed')                   AS "fehlgeschlagen",
             count(*) FILTER (WHERE state = 'skipped')                  AS "uebersprungen",
             count(DISTINCT "companyId")                                AS "firmen",
             round(100.0 * count(*) FILTER (WHERE state = 'failed')
                   / greatest(count(*), 1), 1)                          AS "fehlerquote_prozent"
      FROM "EntityProgress"
      WHERE "updatedAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 5 DESC`,
  },

  producer_verlauf: {
    titel: "Verarbeitungen je Tag",
    db: "gateway",
    art: "verlauf",
    sql: `
      SELECT to_char("updatedAt"::date, 'YYYY-MM-DD')                   AS "tag",
             count(*)                                                    AS "verarbeitungen"
      FROM "EntityProgress"
      WHERE "updatedAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
  },

  producer_fehler: {
    titel: "Häufigste Fehler",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT producer                                                   AS "producer",
             left(coalesce("errorMessage", '(ohne Text)'), 90)          AS "fehler",
             count(*)                                                    AS "anzahl",
             max("lastFailureAt")                                        AS "zuletzt"
      FROM "EntityProgress"
      WHERE state = 'failed'
        AND "updatedAt" > now() - ($1 || ' days')::interval
      GROUP BY 1, 2
      ORDER BY 3 DESC
      LIMIT 15`,
  },

  // ---- Organisationen ----------------------------------------------------
  organisationen: {
    titel: "Organisationen",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT coalesce(nullif(t.name, ''), '(ohne Namen)')               AS "organisation",
             (SELECT count(*) FROM "TenantMember" m WHERE m."tenantId" = t.id)          AS "mitglieder",
             coalesce(u.aufrufe, 0)                                     AS "aufrufe",
             coalesce(u.token, 0)                                       AS "token",
             round(coalesce(u.kosten, 0) / 1000000.0, 2)                AS "kosten_usd"
      FROM "Tenant" t
      LEFT JOIN (
        SELECT "tenantId",
               count(*) AS aufrufe,
               sum("inputTokens" + "outputTokens") AS token,
               sum("costMicroUsd") AS kosten
        FROM "LlmUsage"
        WHERE "createdAt" > now() - ($1 || ' days')::interval
        GROUP BY 1
      ) u ON u."tenantId" = t.id
      WHERE u.aufrufe IS NOT NULL
         OR (SELECT count(*) FROM "TenantMember" m WHERE m."tenantId" = t.id) > 1
      ORDER BY 4 DESC NULLS LAST`,
  },

  modelle: {
    titel: "Modelle nach Verbrauch",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT kind                                                       AS "anbieter",
             coalesce(model, '(ohne)')                                  AS "modell",
             count(*)                                                    AS "aufrufe",
             sum("inputTokens" + "outputTokens")                        AS "token",
             round(sum("costMicroUsd") / 1000000.0, 2)                  AS "kosten_usd"
      FROM "LlmUsage"
      WHERE "createdAt" > now() - ($1 || ' days')::interval
      GROUP BY 1, 2
      ORDER BY 4 DESC NULLS LAST
      LIMIT 15`,
  },

  kanaele: {
    titel: "Verbrauch nach Kanal",
    db: "gateway",
    art: "tabelle",
    sql: `
      SELECT coalesce(channel, '(ohne)')                                AS "kanal",
             count(*)                                                    AS "aufrufe",
             sum("inputTokens" + "outputTokens")                        AS "token",
             round(sum("costMicroUsd") / 1000000.0, 2)                  AS "kosten_usd"
      FROM "LlmUsage"
      WHERE "createdAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 3 DESC NULLS LAST`,
  },

  kosten_verlauf: {
    titel: "Kosten je Tag (USD)",
    db: "gateway",
    art: "verlauf",
    sql: `
      SELECT to_char("createdAt"::date, 'YYYY-MM-DD')                   AS "tag",
             round(sum("costMicroUsd") / 1000000.0, 2)                  AS "kosten_usd"
      FROM "LlmUsage"
      WHERE "createdAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
  },

  // ---- Firmenbestand und Abdeckung ---------------------------------------
  bestand_laender: {
    titel: "Firmenbestand nach Land",
    db: "stammdaten",
    art: "tabelle",
    sql: `
      SELECT country                                                    AS "land",
             count(*)                                                    AS "firmen",
             count(*) FILTER (WHERE "registerStatus" = 'ACTIVE')        AS "aktiv",
             count(*) FILTER (WHERE "insolvencyStatus" <> 'NONE')       AS "mit_insolvenz",
             count(*) FILTER (WHERE "changedAt" > now() - ($1 || ' days')::interval) AS "geaendert_im_zeitraum"
      FROM "GermanCompany"
      GROUP BY 1
      ORDER BY 2 DESC`,
  },

  bestand_zuwachs: {
    titel: "Neue Firmen je Tag",
    db: "stammdaten",
    art: "verlauf",
    sql: `
      SELECT to_char("firstSeenAt"::date, 'YYYY-MM-DD')                 AS "tag",
             count(*)                                                    AS "firmen"
      FROM "GermanCompany"
      WHERE "firstSeenAt" > now() - ($1 || ' days')::interval
      GROUP BY 1
      ORDER BY 1`,
  },
};

/** Abdeckung: wie viele Firmen je Producer Daten haben. Eigener Weg, weil die
 *  Zahlen aus verschiedenen Datenbanken kommen und einzeln geholt werden. */
export const ABDECKUNG = [
  { name: "Registerinhalt", db: "register", sql: `SELECT count(*)::int AS n FROM "StructuredContent"` },
  { name: "Website", db: "website", sql: `SELECT count(*)::int AS n FROM "Website"` },
  { name: "Firmenprofil", db: "profile", sql: `SELECT count(*)::int AS n FROM "CompanyProfile"` },
  { name: "Publikationen", db: "publikationen", sql: `SELECT count(DISTINCT "companyId")::int AS n FROM "CompanyPublication"` },
  { name: "Bewertung", db: "bewertung", sql: `SELECT count(*)::int AS n FROM "EvaluationData"` },
  { name: "Kontakte", db: "kontakte", sql: `SELECT count(*)::int AS n FROM "Company"` },
];
