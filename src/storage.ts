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
  locationId: string | null;
};

export type StoredLocation = {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address?: string;
};

export type QuietHours = {
  enabled: boolean;
  startMinutesFromMidnight: number;
  endMinutesFromMidnight: number;
};

export type StoredSettings = {
  schedules: Schedule[];
  locations?: StoredLocation[];
  quietHours?: QuietHours;
  locationRadiusMeters?: number;
};

const STORAGE_KEY = 'intervals_settings_v2';
const DEFAULT_DAYS = [true, true, true, true, true, true, true];
const DEFAULT_QUIET_HOURS: QuietHours = {
  enabled: false,
  startMinutesFromMidnight: 22 * 60,
  endMinutesFromMidnight: 7 * 60,
};

const normalizeDaysOfWeek = (value: unknown) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return [...DEFAULT_DAYS];
  }
  return value.map((entry) => Boolean(entry));
};

const normalizeCoords = (value: unknown) => {
  const location = value as { latitude?: number; longitude?: number } | undefined;
  if (
    !location ||
    typeof location.latitude !== 'number' ||
    typeof location.longitude !== 'number'
  ) {
    return undefined;
  }
  return {
    latitude: location.latitude,
    longitude: location.longitude,
  };
};

const normalizeLocations = (value: unknown) => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => entry as StoredLocation)
    .filter(
      (entry) =>
        entry &&
        typeof entry.id === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.latitude === 'number' &&
        typeof entry.longitude === 'number'
    )
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      latitude: entry.latitude,
      longitude: entry.longitude,
      address: typeof entry.address === 'string' ? entry.address : undefined,
    }));
};

const normalizeMinutes = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0;
  }
  const normalized = Math.floor(value) % (24 * 60);
  return normalized < 0 ? normalized + 24 * 60 : normalized;
};

const normalizeQuietHours = (value: unknown): QuietHours => {
  const input = value as Partial<QuietHours> | undefined;
  const enabled = Boolean(input?.enabled);
  const start =
    typeof input?.startMinutesFromMidnight === 'number'
      ? normalizeMinutes(input.startMinutesFromMidnight)
      : DEFAULT_QUIET_HOURS.startMinutesFromMidnight;
  const end =
    typeof input?.endMinutesFromMidnight === 'number'
      ? normalizeMinutes(input.endMinutesFromMidnight)
      : DEFAULT_QUIET_HOURS.endMinutesFromMidnight;

  return {
    enabled,
    startMinutesFromMidnight: start,
    endMinutesFromMidnight: end,
  };
};

const normalizeLocationRadius = (value: unknown) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const rounded = Math.round(value);
  if (rounded < 25) {
    return 25;
  }
  if (rounded > 1000) {
    return 1000;
  }
  return rounded;
};

export const loadSettings = async (): Promise<StoredSettings | null> => {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as {
      schedules?: unknown;
      isActive?: unknown;
      locations?: unknown;
      homeLocation?: unknown;
      workLocation?: unknown;
      quietHours?: unknown;
      locationRadiusMeters?: unknown;
    };
    if (!Array.isArray(parsed.schedules)) {
      return null;
    }
    const defaultActive = typeof parsed.isActive === 'boolean' ? parsed.isActive : false;
    const locations = normalizeLocations(parsed.locations);
    const legacyHome = normalizeCoords(parsed.homeLocation);
    const legacyWork = normalizeCoords(parsed.workLocation);
    if (legacyHome && !locations.some((location) => location.id === 'home')) {
      locations.push({ id: 'home', name: 'Home', ...legacyHome });
    }
    if (legacyWork && !locations.some((location) => location.id === 'work')) {
      locations.push({ id: 'work', name: 'Work', ...legacyWork });
    }
    const locationIds = new Set(locations.map((location) => location.id));
    const validSchedules = parsed.schedules
      .filter((schedule) => isValidSchedule(schedule))
      .map((schedule, index) => {
        const normalized = schedule as Schedule & { locationFilter?: unknown };
        const rawLocation =
          normalized.locationId ?? (normalized as { locationFilter?: unknown }).locationFilter;
        const locationId =
          typeof rawLocation === 'string' && rawLocation !== 'anywhere'
            ? locationIds.has(rawLocation)
              ? rawLocation
              : null
            : null;
        return {
          ...normalized,
          name: typeof normalized.name === 'string' ? normalized.name : `Notification ${index + 1}`,
          daysOfWeek: normalizeDaysOfWeek(normalized.daysOfWeek),
          isActive:
            typeof normalized.isActive === 'boolean' ? normalized.isActive : defaultActive,
          locationId,
        };
      });
    return {
      schedules: validSchedules,
      locations,
      quietHours: normalizeQuietHours(parsed.quietHours),
      locationRadiusMeters: normalizeLocationRadius(parsed.locationRadiusMeters),
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
    daysValid &&
    (typeof schedule.locationId === 'string' ||
      typeof schedule.locationId === 'undefined' ||
      schedule.locationId === null ||
      typeof schedule.locationFilter === 'string' ||
      typeof schedule.locationFilter === 'undefined')
  );
};
