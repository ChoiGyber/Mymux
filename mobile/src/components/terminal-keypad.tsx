import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

const TERMINAL_KEYS = [
  { label: 'Ctrl+C', data: '\u0003' },
  { label: 'Ctrl+D', data: '\u0004' },
  { label: 'Esc', data: '\u001b' },
  { label: 'Tab', data: '\t' },
  { label: 'Up', data: '\u001b[A' },
  { label: 'Down', data: '\u001b[B' },
  { label: 'Left', data: '\u001b[D' },
  { label: 'Right', data: '\u001b[C' },
  { label: 'Home', data: '\u001b[H' },
  { label: 'End', data: '\u001b[F' },
  { label: 'PgUp', data: '\u001b[5~' },
  { label: 'PgDn', data: '\u001b[6~' },
  { label: 'Ctrl+L', data: '\u000c' },
] as const;

type TerminalKeypadProps = {
  onPressKey: (data: string) => void;
};

export function TerminalKeypad({ onPressKey }: TerminalKeypadProps) {
  return (
    <ScrollView
      horizontal
      accessibilityLabel="터미널 키"
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="always"
      showsHorizontalScrollIndicator={false}>
      {TERMINAL_KEYS.map(({ label, data }) => (
        <Pressable
          key={label}
          accessibilityRole="button"
          accessibilityLabel={`Terminal ${label}`}
          onPress={() => onPressKey(data)}
          style={styles.key}>
          <Text style={styles.label}>{label}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flexGrow: 0, marginTop: 7 },
  content: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  key: {
    minWidth: 38,
    minHeight: 34,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: 7,
    backgroundColor: '#202632',
    borderWidth: 1,
    borderColor: '#2b3340',
  },
  label: { color: '#edf1f7', fontSize: 11, fontWeight: '700' },
});
