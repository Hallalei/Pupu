#!/usr/bin/env python3
"""
《在。》的音乐和音效，全部现场合成，没有采样素材。时间点读 day/beats.json，和画面同一份。

    python3 media/promo/audio/day.py          # 写 media/promo/out/day.wav

全片只有一问一答：「在吗」是两个往上走的音，「在」是落回主音的一个暖音。
片头在黑暗里弹一遍，半夜弹一遍，最后整栋楼一起回答。
"""
import json
import os
import sys

import numpy as np
from scipy.io import wavfile

from score import SR, axis, bell, boom, db, glitter, highpass, hz, lowpass, noise_band, pad, piano, place, pop, purr, reverb, riser, rng, smooth, spark, tick, whoosh

HERE = os.path.dirname(os.path.abspath(__file__))
B = json.load(open(os.path.join(HERE, "../day/beats.json")))
O, W, M, D, U, C, H, K, N, A, P, E = (B[key] for key in ("open", "walk", "meet", "drop", "dup", "cup", "hand", "dusk", "night", "dawn", "pull", "end"))
LENGTH = B["duration"] + 1.0
BEAT = 60 / 132


def timeline():
    return np.zeros((2, int(LENGTH * SR)))


def pizz(note, duration=1.1, velocity=0.7):
    """拨弦：高泛音走得快，起音干脆。"""
    f = hz(note) if isinstance(note, str) else note
    t = axis(duration)
    y = np.zeros_like(t)
    for k in range(1, 10):
        fk = k * f * (1 + 0.0004 * k * k)
        if fk > 7000:
            break
        y += np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28)) / k ** 1.15 * np.exp(-t * (3.4 + 1.9 * k + f / 450))
    y *= np.minimum(t / 0.0025, 1)
    return lowpass(y, 3200) * velocity


def marimba(note, duration=1.5, velocity=0.7):
    """木琴：三个不成倍的模态，槌声很短。"""
    f = hz(note) if isinstance(note, str) else note
    t = axis(duration)
    y = np.zeros_like(t)
    for ratio, amp, decay in ((1.0, 1.0, 4.6), (3.93, 0.22, 15.0), (9.1, 0.05, 36.0)):
        y += amp * np.sin(2 * np.pi * f * ratio * t) * np.exp(-t * decay)
    y *= np.minimum(t / 0.0012, 1)
    knock = lowpass(rng.standard_normal(t.size) * np.exp(-t * 300), 2400) * 0.1
    return (y + knock) * velocity


def slide(f0, f1, duration=0.3):
    """小滑音，猫跳起来、眼珠转过去都用它。"""
    t = axis(duration)
    k = t / duration
    freq = f0 * (f1 / f0) ** k
    y = np.sin(2 * np.pi * np.cumsum(freq) / SR) + 0.25 * np.sin(4 * np.pi * np.cumsum(freq) / SR)
    return y * np.sin(np.pi * k) ** 0.7


def pat():
    """猫爪落地。"""
    t = axis(0.05)
    return lowpass(rng.standard_normal(t.size) * np.exp(-t * 110), 520, 2) * 2.2


def step():
    """人的脚步。"""
    t = axis(0.11)
    return lowpass(rng.standard_normal(t.size) * np.exp(-t * 60), 300, 2) * 2.4 + np.sin(2 * np.pi * 90 * t) * np.exp(-t * 46) * 0.5


def thud():
    return boom(0.28, 170, 72) * 0.9


def key():
    """键盘：一声闷的敲击。"""
    t = axis(0.035)
    return (rng.standard_normal(t.size) * np.exp(-t * 240)) * 0.6 + np.sin(2 * np.pi * rng.uniform(420, 720) * t) * np.exp(-t * 200) * 0.4


def clink(strength=1.0):
    """杯底在木头桌面上挪一下：一声瓷，一小段摩擦。"""
    t = axis(0.24)
    ceramic = sum(a * np.sin(2 * np.pi * f * t) * np.exp(-t * d) for f, a, d in ((2140, 0.7, 58), (3410, 0.45, 80), (5230, 0.2, 130)))
    scrape = noise_band(0.24, lambda x: 1500 + 0 * x, 0.7, lambda x: np.exp(-x * 16) * 0.9)[0]
    wood = np.sin(2 * np.pi * 410 * t) * np.exp(-t * 90) * 0.55
    return (ceramic + scrape * 0.6 + wood) * strength


def switch():
    """灯开关。"""
    t = axis(0.04)
    return (np.sin(2 * np.pi * 1900 * t) * np.exp(-t * 300) + rng.standard_normal(t.size) * np.exp(-t * 500) * 0.5)


def chirp():
    """早上的鸟。"""
    t = axis(rng.uniform(0.06, 0.13))
    k = t / t[-1]
    f = rng.uniform(2800, 4200) * (1 + 0.3 * np.sin(np.pi * k * rng.uniform(1, 3)))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.sin(np.pi * k)


def ask(bus, at, gain=-9.0, pan=0.0, velocity=0.5):
    """在吗？"""
    place(bus, piano("A4", 3.6, velocity), at, gain, pan)
    place(bus, piano("D5", 3.6, velocity + 0.07), at + 0.27, gain + 1, pan)


def answer(bus, at, gain=-7.0, pan=0.0, velocity=0.56):
    """在。"""
    place(bus, piano("D3", 6.0, velocity * 0.9), at, gain - 2, pan)
    place(bus, piano("A3", 6.0, velocity * 0.8), at + 0.012, gain - 4, pan)
    place(bus, piano("D4", 6.0, velocity), at + 0.02, gain, pan)


def said(sfx, at, length, gain=-20.0, pan=0.0, f=700.0):
    """气泡冒出来，字一个一个打上去。"""
    place(sfx, pop(f), at, gain, pan)
    for index in range(length):
        place(sfx, tick(2300 + (index % 3) * 170), at + 0.08 + index / 26, gain - 13, pan)


def typing(sfx, start, end, gain=-31.0, pan=0.0, rate=8.5):
    t = start
    while t < end:
        t += rng.exponential(1 / rate) + 0.03
        place(sfx, key(), t, gain + rng.uniform(-4, 1), pan)


def paws(sfx, start, end, gain=-27.0, gap=0.19):
    t = start
    while t < end:
        place(sfx, pat(), t, gain + rng.uniform(-3, 1), rng.uniform(-0.1, 0.1))
        t += gap


def feet(sfx, start, count, gap=0.3, gain=-22.0, pan=0.0):
    for index in range(count):
        place(sfx, step(), start + index * gap, gain + rng.uniform(-2, 1), pan)


def walk(music, start, end, gain=-13.0, bass=("D3", "A2", "D3", "A2", "G2", "A2", "D3", "A2"), tip=("F#4", "A4", "B4", "A4", "G4", "A4", "F#4", "E4")):
    """猫走路的拨弦：低音踩正拍，高音踮着脚走反拍。"""
    index = 0
    t = start
    while t < end:
        place(music, pizz(bass[index % len(bass)], 1.0, 0.8), t, gain, -0.12)
        if t + BEAT / 2 < end:
            place(music, pizz(tip[index % len(tip)], 0.7, 0.6), t + BEAT / 2, gain - 3, 0.18)
        if index % 4 == 2:
            place(music, marimba("A5", 1.0, 0.5), t + BEAT * 0.75, gain - 7, 0.3)
        t += BEAT
        index += 1


def open_scene(music, sfx):
    place(sfx, noise_band(3.2, lambda x: 180 + 0 * x, 1.3, lambda x: 0.05 + 0 * x), 0, -22)
    said(sfx, O["ask"], 3, -21, -0.3, 620)
    ask(music, O["ask"] + 0.05, -8)
    place(music, bell("A6", 2.0, index=0.8), O["eyes"], -30, 0.0)
    said(sfx, O["say"], 2, -21, 0.3, 560)
    answer(music, O["say"] + 0.03, -6.5)
    place(sfx, purr(1.5), O["say"] + 0.1, -19)
    place(sfx, switch(), O["lamp"], -13)
    place(sfx, thud(), W["start"] + 0.42, -24)


def room_tone(sfx):
    """白天楼里的底噪。"""
    t0, t1 = O["lamp"], K["dark"]

    def level(x):
        return 0.16 * smooth(0, 0.3, x) * (1 - smooth(t1 - t0 - 1.5, t1 - t0, x))

    place(sfx, noise_band(t1 - t0, lambda x: 340 + 0 * x, 1.6, level), t0, -16)


def morning(music, sfx):
    walk(music, W["start"] + 0.1, W["door"] + 0.75)
    paws(sfx, W["start"] + 0.5, W["door"] + 0.45)
    place(music, pad(["D3", "A3", "E4", "F#4"], M["leave"] - M["ask"] + 2.4, attack=1.0, release=1.8, bright=1300), M["ask"] - 0.5, -15)
    said(sfx, M["ask"], 9, -21, -0.2)
    for index in range(4):
        place(sfx, tick(1250 + index * 90), M["turn"] + index * 0.055, -25, -0.4 + index * 0.27)
    place(music, slide(420, 880, 0.42), M["hop"] + 0.06, -28)
    place(sfx, thud(), M["land"], -24)
    said(sfx, M["say"], 16, -20, 0.2, 780)
    place(music, bell("A5", 2.6, index=1.0), M["say"] + 0.1, -22, 0.2)
    place(music, bell("D6", 2.6, index=1.0), M["say"] + 0.28, -24, 0.2)
    for index in range(2):
        place(music, pizz("D4", 0.9, 0.7), M["nod"] + index * 0.45, -17)
    place(sfx, thud(), M["leave"] + 0.46, -27)
    walk(music, M["leave"] + 0.12, D["start"] - 0.05)
    paws(sfx, M["leave"] + 0.5, D["start"] - 0.15)


def fall(music, sfx):
    run = ["D6", "B5", "A5", "F#5", "E5", "D5", "B4", "A4", "F#4", "E4", "D4", "B3", "A3", "F#3", "E3", "D3"]
    span = D["land"] - D["start"]
    for index, note in enumerate(run):
        at = D["start"] + (index / len(run)) ** (1 / 1.7) * span
        place(music, marimba(note, 0.9, 0.6), at, -13, 0.25 - index * 0.03)
    place(sfx, whoosh(span + 0.2, 240, 1800, 0.8), D["start"], -14)
    place(sfx, thud(), D["land"], -14)
    place(music, pizz("D2", 1.4, 0.95), D["land"], -10)


def twins(music, sfx):
    typing(sfx, D["land"] - 0.4, U["say"] + 0.6, -33, 0.3)
    typing(sfx, D["land"] - 0.4, U["look"], -36, 0.1)
    place(music, pad(["G3", "B3", "D4", "A4"], U["leave"] - U["ask"] + 1.4, attack=0.7, release=1.2, bright=1500), U["ask"] - 0.2, -16)
    said(sfx, U["ask"], 8, -21, 0.3)
    said(sfx, U["say"], 10, -20, -0.25, 780)
    place(music, marimba("A5", 1.1, 0.6), U["look"], -15, 0.3)
    place(music, marimba("A4", 1.1, 0.6), U["look"] + 0.12, -15, 0.3)
    for index, note in enumerate(("D5", "F#5", "A5", "D6")):
        place(music, marimba(note, 1.2, 0.6), U["wave"] + index * 0.11, -16, 0.1 * index)
    walk(music, U["leave"] + 0.05, C["in"] - 0.25, -14)
    paws(sfx, U["leave"] + 0.05, C["in"] - 0.35)
    place(music, slide(420, 820, 0.3), C["in"] - 0.3, -28)
    place(sfx, thud(), C["in"], -26)


def cup(music, sfx):
    """音乐全停。只剩杯底在桌面上的三下。"""
    said(sfx, C["say"], 7, -21, 0.25)
    for index, at in enumerate((C["tap1"], C["tap2"], C["tap3"])):
        place(sfx, clink(0.8 + 0.12 * index), at + 0.02, -15, 0.25)
    place(music, slide(460, 690, 0.24), C["slide"], -30, -0.15)
    place(sfx, pop(520), C["ok"], -21, -0.15)
    place(music, piano("D4", 4.5, 0.42), C["ok"] + 0.04, -11, -0.1)
    place(music, piano("F#4", 4.5, 0.4), C["ok"] + 0.06, -13, 0.0)
    place(music, piano("A4", 4.5, 0.42), C["ok"] + 0.08, -13, 0.1)
    place(sfx, clink(0.5), C["back"] + 0.08, -20, 0.2)
    place(music, pad(["D3", "A3", "D4", "F#4"], K["start"] - H["ask"] + 2.4, attack=1.0, release=1.4, bright=1300), H["ask"] - 0.6, -15)
    said(sfx, H["ask"], 7, -21, -0.2)
    said(sfx, H["say"], 3, -20, 0.2, 560)
    answer(music, H["say"] + 0.04, -13, 0.1, 0.44)
    feet(sfx, H["leave"] + 0.05, 5, 0.3, -24, -0.3)
    place(sfx, tick(620), H["leave"] + 1.58, -24, -0.6)
    typing(sfx, H["leave"] + 1.6, K["start"] + 2.2, -34, 0.0, 7)


def dusk(music, sfx):
    """天黑得很快。灯一盏一盏关掉，最后只剩一盏。"""
    start, dark = K["start"], K["dark"]
    seq = [(["D3", "A3", "D4", "F#4", "A4"], 0.0), (["B2", "F#3", "B3", "D4", "F#4"], 1.45), (["G2", "D3", "G3", "B3", "D4"], 2.9), (["E2", "B2", "E3", "G3", "D4"], 4.25)]
    for notes, at in seq:
        place(music, pad(notes, 2.9, attack=0.8, release=1.3, bright=1500 - at * 120), start + at, -9 - at * 0.4)
    place(music, pad(["D2", "A2", "D3"], N["end"] - dark + 5.0, attack=2.6, release=2.0, bright=420), dark - 1.4, -13)
    gap = 0.46
    t = start + 0.4
    while t < dark - 0.3:
        place(sfx, tick(1500), t, -30, 0.1)
        gap = max(0.09, gap * 0.93)
        t += gap
    for _ in range(40):
        place(sfx, switch(), rng.uniform(start + 0.9, dark - 0.4), rng.uniform(-30, -24), rng.uniform(-0.8, 0.8))
    place(sfx, noise_band(dark - start, lambda x: 500 + x * 80, 1.4, lambda x: 0.16 * smooth(0, 2.4, x) * (1 - smooth(3.6, 6, x))), start, -15)


def night(music, sfx):
    place(sfx, noise_band(N["end"] - K["dark"] + 2, lambda x: 900 + 0 * x, 1.5, lambda x: 0.05 + 0 * x), K["dark"], -24)
    typing(sfx, K["dark"], N["ask"] - 0.15, -34, -0.1, 5)
    said(sfx, N["ask"], 3, -22, -0.25, 620)
    ask(music, N["ask"] + 0.05, -9, -0.15, 0.46)
    said(sfx, N["say"], 2, -22, 0.25, 560)
    answer(music, N["say"] + 0.04, -7, 0.1, 0.5)
    place(sfx, purr(2.4), N["say"] + 0.1, -18)
    place(music, piano("F#4", 4.5, 0.32), N["say"] + 1.1, -14, 0.15)
    place(music, piano("A4", 4.5, 0.3), N["say"] + 1.65, -15, -0.1)
    feet(sfx, N["end"] - 0.1, 4, 0.28, -29, -0.5)


def dawn(music, sfx):
    start = N["end"] + 0.2
    place(music, pad(["D3", "A3", "D4", "E4", "A4"], 3.2, attack=1.3, release=1.0, bright=900), start, -11)
    place(music, pad(["G3", "D4", "G4", "B4"], 3.0, attack=1.0, release=0.9, bright=1500), start + 2.0, -11)
    place(music, pad(["D3", "A3", "D4", "F#4", "A4"], A["wave"] - start, attack=1.0, release=0.5, bright=1900), start + 3.7, -11)
    gap = 0.09
    t = start
    while t < A["enter"]:
        place(sfx, tick(1500), t, -32, 0.1)
        gap = min(0.5, gap * 1.1)
        t += gap
    for _ in range(14):
        place(sfx, chirp(), rng.uniform(A["sun"] - 0.4, A["wave"] + 1.2), rng.uniform(-37, -30), rng.uniform(-0.9, 0.9))
    feet(sfx, A["enter"] - 0.2, 4, 0.27, -24, -0.45)
    said(sfx, A["ask"], 6, -21, -0.3)
    said(sfx, A["say"], 6, -20, 0.3, 560)
    answer(music, A["say"] + 0.04, -11, 0.1, 0.52)


def rise(music, sfx):
    """整栋楼亮起来，镜头退到云外。"""
    start, face = A["wave"], P["face"]
    span = face - start
    place(music, pad(["D3", "A3", "D4", "F#4", "A4", "D5"], span + 0.5, attack=span * 0.75, release=0.25, bright=3000), start, -8)
    place(music, pad(["D2", "A2", "D3"], span + 0.5, attack=span * 0.8, release=0.25, bright=500), start, -10)
    notes = ["A4", "D5", "F#5", "A5", "D6", "E6", "F#6", "A6", "D7"]
    t = start
    gap = 0.34
    index = 0
    while t < face - 0.1:
        place(music, piano(notes[index % len(notes)], 2.6, 0.5), t, -14 + index * 0.1, (index % 5 - 2) * 0.2)
        if index % 2 == 0:
            place(music, bell(notes[(index + 3) % len(notes)], 1.8), t, -27, (2 - index % 5) * 0.2)
        gap = max(0.1, gap * 0.94)
        t += gap
        index += 1
    glitter(music, start, face + 0.6, lambda x: 12 + 60 * smooth(start, face, x), -32)
    place(sfx, riser(span, 240, 6400), start, -13)
    for at in (start + 0.9, start + 1.8, start + 2.5):
        place(sfx, whoosh(1.1, 260, 2600, 0.55), at, -17, rng.uniform(-0.5, 0.5))


def face(music, sfx):
    at = P["face"]
    place(sfx, boom(3.4, 88, 30), at, -6)
    place(music, pad(["D2", "A2", "D3", "A3", "D4", "F#4", "A4", "D5"], P["blink"] - at + 1.0, attack=0.04, release=1.1, bright=3400), at, -5)
    answer(music, at, -8, 0.0, 0.8)
    for index, note in enumerate(("D5", "A5", "D6", "F#6", "A6")):
        place(music, bell(note, 3.0), at + index * 0.09, -21 + index, (index - 2) * 0.25)


def blink(music, sfx):
    """整栋楼慢慢眨一下眼。猫这样看你，是说不用怕。"""
    at = P["blink"]
    place(sfx, noise_band(0.62, lambda x: 900 - x * 1000, 1.0, lambda x: np.sin(np.pi * np.clip(x / 0.62, 0, 1)) * 0.5), at, -17)
    place(sfx, noise_band(0.62, lambda x: 300 + x * 1000, 1.0, lambda x: np.sin(np.pi * np.clip(x / 0.62, 0, 1)) * 0.5), at + 0.58, -17)
    place(music, pad(["D3", "A3", "D4", "F#4"], E["brain"] - at + 1.4, attack=0.7, release=1.2, bright=800), at + 0.2, -15)
    place(sfx, purr(60 - at + 0.2), at + 0.4, -9)


def dots(music, sfx):
    at = P["dots"]
    span = P["word"] - at - 0.15
    notes = ("E5", "F#5", "A5")
    cycle = 0
    while cycle * 0.72 < span:
        for index, note in enumerate(notes):
            when = at + cycle * 0.72 + index * 0.16 + 0.12
            if when < P["word"] - 0.12:
                place(music, marimba(note, 0.9, 0.55), when, -16, (index - 1) * 0.4)
        cycle += 1


def word(music, sfx):
    at = P["word"]
    answer(music, at, -3.5, 0.0, 0.86)
    place(music, pizz("D2", 2.0, 0.9), at, -10)
    place(sfx, boom(3.0, 62, 30), at, -11)
    place(music, pad(["D2", "A2", "D3", "A3", "F#4"], 60 - at + 0.6, attack=0.4, release=2.4, bright=1100), at, -11)


def titles(music, sfx):
    ask(music, E["brain"], -12, -0.1, 0.44)
    place(music, piano("B3", 4.6, 0.4), E["line"], -12, -0.1)
    place(music, piano("G3", 4.6, 0.38), E["line"] + 0.02, -13, 0.1)
    place(music, piano("F#4", 4.6, 0.4), E["line"] + 0.03, -13, 0.1)
    answer(music, E["logo"], -9, 0.0, 0.54)
    place(music, bell("D6", 3.0, index=1.0), E["logo"] + 0.02, -21, 0.0)


def main():
    music = timeline()
    sfx = timeline()
    for part in (open_scene, morning, fall, twins, cup, dusk, night, dawn, rise, face, blink, dots, word, titles):
        part(music, sfx)
    room_tone(sfx)

    t = np.arange(music.shape[1]) / SR
    music = reverb(music, 2.8, 3600, 0.34, 3)
    sfx = reverb(sfx, 0.9, 5200, 0.14, 5)
    mix = highpass(music + sfx, 28, 2)

    peak = np.max(np.abs(mix))
    mix = mix / peak
    mix = np.tanh(mix * 2.0) / np.tanh(2.0)
    mix *= db(-1.0) / np.max(np.abs(mix))
    mix = mix * (1 - smooth(59.3, 60.6, t))

    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "../out/day.wav")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wavfile.write(path, SR, mix.T.astype(np.float32))
    print(f"写好了 {os.path.relpath(path)}，{mix.shape[1] / SR:.1f} 秒，峰值 {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS")


if __name__ == "__main__":
    main()
