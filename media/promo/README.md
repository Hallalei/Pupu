# Pupu 宣传片

片子是代码渲染出来的，改文案或镜头后重新跑一遍就行。成片和中间文件都在 `out/`，不进 git。

## 怎么出片

本机要有 Google Chrome、ffmpeg、Node 22.13 以上、Python 3（numpy、scipy）。不用装别的依赖。

```bash
python3 media/promo/audio/score.py
```

```bash
node media/promo/render.mjs video --size 1920x1080 --samples 32 --out film.mp4 --audio score.wav
```

看几帧，不出视频：

```bash
node media/promo/render.mjs stills --at 1.4,19,34.4 --size 960x540 --samples 12 --dir look
```

无头 Chrome 不开窗口，不抢前台。M3 上 1080p、32 子帧约 1 到 2.5 秒一帧。

## 改什么动哪里

- 文案：`film/copy.ts`
- 时间点，画面和声音共用：`film/beats.json`
- 镜头：`film/world.ts` 里的 `PRO`、`KEYS`、`OUT`、`FIN`
- 音乐和音效：`audio/score.py`

## 素材来源

- Pupu、月亮：产品的 `apps/cloud/src/client/pupu-voxels.ts`，直接引用，没有复制。
- 字体：`fonts/` 里的 Fusion Pixel 12px，SIL OFL 1.1，见 `fonts/OFL.txt`。
- 音乐和音效：`audio/score.py` 现场合成，没有采样素材。

## 分镜

见 `分镜.md`。
