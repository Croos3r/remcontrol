import { useColorScheme, useWindowDimensions } from 'react-native';
import { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

export const radius = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export type GradientColors = readonly [string, string, ...string[]];

export type GradientPreset = {
  colors: GradientColors;
  start: { x: number; y: number };
  end: { x: number; y: number };
};

export interface Theme {
  scheme: 'light' | 'dark';
  appBg: string;
  appBgEnd: string;
  surface: string;
  softSurface: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  deep: string;
  navy: string;
  softNavy: string;
  onGradient: string;
  disabled: string;
  disabledText: string;
  danger: string;
  warn: string;
  ok: string;
  warnTint: string;
  dangerTint: string;
  statusLight: 'light' | 'dark';
  shadow: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
  };
  shadowSoft: {
    shadowColor: string;
    shadowOffset: { width: number; height: number };
    shadowOpacity: number;
    shadowRadius: number;
    elevation: number;
  };
  headerGradient: GradientPreset;
  buttonGradient: GradientPreset;
  tabGradient: GradientPreset;
  padGradient: GradientPreset;
}

export const lightTheme: Theme = {
  scheme: 'light',
  appBg: '#EAF2FF',
  appBgEnd: '#F3F8FF',
  surface: '#FFFFFF',
  softSurface: '#F3F8FF',
  border: '#D6E6F8',
  text: '#062B66',
  muted: '#6B7C93',
  primary: '#008CFF',
  deep: '#005DE8',
  navy: '#062B66',
  softNavy: '#123A78',
  onGradient: '#FFFFFF',
  disabled: '#C9D6EA',
  disabledText: '#8898B0',
  danger: '#D64545',
  warn: '#B9770E',
  ok: '#2EA36B',
  warnTint: '#FFF4E0',
  dangerTint: '#FFECEC',
  statusLight: 'dark',
  shadow: {
    shadowColor: '#062B66',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
    elevation: 4,
  },
  shadowSoft: {
    shadowColor: '#062B66',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  headerGradient: {
    colors: ['#005DE8', '#008CFF'] as const,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  buttonGradient: {
    colors: ['#008CFF', '#005DE8'] as const,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  tabGradient: {
    colors: ['#008CFF', '#005DE8'] as const,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  },
  padGradient: {
    colors: ['#FFFFFF', '#EAF2FF'] as const,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
  },
};

export const darkTheme: Theme = {
  scheme: 'dark',
  appBg: '#06122E',
  appBgEnd: '#0A1F4A',
  surface: '#13245A',
  softSurface: '#0E1C40',
  border: '#1F3A7A',
  text: '#EAF2FF',
  muted: '#9FB3D6',
  primary: '#008CFF',
  deep: '#005DE8',
  navy: '#062B66',
  softNavy: '#123A78',
  onGradient: '#FFFFFF',
  disabled: '#26406F',
  disabledText: '#6F86B0',
  danger: '#FF6B6B',
  warn: '#FFB347',
  ok: '#3DDC84',
  warnTint: 'rgba(255,179,71,0.15)',
  dangerTint: 'rgba(255,107,107,0.15)',
  statusLight: 'light',
  shadow: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 18,
    elevation: 8,
  },
  shadowSoft: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 4,
  },
  headerGradient: {
    colors: ['#005DE8', '#008CFF'] as const,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  buttonGradient: {
    colors: ['#008CFF', '#005DE8'] as const,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  tabGradient: {
    colors: ['#008CFF', '#005DE8'] as const,
    start: { x: 0, y: 0 },
    end: { x: 1, y: 0 },
  },
  padGradient: {
    colors: ['#13245A', '#0A1F4A'] as const,
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
  },
};

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkTheme : lightTheme;
}

export function useIsLandscape() {
  const { width, height } = useWindowDimensions();
  return width >= height;
}

const SPRING = { damping: 18, stiffness: 300, mass: 0.8 };

export function usePressScale() {
  const scale = useSharedValue(1);
  const onPressIn = () => {
    scale.value = withSpring(0.97, SPRING);
  };
  const onPressOut = () => {
    scale.value = withSpring(1, SPRING);
  };
  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  return { onPressIn, onPressOut, animatedStyle };
}
