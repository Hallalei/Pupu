import { useEffect, useState } from "react";

/** 宽屏：侧栏常驻、子会话卡开在右边。和规范一样从 1024 起，768 到 1023 还是手机布局。 */
const WIDE = "(min-width: 1024px)";

export function useWide(): boolean {
  const [wide, setWide] = useState(() => matchMedia(WIDE).matches);
  useEffect(() => {
    const query = matchMedia(WIDE);
    const onChange = () => setWide(query.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return wide;
}
