import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Card } from './src/components/Card';
import { Icon } from './src/components/Icon';
import { Connection } from './src/connection';
import { loadPrefs, type Prefs } from './src/prefs';
import ConnectScreen from './src/screens/ConnectScreen';
import TrackpadScreen from './src/screens/TrackpadScreen';
import { loadLastConnection } from './src/storage';
import { useTheme } from './src/theme';
import type { ServerInfo } from './src/types';

type Screen = 'restoring' | 'connect' | 'trackpad';

export default function App() {
  const theme = useTheme();
  const [screen, setScreen] = useState<Screen>('restoring');
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const connectionRef = useRef<Connection | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadPrefs().then((loaded) => {
      if (cancelled) return;
      setPrefs(loaded);
      if (!loaded.autoReconnect) {
        setScreen('connect');
        return;
      }
      void loadLastConnection().then((info: ServerInfo | null) => {
        if (cancelled || !info) {
          setScreen('connect');
          return;
        }
        const timer = setTimeout(() => {
          if (cancelled) return;
          connectionRef.current?.close();
          connectionRef.current = null;
          setScreen('connect');
        }, 5000);
        const conn = new Connection(info, {
          onOpen: () => {
            clearTimeout(timer);
            if (cancelled) {
              conn.close();
              return;
            }
            connectionRef.current = conn;
            setScreen('trackpad');
          },
          onError: () => {
            clearTimeout(timer);
            if (cancelled) return;
            connectionRef.current?.close();
            connectionRef.current = null;
            setScreen('connect');
          },
        });
        connectionRef.current = conn;
        conn.connect();
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const onConnected = (conn: Connection) => {
    connectionRef.current = conn;
    setScreen('trackpad');
  };

  const onDisconnect = () => {
    connectionRef.current?.close();
    connectionRef.current = null;
    setScreen('connect');
  };

  return (
    <GestureHandlerRootView style={[styles.root, { backgroundColor: theme.appBg }]}>
      <SafeAreaProvider>
        <StatusBar style={theme.statusLight} />
        {screen === 'restoring' && (
          <View style={styles.center}>
            <Card style={styles.restoringCard}>
              <Icon name="wifi" size={32} color={theme.primary} />
              <View style={styles.restoringText}>
                <Text style={[styles.restoringTitle, { color: theme.text }]}>Reconnecting</Text>
                <Text style={[styles.restoringSub, { color: theme.muted }]}>
                  to the last server…
                </Text>
              </View>
              <ActivityIndicator color={theme.primary} />
            </Card>
          </View>
        )}
        {screen === 'connect' && (
          <ConnectScreen onConnected={onConnected} onPrefsChange={setPrefs} />
        )}
        {screen === 'trackpad' && connectionRef.current && (
          <TrackpadScreen
            connection={connectionRef.current}
            onDisconnect={onDisconnect}
            initialSensitivity={prefs?.defaultSensitivity}
          />
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  restoringCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 18,
    minWidth: 280,
  },
  restoringText: {
    flex: 1,
  },
  restoringTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  restoringSub: {
    fontSize: 14,
    marginTop: 2,
  },
});
