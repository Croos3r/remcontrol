import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '../theme';

const THUMB_SIZE = 22;
const TRACK_HEIGHT = 6;
const TOUCH_HEIGHT = 44;

interface Props {
  value: number;
  min: number;
  max: number;
  step?: number;
  accessibilityLabel?: string;
  onValueChange?: (v: number) => void;
  onSlidingComplete?: (v: number) => void;
}

export function Slider({
  value,
  min,
  max,
  step = 0.1,
  accessibilityLabel = 'Slider',
  onValueChange,
  onSlidingComplete,
}: Props) {
  const theme = useTheme();
  const range = max - min;
  const trackWidth = useSharedValue(0);
  const fraction = useSharedValue(range > 0 ? (value - min) / range : 0);
  const startFraction = useSharedValue(0);
  const dragging = useSharedValue(false);

  useEffect(() => {
    if (dragging.value || range <= 0) return;
    fraction.value = withTiming((value - min) / range, { duration: 60 });
  }, [value, min, range, fraction]);

  const stepped = (v: number) => {
    'worklet';
    const clamped = Math.min(max, Math.max(min, min + Math.round((v - min) / step) * step));
    return Math.round(clamped / step) * step;
  };

  const apply = (frac: number) => {
    'worklet';
    const clamped = Math.min(1, Math.max(0, frac));
    fraction.value = clamped;
    if (onValueChange) runOnJS(onValueChange)(stepped(min + clamped * range));
  };

  const finish = () => {
    'worklet';
    if (onSlidingComplete) runOnJS(onSlidingComplete)(stepped(min + fraction.value * range));
  };

  const pan = Gesture.Pan()
    .onBegin(() => {
      'worklet';
      startFraction.value = fraction.value;
    })
    .onStart(() => {
      'worklet';
      dragging.value = true;
    })
    .onUpdate((e) => {
      'worklet';
      if (trackWidth.value <= 0) return;
      apply(startFraction.value + e.translationX / trackWidth.value);
    })
    .onEnd(() => {
      'worklet';
      finish();
    })
    .onFinalize(() => {
      'worklet';
      dragging.value = false;
    });

  const tap = Gesture.Tap().onEnd((e) => {
    'worklet';
    if (trackWidth.value <= 0) return;
    apply(e.x / trackWidth.value);
    finish();
  });

  const gesture = Gesture.Race(pan, tap);

  const fillStyle = useAnimatedStyle(() => ({
    width: trackWidth.value > 0 ? fraction.value * trackWidth.value : 0,
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          trackWidth.value > 0
            ? fraction.value * trackWidth.value - THUMB_SIZE / 2
            : -THUMB_SIZE / 2,
      },
    ],
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        style={styles.touch}
        accessibilityRole="adjustable"
        accessibilityLabel={accessibilityLabel}
        accessibilityValue={{ text: `${steppedJS(value, min, max, step).toFixed(1)}x` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => {
          const dir = e.nativeEvent.actionName === 'increment' ? 1 : -1;
          const next = Math.min(max, Math.max(min, Math.round((value + dir * step) / step) * step));
          onValueChange?.(next);
          onSlidingComplete?.(next);
        }}
        onLayout={(e) => {
          trackWidth.value = e.nativeEvent.layout.width;
        }}
      >
        <View style={[styles.track, { backgroundColor: theme.disabled }]} />
        <Animated.View style={[styles.fill, fillStyle, { backgroundColor: theme.primary }]} />
        <Animated.View style={[styles.thumb, thumbStyle, { backgroundColor: theme.primary }]} />
      </Animated.View>
    </GestureDetector>
  );
}

function steppedJS(value: number, min: number, max: number, step: number) {
  const clamped = Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step));
  return Math.round(clamped / step) * step;
}

const styles = StyleSheet.create({
  touch: {
    height: TOUCH_HEIGHT,
    width: '100%',
  },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: (TOUCH_HEIGHT - TRACK_HEIGHT) / 2,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: (TOUCH_HEIGHT - TRACK_HEIGHT) / 2,
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
  },
  thumb: {
    position: 'absolute',
    top: (TOUCH_HEIGHT - THUMB_SIZE) / 2,
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_SIZE / 2,
  },
});
