/* Flood iconography, exported from the Glimpse Figma library.
   SVGs are inlined (vite `?raw`) with fills swapped to currentColor so every
   glyph follows the text colour of its surroundings in both themes. */
import undo from './icons/undo.svg?raw';
import redo from './icons/redo.svg?raw';
import plus from './icons/plus.svg?raw';
import open from './icons/open.svg?raw';
import save from './icons/save.svg?raw';
import saveAs from './icons/save-as.svg?raw';
import skipStart from './icons/skip-start.svg?raw';
import prevFrame from './icons/prev-frame.svg?raw';
import play from './icons/play.svg?raw';
import nextFrame from './icons/next-frame.svg?raw';
import skipEnd from './icons/skip-end.svg?raw';
import loop from './icons/loop.svg?raw';
import addZoom from './icons/add-zoom.svg?raw';
import cancel from './icons/cancel.svg?raw';
import cancelCircle from './icons/cancel-circle.svg?raw';
import chevronDown from './icons/chevron-down.svg?raw';
import check from './icons/check.svg?raw';
import trash from './icons/trash.svg?raw';
import audio from './icons/audio.svg?raw';
import logoA from './icons/logo-a.svg?raw';
import logoB from './icons/logo-b.svg?raw';

const GLYPHS = {
  undo,
  redo,
  plus,
  open,
  save,
  'save-as': saveAs,
  'skip-start': skipStart,
  'prev-frame': prevFrame,
  play,
  'next-frame': nextFrame,
  'skip-end': skipEnd,
  loop,
  'add-zoom': addZoom,
  cancel,
  'cancel-circle': cancelCircle,
  'chevron-down': chevronDown,
  check,
  trash,
  audio,
} as const;

export type IconName = keyof typeof GLYPHS;

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className ? `icon ${className}` : 'icon'}
      style={{ width: size, height: size }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: GLYPHS[name] }}
    />
  );
}

/** Placeholder app mark (two stacked layers from the design file). Swapped for
 * the real logo when it lands. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <span className="icon logo-mark" style={{ width: size, height: size }} aria-hidden="true">
      <span dangerouslySetInnerHTML={{ __html: logoA }} />
      <span dangerouslySetInnerHTML={{ __html: logoB }} />
    </span>
  );
}
