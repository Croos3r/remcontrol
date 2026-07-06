import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps } from 'react';
import { useEffect, useState } from 'react';
import {
  type LayoutChangeEvent,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { radius, spacing, useTheme } from '../theme';
import { Icon } from './Icon';

type IconName = ComponentProps<typeof Icon>['name'];

interface Tab<T extends string> {
  key: T;
  /** Used for the accessibility label; not rendered on screen. */
  label: string;
  icon?: IconName;
}

interface Props<T extends string> {
  tabs: Tab<T>[];
  value: T;
  onChange: (key: T) => void;
  style?: StyleProp<ViewStyle>;
}

const GAP = spacing.xs;
const ANIM_MS = 180;

export function TabBar<T extends string>({ tabs, value, onChange, style }: Props<T>) {
  const theme = useTheme();
  const [rowWidth, setRowWidth] = useState(0);
  const indicatorX = useSharedValue(0);
  const indicatorW = useSharedValue(0);

  const activeIndex = Math.max(
    0,
    tabs.findIndex((t) => t.key === value),
  );

  const onRowLayout = (e: LayoutChangeEvent) => {
    setRowWidth(e.nativeEvent.layout.width);
  };

  useEffect(() => {
    const count = tabs.length;
    if (rowWidth === 0 || count === 0) return;
    const tabW = (rowWidth - (count - 1) * GAP) / count;
    indicatorW.value = tabW;
    indicatorX.value = withTiming(activeIndex * (tabW + GAP), { duration: ANIM_MS });
  }, [activeIndex, rowWidth, tabs.length, indicatorX, indicatorW]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: indicatorX.value }],
    width: indicatorW.value,
  }));

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.softSurface, borderColor: theme.border },
        style,
      ]}
    >
      <View style={styles.row} onLayout={onRowLayout}>
        <Animated.View style={[styles.indicator, indicatorStyle]} pointerEvents="none">
          <LinearGradient
            colors={theme.tabGradient.colors}
            start={theme.tabGradient.start}
            end={theme.tabGradient.end}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        {tabs.map((t) => {
          const active = t.key === value;
          return (
            <Pressable
              key={t.key}
              onPress={() => onChange(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={t.label}
              style={styles.tab}
            >
              <View style={styles.fill}>
                {t.icon ? (
                  <Icon name={t.icon} size={20} color={active ? theme.onGradient : theme.muted} />
                ) : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: radius.lg,
    borderWidth: 1,
    padding: GAP,
  },
  row: {
    flexDirection: 'row',
    gap: GAP,
    position: 'relative',
  },
  tab: {
    flex: 1,
  },
  fill: {
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    paddingVertical: spacing.sm,
  },
  indicator: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    borderRadius: radius.md,
    overflow: 'hidden',
    width: 0,
  },
});
