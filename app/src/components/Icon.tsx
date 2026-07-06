import Ionicons from '@expo/vector-icons/Ionicons';
import type { ComponentProps } from 'react';
import { useTheme } from '../theme';

export type IconName = ComponentProps<typeof Ionicons>['name'];

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  style?: ComponentProps<typeof Ionicons>['style'];
}

export function Icon({ name, size = 22, color, style }: Props) {
  const theme = useTheme();
  return <Ionicons name={name} size={size} color={color ?? theme.navy} style={style} />;
}
