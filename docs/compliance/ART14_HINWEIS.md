# Hinweistext nach Art. 14 DSGVO — Vorlage

AVA erzeugt den Text je Person automatisch (`GET /v1/persons/{id}/hinweis`,
Chat-Tool `person_hinweis`, Button „Art.-14-Hinweis" an der Kontaktkarte).
Vorlage mit Platzhaltern:

```
Information nach Art. 14 DSGVO

Sehr geehrte/r [Name],

[Organisation] hat berufliche Kontaktdaten zu Ihrer Person aus oeffentlich
zugaenglichen Quellen ([Quellen]) erhoben, im Zusammenhang mit [Unternehmen].
Gespeichert sind: [Datenkategorien].

Zweck: Recherche und Kontaktaufnahme im geschaeftlichen Kontext
(Art. 6 Abs. 1 lit. f DSGVO, berechtigtes Interesse an B2B-Vertriebskommunikation).
Speicherdauer: Die Daten werden geloescht, wenn sie [N] Tage lang auf keiner
Quelle mehr bestaetigt wurden, spaetestens jedoch auf Ihren Widerspruch hin.
Ihre Rechte: Auskunft, Berichtigung, Loeschung, Einschraenkung der
Verarbeitung, Widerspruch (Art. 15–21 DSGVO) sowie Beschwerde bei einer
Aufsichtsbehoerde.
Kontakt: [Datenschutz-Kontakt]

Mit freundlichen Gruessen
[Organisation]
```

Nach dem Versand den Vermerk „Informiert am" setzen (Button an der Kontaktkarte
oder `person_informed`), damit der Nachweis im Herkunftsbericht erscheint.
