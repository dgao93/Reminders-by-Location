export type ScheduleInput = {
  now: Date;
  intervalMinutes: number;
  startMinutesFromMidnight: number;
  endMinutesFromMidnight: number;
  daysOfWeek?: boolean[];
  maxCount?: number;
  horizonHours?: number;
};

export type ScheduleRule = {
  id: string;
  intervalMinutes: number;
  startMinutesFromMidnight: number;
  endMinutesFromMidnight: number;
  message: string;
  daysOfWeek?: boolean[];
};

export type ScheduledNotification = {
  scheduleId: string;
  date: Date;
  message: string;
};

export type QueueInput = {
  now: Date;
  schedules: ScheduleRule[];
  maxCount?: number;
  horizonHours?: number;
};

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 180;
const DEFAULT_DAYS = [true, true, true, true, true, true, true];

const normalizeDaysOfWeek = (value?: boolean[]) => {
  if (!Array.isArray(value) || value.length !== 7) {
    return DEFAULT_DAYS;
  }
  return value.map((entry) => Boolean(entry));
};

const isDayActive = (date: Date, daysOfWeek: boolean[]) => {
  const day = date.getDay();
  const index = day === 0 ? 6 : day - 1;
  return Boolean(daysOfWeek[index]);
};

export const buildNotificationQueue = (input: QueueInput): ScheduledNotification[] => {
  const maxCount = input.maxCount ?? 50;
  const horizonHours = input.horizonHours ?? 24;
  const now = input.now;

  const combined: ScheduledNotification[] = [];
  for (const schedule of input.schedules) {
    const dates = generateFireDates({
      now,
      intervalMinutes: schedule.intervalMinutes,
      startMinutesFromMidnight: schedule.startMinutesFromMidnight,
      endMinutesFromMidnight: schedule.endMinutesFromMidnight,
      daysOfWeek: schedule.daysOfWeek,
      maxCount,
      horizonHours,
    });
    for (const date of dates) {
      combined.push({
        scheduleId: schedule.id,
        date,
        message: schedule.message,
      });
    }
  }

  combined.sort((a, b) => a.date.getTime() - b.date.getTime());
  return combined.slice(0, maxCount);
};

export const generateFireDates = (input: ScheduleInput): Date[] => {
  const interval = clamp(input.intervalMinutes, MIN_INTERVAL, MAX_INTERVAL);
  const startMinutes = normalizeMinutes(input.startMinutesFromMidnight);
  const endMinutes = normalizeMinutes(input.endMinutesFromMidnight);
  const maxCount = input.maxCount ?? 50;
  const horizonHours = input.horizonHours ?? 24;
  const activeDays = normalizeDaysOfWeek(input.daysOfWeek);
  if (!activeDays.some(Boolean)) {
    return [];
  }

  const results: Date[] = [];
  const now = input.now;
  const horizon = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);
  const allDay = startMinutes === endMinutes;
  const spansMidnight = endMinutes < startMinutes;
  let cursor = new Date(now);

  while (results.length < maxCount && cursor <= horizon) {
    if (allDay) {
      const windowStart = startOfDay(cursor);
      let candidate = alignToInterval(windowStart, cursor, interval);
      if (candidate <= now) {
        candidate = addMinutes(candidate, interval);
      }
      if (candidate > horizon) {
        break;
      }
      if (isDayActive(candidate, activeDays)) {
        results.push(candidate);
      }
      cursor = addMinutes(candidate, interval);
      continue;
    }

    if (!isWithinWindow(cursor, startMinutes, endMinutes, spansMidnight)) {
      const nextStart = nextWindowStart(cursor, startMinutes, endMinutes, spansMidnight);
      if (nextStart > horizon) {
        break;
      }
      cursor = nextStart;
    }

    const window = windowFor(cursor, startMinutes, endMinutes, spansMidnight);
    let candidate = alignToInterval(window.start, cursor, interval);
    while (candidate < window.end && candidate <= horizon && results.length < maxCount) {
      if (candidate > now && isDayActive(candidate, activeDays)) {
        results.push(candidate);
      }
      candidate = addMinutes(candidate, interval);
    }
    cursor = addMinutes(window.end, 1);
  }

  if (results.length === 0) {
    return generateFallbackDates({
      now,
      intervalMinutes: interval,
      startMinutes,
      endMinutes,
      daysOfWeek: activeDays,
      maxCount,
      horizonHours,
    });
  }

  return results;
};

const normalizeMinutes = (value: number) => {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const normalized = Math.floor(value) % (24 * 60);
  return normalized < 0 ? normalized + 24 * 60 : normalized;
};

const clamp = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
};

const startOfDay = (date: Date) => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const dateAtMinutes = (date: Date, minutes: number) => {
  const next = startOfDay(date);
  next.setMinutes(minutes);
  return next;
};

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60 * 1000);

const isWithinWindow = (
  date: Date,
  startMinutes: number,
  endMinutes: number,
  spansMidnight: boolean
) => {
  const timeMinutes = minutesSinceMidnight(date);
  if (!spansMidnight) {
    return timeMinutes >= startMinutes && timeMinutes < endMinutes;
  }
  // Midnight-spanning window, e.g. 21:00 to 06:00.
  return timeMinutes >= startMinutes || timeMinutes < endMinutes;
};

const nextWindowStart = (
  date: Date,
  startMinutes: number,
  endMinutes: number,
  spansMidnight: boolean
) => {
  const timeMinutes = minutesSinceMidnight(date);
  const todayStart = dateAtMinutes(date, startMinutes);

  if (!spansMidnight) {
    return timeMinutes < startMinutes ? todayStart : addDays(todayStart, 1);
  }

  // Outside window only occurs between endMinutes and startMinutes.
  if (timeMinutes >= endMinutes && timeMinutes < startMinutes) {
    return todayStart;
  }

  return addDays(todayStart, 1);
};

const windowFor = (
  date: Date,
  startMinutes: number,
  endMinutes: number,
  spansMidnight: boolean
) => {
  const timeMinutes = minutesSinceMidnight(date);
  const todayStart = dateAtMinutes(date, startMinutes);

  if (!spansMidnight) {
    return {
      start: todayStart,
      end: dateAtMinutes(date, endMinutes),
    };
  }

  if (timeMinutes >= startMinutes) {
    return {
      start: todayStart,
      end: dateAtMinutes(addDays(todayStart, 1), endMinutes),
    };
  }

  return {
    start: dateAtMinutes(addDays(todayStart, -1), startMinutes),
    end: dateAtMinutes(date, endMinutes),
  };
};

const alignToInterval = (windowStart: Date, cursor: Date, intervalMinutes: number) => {
  const diffMinutes = Math.max(0, Math.floor((cursor.getTime() - windowStart.getTime()) / 60000));
  const remainder = diffMinutes % intervalMinutes;
  const delta = remainder === 0 ? 0 : intervalMinutes - remainder;
  return addMinutes(cursor, delta);
};

const minutesSinceMidnight = (date: Date) => date.getHours() * 60 + date.getMinutes();

const addDays = (date: Date, days: number) => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

type FallbackInput = {
  now: Date;
  intervalMinutes: number;
  startMinutes: number;
  endMinutes: number;
  daysOfWeek: boolean[];
  maxCount: number;
  horizonHours: number;
};

const generateFallbackDates = (input: FallbackInput) => {
  const { now, intervalMinutes, startMinutes, endMinutes, daysOfWeek, maxCount, horizonHours } =
    input;
  const results: Date[] = [];
  const horizon = new Date(now.getTime() + horizonHours * 60 * 60 * 1000);
  const allDay = startMinutes === endMinutes;
  const spansMidnight = endMinutes < startMinutes;

  let cursor = addMinutes(now, intervalMinutes);
  cursor.setSeconds(0, 0);

  while (results.length < maxCount && cursor <= horizon) {
    if (
      (allDay || isWithinWindow(cursor, startMinutes, endMinutes, spansMidnight)) &&
      isDayActive(cursor, daysOfWeek)
    ) {
      results.push(cursor);
    }
    cursor = addMinutes(cursor, intervalMinutes);
  }

  return results;
};
