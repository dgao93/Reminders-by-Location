import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';
import * as Notifications from 'expo-notifications';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

export default function HomeScreen() {
  const [intervalMinutes, setIntervalMinutes] = useState('120');
  const [hour, setHour] = useState('9');
  const [minute, setMinute] = useState('0');
  const [status, setStatus] = useState('');
  const [permissionGranted, setPermissionGranted] = useState(false);

  useEffect(() => {
    const requestPermissions = async () => {
      const current = await Notifications.getPermissionsAsync();
      if (current.granted) {
        setPermissionGranted(true);
        return;
      }
      const requested = await Notifications.requestPermissionsAsync();
      setPermissionGranted(requested.granted);
      if (!requested.granted) {
        setStatus('Notifications are off. Turn them on in Settings to receive alerts.');
      }
    };

    void requestPermissions();
  }, []);

  const scheduleInterval = async () => {
    if (!permissionGranted) {
      setStatus('Please allow notifications first.');
      return;
    }

    const minutes = Number(intervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      setStatus('Enter a valid number of minutes.');
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Interval Reminder',
        body: `This repeats every ${minutes} minutes.`,
      },
      trigger: {
        type: 'timeInterval',
        seconds: Math.round(minutes * 60),
        repeats: true,
      },
    });

    setStatus(`Scheduled an interval reminder every ${minutes} minutes.`);
  };

  const scheduleDaily = async () => {
    if (!permissionGranted) {
      setStatus('Please allow notifications first.');
      return;
    }

    const hourNumber = Number(hour);
    const minuteNumber = Number(minute);
    const hourValid = Number.isInteger(hourNumber) && hourNumber >= 0 && hourNumber <= 23;
    const minuteValid = Number.isInteger(minuteNumber) && minuteNumber >= 0 && minuteNumber <= 59;

    if (!hourValid || !minuteValid) {
      setStatus('Enter a valid time (HH 0-23, MM 0-59).');
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Daily Reminder',
        body: `This fires every day at ${hourNumber.toString().padStart(2, '0')}:${minuteNumber
          .toString()
          .padStart(2, '0')}.`,
      },
      trigger: {
        type: 'calendar',
        hour: hourNumber,
        minute: minuteNumber,
        repeats: true,
      },
    });

    setStatus('Scheduled a daily reminder.');
  };

  const clearAll = async () => {
    await Notifications.cancelAllScheduledNotificationsAsync();
    setStatus('All scheduled notifications cleared.');
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <ThemedText type="title">Custom Notifications</ThemedText>
      <ThemedText style={styles.subtitle}>
        Set repeating reminders by interval or daily time. Everything runs on the phone.
      </ThemedText>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">Repeat every X minutes</ThemedText>
        <ThemedView style={styles.row}>
          <TextInput
            value={intervalMinutes}
            onChangeText={setIntervalMinutes}
            placeholder="120"
            keyboardType="number-pad"
            inputMode="numeric"
            style={styles.input}
          />
          <ThemedText style={styles.inlineLabel}>minutes</ThemedText>
        </ThemedView>
        <Pressable style={styles.button} onPress={scheduleInterval}>
          <ThemedText type="defaultSemiBold">Schedule interval</ThemedText>
        </Pressable>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">Daily at a time</ThemedText>
        <ThemedView style={styles.row}>
          <TextInput
            value={hour}
            onChangeText={setHour}
            placeholder="HH"
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={2}
            style={styles.timeInput}
          />
          <ThemedText style={styles.timeSeparator}>:</ThemedText>
          <TextInput
            value={minute}
            onChangeText={setMinute}
            placeholder="MM"
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={2}
            style={styles.timeInput}
          />
        </ThemedView>
        <Pressable style={styles.button} onPress={scheduleDaily}>
          <ThemedText type="defaultSemiBold">Schedule daily</ThemedText>
        </Pressable>
      </ThemedView>

      <Pressable style={styles.clearButton} onPress={clearAll}>
        <ThemedText type="defaultSemiBold">Clear all scheduled notifications</ThemedText>
      </Pressable>

      {status ? <ThemedText style={styles.status}>{status}</ThemedText> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: 20,
    gap: 16,
  },
  subtitle: {
    opacity: 0.8,
  },
  card: {
    gap: 12,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#d0d0d0',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderColor: '#c0c0c0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 90,
  },
  timeInput: {
    borderWidth: 1,
    borderColor: '#c0c0c0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    minWidth: 60,
    textAlign: 'center',
  },
  timeSeparator: {
    fontSize: 18,
  },
  inlineLabel: {
    fontSize: 16,
  },
  button: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#b0b0b0',
  },
  clearButton: {
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#b84a4a',
  },
  status: {
    marginTop: 4,
  },
});
