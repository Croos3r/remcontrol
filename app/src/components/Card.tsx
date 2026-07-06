import type { ReactNode } from 'react';
import { type StyleProp, StyleSheet, View, type ViewStyle } from 'react-native';
import { radius, useTheme } from '../theme';

interface Props {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  soft?: boolean;
  padded?: boolean;
}

export function Card({ children, style, soft = false, padded = true }: Props) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: soft ? theme.softSurface : theme.surface,
          borderColor: theme.border,
          ...theme.shadowSoft,
        },
        padded && styles.padded,
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  padded: {
    padding: radius.md,
  },
});
