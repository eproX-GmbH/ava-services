#!/usr/bin/env python3
"""Demo-Video fuer die ChatGPT-Plugin-Einreichung (docs/PLAN_CHATGPT_PLUGIN.md, C4).

Setzt echte Browser-Aufnahmen (Einzelbilder aus Chrome) zu einem MP4 zusammen:
Verlauf in den AVA-Farben, Browser-Rahmen, sanfte Zooms, Klick-Welle, deutsche
Untertitel, Titel- und Abschlusskarte. Mailadressen/Telefonnummern werden an den
mitgeschriebenen Positionen weichgezeichnet. Keine Fremddienste, nur Pillow + ffmpeg.

Muster nach OpenVideo (Bomx/OpenVideo, demo_video_composer.py), eigene Umsetzung.

Aufruf:
  python3 compose.py storyboard.json <frames-wurzel> <ausgabe.mp4>
"""
import json
import math
import os
import subprocess
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat

W, H, FPS = 1920, 1080, 30
DUNKEL = (10, 31, 42)       # #0A1F2A
AKZENT = (0, 192, 167)      # #00C0A7
HELL = (242, 247, 246)      # #F2F7F6
FONT_DIR = os.path.expanduser("~/Library/Fonts")


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, f"Poppins-{name}.ttf"), size)


def ease(t):
    t = max(0.0, min(1.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - pow(-2 * t + 2, 3) / 2


def verlauf():
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        for x in range(0, W, 4):
            # diagonal von dunkel nach dunkel-tuerkis
            t = (x / W) * 0.6 + (y / H) * 0.4
            r = int(DUNKEL[0] + (0 - DUNKEL[0]) * t * 0.35)
            g = int(DUNKEL[1] + (AKZENT[1] - DUNKEL[1]) * t * 0.28)
            b = int(DUNKEL[2] + (AKZENT[2] - DUNKEL[2]) * t * 0.28)
            for dx in range(4):
                if x + dx < W:
                    px[x + dx, y] = (r, g, b)
    return img


def rund_maske(size, radius):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, size[0] - 1, size[1] - 1], radius=radius, fill=255)
    return m


class Composer:
    def __init__(self, sb, root):
        self.sb = sb
        self.root = root
        self.bg = verlauf()
        self.logo = Image.open(sb["logo"]).convert("RGBA")
        # Fensterflaeche
        self.cw = 1560
        self.ch = int(self.cw * 820 / 1456)
        self.bar = 40
        self.wx = (W - self.cw) // 2
        self.wy = 34
        self.cache = {}
        self.zoom_akt = (0.5, 0.5, 1.0)

    # ---- Quellbilder -----------------------------------------------------
    def quelle(self, clip, n):
        key = (clip, n)
        if key in self.cache:
            return self.cache[key]
        img = Image.open(os.path.join(self.root, clip, f"f{n:03d}.png")).convert("RGB")
        if img.size != (1456, 820):
            # andere Fenstergroesse (App-Aufnahme): auf 1456 Breite, oben anheften
            s = 1456 / img.size[0]
            img2 = Image.new("RGB", (1456, 820), (248, 250, 250))
            r = img.resize((1456, int(img.size[1] * s)), Image.LANCZOS)
            img2.paste(r.crop((0, 0, 1456, min(820, r.size[1]))), (0, 0))
            img = img2
        c = self.sb["clips"].get(clip, {})
        for x0, y0, x1, y1 in c.get("abdecken", []):
            ImageDraw.Draw(img).rectangle([x0, y0, x1, y1], fill=tuple(c.get("abdeckfarbe", [0, 0, 0])))
        css = c.get("css_faktor", 1.0)
        for r in c.get("weich", {}).get(str(n), []) + c.get("weich_immer", []):
            x, y, w, h = r
            x0, y0 = int(x * css) - 8, int(y * css) - 6
            x1, y1 = int((x + w) * css) + 8, int((y + h) * css) + 6
            box = (max(0, x0), max(0, y0), min(1456, x1), min(820, y1))
            if box[2] > box[0] and box[3] > box[1]:
                img.paste(img.crop(box).filter(ImageFilter.GaussianBlur(9)), box[:2])
        self.cache[key] = img
        if len(self.cache) > 12:
            self.cache.pop(next(iter(self.cache)))
        return img

    # ---- Zeichnen --------------------------------------------------------
    def fenster(self, inhalt, url, hell):
        frame = self.bg.copy()
        # Schatten
        sh = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        ImageDraw.Draw(sh).rounded_rectangle(
            [self.wx + 6, self.wy + 18, self.wx + self.cw + 6, self.wy + self.bar + self.ch + 18], radius=18, fill=(0, 0, 0, 120))
        sh = sh.filter(ImageFilter.GaussianBlur(22))
        frame.paste(sh, (0, 0), sh)
        win = Image.new("RGB", (self.cw, self.bar + self.ch), (28, 28, 30) if not hell else (232, 236, 236))
        d = ImageDraw.Draw(win)
        for i, col in enumerate([(255, 95, 87), (254, 188, 46), (40, 200, 64)]):
            d.ellipse([18 + i * 22, 14, 30 + i * 22, 26], fill=col)
        pill_w = 420
        px0 = (self.cw - pill_w) // 2
        d.rounded_rectangle([px0, 8, px0 + pill_w, 32], radius=12, fill=(48, 48, 52) if not hell else (255, 255, 255))
        f = font("Regular", 15)
        tw = d.textlength(url, font=f)
        d.text((px0 + (pill_w - tw) / 2, 11), url, font=f, fill=(200, 200, 205) if not hell else (60, 70, 75))
        win.paste(inhalt, (0, self.bar))
        frame.paste(win, (self.wx, self.wy), rund_maske(win.size, 16))
        return frame

    def zoomen(self, img, z):
        cx, cy, f = z
        sw, sh = 1456 / f, 820 / f
        x0 = min(max(cx * 1456 - sw / 2, 0), 1456 - sw)
        y0 = min(max(cy * 820 - sh / 2, 0), 820 - sh)
        return img.resize((self.cw, self.ch), Image.LANCZOS, box=(x0, y0, x0 + sw, y0 + sh)), (x0, y0, sw, sh)

    def untertitel(self, frame, text, alpha):
        if not text or alpha <= 0:
            return frame
        f = font("SemiBold", 30)
        d0 = ImageDraw.Draw(frame)
        tw = d0.textlength(text, font=f)
        bw, bh = int(tw + 72), 64
        x0 = (W - bw) // 2
        y0 = H - bh - 30
        lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        a = int(235 * alpha)
        d.rounded_rectangle([x0, y0, x0 + bw, y0 + bh], radius=32, fill=DUNKEL + (a,), outline=AKZENT + (int(255 * alpha),), width=2)
        d.text((x0 + 36, y0 + 13), text, font=f, fill=(255, 255, 255, int(255 * alpha)))
        frame = frame.convert("RGBA")
        frame.alpha_composite(lay)
        return frame.convert("RGB")

    def welle(self, frame, pos, t, vis):
        # pos in Quellpixeln -> Fensterpixel ueber den sichtbaren Ausschnitt
        x0, y0, sw, sh = vis
        x = self.wx + (pos[0] - x0) * self.cw / sw
        y = self.wy + self.bar + (pos[1] - y0) * self.ch / sh
        lay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        d = ImageDraw.Draw(lay)
        for k in range(2):
            p = t - k * 0.18
            if 0 <= p <= 1:
                r = 14 + 46 * ease(p)
                a = int(220 * (1 - p))
                d.ellipse([x - r, y - r, x + r, y + r], outline=AKZENT + (a,), width=5)
        d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=AKZENT + (int(200 * max(0, 1 - t)),))
        frame = frame.convert("RGBA")
        frame.alpha_composite(lay)
        return frame.convert("RGB")

    def karte(self, titel, unter, zeile3=None):
        frame = self.bg.copy()
        lg = self.logo.resize((150, 150), Image.LANCZOS)
        m = rund_maske((150, 150), 34)
        frame.paste(lg, ((W - 150) // 2, 300), m)
        d = ImageDraw.Draw(frame)
        f1, f2, f3 = font("Bold", 64), font("Regular", 34), font("SemiBold", 28)
        for txt, f, y, col in [(titel, f1, 490, (255, 255, 255)), (unter, f2, 590, HELL), (zeile3, f3, 660, AKZENT)]:
            if txt:
                tw = d.textlength(txt, font=f)
                d.text(((W - tw) / 2, y), txt, font=f, fill=col)
        return frame

    # ---- Ablauf ----------------------------------------------------------
    def bilder_der_einstellung(self, e):
        clip = e["clip"]
        nums = list(range(e["von"], e["bis"] + 1))
        if e.get("doppelte_weg", True):
            behalten, letzt = [], None
            for n in nums:
                img = self.quelle(clip, n).resize((182, 102))
                if letzt is None or ImageStat.Stat(ImageChops.difference(img, letzt)).mean[0] > 0.35:
                    behalten.append(n)
                    letzt = img
            if behalten[-1] != nums[-1]:
                behalten[-1] = nums[-1]
            nums = behalten
        dauer = e.get("dauern", {})
        plan = []
        for i, n in enumerate(nums):
            d = float(dauer.get(str(n), e.get("je_bild", 1.0)))
            if i == len(nums) - 1:
                d = max(d, e.get("halten", 2.0))
            plan.append((n, d))
        return plan

    def render(self, out):
        cmd = ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
               "-i", "-", "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE)
        total = 0

        def schreibe(img):
            nonlocal total
            p.stdin.write(img.tobytes())
            total += 1

        def ueberblende(a, b, sek):
            n = int(sek * FPS)
            for i in range(n):
                schreibe(Image.blend(a, b, ease((i + 1) / n)))

        letzt = None
        vorher_text = None
        for e in self.sb["ablauf"]:
            if e["art"] == "karte":
                k = self.karte(e["titel"], e.get("unter"), e.get("zeile3"))
                if letzt is not None:
                    ueberblende(letzt, k, 0.6)
                for _ in range(int(e["dauer"] * FPS)):
                    schreibe(k)
                letzt, vorher_text = k, None
                continue
            plan = self.bilder_der_einstellung(e)
            ziel = tuple(e.get("zoom", [0.5, 0.5, 1.0]))
            start_zoom = self.zoom_akt
            url, hell = e.get("url", "chatgpt.com"), e.get("hell", False)
            text = e.get("text")
            t_e = 0.0
            klicks = {int(k): v for k, v in e.get("klicks", {}).items()}
            for idx, (n, d) in enumerate(plan):
                src = self.quelle(e["clip"], n)
                nxt = self.quelle(e["clip"], plan[idx + 1][0]) if idx + 1 < len(plan) else None
                frames = max(1, int(d * FPS))
                for i in range(frames):
                    tt = t_e + i / FPS
                    zf = ease(tt / 0.9)
                    z = tuple(start_zoom[j] + (ziel[j] - start_zoom[j]) * zf for j in range(3))
                    # weiche Ueberblendung in den letzten 0,25 s zum naechsten Quellbild
                    rest = (frames - i) / FPS
                    if nxt is not None and rest < 0.25:
                        quelle = Image.blend(src, nxt, ease(1 - rest / 0.25))
                    else:
                        quelle = src
                    inhalt, vis = self.zoomen(quelle, z)
                    frame = self.fenster(inhalt, url, hell)
                    if n in klicks:
                        frame = self.welle(frame, klicks[n], i / FPS / 0.9, vis)
                    alpha = 1.0 if text == vorher_text else ease(tt / 0.5)
                    frame = self.untertitel(frame, text, alpha)
                    if letzt is not None and idx == 0 and i == 0:
                        ueberblende(letzt, frame, 0.45)
                    schreibe(frame)
                    letzt = frame
                t_e += frames / FPS
            self.zoom_akt = ziel
            vorher_text = text
        p.stdin.close()
        p.wait()
        return total / FPS


if __name__ == "__main__":
    sb = json.load(open(sys.argv[1], encoding="utf-8"))
    sek = Composer(sb, sys.argv[2]).render(sys.argv[3])
    print(f"fertig: {sys.argv[3]} ({sek:.1f} s)")
