import AsyncStorage from '@react-native-async-storage/async-storage';

export type Schedule = {
  id: string;
  name: string;
  intervalMinutes: number;
  startMinutesFromMidnight: number;
  endMinutesFromMidnight: number;
  daysOfWeek: boolean[];
  message: string;
  isActive: boolean;
};

export type StoredSettings = {
  schedules: Schedule[];
};

const STORAGE_KEY = 'intervals_settings_v2';
const DEFAULT_DAYS = [true, true, true, true, true, true, true];

const normalizeDaysOfWeek = (value: unknown) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return [...DEFAULT_DAYS];
  }
  return value.map((entry) => Boolean(entry));
};

export const loadSettings = async (): Promise<StoredSettings | null> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as { schedules?: unknown; isActive?: unknown };
    if (!Array.isArray(parsed.schedules)) {
      return null;
    }
    const defaultActive = typeof parsed.isActive === 'boolean' ? parsed.isActive : false;
    const validSchedules = parsed.schedules
      .filter((schedule) => isValidSchedule(schedule))
      .map((schedule, index) => {
        const normalized = schedule as Schedule;
        return {
          ...normalized,
          name: typeof normalized.name === 'string' ? normalized.name : `Notification ${index + 1}`,
          daysOfWeek: normalizeDaysOfWeek(normalized.daysOfWeek),
          isActive:
            typeof normalized.isActive === 'boolean' ? normalized.isActive : defaultActive,
        };
      });
    return {
      schedules: validSchedules,
    };
  } catch {
    return null;
  }
};

export const saveSettings = async (settings: StoredSettings): Promise<void> => {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage errors for now.
  }
};

const isValidSchedule = (value: unknown) => {
  const schedule = value as Schedule;
  const daysValid =
    typeof schedule?.daysOfWeek === 'undefined' ||
    (Array.isArray(schedule.daysOfWeek) && schedule.daysOfWeek.length === 7);
  return (
    typeof schedule?.id === 'string' &&
    typeof schedule.intervalMinutes === 'number' &&
    typeof schedule.startMinutesFromMidnight === 'number' &&
    typeof schedule.endMinutesFromMidnight === 'number' &&
    typeof schedule.message === 'string' &&
    (typeof schedule.name === 'string' || typeof schedule.name === 'undefined') &&
    daysValid
  );
};
