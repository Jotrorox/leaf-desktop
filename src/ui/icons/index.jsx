// @ts-check
import { splitProps } from "solid-js";

/**
 * Inline SVG icons on a 20×20 grid, stroked in `currentColor` so they take
 * the surrounding text color. They're decorative (`aria-hidden`): the button
 * or link they sit in carries the accessible name.
 */

/**
 * @typedef {Omit<import("solid-js").JSX.SvgSVGAttributes<SVGSVGElement>, "children"> & { size?: number }} IconProps
 */

/** @param {IconProps & { children: import("solid-js").JSX.Element }} props */
function Svg(props) {
  const [local, rest] = splitProps(props, ["size", "children"]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      width={local.size ?? 18}
      height={local.size ?? 18}
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {local.children}
    </svg>
  );
}

/** @param {IconProps} props */
export function IconLeaf(props) {
  return (
    <Svg {...props}>
      <path d="M4 16c0-7 4-11.5 12-12 .5 8-4 12-12 12Z" />
      <path d="M4 16l6.5-6.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconHome(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 9 10 3.5 16.5 9" />
      <path d="M5 7.75v8.5h10v-8.5" />
      <path d="M8.5 16.25v-4.5h3v4.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconPage(props) {
  return (
    <Svg {...props}>
      <path d="M5 2.75h6.5l3.5 3.5v11H5Z" />
      <path d="M11.5 2.75v3.5H15" />
      <path d="M7.5 10.5h5M7.5 13.5h3.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconTrash(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 5.5h13" />
      <path d="M8 5.5V3.75h4V5.5" />
      <path d="m5 5.5.75 11h8.5L15 5.5" />
      <path d="M8.5 8.5v5M11.5 8.5v5" />
    </Svg>
  );
}

/** Sliders: used for Settings. @param {IconProps} props */
export function IconSettings(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 6.5h7M13.5 6.5h3M3.5 13.5h3M9.5 13.5h7" />
      <circle cx="12" cy="6.5" r="1.5" />
      <circle cx="8" cy="13.5" r="1.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconSidebar(props) {
  return (
    <Svg {...props}>
      <rect x="2.75" y="3.75" width="14.5" height="12.5" rx="2" />
      <path d="M7.75 3.75v12.5" />
    </Svg>
  );
}

/** Chevrons pointing left: "collapse". @param {IconProps} props */
export function IconCollapse(props) {
  return (
    <Svg {...props}>
      <path d="m9.5 5.5-4.5 4.5 4.5 4.5M15 5.5 10.5 10l4.5 4.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconMenu(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 6h13M3.5 10h13M3.5 14h13" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconMore(props) {
  return (
    <Svg {...props}>
      <path d="M5 10h.01M10 10h.01M15 10h.01" stroke-width="2.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconChevronRight(props) {
  return (
    <Svg {...props}>
      <path d="m8 5 5 5-5 5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconClose(props) {
  return (
    <Svg {...props}>
      <path d="m5.5 5.5 9 9M14.5 5.5l-9 9" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconPlus(props) {
  return (
    <Svg {...props}>
      <path d="M10 4.5v11M4.5 10h11" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconLink(props) {
  return (
    <Svg {...props}>
      <path d="m8.25 11.75 3.5-3.5" />
      <path d="m9.25 6.25 1.25-1.25a3 3 0 0 1 4.25 4.25L13.5 10.5" />
      <path d="m10.75 13.75-1.25 1.25a3 3 0 0 1-4.25-4.25L6.5 9.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconKeyboard(props) {
  return (
    <Svg {...props}>
      <rect x="2.5" y="5" width="15" height="10" rx="2" />
      <path d="M6 8.5h.01M8.67 8.5h.01M11.33 8.5h.01M14 8.5h.01M6.5 11.75h7" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconHelp(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M8 8a2 2 0 1 1 2.75 1.85c-.45.2-.75.6-.75 1.1v.55" />
      <path d="M10 13.75h.01" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconCheck(props) {
  return (
    <Svg {...props}>
      <path d="m4.5 10.5 3.5 3.5 7.5-8" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconSearch(props) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="9" r="5" />
      <path d="m13 13 3.5 3.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconSignOut(props) {
  return (
    <Svg {...props}>
      <path d="M8 16.25H5.25a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5H8" />
      <path d="M12.5 13.5 16 10l-3.5-3.5" />
      <path d="M16 10H8" />
    </Svg>
  );
}

/** Pencil: rename. @param {IconProps} props */
export function IconPencil(props) {
  return (
    <Svg {...props}>
      <path d="M12.5 4.5 15.5 7.5" />
      <path d="M4 16l.75-3.25 8.5-8.5a1.5 1.5 0 0 1 2.12 0l.88.88a1.5 1.5 0 0 1 0 2.12l-8.5 8.5Z" />
    </Svg>
  );
}

/** Pencil on a page: new page. @param {IconProps} props */
export function IconCompose(props) {
  return (
    <Svg {...props}>
      <path d="M9 3.75H5.25a1.5 1.5 0 0 0-1.5 1.5v9.5a1.5 1.5 0 0 0 1.5 1.5h9.5a1.5 1.5 0 0 0 1.5-1.5V11" />
      <path d="m8 12 .5-2.5 6-6a1.41 1.41 0 0 1 2 2l-6 6Z" />
    </Svg>
  );
}

/** Two overlapping pages: duplicate. @param {IconProps} props */
export function IconCopy(props) {
  return (
    <Svg {...props}>
      <rect x="7" y="7" width="9.25" height="9.25" rx="1.5" />
      <path d="M13 7V5.25a1.5 1.5 0 0 0-1.5-1.5H5.25a1.5 1.5 0 0 0-1.5 1.5v6.25A1.5 1.5 0 0 0 5.25 13H7" />
    </Svg>
  );
}

/** Arrow curving back: restore. @param {IconProps} props */
export function IconRestore(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 8.5h7.75a3.75 3.75 0 0 1 0 7.5H9" />
      <path d="M7.5 5.5 4.5 8.5l3 3" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconSmile(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.25" />
      <path d="M7.25 11.75a3.5 3.5 0 0 0 5.5 0" />
      <path d="M7.75 8h.01M12.25 8h.01" stroke-width="2" />
    </Svg>
  );
}

/** Picture: cover. @param {IconProps} props */
export function IconImage(props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.25" r="1.25" />
      <path d="m3.5 14.5 4-4 3 3 2-2 4 4" />
    </Svg>
  );
}

/** Flask: the mock API's dev menu. @param {IconProps} props */
export function IconFlask(props) {
  return (
    <Svg {...props}>
      <path d="M8 3.5h4M8.75 3.5v4.25L4.6 14.6a1.25 1.25 0 0 0 1.07 1.9h8.66a1.25 1.25 0 0 0 1.07-1.9L11.25 7.75V3.5" />
      <path d="M6.25 12h7.5" />
    </Svg>
  );
}

/** A table: databases. @param {IconProps} props */
export function IconTable(props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="14" height="12" rx="1.5" />
      <path d="M3 8h14M3 12h14M8 8v8" />
    </Svg>
  );
}

/** A board: three columns of cards. @param {IconProps} props */
export function IconBoard(props) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="4" height="12" rx="1" />
      <rect x="8" y="4" width="4" height="8" rx="1" />
      <rect x="13" y="4" width="4" height="10" rx="1" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconFilter(props) {
  return (
    <Svg {...props}>
      <path d="M3.5 5h13M6 10h8M8.5 15h3" />
    </Svg>
  );
}

/** Up and down arrows: sorting. @param {IconProps} props */
export function IconSort(props) {
  return (
    <Svg {...props}>
      <path d="M6.5 15.5v-11M4 7l2.5-2.5L9 7" />
      <path d="M13.5 4.5v11M11 13l2.5 2.5L16 13" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconArrowUp(props) {
  return (
    <Svg {...props}>
      <path d="M10 16V4M5.5 8.5 10 4l4.5 4.5" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconArrowDown(props) {
  return (
    <Svg {...props}>
      <path d="M10 4v12M5.5 11.5 10 16l4.5-4.5" />
    </Svg>
  );
}

/** Lines of text: the text property. @param {IconProps} props */
export function IconText(props) {
  return (
    <Svg {...props}>
      <path d="M4 5.5h12M4 10h12M4 14.5h7" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconHash(props) {
  return (
    <Svg {...props}>
      <path d="M8 3.5 6.5 16.5M13.5 3.5 12 16.5M4 7.5h12.5M3.5 12.5H16" />
    </Svg>
  );
}

/** A circle with a chevron: select. @param {IconProps} props */
export function IconSelect(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M7.5 9 10 11.5 12.5 9" />
    </Svg>
  );
}

/** Two stacked lists: multi-select. @param {IconProps} props */
export function IconList(props) {
  return (
    <Svg {...props}>
      <path d="M8 5.5h8.5M8 10h8.5M8 14.5h8.5" />
      <circle cx="4.25" cy="5.5" r=".75" fill="currentColor" />
      <circle cx="4.25" cy="10" r=".75" fill="currentColor" />
      <circle cx="4.25" cy="14.5" r=".75" fill="currentColor" />
    </Svg>
  );
}

/** A half-filled circle: status. @param {IconProps} props */
export function IconStatus(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="6.5" />
      <path d="M10 3.5a6.5 6.5 0 0 1 0 13Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconCalendar(props) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="4.5" width="13" height="12" rx="1.5" />
      <path d="M3.5 8.5h13M7 3v3M13 3v3" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconPerson(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="7" r="3" />
      <path d="M4 16.5c.5-3 3-4.5 6-4.5s5.5 1.5 6 4.5" />
    </Svg>
  );
}

/** A checked box: the checkbox property. @param {IconProps} props */
export function IconCheckbox(props) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="13" height="13" rx="2.5" />
      <path d="m7 10 2 2 4-4.5" />
    </Svg>
  );
}

/** An arrow out of a box: open the row as a page or in the side peek. @param {IconProps} props */
export function IconOpen(props) {
  return (
    <Svg {...props}>
      <path d="M11 4.5h4.5V9M15.5 4.5 9 11" />
      <path d="M13.5 12v3.5h-9v-9H8" />
    </Svg>
  );
}

/** A crossed-out eye: hide a column. @param {IconProps} props */
export function IconEyeOff(props) {
  return (
    <Svg {...props}>
      <path d="M3 10s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" />
      <circle cx="10" cy="10" r="2" />
      <path d="M4 16 16 4" />
    </Svg>
  );
}

/** An eye: show a column. @param {IconProps} props */
export function IconEye(props) {
  return (
    <Svg {...props}>
      <path d="M3 10s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5Z" />
      <circle cx="10" cy="10" r="2" />
    </Svg>
  );
}

/** Six dots: a drag handle. @param {IconProps} props */
export function IconGrip(props) {
  return (
    <Svg {...props} stroke="none" fill="currentColor">
      <circle cx="7.5" cy="5.5" r="1.25" />
      <circle cx="12.5" cy="5.5" r="1.25" />
      <circle cx="7.5" cy="10" r="1.25" />
      <circle cx="12.5" cy="10" r="1.25" />
      <circle cx="7.5" cy="14.5" r="1.25" />
      <circle cx="12.5" cy="14.5" r="1.25" />
    </Svg>
  );
}

/** @param {IconProps} props */
export function IconChevronLeft(props) {
  return (
    <Svg {...props}>
      <path d="m12 5-5 5 5 5" />
    </Svg>
  );
}

/** A lightning bolt: speed. @param {IconProps} props */
export function IconBolt(props) {
  return (
    <Svg {...props}>
      <path d="M11 2.5 4.5 11H10l-1 6.5L15.5 9H10l1-6.5Z" />
    </Svg>
  );
}

/** Wi-Fi with a slash: offline. @param {IconProps} props */
export function IconOffline(props) {
  return (
    <Svg {...props}>
      <path d="M3 3l14 14" />
      <path d="M2.5 7.5A11 11 0 0 1 6 5.4M9 4.6a11 11 0 0 1 8.5 2.9" />
      <path d="M5 10.3a7 7 0 0 1 3-1.6M12.3 9a7 7 0 0 1 2.7 1.3" />
      <path d="M7.6 13a3.5 3.5 0 0 1 4.8 0" />
      <circle cx="10" cy="15.75" r=".5" fill="currentColor" />
    </Svg>
  );
}

/** Two people: collaboration. @param {IconProps} props */
export function IconPeople(props) {
  return (
    <Svg {...props}>
      <circle cx="7.5" cy="7" r="2.75" />
      <path d="M2.5 16c.4-2.6 2.4-4 5-4s4.6 1.4 5 4" />
      <path d="M12.5 4.4a2.75 2.75 0 0 1 0 5.2M14.5 12.3c1.6.5 2.7 1.7 3 3.7" />
    </Svg>
  );
}

/** A shield with a check: privacy. @param {IconProps} props */
export function IconShield(props) {
  return (
    <Svg {...props}>
      <path d="M10 2.5 4 5v4.5c0 3.7 2.5 6.6 6 8 3.5-1.4 6-4.3 6-8V5l-6-2.5Z" />
      <path d="m7.5 10 1.75 1.75L12.75 8" />
    </Svg>
  );
}

/** A globe: language. @param {IconProps} props */
export function IconGlobe(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7" />
      <path d="M3 10h14" />
      <path d="M10 3c2 2 2.75 4.5 2.75 7S12 15 10 17c-2-2-2.75-4.5-2.75-7S8 5 10 3Z" />
    </Svg>
  );
}

/** A person with a plus: share, invite. @param {IconProps} props */
export function IconShare(props) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="7" r="3" />
      <path d="M2.5 16.5c.5-3 2.6-4.5 5.5-4.5 1.3 0 2.4.3 3.3.9" />
      <path d="M15 11v6M12 14h6" />
    </Svg>
  );
}

/** An upload arrow into a tray. @param {IconProps} props */
export function IconUpload(props) {
  return (
    <Svg {...props}>
      <path d="M10 13V3.5M6.5 7 10 3.5 13.5 7" />
      <path d="M3.5 12.5v3a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-3" />
    </Svg>
  );
}

/** A lock: private. @param {IconProps} props */
export function IconLock(props) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="9" width="11" height="8" rx="1.5" />
      <path d="M7 9V6.5a3 3 0 0 1 6 0V9" />
    </Svg>
  );
}

/** An "i" in a circle: information. @param {IconProps} props */
export function IconInfo(props) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9v4.5" />
      <path d="M10 6.25v.01" stroke-width="2" />
    </Svg>
  );
}

/** A flag: reporting something. @param {IconProps} props */
export function IconFlag(props) {
  return (
    <Svg {...props}>
      <path d="M4.5 17.5v-14" />
      <path d="M4.5 3.5h10l-2 3.5 2 3.5h-10" />
    </Svg>
  );
}

/** A square root over x: math and equations. @param {IconProps} props */
export function IconMath(props) {
  return (
    <Svg {...props}>
      <path d="M2.5 11.5h2l2.5 5 3.5-13h7" />
      <path d="m12.5 8.5 3.5 4.5M16 8.5l-3.5 4.5" />
    </Svg>
  );
}
