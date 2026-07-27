/**
 * @ecoma-io/ui — Alloy design system.
 * Public entry: primitives + utilities. Tokens/styles are imported by hosts
 * directly (see ./styles/global.css and ../tailwind.preset.js).
 */
export { cn } from "./lib/cn";
export { applyAlloyIconDefaults } from "./lib/icon-defaults";
// WCAG_TAGS is deliberately NOT re-exported here — it ships from the narrow
// `@ecoma-io/ui/a11y` entry so a non-Vue consumer can read it without pulling
// in every component below (see tsconfig.base.json).

export { default as Button, buttonVariants } from "./primitives/Button/Button.vue";
export type { ButtonVariants } from "./primitives/Button/Button.vue";

export { default as Badge, badgeVariants } from "./primitives/Badge/Badge.vue";
export type { BadgeVariants } from "./primitives/Badge/Badge.vue";

export { default as Surface, surfaceVariants } from "./primitives/Surface/Surface.vue";
export type { SurfaceVariants } from "./primitives/Surface/Surface.vue";

export { default as Menubar } from "./primitives/Menubar/Menubar.vue";
export type { MenubarMenu, MenubarItem } from "./primitives/Menubar/Menubar.vue";

export { default as WindowControls } from "./primitives/WindowControls/WindowControls.vue";

export { default as Switch } from "./primitives/Switch/Switch.vue";

export { default as SegmentedControl } from "./primitives/SegmentedControl/SegmentedControl.vue";
export type { SegmentedControlOption } from "./primitives/SegmentedControl/SegmentedControl.vue";

export { default as Select } from "./primitives/Select/Select.vue";
export type { SelectOption } from "./primitives/Select/Select.vue";

export { default as NumberField } from "./primitives/NumberField/NumberField.vue";

export { default as Slider } from "./primitives/Slider/Slider.vue";

export { default as InlineError } from "./primitives/InlineError/InlineError.vue";

// Form — text entry, choices, and the label/error row that wraps them.
export { default as TextField } from "./primitives/TextField/TextField.vue";

export { default as Textarea } from "./primitives/Textarea/Textarea.vue";

export { default as Field } from "./primitives/Field/Field.vue";

export { default as Checkbox } from "./primitives/Checkbox/Checkbox.vue";

export { default as RadioGroup } from "./primitives/RadioGroup/RadioGroup.vue";
export type { RadioOption } from "./primitives/RadioGroup/RadioGroup.vue";

// Overlays — floating surfaces built on Reka UI (portal + focus + Presence).
export { default as Popover } from "./primitives/Popover/Popover.vue";

export { default as Dialog } from "./primitives/Dialog/Dialog.vue";

export { default as DropdownMenu } from "./primitives/DropdownMenu/DropdownMenu.vue";
export type { DropdownMenuEntry } from "./primitives/DropdownMenu/DropdownMenu.vue";

export { default as Tooltip } from "./primitives/Tooltip/Tooltip.vue";

// Feedback & display.
export { default as Separator } from "./primitives/Separator/Separator.vue";

export { default as Spinner, spinnerVariants } from "./primitives/Spinner/Spinner.vue";
export type { SpinnerVariants } from "./primitives/Spinner/Spinner.vue";

export { default as Skeleton, skeletonVariants } from "./primitives/Skeleton/Skeleton.vue";
export type { SkeletonVariants } from "./primitives/Skeleton/Skeleton.vue";

export { default as Progress } from "./primitives/Progress/Progress.vue";

export { default as Avatar } from "./primitives/Avatar/Avatar.vue";

export { default as Tabs } from "./primitives/Tabs/Tabs.vue";
export type { TabItem } from "./primitives/Tabs/Tabs.vue";

export { default as Toast } from "./primitives/Toast/Toast.vue";
export type { ToastVariant } from "./primitives/Toast/Toast.vue";

// Icons — custom domain icons; same API as @lucide/vue (see Foundations/Iconography).
export { default as BrandMark } from "./icons/BrandMark";

// Blocks — domain compositions built from primitives.
export { default as TitleBar } from "./blocks/TitleBar/TitleBar.vue";
export { default as EmptyState } from "./blocks/EmptyState/EmptyState.vue";
export { default as PageHeader } from "./blocks/PageHeader/PageHeader.vue";
export { default as RowActions } from "./blocks/RowActions/RowActions.vue";
export { default as ToastStack } from "./blocks/ToastStack/ToastStack.vue";
export type { ToastStackItem } from "./blocks/ToastStack/ToastStack.vue";
export { default as AppHeader } from "./blocks/AppHeader/AppHeader.vue";
export { default as SidebarNav } from "./blocks/SidebarNav/SidebarNav.vue";
export type { SidebarNavItem, SidebarNavSection } from "./blocks/SidebarNav/SidebarNav.vue";
export { default as DashboardGrid } from "./blocks/DashboardGrid/DashboardGrid.vue";
