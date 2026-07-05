import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Connection } from '../connection';
import { saveLastConnection } from '../storage';
import type { ServerInfo } from '../types';

type Zeroconf = {
  on(event: string, cb: (service: ZeroconfService) => void): void;
  scan(type: string, protocol: string, domain?: string): void;
  stop(): void;
  removeDeviceListeners(): void;
};

type ZeroconfService = {
  name?: string;
  port?: number;
  addresses?: string[];
};

function createZeroconf(): Zeroconf | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('react-native-zeroconf') as { default: new () => Zeroconf };
    return new mod.default();
  } catch {
    return null;
  }
}

type Tab = 'scan' | 'discover' | 'manual';

interface Discovered {
  name: string;
  ip: string;
  port: number;
}

interface Props {
  onConnected: (conn: Connection, info: ServerInfo) => void;
}

export default function ConnectScreen({ onConnected }: Props) {
  const [tab, setTab] = useState<Tab>('scan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [zeroconfAvailable, setZeroconfAvailable] = useState(true);
  const [pendingServer, setPendingServer] = useState<Discovered | null>(null);

  const [ip, setIp] = useState('');
  const [port, setPort] = useState('17890');
  const [token, setToken] = useState('');

  useEffect(() => {
    if (tab === 'scan') scannedRef.current = false;
    if (tab !== 'discover') return;
    const zeroconf = createZeroconf();
    if (!zeroconf) {
      setZeroconfAvailable(false);
      return;
    }
    zeroconf.on('resolved', (service) => {
      const address = service.addresses?.find((a) => a.includes('.'));
      if (!address || !service.port) return;
      const entry: Discovered = {
        name: service.name ?? address,
        ip: address,
        port: service.port,
      };
      setDiscovered((prev) =>
        prev.some((d) => d.ip === entry.ip && d.port === entry.port) ? prev : [...prev, entry],
      );
    });
    zeroconf.scan('remcontrol', 'tcp', 'local.');
    return () => {
      zeroconf.stop();
      zeroconf.removeDeviceListeners();
    };
  }, [tab]);

  const connect = (info: ServerInfo) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const conn = new Connection(info, {
      onOpen: () => {
        void saveLastConnection(info);
        setBusy(false);
        onConnected(conn, info);
      },
      onError: (message) => {
        setBusy(false);
        setError(message);
      },
    });
    conn.connect();
  };

  const onBarcode = (result: BarcodeScanningResult) => {
    if (scannedRef.current || busy) return;
    try {
      const parsed: unknown = JSON.parse(result.data);
      const info = parsed as ServerInfo;
      if (
        typeof info.ip === 'string' &&
        typeof info.port === 'number' &&
        typeof info.token === 'string'
      ) {
        scannedRef.current = true;
        connect(info);
      } else {
        setError('QR code is not a remcontrol pairing code');
      }
    } catch {
      setError('QR code is not a remcontrol pairing code');
    }
  };

  const submitManual = () => {
    const portNumber = Number(port);
    if (!ip.trim() || !Number.isInteger(portNumber) || !token.trim()) {
      setError('Fill in IP, port and token');
      return;
    }
    connect({ ip: ip.trim(), port: portNumber, token: token.trim() });
  };

  const renderScan = () => {
    if (!permission?.granted) {
      return (
        <View style={styles.center}>
          <Text style={styles.hint}>Camera access is needed to scan the QR code.</Text>
          <TouchableOpacity style={styles.button} onPress={() => void requestPermission()}>
            <Text style={styles.buttonText}>Allow camera</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <View style={styles.cameraWrap}>
        <CameraView
          style={StyleSheet.absoluteFill}
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={onBarcode}
        />
        <Text style={styles.scanHint}>Point at the QR code in the server terminal</Text>
      </View>
    );
  };

  const renderDiscover = () => {
    if (!zeroconfAvailable) {
      return (
        <View style={styles.center}>
          <Text style={styles.hint}>Discovery is unavailable in this build.</Text>
        </View>
      );
    }
    if (pendingServer) {
      return (
        <View style={styles.form}>
          <Text style={styles.hint}>
            Token for {pendingServer.name} ({pendingServer.ip}:{pendingServer.port})
          </Text>
          <TextInput
            style={styles.input}
            placeholder="Pairing token"
            placeholderTextColor="#666"
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            onChangeText={setToken}
          />
          <TouchableOpacity
            style={styles.button}
            onPress={() =>
              connect({ ip: pendingServer.ip, port: pendingServer.port, token: token.trim() })
            }
          >
            <Text style={styles.buttonText}>Connect</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => setPendingServer(null)}>
            <Text style={styles.link}>Back to the list</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <FlatList
        data={discovered}
        keyExtractor={(item) => `${item.ip}:${item.port}`}
        contentContainerStyle={discovered.length === 0 ? styles.center : undefined}
        ListEmptyComponent={<Text style={styles.hint}>Searching for servers…</Text>}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.listItem} onPress={() => setPendingServer(item)}>
            <Text style={styles.listItemName}>{item.name}</Text>
            <Text style={styles.listItemAddress}>
              {item.ip}:{item.port}
            </Text>
          </TouchableOpacity>
        )}
      />
    );
  };

  const renderManual = () => (
    <View style={styles.form}>
      <TextInput
        style={styles.input}
        placeholder="IP address"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="decimal-pad"
        value={ip}
        onChangeText={setIp}
      />
      <TextInput
        style={styles.input}
        placeholder="Port"
        placeholderTextColor="#666"
        keyboardType="number-pad"
        value={port}
        onChangeText={setPort}
      />
      <TextInput
        style={styles.input}
        placeholder="Pairing token"
        placeholderTextColor="#666"
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
      />
      <TouchableOpacity style={styles.button} onPress={submitManual}>
        <Text style={styles.buttonText}>Connect</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <Text style={styles.title}>remcontrol</Text>
      <View style={styles.tabs}>
        {(['scan', 'discover', 'manual'] as const).map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => {
              setTab(t);
              setError(null);
            }}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'scan' ? 'Scan' : t === 'discover' ? 'Discover' : 'Manual'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.content}>
        {tab === 'scan' && renderScan()}
        {tab === 'discover' && renderDiscover()}
        {tab === 'manual' && renderManual()}
      </View>
      {busy && <Text style={styles.status}>Connecting…</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    paddingTop: 64,
    paddingHorizontal: 20,
  },
  title: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 24,
  },
  tabs: {
    flexDirection: 'row',
    marginBottom: 20,
  },
  tab: {
    flex: 1,
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: '#333',
    alignItems: 'center',
  },
  tabActive: {
    borderBottomColor: '#4da6ff',
  },
  tabText: {
    color: '#888',
    fontSize: 15,
  },
  tabTextActive: {
    color: '#4da6ff',
    fontWeight: '600',
  },
  content: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  cameraWrap: {
    flex: 1,
    borderRadius: 12,
    overflow: 'hidden',
    justifyContent: 'flex-end',
  },
  scanHint: {
    color: '#fff',
    backgroundColor: 'rgba(0,0,0,0.6)',
    textAlign: 'center',
    padding: 10,
  },
  form: {
    gap: 12,
  },
  input: {
    backgroundColor: '#1d1d1d',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: '#4da6ff',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  buttonText: {
    color: '#0a0a0a',
    fontSize: 16,
    fontWeight: '600',
  },
  link: {
    color: '#4da6ff',
    textAlign: 'center',
    paddingVertical: 8,
  },
  hint: {
    color: '#aaa',
    fontSize: 15,
    textAlign: 'center',
  },
  listItem: {
    backgroundColor: '#1d1d1d',
    borderRadius: 8,
    padding: 14,
    marginBottom: 10,
  },
  listItemName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  listItemAddress: {
    color: '#888',
    fontSize: 14,
    marginTop: 2,
  },
  status: {
    color: '#4da6ff',
    textAlign: 'center',
    paddingVertical: 12,
  },
  error: {
    color: '#ff6b6b',
    textAlign: 'center',
    paddingVertical: 12,
  },
});
