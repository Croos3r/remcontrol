import { type BarcodeScanningResult, CameraView, useCameraPermissions } from 'expo-camera';
import { type ComponentProps, useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Platform,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '../components/Buttons';
import { Card } from '../components/Card';
import { Chip } from '../components/Chip';
import { GradientHeader } from '../components/GradientHeader';
import { Icon } from '../components/Icon';
import { TabBar } from '../components/TabBar';
import { Connection } from '../connection';
import { DEFAULT_PREFS, loadPrefs, type Prefs, savePrefs } from '../prefs';
import { probeServer } from '../probe';
import { SENSITIVITIES } from '../sensitivity';
import { forgetConnection, loadRecentConnections, saveConnection } from '../storage';
import { radius, spacing, useTheme } from '../theme';
import type { ServerInfo } from '../types';

const LOGO = require('../../assets/brand/logo.png');

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

type Tab = 'scan' | 'discover' | 'manual' | 'recent' | 'settings';

type ReachStatus = 'checking' | 'ok' | 'fail';

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

function serverKey(ip: string, port: number): string {
  return `${ip}:${port}`;
}

const TAB_LABELS: Record<Tab, string> = {
  scan: 'Scan',
  discover: 'Discover',
  manual: 'Manual',
  recent: 'Recent',
  settings: 'Settings',
};

const TAB_ICONS: Record<Tab, ComponentProps<typeof Icon>['name']> = {
  scan: 'scan-outline',
  discover: 'wifi-outline',
  manual: 'create-outline',
  recent: 'time-outline',
  settings: 'settings-outline',
};

export default function ConnectScreen({ onConnected }: Props) {
  const theme = useTheme();
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
  const [statuses, setStatuses] = useState<Record<string, ReachStatus>>({});
  const [prefs, setPrefs] = useState<Prefs>(DEFAULT_PREFS);
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('17890');
  const [token, setToken] = useState('');

  useEffect(() => {
    void loadRecentConnections().then(setRecent);
    void loadPrefs().then(setPrefs);
  }, []);

  const updatePrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      void savePrefs(next);
      return next;
    });
  }, []);

  const probeAll = useCallback((servers: ServerInfo[]) => {
    setStatuses((prev) => {
      const next = { ...prev };
      for (const s of servers) next[serverKey(s.ip, s.port)] = 'checking';
      return next;
    });
    for (const s of servers) {
      const key = serverKey(s.ip, s.port);
      void probeServer(s).then((ok) => {
        setStatuses((prev) => ({ ...prev, [key]: ok ? 'ok' : 'fail' }));
      });
    }
  }, []);

  useEffect(() => {
    if (tab === 'recent') probeAll(recent);
  }, [tab, recent, probeAll]);

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
    const next = await forgetConnection(info);
    setRecent(next);
    setStatuses((prev) => {
      const key = serverKey(info.ip, info.port);
      if (!(key in prev)) return prev;
      const rest = { ...prev };
      delete rest[key];
      return rest;
    });
  };

  const renderScan = () => {
    if (!permission?.granted) {
      return (
        <View style={styles.center}>
          <Icon name="scan-outline" size={48} color={theme.muted} />
          <Text style={[styles.hint, { color: theme.muted }]}>
            Camera access is needed to scan the QR code.
          </Text>
          <Button label="Allow camera" onPress={() => void requestPermission()} />
        </View>
      );
    }
    const width = Math.min(Dimensions.get('window').width - 96, 320);
    return (
      <View style={styles.scanColumn}>
        <View style={[styles.cameraFrame, { width, height: width, borderColor: theme.navy }]}>
          <CameraView
            style={StyleSheet.absoluteFill}
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onBarcode}
          />
        </View>
        <Text style={[styles.scanHint, { color: theme.muted }]}>
          Point at the QR code in the server terminal
        </Text>
      </View>
    );
  };

  const renderDiscover = () => {
    if (!zeroconfAvailable) {
      return (
        <View style={styles.center}>
          <Icon name="wifi-outline" size={48} color={theme.muted} />
          <Text style={[styles.hint, { color: theme.muted }]}>
            Discovery is unavailable in this build.
          </Text>
        </View>
      );
    }
    if (pendingServer) {
      return (
        <View style={styles.form}>
          <Text style={[styles.hint, { color: theme.muted }]}>
            Token for {pendingServer.name} ({pendingServer.ip}:{pendingServer.port})
          </Text>
          <TextInput
            style={[styles.input, inputStyle(theme)]}
            placeholder="Pairing token"
            placeholderTextColor={theme.disabledText}
            autoCapitalize="none"
            autoCorrect={false}
            value={token}
            onChangeText={setToken}
          />
          <Button
            label="Connect"
            onPress={() =>
              connect({
                ip: pendingServer.ip,
                port: pendingServer.port,
                token: token.trim(),
                name: pendingServer.name,
              })
            }
          />
          <TouchableOpacity onPress={() => setPendingServer(null)} hitSlop={8}>
            <Text style={[styles.link, { color: theme.primary }]}>Back to the list</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return (
      <FlatList
        data={discovered}
        keyExtractor={(item) => `${item.ip}:${item.port}`}
        contentContainerStyle={discovered.length === 0 ? styles.center : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Icon name="wifi-outline" size={48} color={theme.muted} />
            <Text style={[styles.hint, { color: theme.muted }]}>Searching for servers…</Text>
          </View>
        }
        renderItem={({ item }) => (
          <ServerRow
            name={item.name}
            address={`${item.ip}:${item.port}`}
            onPress={() => setPendingServer(item)}
          />
        )}
      />
    );
  };

  const renderRecent = () => {
    if (recent.length === 0) {
      return (
        <View style={styles.center}>
          <Icon name="time-outline" size={48} color={theme.muted} />
          <Text style={[styles.hint, { color: theme.muted }]}>
            No saved servers yet. Scan a QR code or connect manually.
          </Text>
        </View>
      );
    }
    return (
      <FlatList
        data={recent}
        keyExtractor={(item) => serverKey(item.ip, item.port)}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <View style={{ flex: 1 }}>
              <ServerRow
                name={displayName(item)}
                address={`${item.ip}:${item.port}`}
                onPress={() => connect(item)}
                disabled={busy}
                status={statuses[serverKey(item.ip, item.port)]}
              />
            </View>
            <TouchableOpacity
              style={[styles.forgetButton, { borderColor: theme.border }]}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              accessibilityRole="button"
              accessibilityLabel="Forget server"
              onPress={() => void forget(item)}
            >
              <Icon name="close" size={16} color={theme.muted} />
            </TouchableOpacity>
          </View>
        )}
      />
    );
  };

  const renderManual = () => (
    <View style={styles.form}>
      <TextInput
        style={[styles.input, inputStyle(theme)]}
        placeholder="IP address"
        placeholderTextColor={theme.disabledText}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="decimal-pad"
        value={ip}
        onChangeText={setIp}
      />
      <TextInput
        style={[styles.input, inputStyle(theme)]}
        placeholder="Port"
        placeholderTextColor={theme.disabledText}
        keyboardType="number-pad"
        value={port}
        onChangeText={setPort}
      />
      <TextInput
        style={[styles.input, inputStyle(theme)]}
        placeholder="Pairing token"
        placeholderTextColor={theme.disabledText}
        autoCapitalize="none"
        autoCorrect={false}
        value={token}
        onChangeText={setToken}
      />
      <Button label="Connect" onPress={submitManual} />
    </View>
  );

  const renderSettings = () => (
    <View style={styles.form}>
      <Card style={styles.settingsCard}>
        <Text style={[styles.settingsTitle, { color: theme.text }]}>Default trackpad speed</Text>
        <Text style={[styles.settingsHint, { color: theme.muted }]}>
          Used when opening the trackpad.
        </Text>
        <View style={styles.chipRow}>
          {SENSITIVITIES.map((s) => (
            <Chip
              key={s.label}
              label={s.label}
              active={prefs.defaultSensitivity === s.value}
              onPress={() => updatePrefs({ defaultSensitivity: s.value })}
            />
          ))}
        </View>
      </Card>

      <Card style={styles.settingsCard}>
        <View style={styles.settingsRow}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.settingsTitle, { color: theme.text }]}>Auto-reconnect</Text>
            <Text style={[styles.settingsHint, { color: theme.muted }]}>
              Reconnect to the last server on launch.
            </Text>
          </View>
          <Switch
            value={prefs.autoReconnect}
            onValueChange={(v) => updatePrefs({ autoReconnect: v })}
            trackColor={{ false: theme.disabled, true: theme.primary }}
            thumbColor={Platform.OS === 'android' ? theme.surface : undefined}
          />
        </View>
      </Card>
    </View>
  );

  const tabs: Tab[] = ['scan', 'discover', 'manual'];
  if (recent.length > 0) tabs.push('recent');
  tabs.push('settings');

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: theme.appBg, paddingTop: insets.top + spacing.md },
      ]}
    >
      <GradientHeader title="RemControl" subtitle="Connect a computer" icon={LOGO} />
      <TabBar
        style={styles.tabs}
        tabs={tabs.map((t) => ({ key: t, label: TAB_LABELS[t], icon: TAB_ICONS[t] }))}
        value={tab}
        onChange={(t) => {
          setTab(t);
          setError(null);
        }}
      />
      <View style={styles.content}>
        {tab === 'scan' && renderScan()}
        {tab === 'discover' && renderDiscover()}
        {tab === 'manual' && renderManual()}
        {tab === 'recent' && renderRecent()}
        {tab === 'settings' && renderSettings()}
      </View>
      {busy && (
        <View style={styles.busyRow}>
          <ActivityIndicator color={theme.primary} size="small" />
          <Text style={[styles.busyText, { color: theme.muted }]}>Connecting…</Text>
        </View>
      )}
      {error && (
        <View
          style={[styles.errorCard, { backgroundColor: theme.surface, borderColor: theme.danger }]}
        >
          <Icon name="alert-circle-outline" size={18} color={theme.danger} />
          <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>
        </View>
      )}
    </View>
  );
}

function inputStyle(theme: ReturnType<typeof useTheme>) {
  return {
    backgroundColor: theme.surface,
    color: theme.text,
    borderColor: theme.border,
    borderWidth: 1,
    borderRadius: radius.md,
  };
}

function ServerRow({
  name,
  address,
  onPress,
  disabled,
  status,
}: {
  name: string;
  address: string;
  onPress: () => void;
  disabled?: boolean;
  status?: ReachStatus;
}) {
  const theme = useTheme();
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      style={{ marginBottom: spacing.sm }}
    >
      <Card style={styles.serverCard}>
        <View style={styles.serverIcon}>
          <Icon name="desktop-outline" size={22} color={theme.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.serverName, { color: theme.text }]}>{name}</Text>
          <Text style={[styles.serverAddress, { color: theme.muted }]}>{address}</Text>
        </View>
        {status && <StatusDot status={status} />}
        <Icon name="chevron-forward" size={20} color={theme.muted} />
      </Card>
    </TouchableOpacity>
  );
}

function StatusDot({ status }: { status: ReachStatus }) {
  const theme = useTheme();
  if (status === 'checking') {
    return <ActivityIndicator size="small" color={theme.muted} style={styles.statusDot} />;
  }
  const color = status === 'ok' ? theme.ok : theme.danger;
  return <View style={[styles.statusDot, { backgroundColor: color }]} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
  tabs: {
    marginBottom: spacing.lg,
  },
  content: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.lg,
  },
  empty: {
    alignItems: 'center',
    gap: spacing.md,
  },
  list: {
    paddingBottom: spacing.lg,
  },
  scanColumn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
  },
  cameraFrame: {
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: '#000',
    borderWidth: 2,
  },
  scanHint: {
    fontSize: 14,
    textAlign: 'center',
  },
  form: {
    gap: spacing.md,
  },
  settingsCard: {
    gap: spacing.xs,
    padding: spacing.md,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  settingsTitle: {
    fontSize: 16,
    fontWeight: '700',
  },
  settingsHint: {
    fontSize: 13,
    marginTop: 2,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  input: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md + 2,
    fontSize: 16,
  },
  link: {
    textAlign: 'center',
    paddingVertical: spacing.sm,
    fontSize: 15,
    fontWeight: '600',
  },
  hint: {
    fontSize: 15,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  serverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
  },
  serverIcon: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,140,255,0.10)',
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  serverName: {
    fontSize: 16,
    fontWeight: '700',
  },
  serverAddress: {
    fontSize: 13,
    marginTop: 2,
  },
  forgetButton: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  busyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.md,
  },
  busyText: {
    fontSize: 15,
    fontWeight: '600',
  },
  errorCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginBottom: spacing.md,
  },
  errorText: {
    flex: 1,
    fontSize: 14,
    fontWeight: '600',
  },
});
