import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Connection } from '../connection';

interface Props {
  connection: Connection;
  onDisconnect: () => void;
}

export default function TrackpadScreen({ onDisconnect }: Props) {
  return (
    <View style={styles.container}>
      <Text style={styles.placeholder}>Trackpad coming in the next task</Text>
      <TouchableOpacity onPress={onDisconnect}>
        <Text style={styles.disconnect}>Disconnect</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  placeholder: {
    color: '#aaa',
  },
  disconnect: {
    color: '#4da6ff',
  },
});
