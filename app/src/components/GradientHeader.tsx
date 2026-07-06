import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps } from 'react';
import { Image, StyleSheet, Text, type TextStyle, View, type ViewStyle } from 'react-native';
import { radius, spacing, useTheme } from '../theme';

const SUBTITLE_COLOR = 'rgba(255,255,255,0.82)';

type ImageSource = ComponentProps<typeof Image>['source'];

interface Props {
  title: string;
  subtitle?: string;
  icon?: ImageSource;
  style?: ViewStyle;
  titleStyle?: TextStyle;
}

export function GradientHeader({ title, subtitle, icon, style, titleStyle }: Props) {
  const theme = useTheme();
  return (
    <LinearGradient
      colors={theme.headerGradient.colors}
      start={theme.headerGradient.start}
      end={theme.headerGradient.end}
      style={[styles.header, style]}
    >
      <View style={styles.textCol}>
        <Text style={[styles.title, { color: theme.onGradient }, titleStyle]}>{title}</Text>
        {subtitle ? (
          <Text style={[styles.subtitle, { color: SUBTITLE_COLOR }]}>{subtitle}</Text>
        ) : null}
      </View>
      {icon ? (
        <View style={styles.logoWrap}>
          <Image source={icon} style={styles.logo} resizeMode="contain" />
        </View>
      ) : null}
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderRadius: radius.xl,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.xl,
    marginBottom: spacing.lg,
    minHeight: 132,
  },
  textCol: {
    flex: 1,
    justifyContent: 'center',
    paddingRight: spacing.lg,
  },
  title: {
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subtitle: {
    fontSize: 15,
    marginTop: 6,
    fontWeight: '500',
  },
  logoWrap: {
    width: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  logo: {
    width: 80,
    height: 80,
    borderRadius: 18,
  },
});
