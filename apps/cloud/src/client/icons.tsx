import type { SVGProps } from "react";

/** 界面用到的几个线性图标，24 格、描边跟随文字颜色。 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function MenuIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 7h16M4 12h11M4 17h7" />
    </Icon>
  );
}

export function FolderIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </Icon>
  );
}

export function ArrowUpIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props} strokeWidth={2.2}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Icon>
  );
}

export function StopIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" {...props}>
      <rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" />
    </svg>
  );
}

export function CopyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2.5" />
      <path d="M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </Icon>
  );
}

export function ReplyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M10 6 4.5 11.5 10 17" />
      <path d="M4.5 11.5H14a5.5 5.5 0 0 1 5.5 5.5v1" />
    </Icon>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Icon>
  );
}

export function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M12 5v14M5 12h14" />
    </Icon>
  );
}

export function PhoneIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="6.5" y="2.5" width="11" height="19" rx="2.5" />
      <path d="M10.5 18.5h3" />
    </Icon>
  );
}

export function ChevronDownIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props} strokeWidth={2.2}>
      <path d="m6 9 6 6 6-6" />
    </Icon>
  );
}

export function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props} strokeWidth={2}>
      <path d="m9 6 6 6-6 6" />
    </Icon>
  );
}

export function ChatIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M20 11.5a7.5 7.5 0 0 1-11 6.6L4 19.5l1.4-4.4A7.5 7.5 0 1 1 20 11.5z" />
    </Icon>
  );
}

/** 正在做：一条起伏的线。 */
export function LockIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </Icon>
  );
}

export function TerminalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="m5 7 5 5-5 5M12 18h7" />
    </Icon>
  );
}

export function FileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M13.5 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13.5 3.5V9H19M9 13h6M9 16.5h4" />
    </Icon>
  );
}

export function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M15.5 5.5 18.5 8.5 9 18l-4 1 1-4z" />
    </Icon>
  );
}

export function ScreenshotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

export function CursorIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 4.5 11 19l2-6.5L19.5 10.5z" />
      <path d="m13 12.5 5 5" />
    </Icon>
  );
}

export function KeyboardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8" />
    </Icon>
  );
}

/** 好几步合成一组。 */
export function StepsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" />
    </Icon>
  );
}

export function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props} strokeWidth={2.4}>
      <path d="M5 12.5 10 17.5 19 7" />
    </Icon>
  );
}
