import { describe, expect, it } from 'vitest';
import { INITIAL_TOP_BAR_STATE, reduceTopBar } from './topBarVisibility';

describe('reduceTopBar', () => {
  it('starts visible with settings closed', () => {
    expect(INITIAL_TOP_BAR_STATE).toEqual({ visible: true, settingsOpen: false });
  });

  it('DRAG_START hides the bar', () => {
    const next = reduceTopBar({ visible: true, settingsOpen: false }, { type: 'DRAG_START' });
    expect(next).toEqual({ visible: false, settingsOpen: false });
  });

  it('DRAG_START is a no-op while settings are open', () => {
    const state = { visible: true, settingsOpen: true };
    expect(reduceTopBar(state, { type: 'DRAG_START' })).toEqual(state);
  });

  it('IDLE_TIMEOUT hides the bar', () => {
    const next = reduceTopBar({ visible: true, settingsOpen: false }, { type: 'IDLE_TIMEOUT' });
    expect(next).toEqual({ visible: false, settingsOpen: false });
  });

  it('IDLE_TIMEOUT is a no-op while settings are open', () => {
    const state = { visible: true, settingsOpen: true };
    expect(reduceTopBar(state, { type: 'IDLE_TIMEOUT' })).toEqual(state);
  });

  it('REVEAL_TAP shows the bar', () => {
    const next = reduceTopBar({ visible: false, settingsOpen: false }, { type: 'REVEAL_TAP' });
    expect(next).toEqual({ visible: true, settingsOpen: false });
  });

  it('SETTINGS_TOGGLE opening forces the bar visible', () => {
    const next = reduceTopBar({ visible: false, settingsOpen: false }, { type: 'SETTINGS_TOGGLE' });
    expect(next).toEqual({ visible: true, settingsOpen: true });
  });

  it('SETTINGS_TOGGLE closing preserves current visibility', () => {
    const next = reduceTopBar({ visible: true, settingsOpen: true }, { type: 'SETTINGS_TOGGLE' });
    expect(next).toEqual({ visible: true, settingsOpen: false });
  });
});
