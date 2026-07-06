export type TopBarState = { visible: boolean; settingsOpen: boolean };

export type TopBarAction =
  | { type: 'DRAG_START' }
  | { type: 'IDLE_TIMEOUT' }
  | { type: 'DRAWER_OPEN' }
  | { type: 'DRAWER_CLOSE' }
  | { type: 'SETTINGS_TOGGLE' };

export const INITIAL_TOP_BAR_STATE: TopBarState = { visible: true, settingsOpen: false };

export function reduceTopBar(state: TopBarState, action: TopBarAction): TopBarState {
  switch (action.type) {
    case 'DRAG_START':
    case 'IDLE_TIMEOUT':
      return state.settingsOpen ? state : { ...state, visible: false };
    case 'DRAWER_OPEN':
      return { ...state, visible: true };
    case 'DRAWER_CLOSE':
      return { visible: false, settingsOpen: false };
    case 'SETTINGS_TOGGLE': {
      const settingsOpen = !state.settingsOpen;
      return { visible: settingsOpen ? true : state.visible, settingsOpen };
    }
  }
}
