import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { radius, spacing, useTheme } from '../theme';
import { F_KEYS, MODIFIER_LABEL, MODIFIERS, type ModifierKey, TAP_KEYS } from './keys';

export type { ModifierKey } from './keys';
export { F_KEYS, MODIFIER_LABEL, MODIFIERS, TAP_KEYS } from './keys';

interface KeyPanelProps {
  heldMods: Set<ModifierKey>;
  onModifier: (m: ModifierKey) => void;
  onKey: (id: string) => void;
  variant: 'float' | 'dock';
}

export function KeyPanel({ heldMods, onModifier, onKey, variant }: KeyPanelProps) {
  return (
    <View style={variant === 'dock' ? styles.dockRoot : styles.floatRoot}>
      <View style={styles.row}>
        {MODIFIERS.map((m) => (
          <KeyButton
            key={m}
            label={MODIFIER_LABEL[m]}
            active={heldMods.has(m)}
            onPress={() => onModifier(m)}
            variant={variant}
          />
        ))}
      </View>
      <View style={styles.row}>
        {TAP_KEYS.map((k) => (
          <KeyButton key={k.id} label={k.label} onPress={() => onKey(k.id)} variant={variant} />
        ))}
      </View>
      <View style={styles.row}>
        {F_KEYS.map((k) => (
          <KeyButton
            key={k.id}
            label={k.label}
            small
            onPress={() => onKey(k.id)}
            variant={variant}
          />
        ))}
      </View>
    </View>
  );
}

function KeyButton({
  label,
  onPress,
  active = false,
  small = false,
  variant,
}: {
  label: string;
  onPress: () => void;
  active?: boolean;
  small?: boolean;
  variant: 'float' | 'dock';
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      style={[
        styles.keyButton,
        variant === 'dock' && styles.keyButtonDock,
        active
          ? { backgroundColor: theme.primary, borderColor: theme.primary }
          : { backgroundColor: theme.softSurface, borderColor: theme.border },
        small && styles.keyButtonSmall,
      ]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text
        style={[
          styles.keyText,
          { color: active ? theme.onGradient : theme.text },
          small && styles.fText,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  dockRoot: {
    flex: 1,
    gap: spacing.sm,
  },
  floatRoot: {
    gap: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  keyButton: {
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm + 2,
    minWidth: 38,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
  },
  keyButtonDock: {
    minWidth: 0,
    flex: 1,
    flexGrow: 1,
  },
  keyButtonSmall: {
    minWidth: 0,
    paddingHorizontal: spacing.xs + 2,
    paddingVertical: spacing.xs + 2,
    minHeight: 36,
  },
  keyText: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
  fText: {
    fontSize: 11,
  },
});
