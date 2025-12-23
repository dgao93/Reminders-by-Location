import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

import { cancelScheduleNotifications, scheduleBatch } from './notifications';
import { loadSettings } from './storage';

type GeofencingEvent = {
  eventType: Location.GeofencingEventType;
  region: Location.LocationRegion;
};

export const GEOFENCE_TASK = 'location-geofence-task';

TaskManager.defineTask(GEOFENCE_TASK, async ({ data, error }) => {
  if (error) {
    return;
  }

  const event = data as GeofencingEvent | undefined;
  if (!event?.region) {
    return;
  }

  const regionId = event.region.identifier;
  const settings = await loadSettings();
  if (!settings) {
    return;
  }

  const targetSchedules = settings.schedules.filter(
    (schedule) => schedule.isActive && schedule.locationId === regionId
  );
  if (targetSchedules.length === 0) {
    return;
  }

  if (event.eventType === Location.GeofencingEventType.Exit) {
    await Promise.all(targetSchedules.map((schedule) => cancelScheduleNotifications(schedule.id)));
    return;
  }

  if (event.eventType === Location.GeofencingEventType.Enter) {
    await Promise.all(targetSchedules.map((schedule) => cancelScheduleNotifications(schedule.id)));
    await scheduleBatch(targetSchedules, { quietHours: settings.quietHours });
  }
});
