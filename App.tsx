import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  ActionSheetIOS,
  Animated,
  Easing,
  InteractionManager,
  Keyboard,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import DateTimePicker, { DateTimePickerEvent } from '@react-native-community/datetimepicker';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { StatusBar } from 'expo-status-bar';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as Notifications from 'expo-notifications';
import MapView, { Marker, Region } from 'react-native-maps';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import { ColorSchemeProvider, useColorScheme, useDarkModeToggle } from './hooks/use-color-scheme';
import { GEOFENCE_TASK } from './src/location-task';
import {
  cancelScheduleNotifications,
  DEFAULT_MESSAGE,
  NOTIFICATION_CATEGORY_ID,
  scheduleBatch as scheduleNotificationsBatch,
} from './src/notifications';
import {
  loadSettings,
  saveSettings,
  Schedule,
  StoredSettings,
  QuietHours,
  StoredLocation,
} from './src/storage';

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 180;
const DEFAULT_DAYS = [true, true, true, true, true, true, true];
const OVERNIGHT_NOTICE_KEY = 'settings.overnightNoticeShown';
const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const FONT_REGULAR = 'System';
const FONT_MEDIUM = 'System';
const FONT_BOLD = 'System';
const TAB_BAR_HEIGHT = 56;
const DEFAULT_LOCATION_RADIUS_METERS = 100;
const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startMinutesFromMidnight: 22 * 60,
  endMinutesFromMidnight: 7 * 60,
};
const ONBOARDING_KEY = 'settings.onboardingSeen';
const NOTIFICATION_ACTION_SNOOZE_PREFIX = 'SNOOZE_';
const NOTIFICATION_ACTION_SKIP = 'SKIP_NEXT';
const ANYWHERE_LABEL = 'Anywhere';
type ScheduleResult = { count: number; error?: string; skipped?: boolean };

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

const isOvernightWindow = (startMinutes: number, endMinutes: number) =>
  endMinutes < startMinutes;

const formatDaysSummary = (daysOfWeek: boolean[]) => {
  if (daysOfWeek.every(Boolean)) {
    return 'Daily';
  }
  const isWeekdays = daysOfWeek.slice(0, 5).every(Boolean) && daysOfWeek.slice(5).every((v) => !v);
  if (isWeekdays) {
    return 'Weekdays';
  }
  const isWeekends = daysOfWeek.slice(0, 5).every((v) => !v) && daysOfWeek.slice(5).every(Boolean);
  if (isWeekends) {
    return 'Weekends';
  }
  const selected = DAY_LABELS.filter((_, index) => daysOfWeek[index]);
  if (selected.length === 0) {
    return 'No days';
  }
  return selected.join(', ');
};

const formatTimeRangeSummary = (startMinutes: number, endMinutes: number) => {
  if (startMinutes === endMinutes) {
    return 'All day';
  }
  return `${formatTime(startMinutes)} - ${formatTime(endMinutes)}`;
};

const formatNotificationName = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  return trimmed.replace(/(^\\w)|(\\s+\\w)/g, (match) => match.toUpperCase());
};

const formatLocationName = (value: string) => value.trim().replace(/\\s+/g, ' ');

const createSchedule = (name: string): Schedule => ({
  id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
  name,
  intervalMinutes: 30,
  startMinutesFromMidnight: 9 * 60,
  endMinutesFromMidnight: 21 * 60,
  daysOfWeek: DEFAULT_DAYS.slice(),
  message: '',
  isActive: false,
  locationId: null,
});

const DEFAULT_SETTINGS: StoredSettings = {
  schedules: [createSchedule(getDefaultNotificationName(0))],
  quietHours: DEFAULT_QUIET_HOURS,
  locationRadiusMeters: DEFAULT_LOCATION_RADIUS_METERS,
};


Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

function AppContent() {
  const colorScheme = useColorScheme();
  const colors = colorScheme === 'dark' ? darkColors : lightColors;
  const { isDarkMode, setDarkMode } = useDarkModeToggle();
  const [activeTab, setActiveTab] = useState<'home' | 'settings' | 'locations'>('home');
  const [darkModeDraft, setDarkModeDraft] = useState(isDarkMode);
  const insets = useSafeAreaInsets();
  const [schedules, setSchedules] = useState<Schedule[]>(DEFAULT_SETTINGS.schedules);
  const [locations, setLocations] = useState<StoredLocation[]>([]);
  const [quietHours, setQuietHours] = useState<QuietHours>(DEFAULT_QUIET_HOURS);
  const [locationRadiusMeters, setLocationRadiusMeters] = useState(
    DEFAULT_LOCATION_RADIUS_METERS
  );
  const [locationPermissionStatus, setLocationPermissionStatus] = useState<{
    foreground: boolean;
    background: boolean;
  } | null>(null);
  const [authorizationStatus, setAuthorizationStatus] = useState<'authorized' | 'denied' | 'unknown'>(
    'unknown'
  );
  const [, setInlineMessage] = useState('');
  const [activePicker, setActivePicker] = useState<null | { scheduleId: string; kind: 'start' | 'end' }>(
    null
  );
  const [isNamePromptOpen, setIsNamePromptOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [namePromptTarget, setNamePromptTarget] = useState<'schedule' | 'location'>('schedule');
  const [namePromptMode, setNamePromptMode] = useState<'add' | 'edit'>('add');
  const [namePromptScheduleId, setNamePromptScheduleId] = useState<string | null>(null);
  const [namePromptLocationId, setNamePromptLocationId] = useState<string | null>(null);
  const [menuScheduleId, setMenuScheduleId] = useState<string | null>(null);
  const [menuLocationId, setMenuLocationId] = useState<string | null>(null);
  const [pendingLocationName, setPendingLocationName] = useState<string | null>(null);
  const [pendingLocationUpdate, setPendingLocationUpdate] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [isMapPickerOpen, setIsMapPickerOpen] = useState(false);
  const [mapPickerRegion, setMapPickerRegion] = useState<Region | null>(null);
  const [mapPickerCoords, setMapPickerCoords] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [collapsedSchedules, setCollapsedSchedules] = useState<string[]>([]);
  const [hasSeenOvernightNotice, setHasSeenOvernightNotice] = useState(false);
  const [isOvernightNoticeLoaded, setIsOvernightNoticeLoaded] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [intervalDrafts, setIntervalDrafts] = useState<Record<string, string>>({});
  const [locationRadiusDraft, setLocationRadiusDraft] = useState(
    DEFAULT_LOCATION_RADIUS_METERS.toString()
  );
  const [isOnboardingVisible, setIsOnboardingVisible] = useState(false);
  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(false);
  const [isOnboardingLoaded, setIsOnboardingLoaded] = useState(false);
  const previousSchedulesRef = useRef<Schedule[]>([]);
  const schedulesRef = useRef<Schedule[]>(schedules);
  const rescheduleTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const darkModeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyboardOffset = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (activeTab === 'home') {
      return;
    }
    setActivePicker(null);
    setMenuScheduleId(null);
    setMenuLocationId(null);
    setIsNamePromptOpen(false);
    Keyboard.dismiss();
  }, [activeTab]);

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
      setLocations(stored?.locations ?? []);
      setQuietHours(stored?.quietHours ?? DEFAULT_QUIET_HOURS);
      setLocationRadiusMeters(
        stored?.locationRadiusMeters ?? DEFAULT_LOCATION_RADIUS_METERS
      );
      await refreshAuthorization();
      setIsHydrated(true);
    };
    void hydrate();
  }, []);

  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(OVERNIGHT_NOTICE_KEY)
      .then((value) => {
        if (!isMounted) {
          return;
        }
        if (value === 'true') {
          setHasSeenOvernightNotice(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) {
          setIsOvernightNoticeLoaded(true);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    let isMounted = true;
    AsyncStorage.getItem(ONBOARDING_KEY)
      .then((value) => {
        if (!isMounted) {
          return;
        }
        if (value === 'true') {
          setHasSeenOnboarding(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (isMounted) {
          setIsOnboardingLoaded(true);
        }
      });
    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    setDarkModeDraft(isDarkMode);
  }, [isDarkMode]);

  useEffect(() => {
    return () => {
      if (darkModeTimerRef.current) {
        clearTimeout(darkModeTimerRef.current);
        darkModeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    void saveSettings({
      schedules,
      locations,
      quietHours,
      locationRadiusMeters,
    });
  }, [schedules, locations, quietHours, locationRadiusMeters, isHydrated]);

  useEffect(() => {
    schedulesRef.current = schedules;
  }, [schedules]);

  useEffect(() => {
    setLocationRadiusDraft(locationRadiusMeters.toString());
  }, [locationRadiusMeters]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    void refreshLocationPermissionStatus();
  }, [isHydrated]);

  useEffect(() => {
    if (activeTab !== 'locations') {
      return;
    }
    void refreshLocationPermissionStatus();
  }, [activeTab]);

  const locationScheduleSignature = useMemo(() => {
    return schedules
      .map(
        (schedule) =>
          `${schedule.id}:${schedule.isActive ? '1' : '0'}:${schedule.locationId ?? 'anywhere'}`
      )
      .sort()
      .join('|');
  }, [schedules]);

  useEffect(() => {
    if (!isHydrated || !isOvernightNoticeLoaded || hasSeenOvernightNotice) {
      return;
    }
    const hasOvernight = schedules.some((schedule) =>
      isOvernightWindow(schedule.startMinutesFromMidnight, schedule.endMinutesFromMidnight)
    );
    if (!hasOvernight) {
      return;
    }
    Alert.alert(
      'Overnight window',
      'Alerts after midnight count as the next day. Example: a Mon 9:00 PM - 6:00 AM window needs Tue selected for after-midnight alerts.'
    );
    setHasSeenOvernightNotice(true);
    AsyncStorage.setItem(OVERNIGHT_NOTICE_KEY, 'true').catch(() => {});
  }, [schedules, isHydrated, hasSeenOvernightNotice, isOvernightNoticeLoaded]);

  useEffect(() => {
    if (!isHydrated || !isOnboardingLoaded || hasSeenOnboarding) {
      return;
    }
    setIsOnboardingVisible(true);
  }, [isHydrated, isOnboardingLoaded, hasSeenOnboarding]);

  useEffect(() => {
    if (Platform.OS === 'ios') {
      const sub = Keyboard.addListener('keyboardWillChangeFrame', (event) => {
        const height = event.endCoordinates?.height ?? 0;
        const target = Math.max(0, height + 16);
        Animated.timing(keyboardOffset, {
          toValue: target,
          duration: event.duration ?? 250,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }).start();
      });
      return () => {
        sub.remove();
      };
    }
    const showSub = Keyboard.addListener('keyboardDidShow', (event) => {
      const height = event.endCoordinates?.height ?? 0;
      const target = Math.max(0, height + 16);
      Animated.timing(keyboardOffset, {
        toValue: target,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    const hideSub = Keyboard.addListener('keyboardDidHide', () => {
      Animated.timing(keyboardOffset, {
        toValue: 0,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, [keyboardOffset]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    void syncGeofencing();
  }, [locations, locationRadiusMeters, locationScheduleSignature, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const locationSchedules = schedules.filter(
      (schedule) => schedule.isActive && schedule.locationId
    );
    locationSchedules.forEach((schedule) => {
      void rescheduleSchedule(schedule, { silent: true, preserveActive: true });
    });
  }, [locations, locationRadiusMeters, isHydrated]);

  useEffect(() => {
    if (!isHydrated) {
      return;
    }
    const activeSchedules = schedules.filter((schedule) => schedule.isActive);
    activeSchedules.forEach((schedule) => {
      void rescheduleSchedule(schedule, { silent: true, preserveActive: true });
    });
  }, [quietHours, isHydrated]);

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
        !areDaysEqual(schedule.daysOfWeek, previous.daysOfWeek) ||
        schedule.locationId !== previous.locationId;
      if (hasChanged) {
        debouncedReschedule(schedule);
      }
    }
    previousSchedulesRef.current = schedules;
  }, [schedules, isHydrated]);

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

  const getScheduleById = (scheduleId?: string) => {
    if (!scheduleId) {
      return undefined;
    }
    return schedulesRef.current.find((schedule) => schedule.id === scheduleId);
  };

  const getScheduledNotificationDate = (
    request: Notifications.NotificationRequest
  ): Date | null => {
    const trigger = request.trigger as { date?: string | number | Date } | null;
    if (!trigger || typeof trigger !== 'object' || !('date' in trigger)) {
      return null;
    }
    const rawDate = trigger.date;
    if (!rawDate) {
      return null;
    }
    const date = rawDate instanceof Date ? rawDate : new Date(rawDate);
    return Number.isNaN(date.getTime()) ? null : date;
  };

  const cancelNextScheduledNotification = async (scheduleId: string) => {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const upcoming = scheduled
      .map((item) => {
        const data = item.content?.data as { scheduleId?: string } | undefined;
        if (data?.scheduleId !== scheduleId) {
          return null;
        }
        const date = getScheduledNotificationDate(item);
        if (!date) {
          return null;
        }
        return { id: item.identifier, date };
      })
      .filter(
        (item): item is { id: string; date: Date } =>
          Boolean(item) && item.date.getTime() > Date.now()
      )
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    const next = upcoming[0];
    if (!next) {
      return false;
    }
    await Notifications.cancelScheduledNotificationAsync(next.id);
    return true;
  };

  const scheduleSnooze = async (scheduleId: string, minutes: number) => {
    const schedule = getScheduleById(scheduleId);
    const titleSuffix = schedule?.name?.trim() ? ` - ${schedule.name.trim()}` : '';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `Snoozed${titleSuffix}`,
        body: schedule?.message?.trim() || DEFAULT_MESSAGE,
        sound: 'default',
        categoryIdentifier: NOTIFICATION_CATEGORY_ID,
        data: { scheduleId, isSnooze: true },
      },
      trigger: {
        type: 'date',
        date: new Date(Date.now() + minutes * 60 * 1000),
      },
    });
  };

  useEffect(() => {
    Notifications.setNotificationCategoryAsync(NOTIFICATION_CATEGORY_ID, [
      {
        identifier: `${NOTIFICATION_ACTION_SNOOZE_PREFIX}10`,
        buttonTitle: 'Snooze 10m',
        options: { opensAppToForeground: true },
      },
      {
        identifier: `${NOTIFICATION_ACTION_SNOOZE_PREFIX}30`,
        buttonTitle: 'Snooze 30m',
        options: { opensAppToForeground: true },
      },
      {
        identifier: `${NOTIFICATION_ACTION_SNOOZE_PREFIX}60`,
        buttonTitle: 'Snooze 60m',
        options: { opensAppToForeground: true },
      },
      {
        identifier: NOTIFICATION_ACTION_SKIP,
        buttonTitle: 'Skip next',
        options: { opensAppToForeground: true },
      },
    ]).catch(() => {});

    const responseSub = Notifications.addNotificationResponseReceivedListener((response) => {
      const actionId = response.actionIdentifier;
      const data = response.notification.request.content;
      const scheduleId = (data.data as { scheduleId?: string } | undefined)?.scheduleId;

      if (!scheduleId) {
        return;
      }

      if (actionId.startsWith(NOTIFICATION_ACTION_SNOOZE_PREFIX)) {
        const minutes = Number(actionId.replace(NOTIFICATION_ACTION_SNOOZE_PREFIX, ''));
        if (Number.isFinite(minutes) && minutes > 0) {
          void scheduleSnooze(scheduleId, minutes);
          setInlineMessage(`Snoozed for ${minutes} minutes.`);
        }
        return;
      }

      if (actionId === NOTIFICATION_ACTION_SKIP) {
        void cancelNextScheduledNotification(scheduleId).then((didCancel) => {
          setInlineMessage(didCancel ? 'Skipped the next alert.' : 'No upcoming alert to skip.');
        });
      }
    });

    return () => {
      responseSub.remove();
    };
  }, []);

  const getLocationLabel = (locationId: string | null) => {
    if (!locationId) {
      return ANYWHERE_LABEL;
    }
    return locations.find((location) => location.id === locationId)?.name ?? 'Saved location';
  };

  const getLocationTarget = (locationId: string | null) => {
    if (!locationId) {
      return null;
    }
    return locations.find((location) => location.id === locationId) ?? null;
  };

  const toRadians = (value: number) => (value * Math.PI) / 180;

  const distanceInMeters = (from: { latitude: number; longitude: number }, to: StoredLocation) => {
    const earthRadius = 6371000;
    const dLat = toRadians(to.latitude - from.latitude);
    const dLon = toRadians(to.longitude - from.longitude);
    const lat1 = toRadians(from.latitude);
    const lat2 = toRadians(to.latitude);

    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadius * c;
  };

  const isWithinRadius = (from: { latitude: number; longitude: number }, to: StoredLocation) =>
    distanceInMeters(from, to) <= locationRadiusMeters;

  const checkLocationPermissions = async (requireBackground = false) => {
    if (Platform.OS === 'web') {
      return false;
    }
    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) {
      return false;
    }
    if (!requireBackground) {
      return true;
    }
    const background = await Location.getBackgroundPermissionsAsync();
    return background.granted;
  };

  const refreshLocationPermissionStatus = async () => {
    if (Platform.OS === 'web') {
      setLocationPermissionStatus(null);
      return;
    }
    const foreground = await Location.getForegroundPermissionsAsync();
    const background = await Location.getBackgroundPermissionsAsync();
    setLocationPermissionStatus({
      foreground: foreground.granted,
      background: background.granted,
    });
  };

  const confirmBackgroundLocation = () =>
    new Promise<boolean>((resolve) => {
      Alert.alert(
        'Allow location in the background?',
        'We use background location so alerts can fire when you arrive at or leave a saved place, even if the app is closed.',
        [
          { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
          { text: 'Continue', onPress: () => resolve(true) },
        ],
        { cancelable: true }
      );
    });

  const requestLocationPermissions = async (options?: {
    requireBackground?: boolean;
    explainBackground?: boolean;
  }) => {
    if (Platform.OS === 'web') {
      Alert.alert('Location not supported', 'Saved location alerts are not available on web.');
      return false;
    }
    const servicesEnabled = await Location.hasServicesEnabledAsync();
    if (!servicesEnabled) {
      Alert.alert(
        'Location services off',
        'Turn on Location Services to use saved location alerts.'
      );
      return false;
    }
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) {
      Alert.alert(
        'Location permission needed',
        'Allow location access to use saved location alerts.'
      );
      void refreshLocationPermissionStatus();
      return false;
    }
    if (!options?.requireBackground) {
      void refreshLocationPermissionStatus();
      return true;
    }
    const backgroundExisting = await Location.getBackgroundPermissionsAsync();
    if (backgroundExisting.granted) {
      void refreshLocationPermissionStatus();
      return true;
    }
    if (options?.explainBackground) {
      const shouldContinue = await confirmBackgroundLocation();
      if (!shouldContinue) {
        return false;
      }
    }
    const background = await Location.requestBackgroundPermissionsAsync();
    if (!background.granted) {
      Alert.alert(
        'Background location needed',
        'Allow "Always" location access so saved location alerts work when the app is closed.'
      );
      void refreshLocationPermissionStatus();
      return false;
    }
    void refreshLocationPermissionStatus();
    return true;
  };

  const getCurrentCoords = async () => {
    if (Platform.OS === 'web') {
      return null;
    }
    try {
      const lastKnown = await Location.getLastKnownPositionAsync();
      if (lastKnown?.coords) {
        return lastKnown.coords;
      }
      const current = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      return current.coords;
    } catch {
      return null;
    }
  };

  const isScheduleLocationEligible = async (
    schedule: Schedule,
    options?: { requestPermissions?: boolean; silent?: boolean }
  ) => {
    if (!schedule.locationId) {
      return true;
    }
    const target = getLocationTarget(schedule.locationId);
    const label = getLocationLabel(schedule.locationId);
    if (!target) {
      if (!options?.silent) {
        setInlineMessage('Select a saved location to enable this alert.');
      }
      return false;
    }
    const permissionsGranted = options?.requestPermissions
      ? await requestLocationPermissions({ requireBackground: true, explainBackground: true })
      : await checkLocationPermissions(true);
    if (!permissionsGranted) {
      if (!options?.silent) {
        setInlineMessage('Location permission is required for saved location alerts.');
      }
      return false;
    }
    const coords = await getCurrentCoords();
    if (!coords) {
      if (!options?.silent) {
        setInlineMessage('Could not read your location.');
      }
      return false;
    }
    if (!isWithinRadius(coords, target)) {
      if (!options?.silent) {
        setInlineMessage(`Will alert when you're at ${label}.`);
      }
      return false;
    }
    return true;
  };

  const syncGeofencing = async () => {
    if (Platform.OS === 'web') {
      return;
    }
    const activeLocationIds = new Set(
      schedules
        .filter((schedule) => schedule.isActive && schedule.locationId)
        .map((schedule) => schedule.locationId)
    );

    if (activeLocationIds.size === 0) {
      try {
        const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
        if (started) {
          await Location.stopGeofencingAsync(GEOFENCE_TASK);
        }
      } catch {
        // Ignore geofencing stop errors.
      }
      return;
    }

    const permissionsGranted = await checkLocationPermissions(true);
    if (!permissionsGranted) {
      return;
    }

    const regions: Location.LocationRegion[] = locations
      .filter((location) => activeLocationIds.has(location.id))
      .map((location) => ({
        identifier: location.id,
        latitude: location.latitude,
        longitude: location.longitude,
        radius: locationRadiusMeters,
        notifyOnEnter: true,
        notifyOnExit: true,
      }));

    if (regions.length === 0) {
      try {
        const started = await Location.hasStartedGeofencingAsync(GEOFENCE_TASK);
        if (started) {
          await Location.stopGeofencingAsync(GEOFENCE_TASK);
        }
      } catch {
        // Ignore geofencing stop errors.
      }
      return;
    }

    try {
      await Location.startGeofencingAsync(GEOFENCE_TASK, regions);
    } catch {
      // Ignore geofencing start errors.
    }
  };

  const scheduleIfEligible = async (
    schedule: Schedule,
    options?: { requestPermissions?: boolean; silent?: boolean }
  ): Promise<ScheduleResult> => {
    await cancelScheduleNotifications(schedule.id);
    const eligible = await isScheduleLocationEligible(schedule, options);
    if (!eligible) {
      return { count: 0, skipped: true };
    }
    return scheduleNotificationsBatch([schedule], { quietHours });
  };

  const openLocationNamePrompt = (options?: { location?: StoredLocation; mode?: 'add' | 'edit' }) => {
    setNameDraft(options?.location?.name ?? '');
    setNamePromptTarget('location');
    setNamePromptMode(options?.mode ?? 'add');
    setNamePromptScheduleId(null);
    setNamePromptLocationId(options?.location?.id ?? null);
    setIsNamePromptOpen(true);
  };

  const formatLocationAddress = (address: Location.LocationGeocodedAddress) => {
    const streetBase = address.street ?? address.name;
    const street =
      address.streetNumber && streetBase
        ? `${address.streetNumber} ${streetBase}`
        : streetBase;
    const city = address.city;
    const region = address.region;
    return [street, city, region].filter(Boolean).join(', ');
  };

  const getAddressFromCoords = async (coords: { latitude: number; longitude: number }) => {
    try {
      const results = await Location.reverseGeocodeAsync(coords);
      if (!results.length) {
        return undefined;
      }
      const formatted = formatLocationAddress(results[0]);
      return formatted || undefined;
    } catch {
      return undefined;
    }
  };

  const openMapPicker = async () => {
    if (Platform.OS === 'web') {
      Alert.alert('Maps not supported', 'Map picking is not available on web.');
      setPendingLocationName(null);
      setPendingLocationUpdate(null);
      return;
    }
    const foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted) {
      const foregroundRequest = await Location.requestForegroundPermissionsAsync();
      if (!foregroundRequest.granted) {
        Alert.alert(
          'Location permission needed',
          'Allow location access to pick a place on the map.'
        );
        setPendingLocationName(null);
        setPendingLocationUpdate(null);
        return;
      }
    }
    const background = await Location.getBackgroundPermissionsAsync();
    if (!background.granted) {
      const choice = await new Promise<'open' | 'skip'>((resolve) => {
        Alert.alert(
          'Enable Always location',
          'To save places, set Location to Always in Settings.',
          [
            { text: 'Not now', style: 'cancel', onPress: () => resolve('skip') },
            { text: 'Open Settings', onPress: () => resolve('open') },
          ],
          { cancelable: true }
        );
      });
      if (choice === 'open') {
        setPendingLocationName(null);
        setPendingLocationUpdate(null);
        openSystemSettings();
        return;
      }
    }
    const coords = await getCurrentCoords();
    const fallback = coords ?? { latitude: 37.3349, longitude: -122.00902 };
    const region: Region = {
      latitude: fallback.latitude,
      longitude: fallback.longitude,
      latitudeDelta: 0.01,
      longitudeDelta: 0.01,
    };
    setMapPickerCoords(fallback);
    setMapPickerRegion(region);
    setIsMapPickerOpen(true);
  };

  const saveLocationFromCoords = async (
    name: string,
    coords: { latitude: number; longitude: number },
    locationId?: string
  ) => {
    try {
      const address = await getAddressFromCoords(coords);
      if (locationId) {
        setLocations((currentLocations) =>
          currentLocations.map((location) =>
            location.id === locationId ? { ...location, ...coords, address } : location
          )
        );
        Alert.alert(
          'Location updated',
          `Current location saved for ${name}. Alerts will trigger within ${locationRadiusMeters} meters.`
        );
        return;
      }
      const nextLocation: StoredLocation = {
        id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
        name,
        ...coords,
        address,
      };
      setLocations((currentLocations) => [...currentLocations, nextLocation]);
      Alert.alert(
        'Location saved',
        `Current location saved for ${name}. Alerts will trigger within ${locationRadiusMeters} meters.`
      );
    } catch {
      Alert.alert('Location error', 'Unable to read your location.');
    }
  };

  const saveLocationFromCurrent = async (name: string, locationId?: string) => {
    const permissionsGranted = await requestLocationPermissions({
      requireBackground: false,
    });
    if (!permissionsGranted) {
      return;
    }
    try {
      const lastKnown = await Location.getLastKnownPositionAsync();
      const current = lastKnown
        ? lastKnown
        : await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          });
      const coords = {
        latitude: current.coords.latitude,
        longitude: current.coords.longitude,
      };
      await saveLocationFromCoords(name, coords, locationId);
    } catch {
      Alert.alert('Location error', 'Unable to read your location.');
    }
  };

  const addLocation = () => {
    setPendingLocationName(null);
    setPendingLocationUpdate(null);
    InteractionManager.runAfterInteractions(() => {
      openLocationNamePrompt();
    });
  };

  const renameLocation = (location: StoredLocation) => {
    if (Platform.OS === 'ios') {
      Alert.prompt(
        'Rename location',
        undefined,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Save',
            onPress: (text) => {
              const formatted = formatLocationName(text ?? '');
              if (!formatted) {
                return;
              }
              setLocations((currentLocations) =>
                currentLocations.map((item) =>
                  item.id === location.id ? { ...item, name: formatted } : item
                )
              );
            },
          },
        ],
        'plain-text',
        location.name
      );
      return;
    }
    openLocationNamePrompt({ location, mode: 'edit' });
  };

  const updateLocationFromCurrent = (location: StoredLocation) => {
    void saveLocationFromCurrent(location.name, location.id);
  };

  const openSystemSettings = () => {
    Linking.openSettings().catch(() => {
      Alert.alert(
        'Unable to open Settings',
        'Open the Settings app to adjust location permissions.'
      );
    });
  };

  const closeMapPicker = () => {
    setIsMapPickerOpen(false);
    setMapPickerRegion(null);
    setMapPickerCoords(null);
  };

  const openLocationPicker = (schedule: Schedule) => {
    if (Platform.OS !== 'ios') {
      return;
    }
    const savedNames = locations.map((location) => location.name);
    const options = [ANYWHERE_LABEL, ...savedNames, 'Manage locations', 'Cancel'];
    const manageIndex = options.length - 2;
    const cancelButtonIndex = options.length - 1;

    ActionSheetIOS.showActionSheetWithOptions(
      {
        options,
        cancelButtonIndex,
        title: 'Choose location',
      },
      (buttonIndex) => {
        if (buttonIndex === cancelButtonIndex) {
          return;
        }
        if (buttonIndex === manageIndex) {
          setActiveTab('locations');
          return;
        }
        if (buttonIndex === 0) {
          updateSchedule(schedule.id, { locationId: null });
          return;
        }
        const location = locations[buttonIndex - 1];
        if (location) {
          updateSchedule(schedule.id, { locationId: location.id });
        }
      }
    );
  };

  const removeLocation = (location: StoredLocation) => {
    setLocations((currentLocations) =>
      currentLocations.filter((item) => item.id !== location.id)
    );
    setSchedules((currentSchedules) =>
      currentSchedules.map((schedule) =>
        schedule.locationId === location.id ? { ...schedule, locationId: null } : schedule
      )
    );
  };

  const updateQuietHours = (patch: Partial<QuietHours>) => {
    setQuietHours((current) => ({ ...current, ...patch }));
  };

  const clampLocationRadius = (value: number) => {
    if (!Number.isFinite(value)) {
      return DEFAULT_LOCATION_RADIUS_METERS;
    }
    return Math.min(1000, Math.max(25, Math.round(value)));
  };

  const updateLocationRadiusDraft = (value: string) => {
    const sanitized = value.replace(/[^0-9]/g, '');
    setLocationRadiusDraft(sanitized);
  };

  const stepLocationRadius = (direction: 1 | -1) => {
    const next = clampLocationRadius(locationRadiusMeters + direction * 25);
    setLocationRadiusMeters(next);
    setLocationRadiusDraft(next.toString());
  };

  const commitLocationRadiusDraft = () => {
    const parsed = Number(locationRadiusDraft);
    if (!Number.isFinite(parsed)) {
      setLocationRadiusDraft(locationRadiusMeters.toString());
      return;
    }
    const next = clampLocationRadius(parsed);
    setLocationRadiusMeters(next);
    setLocationRadiusDraft(next.toString());
  };

  const completeOnboarding = () => {
    setIsOnboardingVisible(false);
    setHasSeenOnboarding(true);
    AsyncStorage.setItem(ONBOARDING_KEY, 'true').catch(() => {});
  };

  const enableNotificationsFromOnboarding = async () => {
    await new Promise<void>((resolve) => {
      InteractionManager.runAfterInteractions(() => resolve());
    });
    const granted = await requestAuthorization();
    if (granted) {
      setInlineMessage('Notifications enabled.');
    }
    completeOnboarding();
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
      const result = await scheduleIfEligible(schedule, { silent: silentSuccess });
      if (result.skipped) {
        return;
      }
      if (result.error) {
        setInlineMessage(`Notification setup failed: ${result.error}`);
        if (!preserveActive) {
          setScheduleActive(schedule.id, false);
        }
        return;
      }
      if (result.count === 0) {
        setInlineMessage(
          quietHours.enabled
            ? 'No alerts outside quiet hours. Adjust the window or quiet hours.'
            : 'No alerts in the next 7 days. Adjust the window.'
        );
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
    setScheduleActive(scheduleId, true);
    setInlineMessage('Setting notifications...');
    try {
      const granted =
        authorizationStatus === 'authorized' ? true : await requestAuthorization();
      if (!granted) {
        setInlineMessage('Notifications are off. You can enable them in Settings.');
        setScheduleActive(scheduleId, false);
        return;
      }
      clearRescheduleTimer(scheduleId);
      const result = await scheduleIfEligible(
        { ...schedule, isActive: true },
        { requestPermissions: Boolean(schedule.locationId) }
      );
      if (schedule.locationId) {
        void syncGeofencing();
      }
      if (result.skipped) {
        setScheduleActive(scheduleId, true);
        return;
      }
      if (result.error) {
        setInlineMessage(`Notification setup failed: ${result.error}`);
        setScheduleActive(scheduleId, false);
        return;
      }
      if (result.count === 0) {
        setInlineMessage(
          quietHours.enabled
            ? 'No alerts outside quiet hours. Adjust the window or quiet hours.'
            : 'No alerts in the next 7 days. Adjust the window.'
        );
        setScheduleActive(scheduleId, false);
        return;
      }
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
        const nextInterval = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, next));
        setIntervalDrafts((drafts) => ({ ...drafts, [id]: String(nextInterval) }));
        return {
          ...schedule,
          intervalMinutes: nextInterval,
        };
      })
    );
  };

  const updateIntervalDraft = (id: string, value: string) => {
    const sanitized = value.replace(/[^0-9]/g, '');
    setIntervalDrafts((current) => ({ ...current, [id]: sanitized }));
  };

  const commitIntervalDraft = (id: string) => {
    const draft = intervalDrafts[id];
    const schedule = schedules.find((item) => item.id === id);
    if (!schedule) {
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setIntervalDrafts((current) => ({ ...current, [id]: String(schedule.intervalMinutes) }));
      return;
    }
    const next = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Math.round(parsed)));
    setIntervalDrafts((current) => ({ ...current, [id]: String(next) }));
    updateSchedule(id, { intervalMinutes: next });
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
    setNamePromptTarget('schedule');
    setNamePromptMode('add');
    setNamePromptScheduleId(null);
    setNamePromptLocationId(null);
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
    setNamePromptTarget('schedule');
    setNamePromptMode('edit');
    setNamePromptScheduleId(schedule.id);
    setNamePromptLocationId(null);
    setIsNamePromptOpen(true);
  };

  const duplicateSchedule = (schedule: Schedule) => {
    const baseName = schedule.name?.trim() || getDefaultNotificationName(schedules.length);
    const nextName = `${baseName} copy`;
    const newSchedule: Schedule = {
      ...schedule,
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      name: nextName,
      isActive: false,
    };
    setSchedules((current) => [...current, newSchedule]);
    setInlineMessage(`Duplicated "${baseName}".`);
  };

  const closeMenu = () => {
    setMenuScheduleId(null);
  };

  const closeLocationMenu = () => {
    setMenuLocationId(null);
  };

  const closeNamePrompt = () => {
    Keyboard.dismiss();
    setNamePromptScheduleId(null);
    setNamePromptLocationId(null);
    setIsNamePromptOpen(false);
  };

  const confirmNamePrompt = () => {
    const formatted =
      namePromptTarget === 'location'
        ? formatLocationName(nameDraft)
        : formatNotificationName(nameDraft);
    if (!formatted) {
      return;
    }
    if (namePromptTarget === 'location') {
      if (namePromptMode === 'add') {
        closeNamePrompt();
        setPendingLocationName(formatted);
        setPendingLocationUpdate(null);
        void openMapPicker();
        return;
      }
      if (namePromptMode === 'edit' && namePromptLocationId) {
        setLocations((currentLocations) =>
          currentLocations.map((location) =>
            location.id === namePromptLocationId ? { ...location, name: formatted } : location
          )
        );
      }
      closeNamePrompt();
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
    setIntervalDrafts((current) => {
      const { [id]: _, ...rest } = current;
      return rest;
    });
  };

  const activeSchedule = useMemo(() => {
    if (!activePicker || activePicker.scheduleId === 'quiet') {
      return null;
    }
    return schedules.find((schedule) => schedule.id === activePicker.scheduleId) ?? null;
  }, [activePicker, schedules]);

  const activePickerDate = useMemo(() => {
    if (!activePicker) {
      return new Date();
    }
    if (activePicker.scheduleId === 'quiet') {
      const minutes =
        activePicker.kind === 'start'
          ? quietHours.startMinutesFromMidnight
          : quietHours.endMinutesFromMidnight;
      return minutesToDate(minutes);
    }
    if (!activeSchedule) {
      return new Date();
    }
    const minutes =
      activePicker.kind === 'start'
        ? activeSchedule.startMinutesFromMidnight
        : activeSchedule.endMinutesFromMidnight;
    return minutesToDate(minutes);
  }, [activePicker, activeSchedule, quietHours]);

  const canConfirmName = nameDraft.trim().length > 0;
  const isEditingName = namePromptMode === 'edit';
  const namePromptTitle =
    namePromptTarget === 'location'
      ? isEditingName
        ? 'Rename location'
        : 'New location'
      : isEditingName
        ? 'Edit notification'
        : 'New notification';
  const namePromptPlaceholder =
    namePromptTarget === 'location' ? 'Location name' : 'Notification name';
  const hasLocationSchedules = schedules.some((schedule) => schedule.locationId);
  const needsLocationForeground =
    locationPermissionStatus !== null && !locationPermissionStatus.foreground;
  const needsLocationBackground =
    locationPermissionStatus !== null &&
    locationPermissionStatus.foreground &&
    hasLocationSchedules &&
    !locationPermissionStatus.background;

  const onPickerChange = (_: DateTimePickerEvent, selected?: Date) => {
    if (!selected || !activePicker) {
      return;
    }
    const minutes = dateToMinutes(selected);
    if (activePicker.scheduleId === 'quiet') {
      if (activePicker.kind === 'start') {
        updateQuietHours({ startMinutesFromMidnight: minutes });
      } else {
        updateQuietHours({ endMinutesFromMidnight: minutes });
      }
      return;
    }
    if (activePicker.kind === 'start') {
      updateSchedule(activePicker.scheduleId, { startMinutesFromMidnight: minutes });
    } else {
      updateSchedule(activePicker.scheduleId, { endMinutesFromMidnight: minutes });
    }
  };

  const onToggleDarkMode = (value: boolean) => {
    setDarkModeDraft(value);
    if (darkModeTimerRef.current) {
      clearTimeout(darkModeTimerRef.current);
      darkModeTimerRef.current = null;
    }
    if (Platform.OS === 'ios') {
      darkModeTimerRef.current = setTimeout(() => {
        setDarkMode(value);
      }, 200);
      return;
    }
    setDarkMode(value);
  };

  return (
    <SafeAreaView edges={['top']} style={[styles.safeArea, { backgroundColor: colors.background }]}>
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} backgroundColor={colors.background} />
      {activeTab === 'home' ? (
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
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>Notifications</Text>
            <Pressable
              style={[
                styles.addButton,
                { backgroundColor: colors.inputBackground, borderColor: colors.border },
              ]}
              onPress={addSchedule}
              accessibilityRole="button"
              accessibilityLabel="Add notification"
              hitSlop={8}
            >
              <MaterialIcons name="add" size={22} color={colors.accent} />
            </Pressable>
          </View>

          {schedules.map((schedule, index) => {
            const startLabel = formatTime(schedule.startMinutesFromMidnight);
            const endLabel = formatTime(schedule.endMinutesFromMidnight);
            const daysOfWeek = normalizeDaysOfWeek(schedule.daysOfWeek);
            const isOvernight = isOvernightWindow(
              schedule.startMinutesFromMidnight,
              schedule.endMinutesFromMidnight
            );
            const daysSummary = formatDaysSummary(daysOfWeek);
            const timeSummary = formatTimeRangeSummary(
              schedule.startMinutesFromMidnight,
              schedule.endMinutesFromMidnight
            );
            const locationLabel = getLocationLabel(schedule.locationId);
            const summary = `${daysSummary} | ${timeSummary} | Every ${schedule.intervalMinutes} min | ${locationLabel}`;
            const isCollapsed = collapsedSchedules.includes(schedule.id);
            return (
              <View
                key={schedule.id}
                style={[
                  styles.card,
                  {
                    backgroundColor: colors.card,
                    shadowColor: colors.shadow,
                    borderColor: schedule.isActive ? colors.accent : colors.border,
                    shadowOpacity: schedule.isActive ? 0.12 : 0.04,
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
                  <View style={styles.cardHeaderActions}>
                    <Pressable
                      style={[
                        styles.toggleButton,
                        { backgroundColor: schedule.isActive ? colors.active : colors.inactive },
                      ]}
                      onPress={() =>
                        schedule.isActive
                          ? void onStopSchedule(schedule.id)
                          : void onStartSchedule(schedule.id)
                      }
                    >
                      <Text style={styles.toggleButtonLabel}>
                        {schedule.isActive ? 'Active' : 'Inactive'}
                      </Text>
                    </Pressable>
                    <Pressable onPress={() => setMenuScheduleId(schedule.id)} hitSlop={10}>
                      <Text style={[styles.menuLabel, { color: colors.textSecondary }]}>...</Text>
                    </Pressable>
                  </View>
                </View>

                <Text style={[styles.cardSummary, { color: colors.textSecondary }]}>
                  {summary}
                </Text>

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
                    <View style={[styles.divider, { backgroundColor: colors.border }]} />

                    <View
                      style={[
                        styles.intervalRow,
                        { backgroundColor: colors.inputBackground, borderColor: colors.border },
                      ]}
                    >
                      <Pressable
                        style={[
                          styles.stepperButton,
                          { backgroundColor: colors.accent, borderColor: colors.accent },
                        ]}
                        onPress={() => stepInterval(schedule.id, -1)}
                      >
                        <Text style={styles.stepperLabel}>-</Text>
                      </Pressable>
                      <View style={styles.intervalInputGroup}>
                        <TextInput
                          value={intervalDrafts[schedule.id] ?? String(schedule.intervalMinutes)}
                          onChangeText={(value) => updateIntervalDraft(schedule.id, value)}
                          onBlur={() => commitIntervalDraft(schedule.id)}
                          onSubmitEditing={() => commitIntervalDraft(schedule.id)}
                          keyboardType="number-pad"
                          returnKeyType="done"
                          style={[
                            styles.intervalInput,
                            { color: colors.textPrimary, borderColor: colors.border },
                          ]}
                        />
                        <Text style={[styles.intervalUnit, { color: colors.textSecondary }]}>
                          min
                        </Text>
                      </View>
                      <Pressable
                        style={[
                          styles.stepperButton,
                          { backgroundColor: colors.accent, borderColor: colors.accent },
                        ]}
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

                    {isOvernight ? (
                      <Text style={[styles.helperText, { color: colors.textMuted }]}>
                        Overnight window. Alerts after midnight count as the next day. Example:
                        Mon 9:00 PM - 6:00 AM needs Tue selected for after-midnight alerts.
                      </Text>
                    ) : null}

                    <View style={[styles.divider, { backgroundColor: colors.border }]} />

                    <Text style={[styles.messageLabel, { color: colors.label }]}>Location</Text>
                    <Pressable
                      style={[
                        styles.timeRow,
                        { backgroundColor: colors.inputBackground, borderColor: colors.border },
                      ]}
                      onPress={() => openLocationPicker(schedule)}
                    >
                      <Text style={[styles.timeLabel, { color: colors.label }]}>Choose</Text>
                      <Text
                        style={[styles.timeValue, { color: colors.textPrimary }]}
                        numberOfLines={1}
                      >
                        {locationLabel}
                      </Text>
                    </Pressable>

                  </>
                ) : null}
              </View>
            );
          })}

        </ScrollView>
      </KeyboardAvoidingView>
      ) : activeTab === 'locations' ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.settingsContainer, { backgroundColor: colors.background }]}
          contentInsetAdjustmentBehavior="always"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.titleRow}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>Locations</Text>
            <Pressable
              style={[
                styles.addButton,
                { backgroundColor: colors.inputBackground, borderColor: colors.border },
              ]}
              onPress={addLocation}
              accessibilityRole="button"
              accessibilityLabel="Add location"
              hitSlop={8}
            >
              <MaterialIcons name="add" size={22} color={colors.accent} />
            </Pressable>
          </View>
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.card,
                shadowColor: colors.shadow,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.settingsSectionTitle, { color: colors.textPrimary }]}>
              Location settings
            </Text>
            <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
              Alerts fire within {locationRadiusMeters} meters.
            </Text>
            <View style={styles.locationRadiusRow}>
              <View style={styles.settingsText}>
                <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>
                  Alert radius
                </Text>
                <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                  25m to 1000m
                </Text>
              </View>
              <View style={styles.radiusControls}>
                <Pressable
                  style={[
                    styles.stepperButton,
                    { backgroundColor: colors.accent, borderColor: colors.accent },
                  ]}
                  onPress={() => stepLocationRadius(-1)}
                >
                  <Text style={styles.stepperLabel}>-</Text>
                </Pressable>
                <View style={styles.radiusInputGroup}>
                  <TextInput
                    value={locationRadiusDraft}
                    onChangeText={updateLocationRadiusDraft}
                    onBlur={commitLocationRadiusDraft}
                    onSubmitEditing={commitLocationRadiusDraft}
                    keyboardType="number-pad"
                    returnKeyType="done"
                    style={[
                      styles.radiusInput,
                      { color: colors.textPrimary, borderColor: colors.border },
                    ]}
                  />
                  <Text style={[styles.intervalUnit, { color: colors.textSecondary }]}>m</Text>
                </View>
                <Pressable
                  style={[
                    styles.stepperButton,
                    { backgroundColor: colors.accent, borderColor: colors.accent },
                  ]}
                  onPress={() => stepLocationRadius(1)}
                >
                  <Text style={styles.stepperLabel}>+</Text>
                </Pressable>
              </View>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.border }]} />
            <Text style={[styles.settingsSectionTitle, { color: colors.textPrimary }]}>
              Saved locations
            </Text>
            {locations.length === 0 ? (
              <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                No saved locations yet.
              </Text>
            ) : (
              locations.map((location) => (
                <View key={location.id} style={styles.locationSettingRow}>
                  <View style={styles.settingsText}>
                    <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>
                      {location.name}
                    </Text>
                    {location.address ? (
                      <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                        {location.address}
                      </Text>
                    ) : null}
                  </View>
                  <View style={styles.locationActions}>
                    <Pressable
                      style={styles.locationIconButton}
                      onPress={() => setMenuLocationId(location.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`${location.name} actions`}
                      hitSlop={10}
                    >
                      <Text style={[styles.menuLabel, { color: colors.textSecondary }]}>...</Text>
                    </Pressable>
                  </View>
                </View>
              ))
            )}
            {needsLocationForeground || needsLocationBackground ? (
              <>
                <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                  {needsLocationForeground
                    ? 'Location access is off. Allow While Using to save places.'
                    : 'Background location is off. Enable Always to alert when the app is closed.'}
                </Text>
                <Pressable
                  style={[styles.secondaryButton, { borderColor: colors.border }]}
                  onPress={openSystemSettings}
                >
                  <Text style={[styles.secondaryButtonLabel, { color: colors.textPrimary }]}>
                    Open iOS Settings
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        </ScrollView>
      ) : (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[styles.settingsContainer, { backgroundColor: colors.background }]}
          contentInsetAdjustmentBehavior="always"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text style={[styles.title, { color: colors.textPrimary }]}>Settings</Text>
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.card,
                shadowColor: colors.shadow,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.settingsRow}>
              <View style={styles.settingsText}>
                <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>Dark mode</Text>
                <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                  Use the dark color theme.
                </Text>
              </View>
              <Switch
                value={darkModeDraft}
                onValueChange={onToggleDarkMode}
                trackColor={{ false: colors.border, true: colors.accent }}
                ios_backgroundColor={colors.border}
              />
            </View>
          </View>
          <View
            style={[
              styles.card,
              {
                backgroundColor: colors.card,
                shadowColor: colors.shadow,
                borderColor: colors.border,
              },
            ]}
          >
            <View style={styles.settingsRow}>
              <View style={styles.settingsText}>
                <Text style={[styles.settingsLabel, { color: colors.textPrimary }]}>
                  Quiet hours
                </Text>
                <Text style={[styles.settingsHelper, { color: colors.textSecondary }]}>
                  Mute alerts during the hours you choose.
                </Text>
              </View>
              <Switch
                value={quietHours.enabled}
                onValueChange={(value) => updateQuietHours({ enabled: value })}
                trackColor={{ false: colors.border, true: colors.accent }}
                ios_backgroundColor={colors.border}
              />
            </View>
            <View style={styles.timeRowGroup}>
              <Pressable
                style={[
                  styles.timeRow,
                  { backgroundColor: colors.inputBackground, borderColor: colors.border },
                ]}
                onPress={() => setActivePicker({ scheduleId: 'quiet', kind: 'start' })}
              >
                <Text style={[styles.timeLabel, { color: colors.label }]}>Start</Text>
                <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                  {formatTime(quietHours.startMinutesFromMidnight)}
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.timeRow,
                  { backgroundColor: colors.inputBackground, borderColor: colors.border },
                ]}
                onPress={() => setActivePicker({ scheduleId: 'quiet', kind: 'end' })}
              >
                <Text style={[styles.timeLabel, { color: colors.label }]}>End</Text>
                <Text style={[styles.timeValue, { color: colors.textPrimary }]}>
                  {formatTime(quietHours.endMinutesFromMidnight)}
                </Text>
              </Pressable>
            </View>
            <Text style={[styles.helperText, { color: colors.textMuted }]}>
              Alerts that fall inside this window will be skipped.
            </Text>
          </View>
        </ScrollView>
      )}

      <View
        style={[
          styles.tabBar,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            height: TAB_BAR_HEIGHT + insets.bottom,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <Pressable
          onPress={() => setActiveTab('home')}
          style={styles.tabButton}
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'home' }}
        >
          <MaterialIcons
            name="home"
            size={25}
            color={activeTab === 'home' ? colors.accent : colors.textSecondary}
            style={styles.tabIcon}
          />
          <Text
            style={[
              styles.tabLabel,
              { color: activeTab === 'home' ? colors.accent : colors.textSecondary },
            ]}
          >
            Home
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab('locations')}
          style={styles.tabButton}
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'locations' }}
        >
          <MaterialIcons
            name="place"
            size={25}
            color={activeTab === 'locations' ? colors.accent : colors.textSecondary}
            style={styles.tabIcon}
          />
          <Text
            style={[
              styles.tabLabel,
              { color: activeTab === 'locations' ? colors.accent : colors.textSecondary },
            ]}
          >
            Locations
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setActiveTab('settings')}
          style={styles.tabButton}
          accessibilityRole="button"
          accessibilityState={{ selected: activeTab === 'settings' }}
        >
          <MaterialIcons
            name="settings"
            size={25}
            color={activeTab === 'settings' ? colors.accent : colors.textSecondary}
            style={styles.tabIcon}
          />
          <Text
            style={[
              styles.tabLabel,
              { color: activeTab === 'settings' ? colors.accent : colors.textSecondary },
            ]}
          >
            Settings
          </Text>
        </Pressable>
      </View>

      {isNamePromptOpen ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <Animated.View
            style={[
              styles.namePromptWrapper,
              { transform: [{ translateY: Animated.multiply(keyboardOffset, -1) }] },
            ]}
          >
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
                {namePromptTitle}
              </Text>
              <TextInput
                value={nameDraft}
                onChangeText={setNameDraft}
                placeholder={namePromptPlaceholder}
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
          </Animated.View>
        </View>
      ) : null}

      {activeTab === 'home' && menuScheduleId ? (
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
              <View style={styles.menuItemContent}>
                <MaterialIcons name="edit" size={18} color={colors.textPrimary} />
                <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>Edit</Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const schedule = schedules.find((item) => item.id === menuScheduleId);
                closeMenu();
                if (schedule) {
                  duplicateSchedule(schedule);
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="content-copy" size={18} color={colors.textPrimary} />
                <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>Duplicate</Text>
              </View>
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
              <View style={styles.menuItemContent}>
                <MaterialIcons name="delete-outline" size={18} color={colors.remove} />
                <Text style={[styles.menuItemText, { color: colors.remove }]}>Remove</Text>
              </View>
            </Pressable>
            <Pressable style={styles.menuCancel} onPress={closeMenu}>
              <View style={styles.menuCancelContent}>
                <MaterialIcons name="close" size={18} color={colors.textSecondary} />
                <Text style={[styles.menuCancelText, { color: colors.textSecondary }]}>
                  Cancel
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      ) : null}

      {activePicker && (activeSchedule || activePicker.scheduleId === 'quiet') ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View style={[styles.sheet, { backgroundColor: colors.sheet }]}>
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>
                {activePicker.scheduleId === 'quiet'
                  ? activePicker.kind === 'start'
                    ? 'Quiet hours start'
                    : 'Quiet hours end'
                  : activePicker.kind === 'start'
                    ? 'Start time'
                    : 'End time'}
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

      {isOnboardingVisible ? (
        <View style={[styles.onboardingBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View
            style={[
              styles.onboardingCard,
              { backgroundColor: colors.card, borderColor: colors.border, shadowColor: colors.shadow },
            ]}
          >
            <Text style={[styles.onboardingTitle, { color: colors.textPrimary }]}>
              Welcome to Never4Get
            </Text>
            <Text style={[styles.onboardingText, { color: colors.textSecondary }]}>
              Enable notifications so we can remind you. Location is optional for saved location alerts.
            </Text>
            <Pressable
              style={[
                styles.onboardingButton,
                { backgroundColor: colors.accent, borderColor: colors.accent },
              ]}
              onPress={() => void enableNotificationsFromOnboarding()}
            >
              <Text style={styles.onboardingButtonLabel}>Enable notifications</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {activeTab === 'locations' && menuLocationId ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={closeLocationMenu} />
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
                const location = locations.find((item) => item.id === menuLocationId);
                closeLocationMenu();
                if (location) {
                  renameLocation(location);
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="edit" size={18} color={colors.textPrimary} />
                <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>Edit</Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const location = locations.find((item) => item.id === menuLocationId);
                closeLocationMenu();
                if (location) {
                  setPendingLocationName(null);
                  setPendingLocationUpdate({ id: location.id, name: location.name });
                  void openMapPicker();
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="place" size={18} color={colors.textPrimary} />
                <Text style={[styles.menuItemText, { color: colors.textPrimary }]}>
                  Change location
                </Text>
              </View>
            </Pressable>
            <Pressable
              style={styles.menuItem}
              onPress={() => {
                const location = locations.find((item) => item.id === menuLocationId);
                closeLocationMenu();
                if (location) {
                  removeLocation(location);
                }
              }}
            >
              <View style={styles.menuItemContent}>
                <MaterialIcons name="delete-outline" size={18} color={colors.remove} />
                <Text style={[styles.menuItemText, { color: colors.remove }]}>Remove</Text>
              </View>
            </Pressable>
            <Pressable style={styles.menuCancel} onPress={closeLocationMenu}>
              <View style={styles.menuCancelContent}>
                <MaterialIcons name="close" size={18} color={colors.textSecondary} />
                <Text style={[styles.menuCancelText, { color: colors.textSecondary }]}>
                  Cancel
                </Text>
              </View>
            </Pressable>
          </View>
        </View>
      ) : null}

      {isMapPickerOpen ? (
        <View style={[styles.sheetBackdrop, { backgroundColor: colors.sheetBackdrop }]}>
          <View
            style={[
              styles.mapPickerCard,
              { backgroundColor: colors.card, borderColor: colors.border, shadowColor: colors.shadow },
            ]}
          >
            <View style={styles.mapPickerHeader}>
              <Text style={[styles.mapPickerTitle, { color: colors.textPrimary }]}>
                Pick a location
              </Text>
              <Pressable
                onPress={() => {
                  setPendingLocationName(null);
                  setPendingLocationUpdate(null);
                  closeMapPicker();
                }}
                hitSlop={10}
              >
                <MaterialIcons name="close" size={20} color={colors.textSecondary} />
              </Pressable>
            </View>
            <View style={styles.mapPickerMap}>
              {mapPickerRegion ? (
                <MapView
                  style={StyleSheet.absoluteFill}
                  initialRegion={mapPickerRegion}
                  onRegionChangeComplete={(region) => {
                    setMapPickerRegion(region);
                    setMapPickerCoords({
                      latitude: region.latitude,
                      longitude: region.longitude,
                    });
                  }}
                >
                </MapView>
              ) : null}
              <View pointerEvents="none" style={styles.mapPickerPin}>
                <MaterialIcons name="location-on" size={36} color={colors.remove} />
              </View>
            </View>
            <View style={styles.mapPickerActions}>
              <Pressable
                style={[
                  styles.secondaryButton,
                  { borderColor: colors.border, minWidth: 120 },
                ]}
                onPress={() => {
                  setPendingLocationName(null);
                  setPendingLocationUpdate(null);
                  closeMapPicker();
                }}
              >
                <Text style={[styles.secondaryButtonLabel, { color: colors.textPrimary }]}>
                  Cancel
                </Text>
              </Pressable>
              <Pressable
                style={[
                  styles.secondaryButton,
                  { backgroundColor: colors.accent, borderColor: colors.accent, minWidth: 160 },
                ]}
                onPress={() => {
                  if (!mapPickerCoords) {
                    return;
                  }
                  const update = pendingLocationUpdate;
                  if (update) {
                    closeMapPicker();
                    setPendingLocationUpdate(null);
                    void saveLocationFromCoords(update.name, mapPickerCoords, update.id);
                    return;
                  }
                  const name = pendingLocationName?.trim();
                  if (!name) {
                    closeMapPicker();
                    openLocationNamePrompt();
                    return;
                  }
                  closeMapPicker();
                  setPendingLocationName(null);
                  void saveLocationFromCoords(name, mapPickerCoords);
                }}
              >
                <Text style={styles.onboardingButtonLabel}>Use this location</Text>
              </Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <ColorSchemeProvider>
        <AppContent />
      </ColorSchemeProvider>
    </SafeAreaProvider>
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
  settingsContainer: {
    flex: 1,
    padding: 18,
    paddingBottom: TAB_BAR_HEIGHT + 32,
    gap: 12,
  },
  settingsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  settingsText: {
    flex: 1,
    gap: 6,
  },
  settingsLabel: {
    fontSize: 16,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
  },
  settingsHelper: {
    fontSize: 13,
  },
  settingsSectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  locationSettingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  locationRadiusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
  },
  radiusControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  radiusInputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  radiusInput: {
    minWidth: 60,
    textAlign: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  locationActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  locationIconButton: {
    padding: 6,
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
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  addButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
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
  cardHeaderActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  cardSummary: {
    fontSize: 12,
    fontFamily: FONT_REGULAR,
    marginBottom: 6,
  },
  toggleButton: {
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    width: 88,
    alignItems: 'center',
  },
  toggleButtonLabel: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  divider: {
    height: 1,
    width: '100%',
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
  intervalInputGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  intervalInput: {
    minWidth: 46,
    textAlign: 'center',
    borderWidth: 1,
    borderRadius: 10,
    paddingVertical: 6,
    paddingHorizontal: 8,
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  intervalUnit: {
    fontSize: 13,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
  stepperButton: {
    width: 34,
    height: 34,
    borderRadius: 10,
    borderWidth: 1,
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
  timeRowGroup: {
    gap: 8,
    marginTop: 8,
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
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  locationChip: {
    flex: 1,
    borderRadius: 10,
    borderWidth: 1,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  locationChipLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
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
  menuItemContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
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
  menuCancelContent: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  menuCancelText: {
    fontSize: 15,
    fontWeight: '600',
    fontFamily: FONT_BOLD,
    textAlign: 'center',
  },
  mapPickerCard: {
    marginHorizontal: 18,
    marginBottom: 24,
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    gap: 12,
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
  },
  mapPickerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  mapPickerTitle: {
    fontSize: 17,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  mapPickerMap: {
    height: 320,
    borderRadius: 16,
    overflow: 'hidden',
  },
  mapPickerPin: {
    position: 'absolute',
    left: '50%',
    top: '50%',
    transform: [{ translateX: -17 }, { translateY: -34 }],
  },
  mapPickerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  namePromptWrapper: {
    flex: 1,
    justifyContent: 'flex-end',
    paddingBottom: 16,
  },
  sheetBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
  },
  onboardingBackdrop: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    padding: 24,
  },
  onboardingCard: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 18,
    gap: 12,
    shadowOpacity: 0.06,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 8 },
  },
  onboardingTitle: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
  },
  onboardingText: {
    fontSize: 13,
    lineHeight: 18,
  },
  onboardingButton: {
    borderRadius: 12,
    paddingVertical: 10,
    alignItems: 'center',
    borderWidth: 1,
  },
  onboardingButtonLabel: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '700',
    fontFamily: FONT_BOLD,
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
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    height: TAB_BAR_HEIGHT,
  },
  tabButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    paddingTop: 20,
    paddingBottom: 0,
  },
  tabIcon: {
    height: 25,
    marginTop: 6,
  },
  tabLabel: {
    fontSize: 12,
    fontWeight: '600',
    fontFamily: FONT_MEDIUM,
  },
});

const lightColors = {
  background: '#EDE3D9',
  card: '#F6ECE2',
  textPrimary: '#1C1C1E',
  textSecondary: '#6E6E73',
  textMuted: '#8E8E93',
  label: '#3A3A3C',
  inputBackground: '#F1E6DC',
  inputText: '#1C1C1E',
  placeholder: '#8E8E93',
  accent: '#0A84FF',
  active: '#34C759',
  inactive: '#C7C7CC',
  stop: '#FF3B30',
  shadow: '#000000',
  inline: '#8E6C6C',
  sheet: '#F6ECE2',
  sheetBackdrop: 'rgba(0, 0, 0, 0.35)',
  remove: '#FF3B30',
  border: '#DED0C4',
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
  active: '#30D158',
  inactive: '#636366',
  stop: '#FF453A',
  shadow: '#000000',
  inline: '#C6A3A3',
  sheet: '#1C1C1E',
  sheetBackdrop: 'rgba(0, 0, 0, 0.6)',
  remove: '#FF453A',
  border: '#3A3A3C',
};

