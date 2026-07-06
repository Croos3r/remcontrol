import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps } from 'react';
import { Pressable, type StyleProp, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { radius, spacing, useTheme } from '../theme';
import { Icon } from './Icon';

type IconName = ComponentProps<typeof Icon>['name'];

interface Tab<T extends string> {
  key: T;
  label: string;
  icon?: IconName;
}

interface Props<T extends string> {
  tabs: Tab<T>[];
  value: T;
  onChange: (key: T) => void;
  style?: StyleProp<ViewStyle>;
}

export function TabBar<T extends string>({ tabs, value, onChange, style }: Props<T>) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.softSurface, borderColor: theme.border },
        style,
      ]}
    >
      {tabs.map((t) => {
        const active = t.key === value;
        return (
          <Pressable
            key={t.key}
            onPress={() => onChange(t.key)}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            style={styles.tab}
          >
            {active ? (
              <LinearGradient
                colors={theme.tabGradient.colors}
                start={theme.tabGradient.start}
                end={theme.tabGradient.end}
                style={styles.fill}
              >
                {t.icon ? <Icon name={t.icon} size={16} color={theme.onGradient} /> : null}
                <Text style={[styles.label, { color: theme.onGradient }]} numberOfLines={1}>
                  {t.label}
                </Text>
              </LinearGradient>
            ) : (
              <View style={styles.fill}>
                {t.icon ? <Icon name={t.icon} size={16} color={theme.muted} /> : null}
                <Text style={[styles.label, { color: theme.muted }]} numberOfLines={1}>
                  {t.label}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    gap: spacing.xs,
    padding: spacing.xs,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  tab: {
    flex: 1,
  },
  fill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm + 2,
    borderRadius: radius.md,
    minHeight: 40,
    paddingHorizontal: spacing.sm,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
    textAlignVertical: 'center',
    includeFontPadding: false,
  },
});
