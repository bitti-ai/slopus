/* The app's icons: Fluent System Icons (MIT), from the headless build of
   @fluentui/react-icons — plain SVG with fill: currentColor and no CSS-in-JS
   runtime. This is the one place that says which Fluent glyph stands for
   which app idea, so swapping a glyph app-wide is a one-line change here.

   Naming: <Idea><px> is the Regular glyph drawn at px; <Idea><px>Filled is
   the Filled one, used for the on / pressed / selected state of a toggle.
   Fluent draws most glyphs on a 12, 16, 20, 24, 28, 32 or 48 grid and each is
   exported at its own design size; a size between those (10, 14, 18, 22…)
   scales the next larger design with a .ui-icon--<px> class (ui.css), and a
   stylesheet rule that sizes an icon (EmptyState's 32px, a chip's 16px) still
   wins, as it did over lucide's width/height attributes. */
import type { FluentIcon, FluentIconsProps } from "@fluentui/react-icons/headless";

export { Add16Regular as Add16, Add20Regular as Add20 } from "@fluentui/react-icons/headless/svg/add";
export { ArrowCounterclockwise12Regular as Reset12, ArrowCounterclockwise16Regular as Reset16, ArrowCounterclockwise32Regular as Reset32 } from "@fluentui/react-icons/headless/svg/arrow-counterclockwise";
export { ArrowDown12Regular as ArrowDown12, ArrowDown16Regular as ArrowDown16 } from "@fluentui/react-icons/headless/svg/arrow-down";
export { ArrowDownload16Regular as Download16, ArrowDownload16Filled as Download16Filled, ArrowDownload20Regular as Download20, ArrowDownload32Regular as Download32 } from "@fluentui/react-icons/headless/svg/arrow-download";
export { ArrowLeft16Regular as Back16 } from "@fluentui/react-icons/headless/svg/arrow-left";
export { ArrowRedo16Regular as Redo16 } from "@fluentui/react-icons/headless/svg/arrow-redo";
export { ArrowSync16Regular as Refresh16, ArrowSync16Filled as Refresh16Filled, ArrowSync20Regular as Refresh20 } from "@fluentui/react-icons/headless/svg/arrow-sync";
export { ArrowUndo16Regular as Undo16 } from "@fluentui/react-icons/headless/svg/arrow-undo";
export { ArrowUp12Regular as ArrowUp12, ArrowUp16Regular as ArrowUp16 } from "@fluentui/react-icons/headless/svg/arrow-up";
export { ArrowUpload16Regular as Import16 } from "@fluentui/react-icons/headless/svg/arrow-upload";
export { BookOpen16Regular as References16, BookOpen16Filled as References16Filled } from "@fluentui/react-icons/headless/svg/book-open";
export { Bot16Regular as Agent16, Bot16Filled as Agent16Filled, Bot20Regular as Agent20, Bot32Regular as Agent32 } from "@fluentui/react-icons/headless/svg/bot";
export { Broom16Regular as Clear16 } from "@fluentui/react-icons/headless/svg/broom";
export { Checkmark16Regular as Check16, Checkmark20Regular as Check20 } from "@fluentui/react-icons/headless/svg/checkmark";
export { CheckmarkCircle32Regular as Success32 } from "@fluentui/react-icons/headless/svg/checkmark-circle";
export { ChevronDown12Regular as ChevronDown12, ChevronDown16Regular as ChevronDown16 } from "@fluentui/react-icons/headless/svg/chevron-down";
export { ChevronLeft16Regular as ChevronLeft16 } from "@fluentui/react-icons/headless/svg/chevron-left";
export { ChevronRight12Regular as ChevronRight12, ChevronRight16Regular as ChevronRight16, ChevronRight20Regular as ChevronRight20 } from "@fluentui/react-icons/headless/svg/chevron-right";
export { ClipboardPaste16Regular as Paste16 } from "@fluentui/react-icons/headless/svg/clipboard-paste";
export { Clock16Regular as Clock16 } from "@fluentui/react-icons/headless/svg/clock";
export { Color16Regular as Palette16, Color16Filled as Palette16Filled, Color20Regular as Palette20 } from "@fluentui/react-icons/headless/svg/color";
export { Copy16Regular as Copy16 } from "@fluentui/react-icons/headless/svg/copy";
export { Cube16Regular as Cube16, Cube16Filled } from "@fluentui/react-icons/headless/svg/cube";
export { Cursor16Regular as Cursor16, Cursor16Filled } from "@fluentui/react-icons/headless/svg/cursor";
export { Cut16Regular as Cut16 } from "@fluentui/react-icons/headless/svg/cut";
export { Delete16Regular as Delete16 } from "@fluentui/react-icons/headless/svg/delete";
export { Desktop20Regular as Desktop20 } from "@fluentui/react-icons/headless/svg/desktop";
export { DeveloperBoard20Regular as Gpu20 } from "@fluentui/react-icons/headless/svg/developer-board";
export { Dismiss12Regular as Dismiss12, Dismiss16Regular as Dismiss16 } from "@fluentui/react-icons/headless/svg/dismiss";
export { DocumentCube20Regular as ModelFile20 } from "@fluentui/react-icons/headless/svg/document-cube";
export { DocumentText16Regular as TextFile16, DocumentText20Regular as TextFile20, DocumentText24Regular as TextFile24 } from "@fluentui/react-icons/headless/svg/document-text";
export { Edit16Regular as Edit16 } from "@fluentui/react-icons/headless/svg/edit";
export { ErrorCircle16Regular as Error16, ErrorCircle20Regular as Error20 } from "@fluentui/react-icons/headless/svg/error-circle";
export { Eyedropper16Regular as Eyedropper16 } from "@fluentui/react-icons/headless/svg/eyedropper";
export { Filmstrip16Regular as Film16, Filmstrip16Filled as Film16Filled, Filmstrip20Regular as Film20, Filmstrip32Regular as Film32 } from "@fluentui/react-icons/headless/svg/filmstrip";
export { Flash20Regular as Flash20 } from "@fluentui/react-icons/headless/svg/flash";
export { Folder20Regular as Folder20 } from "@fluentui/react-icons/headless/svg/folder";
export { FolderAdd16Regular as FolderAdd16 } from "@fluentui/react-icons/headless/svg/folder-add";
export { FolderArrowRight16Regular as MoveTo16 } from "@fluentui/react-icons/headless/svg/folder-arrow-right";
export { FolderOpen16Regular as FolderOpen16 } from "@fluentui/react-icons/headless/svg/folder-open";
export { FullScreenMaximize16Regular as FullScreen16 } from "@fluentui/react-icons/headless/svg/full-screen-maximize";
export { FullScreenMinimize16Regular as ExitFullScreen16 } from "@fluentui/react-icons/headless/svg/full-screen-minimize";
export { Gauge20Regular as Gauge20 } from "@fluentui/react-icons/headless/svg/gauge";
export { Grid16Regular as GridView16, Grid16Filled as GridView16Filled } from "@fluentui/react-icons/headless/svg/grid";
export { Image16Regular as Image16, Image16Filled, Image20Regular as Image20, Image24Regular as Image24, Image32Regular as Image32 } from "@fluentui/react-icons/headless/svg/image";
export { ImageMultiple32Regular as Images32 } from "@fluentui/react-icons/headless/svg/image-multiple";
export { Layer20Regular as Lora20 } from "@fluentui/react-icons/headless/svg/layer";
export { List16Regular as ListView16, List16Filled as ListView16Filled } from "@fluentui/react-icons/headless/svg/list";
export { MoreHorizontal16Regular as More16 } from "@fluentui/react-icons/headless/svg/more-horizontal";
export { MusicNote216Regular as Audio16 } from "@fluentui/react-icons/headless/svg/music-note";
export { Next16Regular as GoToEnd16 } from "@fluentui/react-icons/headless/svg/next";
export { Open16Regular as OpenExternal16 } from "@fluentui/react-icons/headless/svg/open";
export { Options20Regular as Options20 } from "@fluentui/react-icons/headless/svg/options";
export { PanelLeft16Regular as PanelLeft16, PanelLeft16Filled } from "@fluentui/react-icons/headless/svg/panel-left";
export { PanelRight16Regular as PanelRight16, PanelRight16Filled } from "@fluentui/react-icons/headless/svg/panel-right";
export { Pause16Regular as Pause16, Pause20Regular as Pause20 } from "@fluentui/react-icons/headless/svg/pause";
export { Play16Regular as Play16, Play20Filled } from "@fluentui/react-icons/headless/svg/play";
export { Previous16Regular as GoToStart16 } from "@fluentui/react-icons/headless/svg/previous";
export { Prohibited16Regular as Prohibited16 } from "@fluentui/react-icons/headless/svg/prohibited";
export { ReOrderDotsVertical16Regular as Grip16 } from "@fluentui/react-icons/headless/svg/re-order-dots-vertical";
export { Rename16Regular as Rename16, Rename20Regular as Rename20 } from "@fluentui/react-icons/headless/svg/rename";
export { Save16Regular as Save16 } from "@fluentui/react-icons/headless/svg/save";
export { ScanDash16Regular as SafeArea16, ScanDash16Filled as SafeArea16Filled } from "@fluentui/react-icons/headless/svg/scan-dash";
export { Search16Regular as Search16, Search32Regular as Search32 } from "@fluentui/react-icons/headless/svg/search";
export { SelectObject16Regular as Boxes16, SelectObject16Filled as Boxes16Filled } from "@fluentui/react-icons/headless/svg/select-object";
export { Send16Regular as Send16 } from "@fluentui/react-icons/headless/svg/send";
export { Server16Regular as Worker16, Server16Filled as Worker16Filled, Server20Regular as Worker20 } from "@fluentui/react-icons/headless/svg/server";
export { Settings16Regular as Settings16 } from "@fluentui/react-icons/headless/svg/settings";
export { Sparkle12Regular as Sparkle12, Sparkle16Regular as Sparkle16, Sparkle16Filled, Sparkle20Regular as Sparkle20 } from "@fluentui/react-icons/headless/svg/sparkle";
export { SpinnerIos16Regular as Spinner16, SpinnerIos20Regular as Spinner20 } from "@fluentui/react-icons/headless/svg/spinner-ios";
export { Stop16Regular as Stop16 } from "@fluentui/react-icons/headless/svg/stop";
export { TaskListSquareLtr16Regular as WorkQueue16 } from "@fluentui/react-icons/headless/svg/task-list-square-ltr";
export { TextNumberListLtr20Regular as Steps20 } from "@fluentui/react-icons/headless/svg/text-number-list-ltr";
export { TextT12Regular as Text12, TextT16Regular as Text16, TextT16Filled as Text16Filled } from "@fluentui/react-icons/headless/svg/text-t";
export { Video16Regular as Video16, Video16Filled, Video20Regular as Video20 } from "@fluentui/react-icons/headless/svg/video";
export { VideoClip16Regular as Scene16, VideoClip32Regular as Scene32 } from "@fluentui/react-icons/headless/svg/video-clip";
export { Wand16Regular as Wand16 } from "@fluentui/react-icons/headless/svg/wand";
export { Warning16Regular as Warning16, Warning20Regular as Warning20 } from "@fluentui/react-icons/headless/svg/warning";
export { Wrench16Regular as Wrench16 } from "@fluentui/react-icons/headless/svg/wrench";
export { ZoomIn16Regular as ZoomIn16 } from "@fluentui/react-icons/headless/svg/zoom-in";
export { ZoomOut16Regular as ZoomOut16 } from "@fluentui/react-icons/headless/svg/zoom-out";

import { Add16Regular } from "@fluentui/react-icons/headless/svg/add";
import { ArrowCounterclockwise16Regular } from "@fluentui/react-icons/headless/svg/arrow-counterclockwise";
import { ArrowSync16Regular, ArrowSync24Regular } from "@fluentui/react-icons/headless/svg/arrow-sync";
import { Checkmark12Filled, Checkmark16Regular } from "@fluentui/react-icons/headless/svg/checkmark";
import { ChevronDown16Regular } from "@fluentui/react-icons/headless/svg/chevron-down";
import { ChevronRight16Regular } from "@fluentui/react-icons/headless/svg/chevron-right";
import { Clock20Regular } from "@fluentui/react-icons/headless/svg/clock";
import { CursorClick24Regular } from "@fluentui/react-icons/headless/svg/cursor-click";
import { Delete16Regular } from "@fluentui/react-icons/headless/svg/delete";
import { Dismiss12Filled } from "@fluentui/react-icons/headless/svg/dismiss";
import { DocumentText16Regular } from "@fluentui/react-icons/headless/svg/document-text";
import { Edit12Regular } from "@fluentui/react-icons/headless/svg/edit";
import { Filmstrip16Regular, Filmstrip20Regular } from "@fluentui/react-icons/headless/svg/filmstrip";
import { FolderOpen16Regular, FolderOpen28Regular } from "@fluentui/react-icons/headless/svg/folder-open";
import { Group20Filled, Group20Regular } from "@fluentui/react-icons/headless/svg/group";
import { Image16Regular, Image24Regular } from "@fluentui/react-icons/headless/svg/image";
import { ImageAdd20Regular } from "@fluentui/react-icons/headless/svg/image-add";
import { LockClosed16Filled } from "@fluentui/react-icons/headless/svg/lock-closed";
import { LockOpen16Regular } from "@fluentui/react-icons/headless/svg/lock-open";
import { MoreHorizontal16Regular } from "@fluentui/react-icons/headless/svg/more-horizontal";
import { MusicNote216Regular, MusicNote224Regular } from "@fluentui/react-icons/headless/svg/music-note";
import { NextFrame20Regular } from "@fluentui/react-icons/headless/svg/next-frame";
import { Pause16Regular } from "@fluentui/react-icons/headless/svg/pause";
import { Play16Regular } from "@fluentui/react-icons/headless/svg/play";
import { PreviousFrame20Regular } from "@fluentui/react-icons/headless/svg/previous-frame";
import { Prohibited20Regular } from "@fluentui/react-icons/headless/svg/prohibited";
import { Pulse20Filled, Pulse20Regular } from "@fluentui/react-icons/headless/svg/pulse";
import { Speaker216Regular } from "@fluentui/react-icons/headless/svg/speaker";
import { SpeakerMute16Filled } from "@fluentui/react-icons/headless/svg/speaker-mute";
import { SpinnerIos20Regular } from "@fluentui/react-icons/headless/svg/spinner-ios";
import { Stop16Regular } from "@fluentui/react-icons/headless/svg/stop";
import { TaskListSquareLtr48Regular } from "@fluentui/react-icons/headless/svg/task-list-square-ltr";
import { Video24Regular } from "@fluentui/react-icons/headless/svg/video";
import { Warning20Regular, Warning24Regular } from "@fluentui/react-icons/headless/svg/warning";

/** A Fluent design drawn at an off-grid size, through a .ui-icon--<size> class. */
function scaled(Icon: FluentIcon, size: number): FluentIcon {
  const sizeClass = `ui-icon--${size}`;
  const Scaled = ({ className, ...props }: FluentIconsProps) => <Icon {...props} className={className ? `${sizeClass} ${className}` : sizeClass} />;
  Scaled.displayName = `${Icon.displayName ?? "Icon"}@${size}`;
  return Scaled;
}

export const Add14 = /*#__PURE__*/ scaled(Add16Regular, 14);
export const Audio12 = /*#__PURE__*/ scaled(MusicNote216Regular, 12);
export const Audio22 = /*#__PURE__*/ scaled(MusicNote224Regular, 22);
export const Check10Filled = /*#__PURE__*/ scaled(Checkmark12Filled, 10);
export const Check14 = /*#__PURE__*/ scaled(Checkmark16Regular, 14);
export const ChevronDown14 = /*#__PURE__*/ scaled(ChevronDown16Regular, 14);
export const ChevronRight14 = /*#__PURE__*/ scaled(ChevronRight16Regular, 14);
export const Clock18 = /*#__PURE__*/ scaled(Clock20Regular, 18);
export const CursorClick32 = /*#__PURE__*/ scaled(CursorClick24Regular, 32);
export const Delete14 = /*#__PURE__*/ scaled(Delete16Regular, 14);
export const Diagnostics16 = /*#__PURE__*/ scaled(Pulse20Regular, 16);
export const Diagnostics16Filled = /*#__PURE__*/ scaled(Pulse20Filled, 16);
export const Dismiss10Filled = /*#__PURE__*/ scaled(Dismiss12Filled, 10);
export const Edit11 = /*#__PURE__*/ scaled(Edit12Regular, 11);
export const Film12 = /*#__PURE__*/ scaled(Filmstrip16Regular, 12);
export const Film18 = /*#__PURE__*/ scaled(Filmstrip20Regular, 18);
export const FolderOpen14 = /*#__PURE__*/ scaled(FolderOpen16Regular, 14);
export const FolderOpen48 = /*#__PURE__*/ scaled(FolderOpen28Regular, 48);
export const Group16 = /*#__PURE__*/ scaled(Group20Regular, 16);
export const Group16Filled = /*#__PURE__*/ scaled(Group20Filled, 16);
export const Image12 = /*#__PURE__*/ scaled(Image16Regular, 12);
export const Image22 = /*#__PURE__*/ scaled(Image24Regular, 22);
export const ImageAdd14 = /*#__PURE__*/ scaled(ImageAdd20Regular, 14);
export const ImageAdd16 = /*#__PURE__*/ scaled(ImageAdd20Regular, 16);
export const Lock14Filled = /*#__PURE__*/ scaled(LockClosed16Filled, 14);
export const More14 = /*#__PURE__*/ scaled(MoreHorizontal16Regular, 14);
export const Mute14Filled = /*#__PURE__*/ scaled(SpeakerMute16Filled, 14);
export const NextFrame16 = /*#__PURE__*/ scaled(NextFrame20Regular, 16);
export const Pause14 = /*#__PURE__*/ scaled(Pause16Regular, 14);
export const Play14 = /*#__PURE__*/ scaled(Play16Regular, 14);
export const PreviousFrame16 = /*#__PURE__*/ scaled(PreviousFrame20Regular, 16);
export const Prohibited18 = /*#__PURE__*/ scaled(Prohibited20Regular, 18);
export const Refresh14 = /*#__PURE__*/ scaled(ArrowSync16Regular, 14);
export const Refresh32 = /*#__PURE__*/ scaled(ArrowSync24Regular, 32);
export const Reset14 = /*#__PURE__*/ scaled(ArrowCounterclockwise16Regular, 14);
export const Speaker14 = /*#__PURE__*/ scaled(Speaker216Regular, 14);
export const Spinner18 = /*#__PURE__*/ scaled(SpinnerIos20Regular, 18);
export const Stop14 = /*#__PURE__*/ scaled(Stop16Regular, 14);
export const TextFile14 = /*#__PURE__*/ scaled(DocumentText16Regular, 14);
export const Unlock14 = /*#__PURE__*/ scaled(LockOpen16Regular, 14);
export const Video22 = /*#__PURE__*/ scaled(Video24Regular, 22);
export const Warning18 = /*#__PURE__*/ scaled(Warning20Regular, 18);
export const Warning22 = /*#__PURE__*/ scaled(Warning24Regular, 22);
export const WorkQueue32 = /*#__PURE__*/ scaled(TaskListSquareLtr48Regular, 32);
