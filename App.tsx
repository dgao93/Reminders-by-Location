import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import * as Notifications from 'expo-notifications';

import { buildNotificationQueue, ScheduleRule } from './src/scheduler';
import { loadSettings, saveSettings, Schedule, StoredSettings } from './src/storage';

const DEFAULT_MESSAGE = 'Time to check in.';
const MIN_INTERVAL = 5;
const MAX_INTERVAL = 180;
const DEFAULT_DAYS = [true, true, true, true, true, true, true];
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FONT_REGULAR = Platform.select({ ios: 'System', android: 'sans-serif' });
const FONT_MEDIUM = Platform.select({ ios: 'System', android: 'sans-serif-medium' });
const FONT_BOLD = Platform.select({ ios: 'System', android: 'sans-serif-medium' });

const getDefaultNotificationName = (index: number) => `Notification ${index + 1}`;
const normalizeDaysOfWeek = (value?: boolean[]) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return DEFAULT_DAYS;
  }
  return value.map((entry) => Boolean(entry));
};

const areDaysEqual = (left?: boolean[], right?: boolean[]) => {
  const leftDays = normalizeDaysOfWeek(left);
  const rightDays = normalizeDaysOfWeek(right);
  return leftDays.every((value, index) => value === rightDays[index]);
};

const formatNotificationName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/(^\\w)|(\\s+\\w)/g, (match) => match.toUpperCase());
};

const createSchedule = (name: string): Schedule => ({
  id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
  name,
  intervalMinutes: 30,
  startMinutesFromMidnight: 9 * 60,
  endMinutesFromMidnight: 21 * 60,
  daysOfWeek: DEFAULT_DAYS.slice(),
  message: '',
  isActive: false,
});

const DEFAULT_SETTINGS: StoredSettings = {
  schedules: [createSchedule(getDefaultNotificationName(0))],
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export default function App() {
  const colorScheme = useColorScheme();
  const colors = colorScheme === 'dark' ? darkColors : lightColors;
  const [schedules, setSchedules] = useState<Schedule[]>(DEFAULT_SETTINGS.schedules);
  const [authorizationStatus, setAuthorizationStatus] = useState<'authorized' | 'denied' | 'unknown'>(
    'unknown'
  );
  const [inlineMessage, setInlineMessage] = useState('');
  const [activePicker, setActivePicker] = useState<null | { scheduleId: string; kind: 'start' | 'end' }>(
    null
  );
  const [isNamePromptOpen, setIsNamePromptOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [namePromptMode, setNamePromptMode] = useState<'add' | 'edit'>('add');
  const [namePromptScheduleId, setNamePromptScheduleId] = useState<string | null>(null);
  const [menuScheduleId, setMenuScheduleId] = useState<string | null>(null);
  const [collapsedSchedules, setCollapsedSchedules] = useState<string[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const previousSchedulesRef = useRef<Schedule[]>([]);
  const rescheduleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const hydrate = async () => {
      const stored = await loadSettings();
      if (stored?.schedules?.length) {
        setSchedules(
          stored.schedules.map((schedule) => ({
            ...schedule,
            message: schedule.message === DEFAULT_MESSAGE ? '' : schedule.message,
            isActive: schedule.isActive ?? false,
          }))
        );
      }
      await refreshAuthorization();
      setIsHydrated(true);
    };
    void hydrate();
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    void saveSettings({
      schedules,
    });
  }, [schedules, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const previousSchedules = previousSchedulesRef.current;
    const previousById = new Map(previousSchedules.map((schedule) => [schedule.id, schedule]));
    for (const schedule of schedules) {
      const previous = previousById.get(schedule.id);
      if (!previous || !schedule.isActive || !previous.isActive) {
        continue;
      }
      const hasChanged =
        schedule.intervalMinutes !== previous.intervalMinutes ||
        schedule.startMinutesFromMidnight !== previous.startMinutesFromMidnight ||
        schedule.endMinutesFromMidnight !== previous.endMinutesFromMidnight ||
        schedule.message !== previous.message ||
        !areDaysEqual(schedule.daysOfWeek, previous.daysOfWeek);
      if (hasChanged) {
        debouncedReschedule(schedule);
      }
    }
    previousSchedulesRef.current = schedules;
  }, [schedules, isHydrated]);

  const activeSchedules = useMemo(
    () => schedules.filter((schedule) => schedule.isActive),
    [schedules]
  );

  const nextAlertText = useMemo(() => {
    if (activeSchedules.length === 0) {
      return 'Next alert: --';
    }
    const queue = buildQueue(activeSchedules);
    if (queue.length === 0) {
      return 'Next alert: --';
    }
    const formatter = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
    return `Next alert: ${formatter.format(queue[0].date)}`;
  }, [activeSchedules]);

  const refreshAuthorization = async () => {
    const settings = await Notifications.getPermissionsAsync();
    if (settings.status === 'granted') {
      setAuthorizationStatus('authorized');
      return;
    }
    if (settings.status === 'denied') {
      setAuthorizationStatus('denied');
      return;
    }
    setAuthorizationStatus('unknown');
  };

  const requestAuthorization = async () => {
    const response = await Notifications.requestPermissionsAsync();
    if (response.granted) {
      setAuthorizationStatus('authorized');
      return true;
    }
    setAuthorizationStatus('denied');
    return false;
  };

  const clearRescheduleTimer = (scheduleId: string) => {
    const existing = rescheduleTimers.current.get(scheduleId);
    if (existing) {
      clearTimeout(existing);
      rescheduleTimers.current.delete(scheduleId);
    }
  };

  function buildQueue(targetSchedules: Schedule[]) {
    const horizonHours = 24 * 7;
    const scheduleRules: ScheduleRule[] = targetSchedules.map((schedule) => ({
      id: schedule.id,
      intervalMinutes: schedule.intervalMinutes,
      startMinutesFromMidnight: schedule.startMinutesFromMidnight,
      endMinutesFromMidnight: schedule.endMinutesFromMidnight,
      message: schedule.message,
      daysOfWeek: schedule.daysOfWeek,
    }));

    return buildNotificationQueue({
      now: new Date(),
      schedules: scheduleRules,
      maxCount: 50,
      horizonHours,
    });
  }

  const scheduleBatch = async (targetSchedules: Schedule[]) => {
    const queue = buildQueue(targetSchedules);
    if (queue.length === 0) {
      return { count: 0 };
    }

    let scheduled = 0;
    for (const item of queue) {
      try {
        await Notifications.scheduleNotificationAsync({
          content: {
            title: 'Ping',
            body: item.message.trim() || DEFAULT_MESSAGE,
            sound: 'default',
            data: { scheduleId: item.scheduleId },
          },
          trigger: {
            type: 'date',
            date: item.date,
          },
        });
        scheduled += 1;
      } catch (error) {
        return { count: scheduled, error: formatError(error) };
      }
    }

    return { count: scheduled };
  };

  const cancelScheduleNotifications = async (scheduleId: string) => {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const matches = scheduled.filter((item) => {
      const data = item.content?.data as { scheduleId?: string } | undefined;
      return data?.scheduleId === scheduleId;
    });
    for (const item of matches) {
      await Notifications.cancelScheduledNotificationAsync(item.identifier);
    }
    return matches.length;
  };

  const setScheduleActive = (scheduleId: string, isActive: boolean) => {
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === scheduleId ? { ...schedule, isActive } : schedule
      )
    );
  };

  const rescheduleSchedule = async (
    schedule: Schedule,
    options?: { silent?: boolean; preserveActive?: boolean }
  ) => {
    const silentSuccess = options?.silent ?? true;
    const preserveActive = options?.preserveActive ?? false;
    if (authorizationStatus !== 'authorized') {
      setInlineMessage('Notifications are off. You can enable them in Settings.');
      if (!preserveActive) {
        setScheduleActive(schedule.id, false);
      }
      return;
    }

    try {
      await cancelScheduleNotifications(schedule.id);
      const result = await scheduleBatch([schedule]);
      if (result.error) {
        setInlineMessage(`Notification setup failed: ${result.error}`);
        if (!preserveActive) {
          setScheduleActive(schedule.id, false);
        }
        return;
      }
      if (result.count === 0) {
        setInlineMessage('No alerts in the next 7 days. Adjust the window.');
        if (!preserveActive) {
          setScheduleActive(schedule.id, false);
        }
        return;
      }
      if (!silentSuccess) {
        setInlineMessage(`Scheduled ${result.count} alerts.`);
      }
    } catch (error) {
      setInlineMessage(`Could not schedule notifications. ${formatError(error)}`);
      if (!preserveActive) {
        setScheduleActive(schedule.id, false);
      }
    }
  };

  const debouncedReschedule = (schedule: Schedule) => {
    clearRescheduleTimer(schedule.id);
    const timer = setTimeout(() => {
      rescheduleTimers.current.delete(schedule.id);
      void rescheduleSchedule(schedule, { silent: true, preserveActive: true });
    }, 300);
    rescheduleTimers.current.set(schedule.id, timer);
  };

  const onStartSchedule = async (scheduleId: string) => {
    const schedule = schedules.find((item) => item.id === scheduleId);
    if (!schedule) {
      return;
    }
    setInlineMessage('Setting notifications...');
    try {
      const granted =
        authorizationStatus === 'authorized' ? true : await requestAuthorization();
      if (!granted) {
        setInlineMessage('Notifications are off. You can enable them in Settings.');
        return;
      }
      clearRescheduleTimer(scheduleId);
      await cancelScheduleNotifications(scheduleId);
      const result = await scheduleBatch([{ ...schedule, isActive: true }]);
      if (result.error) {
        setInlineMessage(`Notification setup failed: ${result.error}`);
        setScheduleActive(scheduleId, false);
        return;
      }
      if (result.count === 0) {
        setInlineMessage('No alerts in the next 7 days. Adjust the window.');
        setScheduleActive(scheduleId, false);
        return;
      }
      setScheduleActive(scheduleId, true);
      setInlineMessage(`Scheduled ${result.count} alerts.`);
    } catch (error) {
      setScheduleActive(scheduleId, false);
      setInlineMessage(`Could not schedule notifications. ${formatError(error)}`);
    }
  };

  const onStopSchedule = async (scheduleId: string) => {
    try {
      clearRescheduleTimer(scheduleId);
      await cancelScheduleNotifications(scheduleId);
      setScheduleActive(scheduleId, false);
      setInlineMessage('Notifications stopped for this notification.');
    } catch (error) {
      setInlineMessage(`Could not stop notifications. ${formatError(error)}`);
    }
  };

  const updateSchedule = (id: string, patch: Partial<Schedule>) => {
    setSchedules((current) =>
      current.map((schedule) =>
        schedule.id === id ? { ...schedule, ...patch } : schedule
      )
    );
  };

  const stepInterval = (id: string, direction: 1 | -1) => {
    setSchedules((current) =>
      current.map((schedule) => {
        if (schedule.id !== id) {
          return schedule;
        }
        const next = schedule.intervalMinutes + direction * 5;
        return {
          ...schedule,
          intervalMinutes: Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, next)),
        };
      })
    );
  };

  const toggleScheduleDay = (id: string, dayIndex: number) => {
    setSchedules((current) =>
      current.map((schedule) => {
        if (schedule.id !== id) {
          return schedule;
        }
        const nextDays = [...normalizeDaysOfWeek(schedule.daysOfWeek)];
        nextDays[dayIndex] = !nextDays[dayIndex];
        return { ...schedule, daysOfWeek: nextDays };
      })
    );
  };

  const toggleScheduleCollapse = (id: string) => {
    setCollapsedSchedules((current) =>
      current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]
    );
  };

  const addSchedule = () => {
    setActivePicker(null);
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'New notification',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Add',
            onPress: (text) => {
              const formatted = formatNotificationName(text ?? '');
              if (!formatted) {
                return;
              }
              setSchedules((current) => [...current, createSchedule(formatted)]);
            },
          },
        ],
        'plain-text'
      );
      return;
    }
    setNameDraft('');
    setNamePromptMode('add');
    setNamePromptScheduleId(null);
    setIsNamePromptOpen(true);
  };

  const editScheduleName = (schedule: Schedule) => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Edit notification',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: (text) => {
              const formatted = formatNotificationName(text ?? '');
              if (!formatted) {
                return;
              }
              updateSchedule(schedule.id, { name: formatted });
            },
          },
        ],
        'plain-text',
        schedule.name
      );
      return;
    }
    setNameDraft(schedule.name);
    setNamePromptMode('edit');
    setNamePromptScheduleId(schedule.id);
    setIsNamePromptOpen(true);
  };

  const closeMenu = () => {
    setMenuScheduleId(null);
  };

  const closeNamePrompt = () => {
    Keyboard.dismiss();
    setNamePromptScheduleId(null);
    setIsNamePromptOpen(false);
  };

  const confirmNamePrompt = () => {
    const formatted = formatNotificationName(nameDraft);
    if (!formatted) {
      return;
    }
    if (namePromptMode === 'add') {
      setSchedules((current) => [...current, createSchedule(formatted)]);
    } else if (namePromptMode === 'edit' && namePromptScheduleId) {
      updateSchedule(namePromptScheduleId, { name: formatted });
    }
    closeNamePrompt();
  };

  const removeSchedule = async (id: string) => {
    clearRescheduleTimer(id);
    try {
      await cancelScheduleNotifications(id);
    } catch {
      // Ignore cancellation errors during removal.
    }
    setActivePicker((current) => (current?.scheduleId === id ? null : current));
    setSchedules((current) => current.filter((schedule) => schedule.id !== id));
    setCollapsedSchedules((current) => current.filter((entry) => entry !== id));
  };

  const activeSchedule = useMemo(() => {
    if (!activePicker) {
      return null;
    }
    return schedules.find((schedule) => schedule.id === activePicker.scheduleId) ?? null;
  }, [activePicker, schedules]);

  const activePickerDate = useMemo(() => {
    if (!activePicker || !activeSchedule) {
      return new Date();
    }
    const minutes =
      activePicker.kind === 'start'
        ? activeSchedule.startMinutesFromMidnight
        : activeSchedule.endMinutesFromMidnight;
    return minutesToDate(minutes);
  }, [activePicker, activeSchedule]);

  const canConfirmName = nameDraft.trim().length > 0;
  const isEditingName = namePromptMode === 'edit';

  const onPickerChange = (_: DateTimePickerEvent, selected?: Date) => {
    if (!selected || !activePicker) {
      return;
    }
    const minutes = dateToMinutes(selected);
    if (activePicker.kind === 'start') {
      updateSchedule(activePicker.scheduleId, { startMinutesFromMidnight: minutes });
    } else {
      updateSchedule(activePicker.scheduleId, { endMinutesFromMidnight: minutes });
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
        style={styles.flex}
      >
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.container, { backgroundColor: colors.background }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="always"
          automaticallyAdjustKeyboardInsets
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>Notifications</Text>

          {schedules.map((schedule, index) => {
            const startLabel = formatTime(schedule.startMinutesFromMidnight);
            const endLabel = formatTime(schedule.endMinutesFromMidnight);
            const daysOfWeek = normalizeDaysOfWeek(schedule.daysOfWeek);
            const isCollapsed = collapsedSchedules.includes(schedule.id);
            return (
              <View
                key={schedule.id}
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.card,
                    shadowColor: colors.shadow,
                    borderColor: colors.border,
                  },
                ]}
              >
                <View style={styles.cardHeader}>
                  <Pressable
                    style={styles.cardTitleButton}
                    onPress={() => toggleScheduleCollapse(schedule.id)}
                  >
                    <Text style={[styles.cardTitleInput, { color: colors.textPrimary }]}>
                      {schedule.name?.trim()
                        ? schedule.name
                        : getDefaultNotificationName(index)}
                    </Text>
                    <View
                      style={[
                        styles.chevron,
                        { transform: [{ rotate: isCollapsed ? '0deg' : '180deg' }] },
                      ]}
                    >
                      <View
                        style={[
                          styles.chevronLine,
                          styles.chevronLeft,
                          { backgroundColor: colors.textSecondary },
                        ]}
                      />
                      <View
                        style={[
                          styles.chevronLine,
                          styles.chevronRight,
                          { backgroundColor: colors.textSecondary },
                        ]}
                      />
                    </View>
                  </Pressable>
                  <Pressable onPress={() => setMenuScheduleId(schedule.id)} hitSlop={10}>
                    <Text style={[styles.menuLabel, { color: colors.textSecondary }]}>...</Text>
                  </Pressable>
                </View>

                <View style={styles.messageBlock}>
                  <Text style={[styles.messageLabel, { color: colors.label }]}>Message</Text>
                  <TextInput
                    value={schedule.message}
                    onChangeText={(text) => updateSchedule(schedule.id, { message: text })}
                    placeholder={DEFAULT_MESSAGE}
                    placeholderTextColor={colors.placeholder}
                    style={[
                      styles.messageInput,
                      {
                        backgroundColor: colors.inputBackground,
                        color: colors.inputText,
                        borderColor: colors.border,
                      },
                    ]}
                    maxLength={120}
                    clearButtonMode="while-editing"
                    returnKeyType="done"
                    onSubmitEditing={Keyboard.dismiss}
                  />
                </View>

                {!isCollapsed ? (
                  <>
                <View
                  style={[
                    styles.intervalRow,
                    { backgroundColor: colors.inputBackground, borderColor: colors.border },
                  ]}
                >
                  <Pressable
                    style={[styles.stepperButton, { backgroundColor: colors.accent }]}
                    onPress={() => stepInterval(schedule.id, -1)}
                  >
                    <Text style={styles.stepperLabel}>-</Text>
                  </Pressable>
                      <Text style={[styles.intervalValue, { color: colors.textPrimary }]}>
                        {schedule.intervalMinutes} min
                      </Text>
                      <Pressable
                        style={[styles.stepperButton, { backgroundColor: colors.accent }]}
                        onPress={() => stepInterval(schedule.id, 1)}
                      >
                        <Text style={styles.stepperLabel}>+</Text>
                      </Pressable>
                    </View>

                <Pressable
                  style={[
                    styles.timeRow,
                    { backgroundColor: colors.inputBackground, borderColor: colors.border },
                  ]}
                  onPress={() =>
                    setActivePicker({ scheduleId: schedule.id, kind: 'start' })
                  }
                >
                  <Text style={[styles.timeLabel, { color: colors.label }]}>Start</Text>
                  <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                    {startLabel}
                  </Text>
                </Pressable>

                <Pressable
                  style={[
                    styles.timeRow,
                    { backgroundColor: colors.inputBackground, borderColor: colors.border },
                  ]}
                  onPress={() => setActivePicker({ scheduleId: schedule.id, kind: 'end' })}
                >
                  <Text style={[styles.timeLabel, { color: colors.label }]}>End</Text>
                  <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                        {endLabel}
                      </Text>
                    </Pressable>

                    <View style={styles.dayRow}>
                      {DAY_LABELS.map((label, dayIndex) => {
                        const isSelected = daysOfWeek[dayIndex];
                        return (
                          <Pressable
                            key={`${schedule.id}-${label}`}
                          style={[
                            styles.dayButton,
                          {
                            backgroundColor: isSelected ? colors.accent : colors.inputBackground,
                            borderColor: isSelected ? colors.accent : colors.border,
                          },
                        ]}
                        onPress={() => toggleScheduleDay(schedule.id, dayIndex)}
                      >
                        <Text
                          style={[
                            styles.dayLabel,
                            { color: isSelected ? '#FFFFFF' : colors.textSecondary },
                          ]}
                        >
                              {label}
                            </Text>
                          </Pressable>
                        );
                      })}
                    </View>

                    <Text style={[styles.helperText, { color: colors.textMuted }]}>
                      Sends alerts within this window
                    </Text>

                <Pressable
                  style={[
                    styles.cardButton,
                    { backgroundColor: schedule.isActive ? colors.stop : colors.accent },
                  ]}
                  onPress={() =>
                    schedule.isActive
                      ? void onStopSchedule(schedule.id)
                      : void onStartSchedule(schedule.id)
                  }
                  hitSlop={8}
                >
                  <Text style={styles.cardButtonLabel}>
                    {schedule.isActive ? 'Stop' : 'Start'}
                  </Text>
                </Pressable>
                  </>
                ) : null}
              </View>
            );
          })}

          <Pressable
            style={[
              styles.secondaryButton,
              { backgroundColor: colors.accent, borderColor: colors.accent },
            ]}
            onPress={addSchedule}
          >
            <Text style={[styles.secondaryButtonLabel, { color: '#FFFFFF' }]}>
              Add notification
            </Text>
          </Pressable>

          <Text style={[styles.previewText, { color: colors.textSecondary }]}>{nextAlertText}</Text>

          {inlineMessage ? (
            <Text style={[styles.inlineMessage, { color: colors.inline }]}>{inlineMessage}</Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>

      {isNamePromptOpen ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View
            style={[
              styles.namePrompt,
              {
                backgroundColor: colors.sheet,
                borderColor: colors.border,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <Text style={[styles.namePromptTitle, { color: colors.textPrimary }]}>
              {isEditingName ? 'Edit notification' : 'New notification'}
            </Text>
            <TextInput
              value={nameDraft}
              onChangeText={setNameDraft}
              placeholder="Notification name"
              placeholderTextColor={colors.placeholder}
              style={[
                styles.namePromptInput,
                {
                  backgroundColor: colors.inputBackground,
                  color: colors.inputText,
                  borderColor: colors.border,
                },
              ]}
              autoCapitalize="words"
              autoFocus
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={confirmNamePrompt}
            />
            <View style={styles.namePromptActions}>
              <Pressable onPress={closeNamePrompt} hitSlop={8}>
                <Text style={[styles.namePromptCancel, { color: colors.textSecondary }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                onPress={confirmNamePrompt}
                disabled={!canConfirmName}
                style={[
                  styles.namePromptButton,
                  { backgroundColor: canConfirmName ? colors.accent : colors.placeholder },
                ]}
              >
                <Text style={styles.namePromptButtonLabel}>
                  {isEditingName ? 'Save' : 'Add'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}

      {menuScheduleId ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeMenu} />
          <View
            style={[
              styles.menuSheet,
              {
                backgroundColor: colors.sheet,
                borderColor: colors.border,
                shadowColor: colors.shadow,
              },
            ]}
          >
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const schedule = schedules.find((item) => item.id === menuScheduleId);
                closeMenu();
                if (schedule) {
                  editScheduleName(schedule);
                }
              }}
            >
              <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>Edit</Text>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const schedule = schedules.find((item) => item.id === menuScheduleId);
                closeMenu();
                if (schedule) {
                  void removeSchedule(schedule.id);
                }
              }}
            >
              <Text style={[styles.menuItemText, { color: colors.remove }]}>Remove</Text>
            </Pressable>
            <Pressable style={styles.menuCancel} onPress={closeMenu}>
              <Text style={[styles.menuCancelText, { color: colors.textSecondary }]}>
                Cancel
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {activePicker && activeSchedule ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View style={[styles.sheet, { backgroundColor: colors.sheet }]}> 
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>
                {activePicker.kind === 'start' ? 'Start time' : 'End time'}
              </Text>
              <Pressable onPress={() => setActivePicker(null)}>
                <Text style={[styles.sheetDone, { color: colors.accent }]}>Done</Text>
              </Pressable>
            </View>
            <DateTimePicker
              value={activePickerDate}
              mode="time"
              display="spinner"
              themeVariant={colorScheme === 'dark' ? 'dark' : 'light'}
              textColor={colors.textPrimary}
              onChange={onPickerChange}
            />
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

const minutesToDate = (minutes: number) => {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setMinutes(minutes);
  return date;
};

const dateToMinutes = (date: Date) => date.getHours() * 60 + date.getMinutes();

const formatTime = (minutes: number) => {
  const date = minutesToDate(minutes);
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'short' }).format(date);
};

const formatError = (error: unknown) => {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return 'Please try again.';
};

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  container: {
    padding: 18,
    paddingBottom: 220,
    gap: 12,
    minHeight: '100%',
  },
  scroll: {
    flex: 1,
  },
  title: {
    fontSize: 32,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
    letterSpacing: 0.2,
  },
  card: {
    borderRadius: 18,
    padding: 16,
    gap: 12,
    borderWidth: 1,
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 2,
  },
  cardTitleButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingRight: 20,
  },
  cardTitleInput: {
    fontSize: 17,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
    flex: 1,
    marginRight: 12,
    paddingVertical: 0,
    paddingHorizontal: 0,
  },
  chevron: {
    width: 16,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevronLine: {
    position: 'absolute',
    width: 10,
    height: 2,
    borderRadius: 2,
  },
  chevronLeft: {
    transform: [{ rotate: '45deg' }],
    left: 0,
  },
  chevronRight: {
    transform: [{ rotate: '-45deg' }],
    right: 0,
  },
  menuLabel: {
    fontSize: 20,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
    letterSpacing: 1,
  },
  intervalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
  },
  stepperButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepperLabel: {
    fontSize: 20,
    color: '#FFFFFF',
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  intervalValue: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  timeLabel: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  timeValue: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  dayRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  dayButton: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 8,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayLabel: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
  },
  helperText: {
    fontSize: 12,
    fontFamily: FONT_REGULAR,
  },
  messageBlock: {
    gap: 6,
  },
  messageLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  messageInput: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontFamily: FONT_REGULAR,
    borderWidth: 1,
  },
  cardButton: {
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
  },
  cardButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  secondaryButton: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryButtonLabel: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  previewText: {
    fontSize: 12,
    fontFamily: FONT_REGULAR,
  },
  inlineMessage: {
    fontSize: 12,
    fontFamily: FONT_REGULAR,
  },
  namePrompt: {
    marginHorizontal: 18,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    gap: 12,
  },
  namePromptTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  namePromptInput: {
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    fontFamily: FONT_REGULAR,
    borderWidth: 1,
  },
  namePromptActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  namePromptCancel: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  namePromptButton: {
    borderRadius: 12,
    paddingHorizontal: 18,
    paddingVertical: 10,
  },
  namePromptButtonLabel: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  menuSheet: {
    marginHorizontal: 18,
    marginBottom: 18,
    borderRadius: 16,
    borderWidth: 1,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
    paddingVertical: 6,
  },
  menuItem: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  menuItemText: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
  },
  menuCancel: {
    paddingHorizontal: 20,
    paddingVertical: 12,
  },
  menuCancelText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
    textAlign: 'center',
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  sheet: {
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 24,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: 8,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '600',
  },
  sheetDone: {
    fontSize: 16,
    fontWeight: '600',
  },
});

const lightColors = {
  background: '#F2F2F7',
  card: '#FFFFFF',
  textPrimary: '#1C1C1E',
  textSecondary: '#6E6E73',
  textMuted: '#8E8E93',
  label: '#3A3A3C',
  inputBackground: '#F4F4F8',
  inputText: '#1C1C1E',
  placeholder: '#8E8E93',
  accent: '#0A84FF',
  stop: '#FF3B30',
  shadow: '#000000',
  inline: '#8E6C6C',
  sheet: '#FFFFFF',
  sheetBackdrop: 'rgba(0, 0, 0, 0.35)',
  remove: '#FF3B30',
  border: '#E5E5EA',
};

const darkColors = {
  background: '#0B0B0D',
  card: '#1C1C1E',
  textPrimary: '#F2F2F7',
  textSecondary: '#AEAEB2',
  textMuted: '#8E8E93',
  label: '#D1D1D6',
  inputBackground: '#2C2C2E',
  inputText: '#F2F2F7',
  placeholder: '#8E8E93',
  accent: '#0A84FF',
  stop: '#FF453A',
  shadow: '#000000',
  inline: '#C6A3A3',
  sheet: '#1C1C1E',
  sheetBackdrop: 'rgba(0, 0, 0, 0.6)',
  remove: '#FF453A',
  border: '#3A3A3C',
};
