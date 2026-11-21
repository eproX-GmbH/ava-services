# Demo-Video für die Plugin-Einreichung

`compose.py` setzt echte Browser-Aufnahmen zu einem MP4 zusammen (1920 × 1080, 30 fps):
Verlauf in den AVA-Farben, Browser-Rahmen, Zooms, Klick-Welle, deutsche Untertitel,
Titel- und Abschlusskarte. Nur Pillow und ffmpeg, keine Fremddienste. Muster nach
OpenVideo (Bomx/OpenVideo), eigene Umsetzung (das Repo hat keine Lizenz).

## Neu aufnehmen

1. ChatGPT im Chrome-Fenster 1600 × 1000, temporärer Chat, Seitenleiste eingeklappt,
   „AVA (Test)“ mit dem Demo-Konto verbunden.
2. Je Szene mit der Chrome-Erweiterung aufnehmen (gif_creator, ohne Klick-Marker und
   Wasserzeichen); jedes Warten ist ein Einzelbild. Nach jedem Warten die Positionen von
   Mailadressen/Telefonnummern im Seitenkontext messen (`window.__schutz()`), Bild k gehört
   zur k-ten Messung.
3. GIFs in Einzelbilder zerlegen: `ffmpeg -i ava-s1a.gif -vsync 0 <wurzel>/s1a/f%03d.png`.
4. `storyboard.json` anpassen (Bildbereiche, Dauern, Zoom, Untertitel, `weich` je Bild).
5. `python3 compose.py storyboard.json <wurzel> ava-chatgpt-demo.mp4`

Vor dem Hochladen jedes Bild mit Mailadresse prüfen (Stichproben mit ffmpeg `fps=1,tile`).
