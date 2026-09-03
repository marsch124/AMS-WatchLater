# AMS WatchLater icon — same stamped-dab hand-drawn recipe as the other AMS apps.
# Flat calm background, one white hand-drawn glyph. No gradient, no glow.

import math, random
from PIL import Image, ImageDraw, ImageFilter

SS = 4
N  = 1024 * SS
W  = 52 * SS

BG = (26, 94, 76, 255)   # calm deep teal, flat

def squircle_bg(color, shadow=True):
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    m = 100 * SS
    r = 184 * SS
    if shadow:
        sh = Image.new("RGBA", (N, N), (0, 0, 0, 0))
        d = ImageDraw.Draw(sh)
        d.rounded_rectangle([m, m + 10*SS, N - m, N - m + 10*SS], r, fill=(10, 30, 24, 70))
        sh = sh.filter(ImageFilter.GaussianBlur(14 * SS))
        img.alpha_composite(sh)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([m, m, N - m, N - m], r, fill=color)
    return img

def wobble(points, seed, amp=3.2, step=5, closed=False):
    rnd = random.Random(seed)
    ph = [rnd.random() * 6.28 for _ in range(4)]
    fr = [rnd.uniform(0.006, 0.02) for _ in range(4)]
    pts = list(points) + ([points[0]] if closed else [])
    out, t = [], 0.0
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(2, int(L / (step * SS)))
        nx, ny = (-(y1 - y0) / L, (x1 - x0) / L)
        for i in range(n):
            u = i / n
            x, y = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
            t += L / n
            off = sum(math.sin(t * fr[k] + ph[k]) for k in range(4)) / 4 * amp * SS
            out.append((x + nx * off, y + ny * off))
    out.append(pts[-1])
    return out

def stroke(d, pts, w=W, fill=(255, 255, 255, 255)):
    r = w / 2
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        L = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(L / (1.5 * SS)))
        for i in range(n + 1):
            u = i / n
            x, y = x0 + (x1 - x0) * u, y0 + (y1 - y0) * u
            d.ellipse([x - r, y - r, x + r, y + r], fill=fill)

def circle_pts(cx, cy, r, seed, n=90, amp=4):
    rnd = random.Random(seed)
    ph = [rnd.random() * 6.28 for _ in range(3)]
    out = []
    for i in range(n + 1):
        a = i / n * 2 * math.pi
        rr = r + sum(math.sin(a * (k + 2) + ph[k]) for k in range(3)) / 3 * amp * SS
        out.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr))
    out[-1] = out[0]
    return out

def P(x, y):
    return (x * SS, y * SS)

# A hand-drawn ring with a play triangle inside it: watch, and the app name
# supplies the "later". Two shapes only, so it still reads at Dock size.
def icon_watchlater():
    img = squircle_bg(BG)
    d = ImageDraw.Draw(img)

    ring = circle_pts(512 * SS, 512 * SS, 292 * SS, seed=41, amp=3.4)
    stroke(d, ring, w=W)

    tri = wobble([P(432, 366), P(432, 658), P(690, 512)], seed=7, amp=2.4, closed=True)
    d.polygon(tri, fill=(255, 255, 255, 255))
    stroke(d, tri, w=int(W * 0.62))

    return img

if __name__ == "__main__":
    im = icon_watchlater()
    im.resize((1024, 1024), Image.LANCZOS).save("icon-1024.png")
    print("wrote icon-1024.png")
