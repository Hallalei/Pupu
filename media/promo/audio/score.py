#!/usr/bin/env python3
"""
片子的音乐和音效，全部现场合成，没有任何采样素材。时间点读 film/beats.json，和画面同一份。

    python3 media/promo/audio/score.py          # 写 media/promo/out/score.wav

主题：四个音 A D E F#。林夏定下这件事的时候钢琴弹一遍，周屿拿到答案的时候同样四个音回来。
上下文接力在声音里也发生一次。
"""
import json
import os
import sys

import numpy as np
from scipy import signal
from scipy.io import wavfile

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
BEATS = json.load(open(os.path.join(HERE, "../film/beats.json")))
R = BEATS["relay"]
LENGTH = BEATS["duration"] + 3.0
rng = np.random.default_rng(7)


def timeline():
    return np.zeros((2, int(LENGTH * SR)))


def db(x):
    return 10 ** (x / 20)


def hz(note):
    names = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
    pitch = names[note[0]] + (1 if "#" in note else -1 if note[1] == "b" else 0)
    return 440 * 2 ** ((pitch + 12 * (int(note[-1]) + 1) - 69) / 12)


def place(bus, y, t, gain=0.0, pan=0.0):
    """pan 是 -1 到 1，或者和 y 等长的曲线。"""
    if y.ndim == 1:
        angle = (np.asarray(pan) + 1) * np.pi / 4
        y = np.stack([y * np.cos(angle), y * np.sin(angle)])
    start = int(t * SR)
    if start < 0:
        y = y[:, -start:]
        start = 0
    end = min(start + y.shape[1], bus.shape[1])
    if end > start:
        bus[:, start:end] += y[:, : end - start] * db(gain)


def lowpass(y, cutoff, order=2):
    sos = signal.butter(order, cutoff, "low", fs=SR, output="sos")
    return signal.sosfilt(sos, y, axis=-1)


def highpass(y, cutoff, order=2):
    sos = signal.butter(order, cutoff, "high", fs=SR, output="sos")
    return signal.sosfilt(sos, y, axis=-1)


def smooth(a, b, x):
    c = np.clip((x - a) / (b - a), 0, 1)
    return c * c * (3 - 2 * c)


def axis(duration):
    return np.arange(int(duration * SR)) / SR


def piano(note, duration=5.0, velocity=0.7):
    """毛毡钢琴：泛音微微不和谐，高泛音走得快，起音软。"""
    f = hz(note) if isinstance(note, str) else note
    t = axis(duration)
    y = np.zeros_like(t)
    for k in range(1, 14):
        fk = k * f * np.sqrt(1 + 0.00032 * k * k)
        if fk > 11000:
            break
        amp = (1 / k ** 1.7) * (0.45 + velocity * 0.55) ** (k * 0.4)
        y += amp * np.sin(2 * np.pi * fk * t + rng.uniform(0, 6.28)) * np.exp(-t * (0.5 + 0.32 * k + f / 1800))
    y *= np.minimum(t / 0.007, 1)
    thump = lowpass(rng.standard_normal(t.size) * np.exp(-t * 110), 700) * 0.09
    return (y + thump) * velocity


def voice(f, duration, width=7.0, partials=9, tilt=1.3):
    """一个声部，几把微微走音的合在一起，左右不一样。"""
    t = axis(duration)
    out = np.zeros((2, t.size))
    for channel, cents in enumerate(((-width, width * 0.35), (width * 0.8, -width * 0.45))):
        for detune in cents:
            ff = f * 2 ** (detune / 1200)
            for k in range(1, partials + 1):
                if ff * k > 9000:
                    break
                out[channel] += np.sin(2 * np.pi * ff * k * t + rng.uniform(0, 6.28)) / k ** tilt
    return out / 2.4


def pad(notes, duration, attack=1.6, release=2.2, bright=1600.0, opening=None):
    """和弦垫底。opening 给一条亮度曲线（0 到 1），在暗和亮两版之间走。"""
    y = sum(voice(hz(note), duration) for note in notes)
    t = axis(duration)
    dark = lowpass(y, bright * 0.45)
    light = lowpass(y, bright * 2.2)
    amount = opening if opening is not None else smooth(0, duration * 0.6, t) * 0.5
    mixed = dark * (1 - amount) + light * amount
    shape = smooth(0, attack, t) * (1 - smooth(duration - release, duration, t))
    return mixed * shape / max(len(notes), 1)


def bell(note, duration=2.6, ratio=3.01, index=1.6):
    f = hz(note) if isinstance(note, str) else note
    t = axis(duration)
    y = np.sin(2 * np.pi * f * t + index * np.exp(-t * 7) * np.sin(2 * np.pi * f * ratio * t))
    y += 0.3 * np.sin(2 * np.pi * f * 2.0 * t + 0.5) * np.exp(-t * 4.5)
    return y * np.exp(-t * 2.4) * np.minimum(t / 0.0015, 1)


def spark(f, duration=0.34):
    t = axis(duration)
    return np.sin(2 * np.pi * f * t + 1.4 * np.exp(-t * 30) * np.sin(2 * np.pi * f * 4.1 * t)) * np.exp(-t * 15) * np.minimum(t / 0.001, 1)


PENTATONIC = [hz(n) for n in ("D6", "E6", "F#6", "A6", "B6", "D7", "E7", "F#7", "A7")]


def glitter(bus, start, end, density, gain=-30.0, low=0, high=None):
    """金色体素飞的声音：很多很短的小铃，音高只在五声音阶里。density 是一秒多少颗（可给曲线）。"""
    high = high or len(PENTATONIC)
    t = start
    while t < end:
        rate = density(t) if callable(density) else density
        t += rng.exponential(1 / max(rate, 0.5))
        if t >= end:
            break
        f = PENTATONIC[rng.integers(low, high)]
        place(bus, spark(f * 2 ** (rng.normal(0, 3) / 1200)), t, gain + rng.uniform(-9, 2), rng.uniform(-0.9, 0.9))


def noise_band(duration, center, width, level):
    """带状噪声。center、level 是时间到数值的函数，宽度按八度。用短时频谱塑形，风和呼啸都从这儿来。"""
    n = int(duration * SR)
    out = []
    for _ in range(2):
        f, frames, Z = signal.stft(rng.standard_normal(n), SR, nperseg=2048)
        logf = np.log2(np.maximum(f, 20))[:, None]
        when = frames[None, :]
        fc = np.log2(np.maximum(center(when), 20))
        gain = np.exp(-(((logf - fc) / width) ** 2)) * level(when)
        _, y = signal.istft(Z * gain, SR, nperseg=2048)
        out.append(y[:n])
    return np.stack(out)


def whoosh(duration, low=240.0, high=4200.0, peak=0.55, width=1.1):
    """走近又走远。"""
    def center(x):
        k = x / duration
        return low * (high / low) ** np.clip(1 - np.abs(k - peak) / max(peak, 1 - peak), 0, 1)

    def level(x):
        k = np.clip(x / duration, 0, 1)
        return (np.minimum(k / peak, 1) ** 2) * (1 - np.clip((k - peak) / (1 - peak), 0, 1)) ** 1.6

    return noise_band(duration, center, width, level)


def riser(duration, low=300.0, high=7000.0):
    return noise_band(duration, lambda x: low * (high / low) ** np.clip(x / duration, 0, 1) ** 1.5, 0.8, lambda x: np.clip(x / duration, 0, 1) ** 2.4)


def boom(duration=3.0, start=86.0, end=31.0):
    t = axis(duration)
    freq = end + (start - end) * np.exp(-t * 5.5)
    phase = 2 * np.pi * np.cumsum(freq) / SR
    return (np.sin(phase) + 0.25 * np.sin(phase * 2)) * np.exp(-t * 1.5) * np.minimum(t / 0.004, 1)


def pop(f=780.0, duration=0.11):
    """气泡冒出来的一声。"""
    t = axis(duration)
    freq = f * (1 + 0.75 * (1 - np.exp(-t * 55)))
    y = np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 34)
    return y * np.minimum(t / 0.002, 1)


def tick(f=2400.0):
    t = axis(0.03)
    return np.sin(2 * np.pi * f * t) * np.exp(-t * 260) + rng.standard_normal(t.size) * np.exp(-t * 420) * 0.3


def clock(high=True):
    t = axis(0.07)
    f = 1650.0 if high else 1320.0
    return (np.sin(2 * np.pi * f * t) * 0.7 + np.sin(2 * np.pi * f * 0.51 * t)) * np.exp(-t * 95)


def purr(duration):
    """Pupu 的呼噜：低频噪声，一秒二十五下。"""
    t = axis(duration)
    y = lowpass(rng.standard_normal(t.size), 150, 4)
    gate = (0.5 + 0.5 * np.sin(2 * np.pi * 24.5 * t + 1.8 * np.sin(2 * np.pi * 0.42 * t))) ** 2
    return y * gate * smooth(0, 0.7, t) * (1 - smooth(duration - 0.8, duration, t)) * 4.0


def impulse(seconds, damp, seed):
    local = np.random.default_rng(seed)
    t = axis(seconds)
    ir = local.standard_normal((2, t.size)) * np.exp(-6.9 * t / seconds)
    dull = lowpass(ir, damp)
    k = np.minimum(t / (seconds * 0.35), 1)
    ir = ir * (1 - k) + dull * k
    ir[:, : int(0.012 * SR)] = 0
    return ir / np.sqrt(np.sum(ir ** 2, axis=1, keepdims=True))


def reverb(bus, seconds, damp, wet, seed=3):
    ir = impulse(seconds, damp, seed)
    out = np.stack([signal.fftconvolve(bus[c], ir[c])[: bus.shape[1]] for c in range(2)])
    return bus + out * wet


def chord(bus, at, duration, notes, gain=-13.0, **shape):
    place(bus, pad(notes, duration, **shape), at, gain)


def motif(bus, at, gap=0.45, velocity=0.62, gain=-9.0):
    for index, note in enumerate(("A4", "D5", "E5", "F#5")):
        place(bus, piano(note, 6.0, velocity + index * 0.03), at + index * gap, gain, (index - 1.5) * 0.12)


def act_questions(music, sfx):
    """第一幕：很多人在问同一句话。低，不解决，气泡越冒越密。"""
    chord(music, 0.0, 14.0, ["D2", "A2", "D3"], -15, attack=4, release=2.5, bright=500, opening=axis(14.0) * 0)
    chord(music, 5.0, 9.0, ["F3", "A3", "C4"], -20, attack=3.5, release=2, bright=800)
    place(music, piano("A3", 7, 0.42), 0.8, -8)
    for at, note in ((3.2, "Bb3"), (5.0, "A3"), (6.6, "C4"), (8.2, "Bb3"), (9.6, "E3")):
        place(music, piano(note, 6, 0.38), at, -11, rng.uniform(-0.3, 0.3))
    place(sfx, pop(620), 0.72, -18)
    pops = [2.4, 3.1, 3.7, 4.4, 4.9, 5.5, 6.0, 6.4, 6.9, 7.3, 7.6, 8.0, 8.3, 8.6, 8.9, 9.1, 9.35, 9.55, 9.75, 9.95, 10.1, 10.25, 10.4, 10.55, 10.7, 10.8, 10.9, 11.0]
    for at in pops:
        place(sfx, pop(rng.uniform(420, 980)), at, -22 + (at / 11) * 4, rng.uniform(-0.8, 0.8))
    place(sfx, noise_band(14, lambda x: 340 + 0 * x, 1.6, lambda x: 0.09 + 0.05 * np.sin(x * 0.7)), 0, -14)
    place(sfx, riser(4.2, 180, 2600), 8.8, -14)


def act_reveal(music, sfx):
    """穿过云层，看见 Pupu。这里第一次亮起来。"""
    place(sfx, noise_band(5, lambda x: 500 + x * 500, 1.3, lambda x: smooth(0, 2.2, x) * (1 - smooth(3.4, 5, x)) * 0.8), 12.4, -8)
    place(sfx, boom(4, 72, 29), 15.9, -5)
    chord(music, 15.7, 6.2, ["D2", "A2", "D3", "A3", "E4", "F#4"], -9, attack=0.5, release=2.0, bright=2200)
    place(sfx, purr(5.0), 16.2, -15)
    for index, note in enumerate(("D5", "A5", "D6", "E6", "F#6")):
        place(music, bell(note), 16.0 + index * 0.16, -21 + index, (index - 2) * 0.2)


def act_relay(music, sfx):
    """上下文接力：样片就是这一段。"""
    s, lift, enter, out, land, end = R["start"], R["lift"], R["enter"], R["exit"], R["land"], R["end"]

    # 林夏：气泡，打字，四个音。
    chord(music, s - 1.0, lift - s + 2.2, ["D3", "A3", "D4", "F#4"], -15, attack=1.2, release=1.6, bright=1100)
    place(sfx, pop(700), s, -17, 0.15)
    text = 18
    for index in range(text):
        place(sfx, tick(2300 + (index % 3) * 180), s + 0.05 + index * 1.1 / text, -33, 0.15)
    motif(music, s + 0.42)

    # 起飞：体素一颗颗离开句子。
    chord(music, lift - 0.3, 3.6, ["D3", "G3", "B3", "D4", "G4"], -13, attack=1.0, release=1.3, bright=1500)
    chord(music, lift + 2.2, enter - lift - 1.9, ["B2", "F#3", "B3", "D4", "F#4", "A4"], -12, attack=0.8, release=0.5, bright=2400)
    for index, note in enumerate(("D5", "F#5", "A5", "B5", "D6", "E6", "F#6", "A6")):
        place(music, bell(note), lift + index * 0.17, -24 + index * 0.6, 0.5 - index * 0.11)
    glitter(music, lift, enter, lambda t: 10 + 70 * smooth(lift, enter - 0.5, t), -33)
    place(sfx, riser(enter - lift, 240, 5200), lift, -15)
    pan = np.linspace(0.8, -0.5, int(2.4 * SR))
    swing = whoosh(2.4, 260, 3400, 0.55)
    place(sfx, np.stack([swing[0] * (1 - pan) / 2 * 1.4, swing[1] * (1 + pan) / 2 * 1.4]), lift + 1.2, -8)
    place(sfx, purr(enter - lift - 1.6), lift + 1.7, -19)

    # 进入 Pupu：一记低音，声音闷下去。
    place(sfx, boom(3.2, 96, 30), enter, -3)
    place(music, bell("A5", 3.2, index=2.4), enter, -14)
    place(sfx, whoosh(1.1, 300, 6000, 0.8), enter - 0.86, -9)

    # 里面：时钟走快，时间从上午到下午。
    chord(music, enter + 0.05, out - enter + 0.25, ["A2", "E3", "A3", "B3", "E4"], -9, attack=0.4, release=0.3, bright=1500)
    t = enter + 0.28
    gap = 0.46
    index = 0
    while t < out - 0.18:
        place(sfx, clock(index % 2 == 0), t, -21, 0.0)
        progress = (t - enter) / (out - enter)
        gap = max(0.075, 0.46 * (1 - smooth(0.3, 0.72, progress) * 0.84))
        t += gap
        index += 1
    place(music, piano("E5", 4, 0.3), enter + 0.5, -14, -0.2)
    place(music, piano("D5", 4, 0.3), enter + 1.05, -14, 0.2)

    # 出来：光回到外面，往周屿那边落。
    place(sfx, whoosh(0.9, 400, 7000, 0.92), out - 0.8, -9)
    place(sfx, boom(2.6, 74, 36), out, -7)
    chord(music, out - 0.05, land - out + 0.4, ["F#2", "D3", "A3", "D4", "F#4", "A4"], -9, attack=0.2, release=0.5, bright=3000)
    place(sfx, purr(1.8), out + 0.1, -18)
    place(sfx, pop(640), out + 0.72, -19, -0.45)
    for index, note in enumerate(("A6", "F#6", "E6", "D6", "B5", "A5", "F#5", "E5")):
        place(music, bell(note), out + 0.35 + index * 0.215, -24, -0.1 - index * 0.07)
    glitter(music, out, land + 0.3, lambda t: 70 - 40 * smooth(out, land, t), -33)
    place(sfx, whoosh(1.7, 280, 2800, 0.42), out + 0.1, -10)

    # 落下：句子一颗颗拼回来，四个音也回来了。
    place(sfx, pop(860), land - 0.5, -15, -0.35)
    for index in range(46):
        place(sfx, tick(2800 + rng.uniform(-300, 900)), land - 0.3 + index * 0.0137 + rng.uniform(0, 0.006), -28, rng.uniform(-0.6, 0.1))
    chord(music, land + 0.25, end - land + 4.0, ["D2", "A2", "D3", "A3", "D4", "F#4", "A4"], -10, attack=0.5, release=2.6, bright=1900)
    motif(music, land + 0.3, 0.42, 0.66, -8)
    for index, note in enumerate(("A5", "D6", "E6", "F#6")):
        place(music, bell(note), land + 0.3 + index * 0.42, -21, -0.2)
    for index in range(7):
        place(sfx, tick(2300 + (index % 3) * 160), land + 0.56 + index * 0.1, -33, -0.25)


def act_flow(music, sfx):
    """所有气泡连起来，天亮。"""
    start, finish = 35.2, 44.0
    gap = 2.2
    for index, notes in enumerate((["D3", "A3", "D4", "F#4"], ["C#3", "A3", "E4", "A4"], ["B2", "F#3", "D4", "F#4"], ["G2", "D3", "B3", "G4"])):
        chord(music, start + index * gap - 0.1, gap + 0.7, notes, -12 + index, attack=0.4, release=0.6, bright=1800 + index * 500)
    arp = ["D5", "F#5", "A5", "D6", "A5", "F#5"]
    t = start
    step = 0.275
    index = 0
    while t < finish:
        place(music, bell(arp[index % len(arp)], 1.4, index=1.0), t, -24 + (t - start) * 0.5, np.sin(index) * 0.5)
        t += step
        index += 1
    glitter(music, start, finish, lambda x: 10 + 40 * smooth(start, finish, x), -36)
    place(sfx, riser(finish - start, 200, 6200), start, -17)


def act_end(music, sfx):
    """太阳出来，Context, Not Control.，收。"""
    at = 44.0
    place(sfx, boom(4, 70, 30), at, -7)
    chord(music, at - 0.05, 9.5, ["D2", "A2", "D3", "A3", "D4", "F#4", "A4", "E5"], -7, attack=0.5, release=4.0, bright=3000)
    motif(music, at + 2.0, 0.6, 0.6, -9)
    for index, note in enumerate(("D6", "A6", "D7")):
        place(music, bell(note, 4.0), at + index * 0.14, -19, (index - 1) * 0.3)
    place(music, bell("D6", 5.0, index=1.1), at + 6.4, -15)
    place(sfx, purr(3.2), at + 6.4, -21)
    place(sfx, noise_band(10, lambda x: 900 + 0 * x, 1.6, lambda x: 0.07 + 0 * x), at, -18)


def main():
    music = timeline()
    sfx = timeline()
    act_questions(music, sfx)
    act_reveal(music, sfx)
    act_relay(music, sfx)
    act_flow(music, sfx)
    act_end(music, sfx)

    # 在 Pupu 里面，所有声音都闷下去。
    t = np.arange(music.shape[1]) / SR
    inside = smooth(R["enter"] - 0.05, R["enter"] + 0.25, t) * (1 - smooth(R["exit"] - 0.2, R["exit"] + 0.08, t))
    both = music + sfx * 0
    muffled = lowpass(both, 620, 4)
    music = music * (1 - inside) + muffled * inside * 1.25

    music = reverb(music, 3.8, 3400, 0.5, 3)
    sfx = reverb(sfx, 1.4, 5200, 0.22, 5)
    mix = highpass(music + sfx, 26, 2)

    peak = np.max(np.abs(mix))
    mix = mix / peak
    mix = np.tanh(mix * 1.5) / np.tanh(1.5)
    mix *= 10 ** (-1.0 / 20) / np.max(np.abs(mix))
    fade = 1 - smooth(LENGTH - 1.4, LENGTH, t)
    mix = mix * fade

    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "../out/score.wav")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    wavfile.write(path, SR, mix.T.astype(np.float32))
    print(f"写好了 {os.path.relpath(path)}，{mix.shape[1] / SR:.1f} 秒，峰值 {20 * np.log10(np.max(np.abs(mix))):.1f} dBFS")


if __name__ == "__main__":
    main()
