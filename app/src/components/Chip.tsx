import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { radius, spacing, usePressScale, useTheme } from '../theme';

interface Props {
  label: string;
  active: boolean;
  onPress: () => void;
}

export function Chip({ label, active, onPress }: Props) {
  const theme = useTheme();
  const { onPressIn, onPressOut, animatedStyle } = usePressScale();
  return (
    <Pressable
      onPress={onPress}
      onPressIn={onPressIn}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Animated.View style={animatedStyle}>
        {active ? (
          <LinearGradient
            colors={theme.tabGradient.colors}
            start={theme.tabGradient.start}
            end={theme.tabGradient.end}
            style={styles.bg}
          >
            <Text style={[styles.label, { color: theme.onGradient }]}>{label}</Text>
          </LinearGradient>
        ) : (
          <View
            style={[
              styles.bg,
              { backgroundColor: theme.softSurface, borderColor: theme.border, borderWidth: 1 },
            ]}
          >
            <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bg: {
    borderRadius: radius.pill,
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
});
