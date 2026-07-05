import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Connection } from './src/connection';
import ConnectScreen from './src/screens/ConnectScreen';
import TrackpadScreen from './src/screens/TrackpadScreen';
import { loadLastConnection } from './src/storage';
import { ServerInfo } from './src/types';

type Screen = 'restoring' | 'connect' | 'trackpad';

export default function App() {
  const [screen, setScreen] = useState<Screen>('restoring');
  const connectionRef = useRef<Connection | null>(null);

  useEffect(() => {
    let cancelled = false;
    const giveUp = () => {
      if (!cancelled) {
        connectionRef.current?.close();
        connectionRef.current = null;
        setScreen('connect');
      }
    };
    void loadLastConnection().then((info: ServerInfo | null) => {
      if (cancelled) return;
      if (!info) {
        setScreen('connect');
        return;
      }
      const timer = setTimeout(giveUp, 5000);
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
          giveUp();
        },
      });
      connectionRef.current = conn;
      conn.connect();
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
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        {screen === 'restoring' && (
          <View style={styles.center}>
            <Text style={styles.restoring}>Reconnecting to the last server…</Text>
          </View>
        )}
        {screen === 'connect' && <ConnectScreen onConnected={onConnected} />}
        {screen === 'trackpad' && connectionRef.current && (
          <TrackpadScreen connection={connectionRef.current} onDisconnect={onDisconnect} />
        )}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#111',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  restoring: {
    color: '#aaa',
    fontSize: 15,
  },
});
