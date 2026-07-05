import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef, useState } from 'react';
import {
  Dimensions,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Connection } from '../connection';
import { forgetConnection, loadRecentConnections, saveConnection } from '../storage';
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

type Tab = 'scan' | 'discover' | 'manual' | 'recent';

interface Discovered {
  name: string;
  ip: string;
  port: number;
}

interface Props {
  onConnected: (conn: Connection, info: ServerInfo) => void;
}

function displayName(info: ServerInfo): string {
  return info.name?.trim() || `${info.ip}:${info.port}`;
}

export default function ConnectScreen({ onConnected }: Props) {
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<Tab>('scan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [permission, requestPermission] = useCameraPermissions();
  const scannedRef = useRef(false);

  const [discovered, setDiscovered] = useState<Discovered[]>([]);
  const [zeroconfAvailable, setZeroconfAvailable] = useState(true);
  const [pendingServer, setPendingServer] = useState<Discovered | null>(null);

  const [recent, setRecent] = useState<ServerInfo[]>([]);
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('17890');
  const [token, setToken] = useState('');

  useEffect(() => {
    void loadRecentConnections().then(setRecent);
  }, []);

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
        void saveConnection(info).then(setRecent);
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
        connect({ ...info, name: typeof info.name === 'string' ? info.name : undefined });
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

  const forget = async (info: ServerInfo) => {
    setRecent(await forgetConnection(info));
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
    const width = Math.min(Dimensions.get('window').width - 40, 360);
    return (
      <View style={styles.scanColumn}>
        <View style={[styles.cameraFrame, { width, height: width }]}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onBarcode}
          />
        </View>
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
              connect({
                ip: pendingServer.ip,
                port: pendingServer.port,
                token: token.trim(),
                name: pendingServer.name,
              })
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

  const renderRecent = () => {
    if (recent.length === 0) {
      return (
        <View style={styles.center}>
          <Text style={styles.hint}>No saved servers yet. Scan a QR code or connect manually.</Text>
        </View>
      );
    }
    return (
      <FlatList
        data={recent}
        keyExtractor={(item) => `${item.ip}:${item.port}`}
        renderItem={({ item }) => (
          <View style={styles.listItemRow}>
            <TouchableOpacity style={styles.listItem} onPress={() => connect(item)} disabled={busy}>
              <Text style={styles.listItemName}>{displayName(item)}</Text>
              <Text style={styles.listItemAddress}>
                {item.ip}:{item.port}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.forgetButton}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              onPress={() => void forget(item)}
            >
              <Text style={styles.forgetText}>✕</Text>
            </TouchableOpacity>
          </View>
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

  const tabs: Tab[] = ['scan', 'discover', 'manual'];
  if (recent.length > 0) tabs.push('recent');

  return (
    <View style={[styles.container, { paddingTop: insets.top + 16 }]}>
      <Text style={styles.title}>remcontrol</Text>
      <View style={styles.tabs}>
        {tabs.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.tab, tab === t && styles.tabActive]}
            onPress={() => {
              setTab(t);
              setError(null);
            }}
          >
            <Text style={[styles.tabText, tab === t && styles.tabTextActive]}>
              {t === 'scan'
                ? 'Scan'
                : t === 'discover'
                  ? 'Discover'
                  : t === 'manual'
                    ? 'Manual'
                    : 'Recent'}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <View style={styles.content}>
        {tab === 'scan' && renderScan()}
        {tab === 'discover' && renderDiscover()}
        {tab === 'manual' && renderManual()}
        {tab === 'recent' && renderRecent()}
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
    paddingHorizontal: 20,
    paddingBottom: 12,
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
  scanColumn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  cameraFrame: {
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  scanHint: {
    color: '#aaa',
    fontSize: 15,
    textAlign: 'center',
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
  listItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
  },
  listItem: {
    flex: 1,
    backgroundColor: '#1d1d1d',
    borderRadius: 8,
    padding: 14,
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
  forgetButton: {
    marginLeft: 10,
    padding: 8,
  },
  forgetText: {
    color: '#888',
    fontSize: 16,
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
