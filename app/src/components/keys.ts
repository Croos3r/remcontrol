export const MODIFIERS = ['ctrl', 'alt', 'shift', 'super'] as const;
export type ModifierKey = (typeof MODIFIERS)[number];
export const MODIFIER_LABEL: Record<ModifierKey, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Shift',
  super: 'Super',
};

interface TapKey {
  id: string;
  label: string;
}
export const TAP_KEYS: TapKey[] = [
  { id: 'esc', label: 'Esc' },
  { id: 'tab', label: 'Tab' },
  { id: 'space', label: 'Space' },
  { id: 'enter', label: '⏎' },
  { id: 'backspace', label: '⌫' },
  { id: 'delete', label: 'Del' },
  { id: 'home', label: 'Home' },
  { id: 'end', label: 'End' },
  { id: 'pageup', label: 'PgUp' },
  { id: 'pagedown', label: 'PgDn' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
];
export const F_KEYS: TapKey[] = Array.from({ length: 12 }, (_, i) => ({
  id: `f${i + 1}`,
  label: `F${i + 1}`,
}));
