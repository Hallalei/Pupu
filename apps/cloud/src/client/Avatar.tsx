import { Button } from "@heroui/react";
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { AVATAR_PRESETS, PUPU_AVATAR_PRESETS } from "../avatar-presets";
import type { MemberView } from "../members";
import { api } from "./api";

/** 云端收的边长，见 avatars.ts 的 `AVATAR_SIDE`。 */
const SIDE = 256;
/** 裁剪框在页面上的边长。 */
const FRAME = 240;
const MAX_ZOOM = 4;

/**
 * 成员的头像：换过的显示图，没换过的显示名字的第一个字。
 * `className` 管大小和首字的底色，图和首字共用，换没换过占的地方一样大。
 */
export function MemberAvatar({ name, src, className }: { name: string; src: string | null; className: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setBroken(true)}
        className={`${className} shrink-0 rounded-full object-cover ${isPixelArt(src) ? "[image-rendering:pixelated]" : ""}`}
      />
    );
  }
  return (
    <span aria-hidden="true" className={`${className} grid shrink-0 place-items-center rounded-full uppercase`}>
      {Array.from(name)[0] ?? "我"}
    </span>
  );
}

/** Pupu 没换过头像时用的图。 */
export const PUPU_AVATAR = "/pupu-avatar.png";

/** 预设和 Pupu 自带的是像素画，放大缩小都按格子来；上传的照片照常平滑。 */
function isPixelArt(src: string): boolean {
  return src.startsWith("/avatars/") || src === PUPU_AVATAR;
}

/** 设置里的「头像」页：自己的。 */
export function MyAvatarPage({ me }: { me: MemberView }) {
  return (
    <AvatarPage
      name={me.name}
      current={me.avatar}
      presets={AVATAR_PRESETS}
      resetLabel="用名字的第一个字"
      onPreset={api.setAvatar}
      onUpload={api.uploadAvatar}
    />
  );
}

/** 设置里的「Pupu 的头像」页，创建者才有。没换过用自带的。 */
export function PupuAvatarPage({ current }: { current: string | null }) {
  return (
    <AvatarPage
      name="Pupu"
      current={current}
      fallback={PUPU_AVATAR}
      presets={PUPU_AVATAR_PRESETS}
      resetLabel="用原来的"
      onPreset={api.setPupuAvatar}
      onUpload={api.uploadPupuAvatar}
    />
  );
}

/** 挑一个预设，或者上传一张裁成方形。 */
function AvatarPage({
  name,
  current,
  fallback = null,
  presets,
  resetLabel,
  onPreset,
  onUpload
}: {
  name: string;
  /** 换过的头像地址，没换过是 null。 */
  current: string | null;
  /** 没换过时显示的图；没有就显示名字的第一个字。 */
  fallback?: string | null;
  /** 成员是像素小人，Pupu 是像素猫。 */
  presets: readonly { readonly id: string; readonly name: string }[];
  resetLabel: string;
  onPreset: (preset: string | null) => Promise<unknown>;
  onUpload: (image: Blob) => Promise<unknown>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  async function run(key: string, action: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (file) {
    return (
      <Cropper
        file={file}
        error={error}
        busy={busy === "upload"}
        onCancel={() => {
          setFile(null);
          setError(null);
        }}
        onDone={async (image) => {
          if (await run("upload", () => onUpload(image))) setFile(null);
        }}
        onBroken={() => {
          setFile(null);
          setError("这张图打不开，换一张 PNG 或 JPEG");
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-center pt-2">
        <MemberAvatar name={name} src={current ?? fallback} className="size-24 bg-foreground text-[40px] text-background" />
      </div>
      <div className="grid grid-cols-4 gap-3 rounded-row bg-surface p-4" role="radiogroup" aria-label="预设头像">
        {presets.map((preset) => {
          const url = `/avatars/${preset.id}.png`;
          const selected = current === url;
          return (
            <button
              key={preset.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={preset.name}
              disabled={busy !== null}
              onClick={() => void run(preset.id, () => onPreset(preset.id))}
              className={`aspect-square overflow-hidden rounded-full ring-offset-2 ring-offset-surface transition hover:opacity-85 ${
                selected ? "ring-2 ring-foreground" : ""
              } ${busy === preset.id ? "animate-pulse" : ""}`}
            >
              <img src={url} alt="" draggable={false} className="size-full [image-rendering:pixelated]" />
            </button>
          );
        })}
      </div>
      <div className="flex flex-col divide-y divide-separator overflow-hidden rounded-row bg-surface">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => input.current?.click()}
          className="flex min-h-control items-center px-4 py-2.5 text-left text-body hover:bg-foreground/4"
        >
          上传照片
        </button>
        {current && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("reset", () => onPreset(null))}
            className="flex min-h-control items-center px-4 py-2.5 text-left text-body hover:bg-foreground/4"
          >
            {resetLabel}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/heic,image/*"
        className="hidden"
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (chosen) {
            setError(null);
            setFile(chosen);
          }
        }}
      />
      {error && <p className="m-0 px-4 text-subheadline text-danger-ink">{error}</p>}
    </div>
  );
}

type View = { readonly zoom: number; readonly x: number; readonly y: number };

/**
 * 把图裁成正方形：图铺满裁剪框，拖动挪位置，滑块或滚轮放大。框外露不出空白。
 * 思路和 react-easy-crop 一样（最小缩放是铺满、位置夹在框里），只要正方形这一种，就自己写了几十行。
 */
function Cropper({
  file,
  error,
  busy,
  onCancel,
  onDone,
  onBroken
}: {
  file: File;
  error: string | null;
  busy: boolean;
  onCancel: () => void;
  onDone: (image: Blob) => Promise<void>;
  onBroken: () => void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 });
  const drag = useRef<{ id: number; x: number; y: number; from: View } | null>(null);
  const broken = useRef(onBroken);
  broken.current = onBroken;

  useEffect(() => {
    const url = URL.createObjectURL(file);
    const next = new Image();
    next.onload = () => {
      setImage(next);
      setView(clamp(next, { zoom: 1, x: -Infinity, y: -Infinity }, true));
    };
    next.onerror = () => broken.current();
    next.src = url;
    return () => {
      // 先摘掉回调再收回地址，不然收回地址会让还没读完的这张报错。
      next.onload = null;
      next.onerror = null;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  const scale = image ? cover(image) * view.zoom : 1;

  function zoomTo(zoom: number) {
    if (!image) return;
    setView((current) => {
      // 以框的中心为准放大缩小。
      const ratio = zoom / current.zoom;
      const x = FRAME / 2 - (FRAME / 2 - current.x) * ratio;
      const y = FRAME / 2 - (FRAME / 2 - current.y) * ratio;
      return clamp(image, { zoom, x, y });
    });
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, from: view };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = drag.current;
    if (!image || !start || start.id !== event.pointerId) return;
    setView(clamp(image, { ...start.from, x: start.from.x + event.clientX - start.x, y: start.from.y + event.clientY - start.y }));
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <div
        aria-label="拖动调整位置"
        className="relative touch-none overflow-hidden rounded-row bg-black select-none"
        style={{ width: FRAME, height: FRAME, cursor: "grab" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onWheel={(event) => zoomTo(Math.min(MAX_ZOOM, Math.max(1, view.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08))))}
      >
        {image && (
          <img
            src={image.src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute top-0 left-0 max-w-none origin-top-left"
            style={{ width: image.naturalWidth * scale, height: image.naturalHeight * scale, transform: `translate(${view.x}px, ${view.y}px)` }}
          />
        )}
        {/* 圆以外压暗：头像各端都裁成圆。 */}
        <div className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_200px_rgba(0,0,0,0.45)]" />
      </div>
      <input
        type="range"
        aria-label="缩放"
        min={1}
        max={MAX_ZOOM}
        step={0.01}
        value={view.zoom}
        onChange={(event) => zoomTo(Number(event.target.value))}
        className="w-[240px] accent-foreground"
      />
      {error && <p className="m-0 text-subheadline text-danger-ink">{error}</p>}
      <div className="flex w-full gap-3">
        <Button variant="secondary" className="flex-1" isDisabled={busy} onPress={onCancel}>
          取消
        </Button>
        <Button
          className="flex-1"
          isDisabled={!image || busy}
          onPress={async () => {
            if (image) await onDone(await cropToSquare(image, view));
          }}
        >
          {busy ? "上传中…" : "用这张"}
        </Button>
      </div>
    </div>
  );
}

/** 铺满裁剪框的最小缩放。 */
function cover(image: HTMLImageElement): number {
  return FRAME / Math.min(image.naturalWidth, image.naturalHeight);
}

/** 位置夹在框里，框里不露空白。`center` 是第一次打开时居中。 */
function clamp(image: HTMLImageElement, view: View, center = false): View {
  const zoom = Math.min(MAX_ZOOM, Math.max(1, view.zoom));
  const scale = cover(image) * zoom;
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  if (center) return { zoom, x: (FRAME - width) / 2, y: (FRAME - height) / 2 };
  return {
    zoom,
    x: Math.min(0, Math.max(FRAME - width, view.x)),
    y: Math.min(0, Math.max(FRAME - height, view.y))
  };
}

/** 框里那块画成 256×256。先试 WebP，浏览器编不了 WebP（老 Safari）就用 JPEG。 */
export async function cropToSquare(image: HTMLImageElement, view: View): Promise<Blob> {
  const scale = cover(image) * view.zoom;
  const canvas = document.createElement("canvas");
  canvas.width = SIDE;
  canvas.height = SIDE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("这个浏览器画不了图");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, -view.x / scale, -view.y / scale, FRAME / scale, FRAME / scale, 0, 0, SIDE, SIDE);
  const encode = (type: string) =>
    new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.86));
  const webp = await encode("image/webp");
  if (webp?.type === "image/webp") return webp;
  const jpeg = await encode("image/jpeg");
  if (!jpeg) throw new Error("没裁出来，换一张试试");
  return jpeg;
}
