/* ============================================================================
   Slopus Fluent UI — the shared WinUI-style component library.

   Import everything from here:  import { ComboBox, ContentDialog } from "../ui";
   Styles live in src/styles/ui.css (already imported by index.css); classes
   are `ui-*`. Every overlay renders into document.body through a portal.

   App root (once):
     <FluentRuntime />            tooltip layer + filled track on every <input type=range>
       (or <TooltipLayer /> and installRangeFill() from lib/rangeFill separately)

   Components — one line each; the source file has a fuller example:
     ContentDialog     modal; title, children, primaryText/onPrimary, secondaryText/onSecondary,
                       closeText + onClose (Esc), defaultButton ("primary"|"secondary"|"close"; Enter runs it),
                       primaryDisabled, width. Buttons render [Primary][Secondary][Close]. No click-outside.
     useModalFocus     useModalFocus(ref, { active, initialFocus, restoreFocus }) — trap + restore focus.
     InfoBar           <InfoBar severity="error" title="…" message="…" action={…} onClose={…} /> inline, full width.
     ComboBox          <ComboBox value onChange={(v) => …} options={[{value,label}]} aria-label /> or keep
                       <option>/<optgroup> children — a drop-in for <select> whose onChange gets the value.
                       `editable` + parseText(text) → value | null + displayText: a text field with the list
                       on a drop-down button; typed text commits on Enter / blur (the image editor's zoom).
                       Every option carries data-value.
     optionsFromChildren(children) → ComboBox items from <option> elements.
     Splitter          <Splitter {...pane.splitterProps} orientation="vertical" reverse aria-label="Resize …" />
     usePaneSize       const pane = usePaneSize("screen.pane", 320, { min, max }); style={pane.style} sets --pane-screen-pane.
     SettingsGroup     <SettingsGroup heading="…">cards…</SettingsGroup> (4px gap).
     SettingsCard      <SettingsCard icon header description>{control}</SettingsCard>; onClick → chevron, href → external.
     SettingsExpander  <SettingsExpander icon header description control={…}>{<SettingsRow …/>}</SettingsExpander>
     SettingsRow       <SettingsRow header description>{control}</SettingsRow> (inside an expander).
     PropSection       <PropSection title="Transform" persistKey="clip.transform" summary="1 changed" actions={…}>rows…</PropSection>
                       28px header on chrome; `summary` is right-aligned and stays visible when collapsed.
     PropRow           <PropRow label htmlFor value defaultValue onReset scrub={{ value, onChange, step, min, max }}>{field}</PropRow>
     ContextMenu       <ContextMenu items position={{x,y}|{anchor}} onClose aria-label /> (controlled).
     useContextMenu    const menu = useContextMenu(); onContextMenu={(e) => menu.open(e, items)}; render {menu.element}.
                       items: { id?, label, icon?, shortcut?, disabled?, checked?, onSelect } | { separator: true };
                       an item with `items: MenuEntry[]` (and no onSelect) is a cascading submenu.
     TooltipLayer      mounted once; any element with data-tooltip="…" [data-tooltip-shortcut="Ctrl+S"] gets one.
     tooltipProps      {...tooltipProps("Split clip", "S")} — the codemod for title="…".
     ToggleSwitch      <ToggleSwitch checked onChange={(on) => …} label? aria-label? stateText={false}? />
     Checkbox          <Checkbox checked onChange={(on) => …} label description indeterminate />
     RadioGroup/Radio  <RadioGroup value onChange label options={[…]} /> or <Radio value label/> children.
     Slider            <Slider value onChange={(n) => …} min max step aria-label /> (sets --p).
     ProgressBar       <ProgressBar value={0..100 | undefined} state="normal"|"paused"|"error" aria-label />
     ProgressRing      <ProgressRing size={16|20|32} value? aria-label />
     InfoBadge         <InfoBadge value={3} severity="attention" /> or a dot without value.
     Expander          <Expander header description icon defaultExpanded>{content}</Expander>
     SelectorBar       <SelectorBar items={[{value,label}]} value onChange aria-label compact? /> (tablist;
                       compact = the 24px segmented form for a pane toolbar).
     CommandBar        <CommandBar aria-label end={…}><CommandBarButton icon label shortcut onClick /><CommandBarSeparator/></CommandBar>
     PaneHeader        <PaneHeader views={<SelectorBar compact …/>} actions={…} /> — the 36px pane toolbar on
                       chrome. `title` still works but a pane should not carry one (see ItemHeader).
     ItemHeader        <ItemHeader color="var(--clip-video)" icon={…} name="Clip" | name={<input className=
                       "ui-item-header__input" …/>} meta="Video · V1 · 6.2 s" actions={…} chip? id? level? />
                       — 48px, heads a pane that shows one selected thing.
     EmptyState        <EmptyState icon={<Film32 />} title="No media yet" description="…" action={…} />
     NavPane/NavItem   <NavPane aria-label footer={…}><NavItem icon label selected badge onClick /></NavPane>
     Flyout            <Flyout open anchor={buttonRef} onClose aria-label>…</Flyout> (light dismiss, acrylic).
     TextField         <TextField value onChange={(v) => …} icon trailing={<button className="ui-textfield__button" …/>} />
     StatusBar         <StatusBar end={…}>items…</StatusBar> (24px, on chrome).

   Shared CSS rules (ui.css), no component:
     .ui-selectable    list rows, tiles, cards: selected by aria-selected / aria-pressed / .is-selected →
                       accent-soft + 3×16 pill (--card: accent ring instead; --separated: --line under a row).
     Toggle on-state   .icon-button--checked, .ui-cmd--pressed, .icon-button / .ui-cmd / .ui-toggle-button
                       with aria-pressed="true": accent-soft fill, accent icon.

   Non-component helpers live in src/lib:
     lib/commands.ts   useShortcut("Ctrl+S", fn, { enabled, allowInInput, scope, preventDefault, allowInModal }),
                       registerShortcut, formatShortcut, matchesCombo, useCommand.
     lib/undo.ts       createUndoStack<T>() / useUndoStack(present, apply, { limit, mergeWindowMs }).
     lib/rangeFill.ts  installRangeFill(root) / uninstallRangeFill(root).
   ========================================================================== */

export { ContentDialog, type ContentDialogProps, type DialogButton } from "./ContentDialog";
export { useModalFocus, type ModalFocusOptions } from "./useModalFocus";
export { InfoBar, SeverityGlyph, type InfoBarProps, type InfoBarSeverity } from "./InfoBar";
export {
  ComboBox, optionsFromChildren,
  type ComboBoxProps, type ComboGroup, type ComboItems, type ComboOption, type ComboValue,
} from "./ComboBox";
export { Splitter, usePaneSize, type PaneSize, type PaneSizeOptions, type SplitterProps } from "./Splitter";
export {
  SettingsCard, SettingsExpander, SettingsGroup, SettingsRow, useDisclosure,
  type SettingsCardProps, type SettingsExpanderProps, type SettingsGroupProps, type SettingsRowProps,
} from "./Settings";
export { PropRow, PropSection, type PropRowProps, type PropSectionProps, type ScrubOptions } from "./PropRow";
export {
  ContextMenu, isSeparator, useContextMenu,
  type ContextMenuProps, type MenuEntry, type MenuItem, type MenuPosition, type MenuSeparator, type OpenMenuOptions,
} from "./ContextMenu";
export { FluentRuntime, TooltipLayer, tooltipProps, TOOLTIP_BETWEEN_DELAY, TOOLTIP_DELAY } from "./Tooltip";
export {
  Checkbox, Expander, InfoBadge, ProgressBar, ProgressRing, Radio, RadioGroup, SelectorBar, Slider, ToggleSwitch, sliderPercent,
  type CheckboxProps, type ExpanderProps, type InfoBadgeProps, type ProgressBarProps, type ProgressRingProps,
  type RadioGroupProps, type RadioProps, type SelectorBarItem, type SelectorBarProps, type SliderProps, type ToggleSwitchProps,
} from "./Controls";
export { Flyout, type FlyoutProps } from "./Flyout";
export { EmptyState, ItemHeader, type EmptyStateProps, type ItemHeaderProps } from "./Pane";
export {
  CommandBar, CommandBarButton, CommandBarSeparator, NavItem, NavPane, PaneHeader, StatusBar, TextField,
  type CommandBarButtonProps, type CommandBarProps, type NavItemProps, type NavPaneProps, type PaneHeaderProps,
  type StatusBarProps, type TextFieldProps,
} from "./Chrome";
export { placeAnchored, placeAtPoint, type Placement } from "./internal";
