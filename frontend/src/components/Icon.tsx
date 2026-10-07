import type { CSSProperties } from "react";
import { cx } from "../lib/format";

export type IconName =
  | "check"
  | "x"
  | "clock"
  | "lock"
  | "unlock"
  | "alert"
  | "info"
  | "hourglass"
  | "external"
  | "copy"
  | "shield"
  | "plane"
  | "rain"
  | "layers"
  | "bolt"
  | "chevronDown"
  | "chevronRight"
  | "play"
  | "stop"
  | "refresh"
  | "wallet"
  | "scale"
  | "server"
  | "flag"
  | "vault"
  | "list"
  | "book"
  | "grid"
  | "forward"
  | "cube"
  | "plus"
  | "minus"
  | "arrowDown"
  | "arrowUp"
  | "target"
  | "beaker"
  | "presenter"
  | "user"
  | "key"
  | "gavel"
  | "sliders"
  | "eye"
  | "dot"
  | "spinner";

const PATHS: Record<IconName, string[]> = {
  check: ["M3 8.5l3 3 7-7"],
  x: ["M4 4l8 8M12 4l-8 8"],
  clock: ["M8 2a6 6 0 100 12A6 6 0 008 2z", "M8 5v3.5l2.2 1.4"],
  lock: ["M3.5 7h9v6.5h-9z", "M5.5 7V5a2.5 2.5 0 015 0v2"],
  unlock: ["M3.5 7h9v6.5h-9z", "M5.5 7V5a2.5 2.5 0 014.8-1"],
  alert: ["M8 2.2l6.2 11.3H1.8z", "M8 6.8v3.2M8 11.8v.4"],
  info: ["M8 2a6 6 0 100 12A6 6 0 008 2z", "M8 7.2v4M8 5v.4"],
  hourglass: ["M4.5 2h7M4.5 14h7", "M5.5 2v2.5L8 8l2.5-3.5V2M5.5 14v-2.5L8 8l2.5 3.5V14"],
  external: ["M9 3h4v4M13 3L7.5 8.5", "M11.5 9.5V13h-8.5V4.5h3.5"],
  copy: ["M5.5 5.5h7.5v7.5H5.5z", "M10.5 5.5V3H3v7.5h2.5"],
  shield: ["M8 1.8l5 2v4c0 3.2-2.2 5.4-5 6.4-2.8-1-5-3.2-5-6.4v-4z", "M5.8 8.1l1.6 1.6 3-3"],
  plane: [
    "M14 6.8c0-.7-.6-1.1-1.3-1.1H9.8L7 1.5H5.6l1.3 4.2H3.8L2.6 4.2H1.5l.8 3.6-.8 3.6h1.1l1.2-1.5h3.1L5.6 14.1H7l2.8-4.2h2.9c.7 0 1.3-.5 1.3-1.1z",
  ],
  rain: [
    "M4.5 10a3 3 0 01.4-6 4 4 0 017.3 1.3A2.4 2.4 0 0111.8 10z",
    "M5.5 12l-.7 2M8.5 12l-.7 2M11.5 12l-.7 2",
  ],
  layers: ["M8 2l6 3-6 3-6-3z", "M2 8l6 3 6-3", "M2 11l6 3 6-3"],
  bolt: ["M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z"],
  chevronDown: ["M4 6l4 4 4-4"],
  chevronRight: ["M6 4l4 4-4 4"],
  play: ["M5 3.5v9l7.5-4.5z"],
  stop: ["M4.5 4.5h7v7h-7z"],
  refresh: ["M13 8a5 5 0 11-1.5-3.6", "M13 2.5v2.8h-2.8"],
  wallet: [
    "M2 4.5h11a1 1 0 011 1v7a1 1 0 01-1 1H3a1 1 0 01-1-1z",
    "M2 4.5l8.5-2.5v2.5",
    "M11 9h.5",
  ],
  scale: [
    "M8 2v12M4.5 14h7M3 4.5h10",
    "M3 4.5L1.5 8.5a1.6 1.6 0 003 0zM13 4.5l-1.5 4a1.6 1.6 0 003 0z",
  ],
  server: ["M2.5 2.5h11v4.5h-11zM2.5 9h11v4.5h-11z", "M5 4.8h.5M5 11.2h.5"],
  flag: ["M3.5 14.5V2", "M3.5 2.5h8.5l-1.8 3 1.8 3H3.5"],
  vault: ["M2 3h12v10H2z", "M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5z", "M4 13v1.5M12 13v1.5"],
  list: ["M5.5 4h8M5.5 8h8M5.5 12h8", "M2.5 4h.6M2.5 8h.6M2.5 12h.6"],
  book: ["M3 2.5h6.5a2 2 0 012 2V14H5a2 2 0 01-2-2z", "M11.5 4.5H13V14h-1.5"],
  grid: ["M2.5 2.5h4.5v4.5H2.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5H2.5zM9 9h4.5v4.5H9z"],
  forward: ["M2.5 4v8l5-4zM8 4v8l5-4z"],
  cube: ["M8 1.8l5.5 3v6.4L8 14.2l-5.5-3V4.8z", "M2.5 4.8L8 7.8l5.5-3M8 7.8v6.4"],
  plus: ["M8 3v10M3 8h10"],
  minus: ["M3 8h10"],
  arrowDown: ["M8 2.5v8.5M4.5 7.5L8 11l3.5-3.5", "M3 13.8h10"],
  arrowUp: ["M8 13.5V5M4.5 8.5L8 5l3.5 3.5", "M3 2.2h10"],
  target: ["M8 2a6 6 0 100 12A6 6 0 008 2z", "M8 0.8v3M8 12.2v3M0.8 8h3M12.2 8h3"],
  beaker: ["M6 2h4M6.5 2v4L2.8 12.6c-.4.8.1 1.4 1 1.4h8.4c.9 0 1.4-.6 1-1.4L9.5 6V2", "M4.5 10h7"],
  presenter: ["M2 2.5h12v8H2z", "M8 10.5V14M5.5 14h5", "M6.5 5v3l2.5-1.5z"],
  user: [
    "M8 2.5a2.8 2.8 0 100 5.6 2.8 2.8 0 000-5.6z",
    "M2.8 14c.6-2.8 2.7-4.2 5.2-4.2s4.6 1.4 5.2 4.2",
  ],
  key: ["M5.5 6.5a3 3 0 106 0 3 3 0 00-6 0z", "M6.3 8.7L2 13v1.5h2V13h1.5v-1.5H7l.7-.7"],
  gavel: ["M7 2.5l4.5 4.5M5 4.5l4.5 4.5M6 3.5l3.5 3.5", "M7.8 7.2L2.5 12.5l1 1 5.3-5.3", "M9 14h5"],
  sliders: ["M3 4h5M11 4h2M3 8h1.5M7.5 8H13M3 12h7M13 12h0", "M8 2.5v3M4.5 6.5v3M10 10.5v3"],
  dot: ["M8 6.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"],
  eye: [
    "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z",
    "M8 6a2 2 0 100 4 2 2 0 000-4z",
  ],
  spinner: ["M8 2a6 6 0 016 6"],
};

export interface IconProps {
  name: IconName;
  size?: number;
  spin?: boolean;
  /** Makes the icon meaningful to assistive tech; otherwise it is decorative. */
  title?: string;
  strokeWidth?: number;
  className?: string;
  style?: CSSProperties;
}

/** 16 px stroke icon set (currentColor). */
export function Icon({
  name,
  size = 16,
  spin,
  title,
  strokeWidth = 1.5,
  className,
  style,
}: IconProps) {
  const d = PATHS[name] ?? PATHS.dot;
  return (
    <svg
      className={cx("ties-icon", spin && "ties-spin", className)}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
      style={style}
    >
      {title ? <title>{title}</title> : null}
      {d.map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

export function Spinner({ size }: { size?: number }) {
  return <Icon name="spinner" spin size={size} strokeWidth={2} />;
}
