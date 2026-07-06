import { LinearGradient } from 'expo-linear-gradient';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';
import { radius, spacing, usePressScale, useTheme } from '../theme';

type Variant = 'primary' | 'secondary';

interface Props {
  label: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  icon?: ReactNode;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  icon,
  style,
  textStyle,
}: Props) {
  const theme = useTheme();
  const { onPressIn, onPressOut, animatedStyle } = usePressScale();

  const content = (
    <>
      {icon}
      <Text style={[styles.label, labelStyle(theme, variant, disabled), textStyle]}>{label}</Text>
    </>
  );

  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      style={[styles.base, style]}
    >
      <Animated.View style={[styles.inner, animatedStyle]}>
        {variant === 'primary' && !disabled ? (
          <LinearGradient
            colors={theme.buttonGradient.colors}
            start={theme.buttonGradient.start}
            end={theme.buttonGradient.end}
            style={StyleSheet.absoluteFill}
          />
        ) : null}
        <View
          style={[
            styles.fill,
            variant === 'secondary' && !disabled
              ? { backgroundColor: theme.surface, borderColor: theme.border, borderWidth: 1 }
              : null,
            disabled ? { backgroundColor: theme.disabled, borderWidth: 0 } : null,
          ]}
        >
          {content}
        </View>
      </Animated.View>
    </Pressable>
  );
}

function labelStyle(
  theme: ReturnType<typeof useTheme>,
  variant: Variant,
  disabled: boolean,
): TextStyle {
  if (disabled) return { color: theme.disabledText };
  if (variant === 'primary') return { color: theme.onGradient };
  return { color: theme.text };
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  inner: {
    borderRadius: radius.pill,
  },
  fill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md + 2,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
  },
  label: {
    fontSize: 16,
    fontWeight: '700',
  },
});
