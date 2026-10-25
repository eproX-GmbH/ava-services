# @ava/website-walker

Kanonische Quelle des Website-Walkers (docs/PLAN_WEBSITE_WALKER.md): Linkgraph
mit Sitemap und Zweck je Link, Blockzerlegung mit Fundstelle, Signalbewertung
je Zweck. Keine Producer-Importe; den Browser-Rückfall reicht der Aufrufer
als Funktion herein.

Die Producer `website` und `company-contact` tragen eine vendorierte Kopie
unter `src/infrastructure/walker/`. Nach jeder Änderung hier:

    node scripts/vendor-sync.mjs

Der Drift-Check (`scripts/check-vendor-drift.mjs`) vergleicht die Dateien.
